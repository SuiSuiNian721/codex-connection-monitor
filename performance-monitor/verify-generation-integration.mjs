import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GenerationCollector } from './generation.mjs';
import { startMonitor } from './server.mjs';

// 此验收只运行本文件创建的假 CLI。绝不调用真实 Codex CLI 或模型。
const projectRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const diagnostics = path.join(projectRoot, 'diagnostics');
await mkdir(diagnostics, { recursive: true });
const outputDir = await mkdtemp(path.join(diagnostics, 'generation-integration-'));
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-generation-integration-'));
const codexHome = path.join(fixtureRoot, '独立 Codex Home');
await mkdir(codexHome);
const homeKey = createHash('sha256').update(codexHome.toLowerCase()).digest('hex').slice(0, 24);
const stateDir = path.join(projectRoot, 'runtime', `performance-${homeKey}`);
const runtimeRelative = path.relative(path.join(projectRoot, 'runtime'), stateDir);
assert.equal(runtimeRelative, `performance-${homeKey}`);
try { await access(stateDir); throw new Error('随机验收状态目录已经存在，不覆盖。'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
let ownsStateDir = false;
let nativeChild;
let nativeClose;
let service;
let browser;
let collector;
let failure;
const checks = [];

function launch(executable, args, env = process.env) {
  const child = spawn(executable, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.on('data', bytes => stdout.push(bytes));
    child.stderr.on('data', bytes => stderr.push(bytes));
    child.once('close', (code, signal) => resolve({ code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
  });
  return { child, closed };
}

async function within(promise, timeoutMs, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} 超时。`)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

async function waitFor(read, condition, label, timeoutMs = 12000) {
  const until = Date.now() + timeoutMs;
  let last;
  do {
    last = await read();
    if (condition(last)) return last;
    await delay(80);
  } while (Date.now() < until);
  throw new Error(`${label} 未达到预期：${JSON.stringify(last)}`);
}

function assertPrivate(value) {
  assert.doesNotMatch(typeof value === 'string' ? value : JSON.stringify(value), /念念|PRIVATE_REASONING|PRIVATE_TOOL|"delta"|"text"/, '快照与 API 不能包含假 CLI 的文字正文或内部输出');
}

async function replaceJson(file, data) {
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify(data), { encoding: 'utf8', flag: 'wx' });
  await rename(temporary, file);
}

try {
  assert.equal(process.platform, 'win32', '此完整串接验收需要 Windows 原生 forwarder。');
  const configureScript = path.join(fixtureRoot, 'configure-generation.ps1');
  await writeFile(configureScript, `param([string]$ProjectRoot, [string]$RealCli, [string]$CodexHome, [int]$RootProcessId)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Import-Module -Name (Join-Path $ProjectRoot 'GenerationBridge.psm1') -Force
$configuration = Get-CodexGenerationConfiguration -RealCliPath $RealCli -CodexHome $CodexHome -ProjectRoot $ProjectRoot
Register-CodexGenerationBinding -Configuration $configuration -CodexProcess (Get-Process -Id $RootProcessId -ErrorAction Stop)
$configuration | ConvertTo-Json -Compress -Depth 5
`, 'utf8');
  async function configure() {
    const launched = launch('pwsh.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', configureScript,
      '-ProjectRoot', projectRoot, '-RealCli', process.execPath, '-CodexHome', codexHome, '-RootProcessId', String(process.pid)]);
    launched.child.stdin.end();
    let result;
    try { result = await within(launched.closed, 15000, 'PowerShell 配置注册'); }
    catch (error) { launched.child.kill(); await launched.closed.catch(() => {}); throw error; }
    assert.equal(result.code, 0, result.stderr.toString('utf8'));
    const config = JSON.parse(result.stdout.toString('utf8'));
    assert.equal(config.HomeKey, homeKey);
    assert.equal(path.resolve(config.StateDirectory).toLowerCase(), path.join(stateDir, 'generation').toLowerCase());
    assert.equal(path.resolve(config.ProjectRoot).toLowerCase(), projectRoot.toLowerCase());
    assert.match(config.LaunchId, /^[a-f0-9]{32}$/);
    return config;
  }
  // Get 配置只允许真实 ProjectRoot；本次 Home 的随机散列隔离全部状态。
  ownsStateDir = true;
  const config = await configure();
  const bindingFile = path.join(config.StateDirectory, 'binding.json');
  const originalBinding = JSON.parse(await readFile(bindingFile, 'utf8'));
  assert.equal(originalBinding.codexPid, process.pid);
  assert.equal(originalBinding.codexExecutable.toLowerCase(), process.execPath.toLowerCase());
  checks.push('real-powershell-configuration-and-process-binding');

  const params = { threadId: 'integration-thread', turnId: 'integration-turn' };
  const event = (method, extra) => ({ method, params: { ...params, ...extra } });
  const message = { id: 'integration-message', type: 'agentMessage', phase: 'final_answer' };
  const openingEvents = [event('item/started', { item: message }),
    ...['念念', '\uD83D', '\uDE00', 'abc'].map(delta => event('item/agentMessage/delta', { itemId: message.id, delta })),
    event('item/reasoning/textDelta', { itemId: message.id, delta: 'PRIVATE_REASONING' }),
    event('item/commandExecution/outputDelta', { itemId: message.id, delta: 'PRIVATE_TOOL' })];
  const openingBytes = Buffer.from(openingEvents.map(value => JSON.stringify(value)).join('\n') + '\n');
  const arbitraryBytes = Buffer.from([0, 255, 13, 10]);
  const completionBytes = Buffer.from(JSON.stringify(event('item/completed', { item: { ...message, text: '念念😀abc' } })) + '\n'
    + JSON.stringify(event('turn/completed', { turn: { id: params.turnId } })) + '\n');
  const errorBytes = Buffer.from([0, 255, 13, 10, 226, 130, 172]);
  const fixtureCli = path.join(fixtureRoot, '假 CLI 中文.mjs');
  await writeFile(fixtureCli, `import readline from 'node:readline';
const output = Buffer.from('${openingBytes.toString('base64')}', 'base64');
const binary = Buffer.from('${arbitraryBytes.toString('base64')}', 'base64');
const completed = Buffer.from('${completionBytes.toString('base64')}', 'base64');
const error = Buffer.from('${errorBytes.toString('base64')}', 'base64');
const input = readline.createInterface({ input: process.stdin });
input.on('line', command => {
  if (command === 'emit') {
    // 每个字节单独写，旁路必须跨 Buffer 正确解码；标准输出不得改写。
    for (const byte of output) process.stdout.write(Buffer.from([byte]));
    process.stdout.write(binary); process.stderr.write(error);
  } else if (command === 'complete') process.stdout.write(completed);
  else if (command === 'exit') { input.close(); process.stdin.destroy(); process.exitCode = 37; }
});
`, 'utf8');
  const env = { ...process.env, CODEX_GENERATION_REAL_CLI: config.RealCliPath, CODEX_GENERATION_NODE: config.NodeExecutable,
    CODEX_GENERATION_SCRIPT: config.ScriptPath, CODEX_GENERATION_STATE_DIR: config.StateDirectory,
    CODEX_GENERATION_HOME_KEY: config.HomeKey, CODEX_GENERATION_LAUNCH_ID: config.LaunchId };
  const native = launch(config.ForwarderPath, [fixtureCli, 'app-server'], env);
  nativeChild = native.child;
  nativeClose = native.closed;
  collector = new GenerationCollector({ stateDir, homeKey });
  const telemetry = { updatedAt: new Date().toISOString(), source: { scannedFiles: 0, errors: 0, truncatedFiles: 0 }, warnings: [],
    turns: [{ id: params.turnId, sessionId: params.threadId, model: 'integration-fixture-model', effort: 'fixture', provider: 'offline-fixture', status: 'running', startedAt: new Date().toISOString(), warnings: [] }] };
  service = await startMonitor({ codexHome, stateDir, port: 0, pollMs: 100, generationPollMs: 100,
    collector: { async poll() {}, snapshot() { return structuredClone(telemetry); } },
    networkCollector: { async poll() {}, snapshot() { return null; }, async close() {} }, generationCollector: collector });
  assert.equal(service.reused, false);
  async function readGeneration() { await collector.poll(); return collector.snapshot(); }
  async function readStatus() { return (await fetch(`${service.url}api/status`)).json(); }
  const initial = await waitFor(readGeneration, value => value.status === 'idle', '默认 PowerShell 身份核对');
  assert.equal(initial.streams.length, 0);
  checks.push('real-generation-reader-default-windows-process-verification');
  const runtimeModule = process.env.PLAYWRIGHT_MODULE_PATH || path.join(process.env.USERPROFILE, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright', 'index.mjs');
  const { chromium } = await import(pathToFileURL(runtimeModule).href);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  const requests = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => requests.push({ method: request.method(), url: request.url() }));
  await page.goto(service.url);
  await page.waitForFunction(() => document.querySelector('#generation-status')?.textContent === '等待文字输出');

  nativeChild.stdin.write('emit\n');
  const active = await waitFor(readGeneration, value => value.streams.some(item => item.characters === 6 && item.charactersPerSecond === 2), '中文和分片 emoji 的真实旁路计数');
  assertPrivate(active);
  const liveItem = active.streams.find(item => item.itemId === message.id);
  assert.equal(liveItem.windowCharacters, 6);
  assert.equal(liveItem.phase, 'final_answer');
  assert.ok(liveItem.observedAt);
  const streamDirectory = path.join(config.StateDirectory, config.LaunchId);
  const streamFiles = (await readdir(streamDirectory)).filter(name => /^stream-\d+-[a-f0-9]{32}\.json$/.test(name));
  assert.equal(streamFiles.length, 1);
  const streamFile = path.join(streamDirectory, streamFiles[0]);
  const rawLiveSnapshot = JSON.parse(await readFile(streamFile, 'utf8'));
  assertPrivate(rawLiveSnapshot);
  assert.equal(rawLiveSnapshot.items[0].characters, 6);
  assert.equal(rawLiveSnapshot.items[0].charactersPerSecond, 2);
  assert.equal(rawLiveSnapshot.launchId, config.LaunchId);
  assert.equal(rawLiveSnapshot.homeKey, homeKey);
  await writeFile(path.join(outputDir, 'live-snapshot.json'), JSON.stringify(rawLiveSnapshot, null, 2), 'utf8');
  const apiLive = await readStatus();
  assertPrivate(apiLive);
  assert.equal(apiLive.generation.streams[0].characters, 6);
  await writeFile(path.join(outputDir, 'api-live-status.json'), JSON.stringify(apiLive, null, 2), 'utf8');
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => document.querySelector('#metric-live-speed')?.textContent === '2');
  assert.match(await page.locator('#live-speed-description').innerText(), /integration-fixture-model/);
  await page.locator('.generation-details > summary').click();
  assert.match(await page.locator('#generation-streams').innerText(), /累计 6 字符/);
  assertPrivate(await page.locator('body').innerText());
  await page.locator('.live-speed-card').screenshot({ path: path.join(outputDir, 'live-speed-card.png') });
  await page.screenshot({ path: path.join(outputDir, 'live-dashboard.png'), fullPage: true });
  checks.push('native-node-fixture-stdout-to-real-reader-server-browser', 'unicode-codepoints-and-split-surrogate-six-characters',
    'fixed-three-second-rate-two-characters-per-second', 'raw-snapshot-and-api-no-message-body', 'browser-live-model-binding-and-speed');

  const memoryScript = path.join(fixtureRoot, 'sample-memory.ps1');
  await writeFile(memoryScript, `param([int]$NativeProcessId, [int]$ObserverProcessId, [string]$NativeExecutable, [string]$NodeExecutable)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$performanceRows = @(Get-CimInstance -ClassName Win32_PerfFormattedData_PerfProc_Process -Filter "IDProcess = $NativeProcessId OR IDProcess = $ObserverProcessId" -ErrorAction Stop)
$identities = @(@{ Id = $NativeProcessId; Role = 'native-forwarder'; Executable = $NativeExecutable }, @{ Id = $ObserverProcessId; Role = 'node-stream-observer'; Executable = $NodeExecutable })
$results = foreach ($identity in $identities) {
  $ownedProcess = Get-Process -Id $identity.Id -ErrorAction Stop
  if ($ownedProcess.Path -ine $identity.Executable) { throw '验收进程路径不可核对。' }
  $performanceRow = $performanceRows | Where-Object { $_.IDProcess -eq $identity.Id } | Select-Object -First 1
  [ordered]@{ role = $identity.Role; pid = $identity.Id; workingSetBytes = $ownedProcess.WorkingSet64; privateWorkingSetBytes = $(if ($null -ne $performanceRow) { [long]$performanceRow.WorkingSetPrivate } else { $null }); privateCommitBytes = $ownedProcess.PrivateMemorySize64 }
}
[ordered]@{ observedAt = [DateTimeOffset]::UtcNow.ToString('o'); source = 'offline-short-lived-fixed-fixture'; samples = @($results); note = '仅为固定离线短时验收的进程开销，不代表长期真实会话或整机总内存。' } | ConvertTo-Json -Compress -Depth 5
`, 'utf8');
  const memoryProcess = launch('pwsh.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', memoryScript,
    '-NativeProcessId', String(nativeChild.pid), '-ObserverProcessId', String(rawLiveSnapshot.pid), '-NativeExecutable', config.ForwarderPath, '-NodeExecutable', config.NodeExecutable]);
  memoryProcess.child.stdin.end();
  let memory;
  try {
    const memoryResult = await within(memoryProcess.closed, 10000, '验收进程内存采样');
    assert.equal(memoryResult.code, 0, memoryResult.stderr.toString('utf8'));
    memory = JSON.parse(memoryResult.stdout.toString('utf8'));
    assert.equal(memory.samples.length, 2);
    await writeFile(path.join(outputDir, 'offline-memory-observation.json'), JSON.stringify(memory, null, 2), 'utf8');
    checks.push('offline-short-lived-native-and-node-observer-memory-sample');
  } catch (error) {
    memoryProcess.child.kill();
    await memoryProcess.closed.catch(() => {});
    throw error;
  }

  nativeChild.stdin.write('complete\n');
  const completed = await waitFor(readGeneration, value => value.streams[0]?.state === 'completed', '真实完成通知');
  assert.equal(completed.streams[0].characters, 6);
  assert.equal(completed.streams[0].charactersPerSecond, null);
  assert.equal(completed.streams[0].windowCharacters, 0);
  const completedApi = await readStatus();
  assertPrivate(completedApi);
  assert.equal(completedApi.generation.streams[0].charactersPerSecond, null);
  await writeFile(path.join(outputDir, 'completed-status.json'), JSON.stringify(completedApi, null, 2), 'utf8');
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => document.querySelector('#generation-status')?.textContent === '等待文字输出');
  assert.equal(await page.locator('#metric-live-speed').innerText(), '等待文字');
  checks.push('completed-message-does-not-falsely-complete-running-turn');
  telemetry.turns[0].status = 'completed';
  telemetry.turns[0].completedAt = new Date().toISOString();
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => document.querySelector('#generation-status')?.textContent === '本轮已完成');
  assert.equal(await page.locator('#metric-live-speed').innerText(), '已完成');
  await page.locator('.live-speed-card').screenshot({ path: path.join(outputDir, 'completed-speed-card.png') });
  checks.push('real-completion-clears-reader-api-browser-rate');

  nativeChild.stdin.write('exit\n');
  const processResult = await within(nativeClose, 6000, '原生桥退出');
  assert.equal(processResult.code, 37);
  const expectedStdout = Buffer.concat([openingBytes, arbitraryBytes, completionBytes]);
  assert.deepEqual(processResult.stdout, expectedStdout);
  assert.deepEqual(processResult.stderr, errorBytes);
  checks.push('native-stdout-arbitrary-bytes-and-jsonl-byte-identical', 'native-stderr-byte-identical', 'native-fixture-exit-status-37-preserved');
  const stopped = await waitFor(readGeneration, value => value.status === 'stale', '真实 writer 停止');
  assert.equal(stopped.streams[0].charactersPerSecond, null);
  checks.push('stopped-native-writer-cannot-keep-live-rate');

  await replaceJson(bindingFile, { ...originalBinding, codexStartedAt: '2000-01-01T00:00:00.0000000Z' });
  const wrongRoot = await waitFor(readGeneration, value => value.status === 'unavailable' && value.streams.length === 0, '默认核对拒绝错误进程开始时间');
  assert.match(wrongRoot.reason, /身份不可核对/);
  checks.push('default-process-verifier-rejects-wrong-root-start-time');
  await replaceJson(bindingFile, { ...originalBinding, homeKey: randomBytes(12).toString('hex') });
  await waitFor(readGeneration, value => value.status === 'unavailable' && value.streams.length === 0, '拒绝错误 Home 绑定');
  checks.push('wrong-home-binding-cannot-expose-prior-stream');
  const newConfig = await configure();
  assert.notEqual(newConfig.LaunchId, config.LaunchId);
  // 旧启动的真实快照仍然存在；当前 reader 只能查看新 launchId 子目录。
  await access(streamFile);
  const newLaunch = await waitFor(readGeneration, value => value.status === 'idle' && value.streams.length === 0, '旧启动隔离');
  assert.equal(newLaunch.updatedAt, null);
  checks.push('new-launch-directory-excludes-existing-old-launch-snapshot');
  const wrongLaunchFile = path.join(newConfig.StateDirectory, newConfig.LaunchId, streamFiles[0]);
  await writeFile(wrongLaunchFile, JSON.stringify({ ...rawLiveSnapshot, updatedAt: new Date().toISOString(), state: 'active' }), 'utf8');
  const wrongLaunch = await waitFor(readGeneration, value => value.streams.length === 0, '拒绝新目录中 nonce 不符快照');
  assert.equal(wrongLaunch.status, 'idle');
  const apiIsolated = await readStatus();
  assert.equal(apiIsolated.generation.streams.length, 0);
  checks.push('wrong-launch-nonce-rejected-even-inside-current-directory');
  assert.deepEqual(pageErrors, []);
  assert.ok(requests.every(request => request.method === 'GET' && new URL(request.url).origin === new URL(service.url).origin));
  checks.push('browser-local-get-only-no-model-or-external-network');
  const report = { passed: true, source: 'real-native-and-powershell-reader-offline-fixed-cli-fixture', browser: 'Microsoft Edge headless',
    checks, expectedCharacters: 6, expectedCharactersPerSecond: 2, windowMs: 3000,
    stdoutBytes: expectedStdout.length, stdoutSha256: createHash('sha256').update(processResult.stdout).digest('hex'),
    stderrBytes: errorBytes.length, exitCode: processResult.code,
    currentRootWasControlledIntegrationNode: originalBinding.codexPid === process.pid,
    usedDefaultWindowsIdentityVerifier: true, productionCodexAndStateUntouched: true,
    offlineShortLivedMemory: memory, outputDir };
  await writeFile(path.join(outputDir, 'integration-report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report));
} catch (error) {
  failure = error;
  await writeFile(path.join(outputDir, 'integration-report.json'), JSON.stringify({ passed: false, checks, error: error.message, outputDir }, null, 2), 'utf8');
} finally {
  if (nativeChild && nativeChild.exitCode === null) {
    // 只终止本脚本 spawn 的原生进程；它的 job 同时清理本次假 CLI。
    nativeChild.kill();
    await within(nativeClose.catch(() => {}), 6000, '验收子进程清理');
  }
  await browser?.close();
  if (service) await service.close();
  else await collector?.close();
  const tempRelative = path.relative(os.tmpdir(), fixtureRoot);
  if (!tempRelative.startsWith('codex-generation-integration-') || tempRelative.includes(path.sep)) throw new Error('临时目录边界核对失败。');
  await rm(fixtureRoot, { recursive: true, force: true });
  if (ownsStateDir) {
    if (!/^[a-f0-9]{24}$/.test(homeKey) || path.resolve(stateDir) !== path.join(projectRoot, 'runtime', `performance-${homeKey}`)) throw new Error('验收状态目录边界核对失败。');
    await rm(stateDir, { recursive: true, force: true });
  }
}
if (failure) throw failure;
