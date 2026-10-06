import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(new URL('./generation-bridge.mjs', import.meta.url));
const native = path.join(root, 'bridge', 'CodexGenerationForwarder.exe');

function notification(method, params) { return { method, params }; }
function started(itemId = 'item-1', turnId = 'turn-1') {
  return notification('item/started', { threadId: 'thread-1', turnId, item: { id: itemId, type: 'agentMessage', phase: 'final_answer' } });
}
function delta(text, itemId = 'item-1', turnId = 'turn-1') {
  return notification('item/agentMessage/delta', { threadId: 'thread-1', turnId, itemId, delta: text });
}

test('stream accumulator counts Unicode text only, expires a fixed 3 second window and stores no text', async () => {
  const { GenerationAccumulator } = await import('./generation-bridge.mjs');
  let now = 0;
  const collector = new GenerationAccumulator({ monotonicNow: () => now, wallNow: () => Date.parse('2026-10-06T00:00:00Z') + now });
  collector.observe(started());
  collector.observe(delta('念念😀abc'));
  collector.observe(notification('item/reasoning/textDelta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'SECRET_REASONING' }));
  collector.observe(notification('item/commandExecution/outputDelta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'SECRET_TOOL' }));
  const current = collector.snapshot();
  assert.equal(current[0].characters, 6);
  assert.equal(current[0].charactersPerSecond, 2);
  assert.equal(current[0].state, 'generating');
  assert.equal(current[0].phase, 'final_answer');
  assert.doesNotMatch(JSON.stringify(current), /念念|SECRET|abc/);
  now = 3500;
  assert.equal(collector.snapshot()[0].charactersPerSecond, 0);
  assert.equal(collector.snapshot()[0].state, 'waiting');
  collector.observe(notification('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'item-1', type: 'agentMessage', text: 'SECRET_BODY' } }));
  assert.equal(collector.snapshot()[0].state, 'completed');
  assert.equal(collector.snapshot()[0].charactersPerSecond, null);
});

test('split surrogate deltas and very frequent chunks keep accurate bounded counts', async () => {
  const { GenerationAccumulator } = await import('./generation-bridge.mjs');
  const collector = new GenerationAccumulator({ monotonicNow: () => 500, wallNow: () => 1000 });
  collector.observe(started());
  collector.observe(delta('\uD83D'));
  collector.observe(delta('\uDE00'));
  for (let index = 0; index < 100_000; index++) collector.observe(delta('a'));
  assert.equal(collector.snapshot()[0].characters, 100_001);
  assert.equal(collector.snapshot()[0].windowCharacters, 100_001);
  for (let index = 0; index < 40; index++) collector.observe(started(`item-${index + 2}`));
  assert.equal(collector.snapshot().length, 20);
  assert.ok(JSON.stringify(collector).length < 30_000, 'retained observer metadata must remain bounded');
});

test('completed messages cannot evict a still streaming item at the retention boundary', async () => {
  const { GenerationAccumulator } = await import('./generation-bridge.mjs');
  const collector = new GenerationAccumulator();
  collector.observe(started('still-streaming'));
  collector.observe(delta('abc', 'still-streaming'));
  for (let index = 0; index < 25; index++) {
    const itemId = `completed-${index}`;
    collector.observe(started(itemId, 'other-turn'));
    collector.observe(notification('item/completed', {
      threadId: 'thread-1', turnId: 'other-turn', item: { id: itemId, type: 'agentMessage' },
    }));
  }
  collector.observe(delta('def', 'still-streaming'));
  const snapshot = collector.snapshot();
  assert.equal(snapshot.length, 20);
  assert.equal(snapshot.find(item => item.itemId === 'still-streaming')?.characters, 6);
});

test('a full active retention window preserves existing counts and reports dropped events and partial resumes', async () => {
  const { GenerationAccumulator } = await import('./generation-bridge.mjs');
  const collector = new GenerationAccumulator();
  for (let index = 0; index < 20; index++) {
    collector.observe(started(`active-${index}`));
    collector.observe(delta('abc', `active-${index}`));
  }
  collector.observe(started('overflow'));
  collector.observe(delta('unobserved', 'overflow'));
  collector.observe(started('active-0'));
  collector.observe(delta('def', 'active-0'));
  const full = collector.snapshot();
  assert.equal(full.length, 20);
  assert.equal(full.find(item => item.itemId === 'active-0')?.characters, 6);
  assert.equal(full.find(item => item.itemId === 'active-0')?.partial, false);
  assert.equal(full.some(item => item.itemId === 'overflow'), false);
  assert.deepEqual(collector.coverage(), { droppedEvents: 2 });
  collector.observe(notification('item/completed', {
    threadId: 'thread-1', turnId: 'turn-1', item: { id: 'active-1', type: 'agentMessage' },
  }));
  collector.observe(delta('xy', 'overflow'));
  const resumed = collector.snapshot().find(item => item.itemId === 'overflow');
  assert.equal(resumed.characters, 2);
  assert.equal(resumed.partial, true);
  collector.observe(started('overflow'));
  collector.observe(delta('z', 'overflow'));
  assert.equal(collector.snapshot().find(item => item.itemId === 'overflow').characters, 3);
  assert.equal(collector.snapshot().find(item => item.itemId === 'overflow').partial, true);
  const coverage = collector.coverage(); coverage.droppedEvents = 0;
  assert.equal(collector.coverage().droppedEvents, 2);
  assert.equal(collector.snapshot().length, 20);
});

test('turn completion, duplicate starts and cross turn ownership cannot reopen finished items', async () => {
  const { GenerationAccumulator } = await import('./generation-bridge.mjs');
  const collector = new GenerationAccumulator();
  collector.observe(started());
  collector.observe(delta('abc'));
  collector.observe(started());
  assert.equal(collector.snapshot()[0].characters, 3);
  collector.observe(notification('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1' } }));
  collector.observe(delta('ignored'));
  assert.equal(collector.snapshot()[0].characters, 3);
  collector.observe(delta('新', 'item-1', 'turn-2'));
  assert.equal(collector.snapshot().length, 2);
  assert.equal(collector.snapshot()[1].characters, 1);
  collector.observe(delta('private', '../secret-path'));
  assert.equal(collector.snapshot().length, 2);
});

test('bounded JSONL observer recovers after malformed and oversized input and decodes split UTF8', async () => {
  const { JsonlObserver, GenerationAccumulator } = await import('./generation-bridge.mjs');
  const collector = new GenerationAccumulator();
  const observer = new JsonlObserver(event => collector.observe(event), { maxLineBytes: 1024 });
  observer.write(Buffer.from('invalid JSON\n' + 'x'.repeat(2000) + '\n'));
  const bytes = Buffer.from(JSON.stringify(started()) + '\n' + JSON.stringify(delta('念😀')) + '\n');
  for (const byte of bytes) observer.write(Buffer.from([byte]));
  observer.end();
  assert.equal(collector.snapshot()[0].characters, 2);
  assert.ok(observer.retainedBytes <= 1024);
});

async function fixture(t, body) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-generation-test-'));
  const homeKey = randomBytes(12).toString('hex');
  const stateDir = path.join(root, 'runtime', `performance-${homeKey}`, 'generation');
  const launchId = randomBytes(16).toString('hex');
  const streamDir = path.join(stateDir, launchId);
  await mkdir(streamDir, { recursive: true });
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await rm(path.dirname(stateDir), { recursive: true, force: true });
  });
  const cli = path.join(directory, 'fixture CLI 中文.mjs');
  await writeFile(cli, body, 'utf8');
  return { cli, stateDir, streamDir, env: { ...process.env, CODEX_GENERATION_REAL_CLI: process.execPath, CODEX_GENERATION_NODE: process.execPath, CODEX_GENERATION_SCRIPT: script, CODEX_GENERATION_STATE_DIR: stateDir, CODEX_GENERATION_HOME_KEY: homeKey, CODEX_GENERATION_LAUNCH_ID: launchId } };
}

function execute(executable, args, env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.on('error', reject);
    child.stdout.on('data', value => out.push(value));
    child.stderr.on('data', value => err.push(value));
    child.on('close', (code, signal) => resolve({ code, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }));
    child.stdin.end(input);
  });
}

async function waitSnapshot(directory, predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const file of await readdir(directory)) {
      if (!file.endsWith('.json')) continue;
      try {
        const snapshot = JSON.parse(await readFile(path.join(directory, file), 'utf8'));
        if (predicate(snapshot)) return { file: path.join(directory, file), snapshot };
      } catch { /* 原子文件正在被替换时稍后再读。 */ }
    }
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('没有观察到预期的采集快照。');
}

test('Node forwarding preserves arbitrary bytes, stderr, environment and non app-server command exit status', async t => {
  const f = await fixture(t, "process.stderr.write(Buffer.from([0,255,13,10])); process.stdin.on('data', bytes=>process.stdout.write(bytes)); process.stdin.on('end', ()=>{process.stdout.write(process.env.GENERATION_FIXTURE_VALUE);process.exitCode=17;});");
  const input = Buffer.from([0, 255, 1, 13, 10, 226, 130, 172]);
  const result = await execute(process.execPath, [script, f.cli, '--version'], { ...f.env, GENERATION_FIXTURE_VALUE: '中文😀' }, input);
  assert.equal(result.code, 17);
  assert.deepEqual(result.stdout, Buffer.concat([input, Buffer.from('中文😀')]));
  assert.deepEqual(result.stderr, Buffer.from([0, 255, 13, 10]));
  assert.equal((await readdir(f.streamDir)).length, 0);
});

test('a prompt or option value containing app-server does not enable sampling', async t => {
  const f = await fixture(t, "process.stdout.write('ordinary CLI');");
  const result = await execute(process.execPath, [script, f.cli, 'exec', 'app-server'], f.env);
  assert.equal(result.stdout.toString(), 'ordinary CLI');
  assert.equal((await readdir(f.streamDir)).length, 0);
  const second = await execute(process.execPath, [script, f.cli, '--profile', 'app-server', '--version'], f.env);
  assert.equal(second.stdout.toString(), 'ordinary CLI');
  assert.equal((await readdir(f.streamDir)).length, 0);
});

test('app-server writes bounded private metadata and preserves its full byte stream', async t => {
  const events = [started(), delta('PRIVATE_BODY😀'), notification('item/reasoning/textDelta', { delta: 'PRIVATE_REASONING' })];
  const output = Buffer.from(events.map(value => JSON.stringify(value)).join('\n') + '\ninvalid\n');
  const f = await fixture(t, `process.stdout.write(Buffer.from('${output.toString('base64')}', 'base64')); process.stderr.write('error channel'); setTimeout(()=>{process.exitCode=23;},350);`);
  const result = await execute(process.execPath, [script, f.cli, 'app-server'], f.env);
  assert.equal(result.code, 23);
  assert.deepEqual(result.stdout, output);
  assert.equal(result.stderr.toString(), 'error channel');
  const files = (await readdir(f.streamDir)).filter(file => file.endsWith('.json'));
  assert.equal(files.length, 1);
  const content = await readFile(path.join(f.streamDir, files[0]), 'utf8');
  assert.doesNotMatch(content, /PRIVATE_BODY|PRIVATE_REASONING|fixture CLI|REAL_CLI|auth|token/);
  const snapshot = JSON.parse(content);
  assert.equal(snapshot.service, 'codex-generation-stream');
  assert.equal(snapshot.state, 'stopped');
  assert.equal(snapshot.items[0].characters, 13);
});

test('invalid metadata destination cannot interrupt CLI forwarding or create arbitrary files', async t => {
  const f = await fixture(t, "process.stdout.write('still works'); process.exitCode=7;");
  const result = await execute(process.execPath, [script, f.cli, 'app-server'], { ...f.env, CODEX_GENERATION_STATE_DIR: path.dirname(f.cli) });
  assert.equal(result.code, 7);
  assert.equal(result.stdout.toString(), 'still works');
  assert.equal((await readdir(path.dirname(f.cli))).length, 1);
});

test('large binary outputs obey backpressure while passthrough remains byte identical', async t => {
  const f = await fixture(t, "const bytes=Buffer.alloc(4*1024*1024);for(let i=0;i<bytes.length;i++)bytes[i]=i%256;process.stdout.write(bytes);process.stderr.write(bytes.subarray(0,1024));");
  const result = await execute(process.execPath, [script, f.cli, '--version'], f.env);
  const expected = Buffer.alloc(4 * 1024 * 1024);
  for (let index = 0; index < expected.length; index++) expected[index] = index % 256;
  assert.deepEqual(result.stdout, expected);
  assert.deepEqual(result.stderr, expected.subarray(0, 1024));
});

test('app-server input EOF preserves slow natural cleanup and the original CLI exit code', async t => {
  const f = await fixture(t, "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>{process.stdout.write('cleanup complete');process.exitCode=41;},1500));");
  const startedAt = Date.now();
  const result = await execute(process.execPath, [script, f.cli, 'app-server'], f.env);
  assert.ok(Date.now() - startedAt < 5000);
  assert.equal(result.code, 41);
  assert.equal(result.stdout.toString(), 'cleanup complete');
  assert.ok(Date.now() - startedAt >= 1500);
});

test('app-server tooling and non stdio listener modes remain unsampled transparent CLI commands', async t => {
  const f = await fixture(t, "setTimeout(()=>{process.stdout.write('finished utility');process.exitCode=47;},1200);");
  const invocations = [
    ['app-server', 'generate-ts'],
    ['app-server', 'generate-json-schema'],
    ['app-server', 'daemon', 'run'],
    ['app-server', 'proxy'],
    ['app-server', '--listen', 'ws://127.0.0.1:8777'],
    ['app-server', '--listen=unix://'],
    ['app-server', '--listen=off'],
  ];
  for (const args of invocations) {
    const result = await execute(process.execPath, [script, f.cli, ...args], f.env);
    assert.equal(result.code, 47, `exit code changed for ${args.join(' ')}`);
    assert.equal(result.stdout.toString(), 'finished utility');
    assert.equal((await readdir(f.streamDir)).length, 0, `sampling enabled for ${args.join(' ')}`);
  }
});

test('snapshot filesystem failures remain invisible to the CLI stream and exit code', async t => {
  const f = await fixture(t, "process.stdout.write('exact-output');setTimeout(()=>{process.exitCode=31;},350);");
  // 父目录存在但 generation 不是目录，禁用采样后仍应照常运行。
  await rm(f.stateDir, { recursive: true, force: true });
  await writeFile(f.stateDir, 'occupied', 'utf8');
  const result = await execute(process.execPath, [script, f.cli, 'app-server'], f.env);
  assert.equal(result.code, 31);
  assert.equal(result.stdout.toString(), 'exact-output');
  assert.equal(result.stderr.length, 0);
  assert.equal(await readFile(f.stateDir, 'utf8'), 'occupied');
});

test('snapshot heartbeats stay fresh, serialized and no faster than four writes per second', async t => {
  const f = await fixture(t, "const event=JSON.stringify({method:'item/agentMessage/delta',params:{threadId:'thread-1',turnId:'turn-1',itemId:'item-1',delta:'a'}})+'\\n';const timer=setInterval(()=>process.stdout.write(event),1);setTimeout(()=>clearInterval(timer),1700);");
  const child = spawn(process.execPath, [script, f.cli, 'app-server'], { env: f.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { try { child.kill(); } catch {} });
  child.stdout.resume();
  child.stderr.resume();
  const versions = new Map();
  const until = Date.now() + 1400;
  while (Date.now() < until) {
    const files = (await readdir(f.streamDir)).filter(file => file.endsWith('.json'));
    if (files[0]) {
      const record = JSON.parse(await readFile(path.join(f.streamDir, files[0]), 'utf8'));
      versions.set(record.updatedAt, record);
      assert.ok(Date.now() - Date.parse(record.updatedAt) < 1100);
      assert.equal(record.items.length <= 20, true);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  child.stdin.end();
  await new Promise(resolve => child.once('close', resolve));
  const times = [...versions.keys()].map(value => Date.parse(value)).sort((a, b) => a - b);
  assert.ok(times.length >= 3);
  for (let index = 1; index < times.length; index++) assert.ok(times[index] - times[index - 1] >= 245);
  assert.ok(times.length <= 6);
});

test('native launch preserves exact Windows arguments including empty, Chinese, quotes and trailing slashes', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, "process.stdout.write(JSON.stringify(process.argv.slice(2))); process.stderr.write('native stderr'); process.exitCode=29;");
  const args = ['--version', '', '中文 空格😀', 'say "hello"', 'C:\\folder with space\\', '\\\\"quoted\\\\', '$(nothing)`literal'];
  const result = await execute(native, [f.cli, ...args], f.env);
  assert.equal(result.code, 29);
  assert.deepEqual(JSON.parse(result.stdout.toString()), args);
  assert.equal(result.stderr.toString(), 'native stderr');
});

test('native inherited standard handles preserve arbitrary stdin, stdout and stderr bytes', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, "process.stdin.on('data',data=>{process.stdout.write(data);process.stderr.write(data);});process.stdin.on('end',()=>{process.exitCode=42;});");
  const bytes = Buffer.from([0, 255, 13, 10, 226, 130, 172, 240, 159, 152, 128]);
  const result = await execute(native, [f.cli, '--version'], f.env, bytes);
  assert.equal(result.code, 42);
  assert.deepEqual(result.stdout, bytes);
  assert.deepEqual(result.stderr, bytes);
});

test('a normal native CLI exit preserves a deliberately detached background child', { skip: process.platform !== 'win32' }, async t => {
  const marker = `generation-dummy-${randomBytes(16).toString('hex')}`;
  const f = await fixture(t, `import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e','setTimeout(()=>{},5000);','${marker}'],{detached:true,windowsHide:true,stdio:'ignore'});child.unref();process.stdout.write(String(child.pid));process.exitCode=49;`);
  const result = await execute(native, [f.cli, 'exec', 'offline fixture'], f.env);
  const dummyPid = Number(result.stdout.toString());
  assert.ok(dummyPid > 0);
  t.after(async () => {
    // 只清理本测试返回且 command line 带唯一 marker 的 dummy。
    const command = `$generationDummy = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${dummyPid}'; if ($generationDummy -and $generationDummy.Name -eq 'node.exe' -and $generationDummy.CommandLine -match '${marker}') { Stop-Process -Id ${dummyPid} }`;
    await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], process.env);
  });
  assert.equal(result.code, 49);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.doesNotThrow(() => process.kill(dummyPid, 0));
});

test('native termination closes the process job and prevents an orphaned real CLI', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, "process.stdout.write(String(process.pid)+'\\n'); setInterval(()=>{},1000);");
  const child = spawn(native, [f.cli, 'app-server'], { env: f.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { try { child.kill(); } catch {} });
  const cliPid = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', data => resolve(Number(data.toString().trim())));
  });
  assert.ok(cliPid > 0);
  child.kill();
  await new Promise(resolve => child.once('close', resolve));
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.throws(() => process.kill(cliPid, 0));
});

test('termination of the bridge Node also cleans its still running real CLI', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, "process.stdout.write(JSON.stringify({cliPid:process.pid,bridgePid:process.ppid})+'\\n');setInterval(()=>{},1000);");
  const child = spawn(native, [f.cli, 'app-server'], { env: f.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { try { child.kill(); } catch {} });
  const identities = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', data => resolve(JSON.parse(data.toString().trim())));
  });
  assert.ok(identities.cliPid > 0 && identities.bridgePid > 0);
  t.after(async () => {
    const expectedPath = f.cli.replaceAll("'", "''");
    const command = `$generationFixture = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${identities.cliPid}'; if ($generationFixture -and $generationFixture.Name -eq 'node.exe' -and $generationFixture.CommandLine.Contains('${expectedPath}')) { Stop-Process -Id ${identities.cliPid} }`;
    await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], process.env);
  });
  process.kill(identities.bridgePid, 'SIGKILL');
  await new Promise(resolve => child.once('close', resolve));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.throws(() => process.kill(identities.cliPid, 0));
});

test('temporary Windows deny-delete sharing errors recover without losing live capture or CLI bytes', { skip: process.platform !== 'win32' }, async t => {
  const line = JSON.stringify(delta('PRIVATE_RECOVERY_TEXT😀')) + '\n';
  const f = await fixture(t, `let count=0;const line=${JSON.stringify(line)};const timer=setInterval(()=>{process.stdout.write(line);if(++count===100){clearInterval(timer);process.stderr.write('original CLI error marker');process.exitCode=53;}},50);`);
  const child = spawn(process.execPath, [script, f.cli, 'app-server'], { env: f.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const output = [];
  const errors = [];
  child.stdout.on('data', bytes => output.push(bytes));
  child.stderr.on('data', bytes => errors.push(bytes));
  const closed = new Promise(resolve => child.once('close', code => resolve(code)));
  t.after(() => { try { child.kill(); } catch {} });
  const initial = await waitSnapshot(f.streamDir, value => value.state === 'active');
  const lock = spawn('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', "$generationLock = [IO.File]::Open($env:GENERATION_LOCK_FILE, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read); [Console]::Out.WriteLine('locked'); [void][Console]::In.ReadLine(); $generationLock.Dispose()"], { env: { ...process.env, GENERATION_LOCK_FILE: initial.file }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { try { lock.stdin.end('\n'); } catch {} try { lock.kill(); } catch {} });
  await new Promise((resolve, reject) => {
    lock.once('error', reject);
    lock.stdout.once('data', bytes => bytes.toString().includes('locked') ? resolve() : reject(new Error('锁定fixture启动失败')));
  });
  await new Promise(resolve => setTimeout(resolve, 1200));
  lock.stdin.end('\n');
  await new Promise(resolve => lock.once('close', resolve));
  const recovered = await waitSnapshot(f.streamDir, value => value.captureHealth?.recoveries >= 1 && value.captureHealth?.state === 'ok');
  assert.equal(recovered.snapshot.captureHealth.lastErrorCode, 'EPERM');
  assert.equal(recovered.snapshot.captureHealth.lastErrorStage, 'rename');
  assert.ok(recovered.snapshot.captureHealth.lastRecoveredAt);
  assert.ok(recovered.snapshot.items[0].characters > 20);
  assert.equal(await closed, 53);
  assert.deepEqual(Buffer.concat(output), Buffer.from(line.repeat(100)));
  assert.equal(Buffer.concat(errors).toString(), 'original CLI error marker');
  const final = await waitSnapshot(f.streamDir, value => value.state === 'stopped');
  assert.equal(final.snapshot.items[0].characters, 22 * 100);
  assert.doesNotMatch(JSON.stringify(final.snapshot), /PRIVATE_RECOVERY_TEXT|LOCK_FILE|fixture CLI|generation-bridge\.mjs|F:\\|C:\\/);
});

test('runtime recovery attaches idempotently to an existing stdio CLI and preserves native transport', { skip: process.platform !== 'win32' }, async t => {
  const before = JSON.stringify(delta('BEFORE_CAPTURE')) + '\n';
  const after = JSON.stringify(delta('恢复😀')) + '\n';
  const f = await fixture(t, `process.stdout.write(${JSON.stringify(before)});setTimeout(()=>process.stdout.write(${JSON.stringify(after)}),700);setTimeout(()=>{process.stderr.write('existing CLI stderr marker');process.exitCode=59;},1200);`);
  const harness = path.join(path.dirname(f.cli), 'existing-native-harness.mjs');
  const results = path.join(path.dirname(f.cli), 'recovery-results.json');
  await writeFile(harness, `
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
const child = spawn(process.env.CODEX_GENERATION_REAL_CLI, process.argv.slice(2), { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout, { end: false });
child.stderr.pipe(process.stderr, { end: false });
const closed = new Promise(resolve=>child.once('close',resolve));
await new Promise(resolve=>setTimeout(resolve,150));
const first = await import(process.env.GENERATION_BRIDGE_IMPORT + '?recover-fixture=first');
const countsBefore = child.stdout.listenerCount('data');
const wrongLaunch = await first.recoverGenerationCapture({ cliPid:child.pid,launchId:'0'.repeat(32) });
const wrongPid = await first.recoverGenerationCapture({ cliPid:child.pid+100000,launchId:process.env.CODEX_GENERATION_LAUNCH_ID });
const attached = await first.recoverGenerationCapture({ cliPid:child.pid,launchId:process.env.CODEX_GENERATION_LAUNCH_ID });
const countsAfter = child.stdout.listenerCount('data');
const second = await import(process.env.GENERATION_BRIDGE_IMPORT + '?recover-fixture=second');
const repeated = await second.recoverGenerationCapture({ cliPid:child.pid,launchId:process.env.CODEX_GENERATION_LAUNCH_ID });
const countsRepeated = child.stdout.listenerCount('data');
const code = await closed;
await new Promise(resolve=>setTimeout(resolve,500));
await writeFile(process.env.GENERATION_RECOVERY_RESULT,JSON.stringify({wrongLaunch,wrongPid,attached,repeated,countsBefore,countsAfter,countsRepeated,countsClosed:child.stdout.listenerCount('data'),code}),'utf8');
process.stdin.pause();
process.exitCode=code;
`, 'utf8');
  const result = await execute(native, [f.cli, 'app-server'], { ...f.env, CODEX_GENERATION_SCRIPT: harness, GENERATION_BRIDGE_IMPORT: pathToFileURL(script).href, GENERATION_RECOVERY_RESULT: results });
  assert.equal(result.code, 59);
  assert.deepEqual(result.stdout, Buffer.from(before + after));
  assert.equal(result.stderr.toString(), 'existing CLI stderr marker');
  const records = JSON.parse(await readFile(results, 'utf8'));
  assert.equal(records.wrongLaunch.attached, false);
  assert.equal(records.wrongPid.attached, false);
  assert.equal(records.attached.attached, true);
  assert.equal(records.attached.reused, false);
  assert.equal(records.repeated.attached, true);
  assert.equal(records.repeated.reused, true);
  assert.equal(records.attached.instanceId, records.repeated.instanceId);
  assert.equal(records.countsAfter, records.countsBefore + 1);
  assert.equal(records.countsRepeated, records.countsAfter);
  assert.equal(records.countsClosed, 0);
  const final = await waitSnapshot(f.streamDir, value => value.state === 'stopped');
  assert.equal(final.snapshot.items[0].characters, 3, '恢复后的累计不能补造恢复前的文字');
  assert.ok(final.snapshot.captureHealth.reattachedAt);
  assert.equal((await readdir(f.streamDir)).filter(value=>value.endsWith('.json')).length, 1);
  assert.doesNotMatch(JSON.stringify(final.snapshot), /BEFORE_CAPTURE|恢复|existing-native-harness|stdio.*path/);
});
