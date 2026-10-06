import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { GenerationCollector } from './generation.mjs';
import { startMonitor } from './server.mjs';

// 仅验收本脚本的离线假 CLI。生产 Codex、生产状态目录和真实模型均不参与。
const projectRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const diagnosticsRoot = path.join(projectRoot, 'diagnostics');
await mkdir(diagnosticsRoot, { recursive: true });
const outputDir = await mkdtemp(path.join(diagnosticsRoot, 'generation-recovery-'));
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-generation-recovery-'));
const codexHome = path.join(fixtureRoot, '独立恢复 Codex Home');
await mkdir(codexHome);
const homeKey = createHash('sha256').update(codexHome.toLowerCase()).digest('hex').slice(0, 24);
const stateDir = path.join(projectRoot, 'runtime', `performance-${homeKey}`);
const legacyScript = path.join(projectRoot, 'performance-monitor', `generation-bridge.recovery-fixture-${randomBytes(8).toString('hex')}.mjs`);
const legacyBackup = path.join(projectRoot, 'backups', '20261006-generation-retry', 'performance-monitor', 'generation-bridge.mjs');
const recoverScript = path.join(projectRoot, 'performance-monitor', 'recover-generation.mjs');
const checks = [];
let ownsState = false;
let ownsLegacy = false;
let native;
let lock;
let service;
let collector;
let failure;
const transcript = [];

function execute(executable, args, env = process.env) {
  const child = spawn(executable, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.on('data', bytes => stdout.push(bytes));
    child.stderr.on('data', bytes => stderr.push(bytes));
    child.once('close', (code, signal) => resolve({ code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
  });
  return { child, stdout, stderr, closed };
}

async function limited(promise, label, timeoutMs = 15000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} 超时。`)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

async function waitFor(read, predicate, label, timeoutMs = 12000) {
  const until = Date.now() + timeoutMs;
  let last;
  do {
    last = await read();
    if (predicate(last)) return last;
    await delay(90);
  } while (Date.now() < until);
  throw new Error(`${label} 未达到预期：${JSON.stringify(last)}`);
}

function assertPrivate(value) {
  assert.doesNotMatch(typeof value === 'string' ? value : JSON.stringify(value), /念念|PRIVATE_REASONING|PRIVATE_TOOL|"text"|"delta"/, '恢复快照/API 不能含假 CLI 正文');
}

try {
  assert.equal(process.platform, 'win32', '此热恢复验收需要 Windows。');
  await access(recoverScript);
  try { await access(stateDir); throw new Error('随机恢复验收目录已存在，不覆盖。'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // 必须同目录，使旧文件的 import.meta.url 所推导 ProjectRoot 保持正确。
  await copyFile(legacyBackup, legacyScript, 1);
  ownsLegacy = true;
  const copiedLegacy = await readFile(legacyScript);
  assert.deepEqual(copiedLegacy, await readFile(legacyBackup));
  checks.push('exact-legacy-copy-same-project-root-and-original-entry-guard');
  const configureFile = path.join(fixtureRoot, 'configure.ps1');
  await writeFile(configureFile, `param([string]$ProjectRoot, [string]$RealCli, [string]$CodexHome, [int]$RootProcessId)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Import-Module -Name (Join-Path $ProjectRoot 'GenerationBridge.psm1') -Force
$configuration = Get-CodexGenerationConfiguration -RealCliPath $RealCli -CodexHome $CodexHome -ProjectRoot $ProjectRoot
Register-CodexGenerationBinding -Configuration $configuration -CodexProcess (Get-Process -Id $RootProcessId -ErrorAction Stop)
$configuration | ConvertTo-Json -Compress -Depth 5
`, 'utf8');
  ownsState = true;
  const configuring = execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', configureFile,
    '-ProjectRoot', projectRoot, '-RealCli', process.execPath, '-CodexHome', codexHome, '-RootProcessId', String(process.pid)]);
  configuring.child.stdin.end();
  const configured = await limited(configuring.closed, '真实绑定配置');
  assert.equal(configured.code, 0, configured.stderr.toString('utf8'));
  const config = JSON.parse(configured.stdout.toString('utf8'));
  assert.equal(config.HomeKey, homeKey);
  assert.equal(path.resolve(config.StateDirectory), path.join(stateDir, 'generation'));
  const binding = JSON.parse(await readFile(path.join(config.StateDirectory, 'binding.json'), 'utf8'));
  assert.equal(binding.codexPid, process.pid);
  checks.push('real-generation-configuration-bound-to-controlled-root');

  const thread = 'recovery-thread';
  const turn = 'recovery-turn';
  const item = { id: 'recovery-message', type: 'agentMessage', phase: 'final_answer' };
  const event = (method, extra) => ({ method, params: { threadId: thread, turnId: turn, ...extra } });
  const beforeBytes = Buffer.concat([Buffer.from('{"id":"fixture-before","result":{"ok":true}}\r\n'), Buffer.from([0, 255, 13, 10])]);
  const openingEvents = [event('item/started', { item }), ...['念念', '\uD83D', '\uDE00', 'abc'].map(delta => event('item/agentMessage/delta', { itemId: item.id, delta })),
    event('item/reasoning/textDelta', { itemId: item.id, delta: 'PRIVATE_REASONING' }), event('item/commandExecution/outputDelta', { itemId: item.id, delta: 'PRIVATE_TOOL' })];
  const openingBytes = Buffer.from(openingEvents.map(value => JSON.stringify(value)).join('\n') + '\n');
  const completedBytes = Buffer.from(JSON.stringify(event('item/completed', { item: { ...item, text: '念念😀abc' } })) + '\n'
    + JSON.stringify(event('turn/completed', { turn: { id: turn } })) + '\n');
  const marker = Buffer.from('RECOVERY_FIXTURE_STDERR_MARKER_中文😀\n');
  const fixtureCli = path.join(fixtureRoot, '假 CLI 恢复.mjs');
  await writeFile(fixtureCli, `import readline from 'node:readline';
process.stderr.write('RECOVERY_FIXTURE_IDS ' + JSON.stringify({cliPid:process.pid,observerPid:process.ppid}) + '\\n');
const before=Buffer.from('${beforeBytes.toString('base64')}','base64');
const opening=Buffer.from('${openingBytes.toString('base64')}','base64');
const completed=Buffer.from('${completedBytes.toString('base64')}','base64');
const marker=Buffer.from('${marker.toString('base64')}','base64');
const input=readline.createInterface({input:process.stdin});
input.on('line',command=>{
 if(command==='before')process.stdout.write(before);
 else if(command==='emit'){for(const byte of opening)process.stdout.write(Buffer.from([byte]));process.stderr.write(marker);}
 else if(command==='complete')process.stdout.write(completed);
 else if(command==='exit'){input.close();process.stdin.destroy();process.exitCode=43;}
});
`, 'utf8');
  const env = { ...process.env, CODEX_GENERATION_REAL_CLI: config.RealCliPath, CODEX_GENERATION_NODE: config.NodeExecutable,
    CODEX_GENERATION_SCRIPT: legacyScript, CODEX_GENERATION_STATE_DIR: config.StateDirectory,
    CODEX_GENERATION_HOME_KEY: homeKey, CODEX_GENERATION_LAUNCH_ID: config.LaunchId };
  native = execute(config.ForwarderPath, [fixtureCli, 'app-server'], env);
  const ids = await waitFor(() => {
    const match = /RECOVERY_FIXTURE_IDS ([^\r\n]+)/.exec(Buffer.concat(native.stderr).toString('utf8'));
    return match ? JSON.parse(match[1]) : null;
  }, value => Number.isInteger(value?.cliPid) && Number.isInteger(value?.observerPid), '假 CLI 数值 PID 标识');
  const processScript = path.join(fixtureRoot, 'identity.ps1');
  await writeFile(processScript, `param([int]$RootProcessId,[int]$NativeProcessId,[int]$ObserverProcessId,[int]$CliProcessId)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$wanted=@($RootProcessId,$NativeProcessId,$ObserverProcessId,$CliProcessId)
$rows=foreach($ownedId in $wanted){
 $p=Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ownedId" -ErrorAction Stop
 if($null -eq $p){throw '验收进程不在运行。'}
 [ordered]@{pid=$p.ProcessId;parentPid=$p.ParentProcessId;startedAt=$p.CreationDate.ToUniversalTime().ToString('o');executableName=[IO.Path]::GetFileName($p.ExecutablePath)}
}
@($rows)|ConvertTo-Json -Compress -Depth 4
`, 'utf8');
  async function identities() {
    const request = execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', processScript,
      '-RootProcessId', String(process.pid), '-NativeProcessId', String(native.child.pid), '-ObserverProcessId', String(ids.observerPid), '-CliProcessId', String(ids.cliPid)]);
    request.child.stdin.end();
    const response = await limited(request.closed, '验收进程身份查询');
    assert.equal(response.code, 0, response.stderr.toString('utf8'));
    return JSON.parse(response.stdout.toString('utf8'));
  }
  const beforeIdentity = await identities();
  const byPid = Object.fromEntries(beforeIdentity.map(value => [value.pid, value]));
  assert.equal(byPid[native.child.pid].parentPid, process.pid);
  assert.equal(byPid[ids.observerPid].parentPid, native.child.pid);
  assert.equal(byPid[ids.cliPid].parentPid, ids.observerPid);
  checks.push('real-root-native-observer-cli-parent-chain');
  collector = new GenerationCollector({ stateDir, homeKey });
  const streamDirectory = path.join(config.StateDirectory, config.LaunchId);
  const legacyFiles = await waitFor(async () => (await readdir(streamDirectory)).filter(name => /^stream-\d+-[a-f0-9]{32}\.json$/.test(name)), value => value.length === 1, 'legacy 首次心跳');
  const legacyFile = path.join(streamDirectory, legacyFiles[0]);
  const readLegacy = async () => JSON.parse(await readFile(legacyFile, 'utf8'));
  // 不提前打开 JSON 读取或后台轮询：旧 writer 会被普通读锁抢先触发冻结，
  // 从而绕过下面明确、受控的共享锁故障步骤。元数据检查不持有内容读锁。
  const baseline = await stat(legacyFile);
  await waitFor(async () => (await stat(legacyFile)).mtimeMs, value => value !== baseline.mtimeMs, 'legacy 心跳先正常更新');
  checks.push('legacy-writer-initially-heartbeats');

  const lockScript = path.join(fixtureRoot, 'lock.ps1');
  const lockReady = path.join(fixtureRoot, 'lock-ready.json');
  const lockRelease = path.join(fixtureRoot, 'release-lock.flag');
  await writeFile(lockScript, `param([string]$TargetFile,[string]$ReadyFile,[string]$ReleaseFile)
$ErrorActionPreference='Stop'
$held=[IO.File]::Open($TargetFile,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try {
 [IO.File]::WriteAllText($ReadyFile,'{"locked":true}',[Text.UTF8Encoding]::new($false))
 $limit=[DateTime]::UtcNow.AddSeconds(30)
 while(-not(Test-Path -LiteralPath $ReleaseFile)){if([DateTime]::UtcNow -gt $limit){throw '仅验收的共享锁等待超时'};Start-Sleep -Milliseconds 75}
} finally {$held.Dispose()}
`, 'utf8');
  lock = execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', lockScript,
    '-TargetFile', legacyFile, '-ReadyFile', lockReady, '-ReleaseFile', lockRelease]);
  lock.child.stdin.end();
  await waitFor(async () => { try { return JSON.parse(await readFile(lockReady, 'utf8')); } catch { return null; } }, value => value?.locked, '只读共享锁已持有');
  const lockedSnapshot = await readLegacy();
  assert.equal(lockedSnapshot.pid, ids.observerPid);
  await delay(1400);
  assert.equal((await readLegacy()).updatedAt, lockedSnapshot.updatedAt, '锁期间 legacy rename 失败，心跳被冻结');
  await writeFile(lockRelease, 'release', 'utf8');
  const released = await limited(lock.closed, '释放验收文件共享锁', 6000);
  assert.equal(released.code, 0, released.stderr.toString('utf8'));
  await delay(1400);
  const frozen = await readLegacy();
  assert.equal(frozen.updatedAt, lockedSnapshot.updatedAt, '锁释放后旧 writer 仍永久停用');
  assert.equal(frozen.state, 'active');
  native.child.stdin.write('before\n');
  transcript.push(beforeBytes);
  await waitFor(() => Buffer.concat(native.stdout).length, value => value === beforeBytes.length, '冻结时 CLI 的 RPC 仍可转发');
  assert.deepEqual(Buffer.concat(native.stdout), beforeBytes);
  checks.push('fileshare-read-lock-reproduces-legacy-permanent-write-disable', 'legacy-does-not-recover-after-lock-release', 'frozen-capture-keeps-original-cli-rpc-forwarding');
  await writeFile(path.join(outputDir, 'frozen-snapshot.json'), JSON.stringify(frozen, null, 2), 'utf8');

  const listenScript = path.join(fixtureRoot, 'listen.ps1');
  await writeFile(listenScript, `param([int]$ObserverProcessId)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$listeners=@(Get-NetTCPConnection -State Listen -OwningProcess $ObserverProcessId -ErrorAction SilentlyContinue)
[ordered]@{listenerCount=$listeners.Count;ports=@($listeners|Select-Object -ExpandProperty LocalPort)}|ConvertTo-Json -Compress -Depth 3
`, 'utf8');
  async function listeners() {
    const request = execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', listenScript,
      '-ObserverProcessId', String(ids.observerPid)]);
    request.child.stdin.end();
    const response = await limited(request.closed, '检查受控 inspector 端点关闭');
    assert.equal(response.code, 0, response.stderr.toString('utf8'));
    return JSON.parse(response.stdout.toString('utf8'));
  }
  const { recoverGeneration } = await import('./recover-generation.mjs');
  await assert.rejects(recoverGeneration({ stateDir, bridgePid: ids.observerPid, cliPid: ids.cliPid, bridgeScript: legacyScript,
    afterActivation() { throw new Error('RECOVERY_FIXTURE_INJECTED_FAILURE'); } }), /RECOVERY_FIXTURE_INJECTED_FAILURE/);
  assert.equal((await listeners()).listenerCount, 0, '激活 inspector 后发生异常也必须关闭端点');
  assert.deepEqual(await identities(), beforeIdentity);
  assert.deepEqual(Buffer.concat(native.stdout), beforeBytes);
  checks.push('activated-inspector-failure-closes-endpoint-with-cli-and-rpc-unchanged');

  const repair = execute(process.execPath, [recoverScript, '--state-dir', stateDir, '--bridge-pid', String(ids.observerPid),
    '--cli-pid', String(ids.cliPid), '--bridge-script', legacyScript]);
  repair.child.stdin.end();
  const repaired = await limited(repair.closed, '受控 inspector 热恢复', 30000);
  assert.equal(repaired.code, 0, repaired.stderr.toString('utf8'));
  const repairResult = JSON.parse(repaired.stdout.toString('utf8'));
  assert.equal(repairResult.attached, true);
  assert.equal(repairResult.processIdentitiesUnchanged, true);
  assert.equal(repairResult.noCliSpawnOrRpcWrite, true);
  const afterIdentity = await identities();
  assert.deepEqual(afterIdentity, beforeIdentity, '热恢复不能替换或重启现有根/native/observer/CLI');
  checks.push('repair-utility-retains-all-four-process-pids-and-start-times');
  const recoveredFiles = await waitFor(async () => (await readdir(streamDirectory)).filter(name => /^stream-\d+-[a-f0-9]{32}\.json$/.test(name)), value => value.length >= 2, '恢复 writer 新快照');
  const newFiles = recoveredFiles.filter(name => name !== legacyFiles[0]);
  assert.ok(newFiles.length >= 1);
  const recoveredFile = path.join(streamDirectory, newFiles[0]);
  const recoveredFirst = JSON.parse(await readFile(recoveredFile, 'utf8'));
  assert.equal(recoveredFirst.pid, ids.observerPid);
  await waitFor(async () => JSON.parse(await readFile(recoveredFile, 'utf8')), value => value.updatedAt !== recoveredFirst.updatedAt, '恢复后新 writer 心跳继续');
  checks.push('new-writer-heartbeats-on-same-existing-observer');

  service = await startMonitor({ codexHome, stateDir, port: 0, generationPollMs: 100,
    collector: { async poll() {}, snapshot() { return { turns: [], warnings: [], source: {}, updatedAt: new Date().toISOString() }; } },
    networkCollector: { async poll() {}, snapshot() { return null; }, async close() {} }, generationCollector: collector });
  native.child.stdin.write('emit\n');
  transcript.push(openingBytes);
  const active = await waitFor(async () => { await collector.poll(); return collector.snapshot(); }, value => value.streams.some(item => item.characters === 6 && item.charactersPerSecond === 2), '热恢复后中文和拆分 emoji 正确计数');
  assertPrivate(active);
  const measured = active.streams.find(value => value.itemId === item.id);
  assert.equal(measured.windowCharacters, 6);
  assert.equal(measured.threadId, thread);
  assert.equal(measured.turnId, turn);
  assert.equal(active.captureHealth?.state, 'ok');
  assert.ok(Number.isFinite(Date.parse(active.captureHealth?.reattachedAt)), '恢复计数的起点必须明确');
  const api = await (await fetch(`${service.url}api/status`)).json();
  assertPrivate(api);
  assert.equal(api.generation.streams.find(value => value.itemId === item.id).characters, 6);
  await writeFile(path.join(outputDir, 'recovered-api-status.json'), JSON.stringify(api, null, 2), 'utf8');
  await writeFile(path.join(outputDir, 'recovered-stream.json'), JSON.stringify(active, null, 2), 'utf8');
  checks.push('same-cli-recovery-unicode-six-codepoints-two-per-second', 'recovery-snapshot-and-api-retain-no-message-body');

  const listenerStatus = await listeners();
  assert.equal(listenerStatus.listenerCount, 0, '指定 observer 的临时 inspector 必须关闭');
  checks.push('temporary-inspector-endpoint-closed');

  native.child.stdin.write('complete\n');
  transcript.push(completedBytes);
  const completed = await waitFor(async () => { await collector.poll(); return collector.snapshot(); }, value => value.streams.some(stream => stream.itemId === item.id && stream.state === 'completed'), '恢复采集的完成状态');
  assert.equal(completed.streams.find(stream => stream.itemId === item.id).charactersPerSecond, null);
  checks.push('recovered-capture-completion-clears-rate');
  native.child.stdin.write('exit\n');
  const result = await limited(native.closed, '假 CLI 正常退出', 6000);
  assert.equal(result.code, 43);
  const expected = Buffer.concat(transcript);
  assert.deepEqual(result.stdout, expected, '热恢复不能改变真实 CLI stdout 或 RPC 字节');
  assert.ok(result.stderr.includes(marker), '假 CLI 原始 stderr marker 必须保留；允许 Node inspector 的诊断 banner');
  checks.push('stdout-rpc-arbitrary-bytes-preserved-before-and-after-recovery', 'fixture-stderr-marker-preserved-with-inspector-banners', 'original-cli-exit-code-43-preserved');
  const report = { passed: true, source: 'offline-legacy-fileshare-lock-and-same-session-inspector-repair-fixture', checks,
    processIdentitiesBefore: beforeIdentity, processIdentitiesAfter: afterIdentity,
    frozenUpdatedAt: frozen.updatedAt, repairedObserverPid: ids.observerPid, repairedCliPid: ids.cliPid,
    expectedCharacters: 6, expectedCharactersPerSecond: 2, windowMs: 3000,
    stdoutBytes: result.stdout.length, stdoutSha256: createHash('sha256').update(result.stdout).digest('hex'), exitCode: result.code,
    inspectorListenerCountAfterRepair: listenerStatus.listenerCount, fixtureStderrMarkerPreserved: true,
    stderrMayContainNodeInspectorDiagnosticBanners: true, productionCodexAndStateUntouched: true, outputDir };
  await writeFile(path.join(outputDir, 'recovery-report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report));
} catch (error) {
  failure = error;
  await writeFile(path.join(outputDir, 'recovery-report.json'), JSON.stringify({ passed: false, checks, error: error.message, outputDir }, null, 2), 'utf8');
} finally {
  if (lock && lock.child.exitCode === null) { lock.child.kill(); await limited(lock.closed.catch(() => {}), '验收共享锁清理', 6000); }
  if (native && native.child.exitCode === null) { native.child.kill(); await limited(native.closed.catch(() => {}), '验收子进程清理', 6000); }
  if (service) await service.close(); else await collector?.close();
  if (ownsLegacy) {
    const legacyRelative = path.relative(path.join(projectRoot, 'performance-monitor'), legacyScript);
    if (!/^generation-bridge\.recovery-fixture-[a-f0-9]{16}\.mjs$/.test(legacyRelative)) throw new Error('legacy fixture 文件边界不正确。');
    await rm(legacyScript);
  }
  const temporaryRelative = path.relative(os.tmpdir(), fixtureRoot);
  if (!temporaryRelative.startsWith('codex-generation-recovery-') || temporaryRelative.includes(path.sep)) throw new Error('恢复临时目录边界不正确。');
  await rm(fixtureRoot, { recursive: true, force: true });
  if (ownsState) {
    if (!/^[a-f0-9]{24}$/.test(homeKey) || path.resolve(stateDir) !== path.join(projectRoot, 'runtime', `performance-${homeKey}`)) throw new Error('恢复验收状态目录边界不正确。');
    await rm(stateDir, { recursive: true, force: true });
  }
}
if (failure) throw failure;
