import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const projectRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const processScript = fileURLToPath(new URL('./generation-recovery-process.ps1', import.meta.url));
const moduleFile = fileURLToPath(new URL('./generation-bridge.mjs', import.meta.url));

async function safePath(file, directory = false) {
  const info = await lstat(file);
  assert.ok(!info.isSymbolicLink() && (directory ? info.isDirectory() : info.isFile()), '恢复路径无法核对。');
  let parent = path.dirname(file);
  while (true) {
    const current = await lstat(parent);
    assert.ok(current.isDirectory() && !current.isSymbolicLink(), '恢复路径无法核对。');
    const next = path.dirname(parent); if (next === parent) break; parent = next;
  }
}

async function identity(binding, bridgePid, cliPid, bridgeScript) {
  const child = spawn('pwsh.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', processScript,
    '-RootProcessId', String(binding.codexPid), '-RootStartedAt', binding.codexStartedAt, '-RootExecutable', binding.codexExecutable,
    '-BridgeProcessId', String(bridgePid), '-CliProcessId', String(cliPid), '-NodeExecutable', process.execPath,
    '-NativeExecutable', path.join(projectRoot, 'bridge', 'CodexGenerationForwarder.exe'), '-BridgeScript', bridgeScript],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let invalid = false;
  const timer = setTimeout(() => { invalid = true; child.kill(); }, 10000);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', value => { output += value; if (output.length > 4096) { invalid = true; child.kill(); } });
  child.stderr.resume();
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => clearTimeout(timer));
  assert.ok(!invalid && code === 0, '恢复进程身份暂不可核对。');
  const value = JSON.parse(output); assert.equal(value.verified, true, '恢复进程链已改变，未接入。');
  return value;
}

async function inspectorTargets() {
  try {
    const response = await fetch('http://127.0.0.1:9229/json/list', { signal: AbortSignal.timeout(500) });
    const value = await response.text(); if (!response.ok || value.length > 16384) return [];
    const targets = JSON.parse(value); return Array.isArray(targets) ? targets : [];
  } catch { return []; }
}

async function attachSocket(url) {
  const target = new URL(url);
  assert.ok(target.protocol === 'ws:' && target.hostname === '127.0.0.1' && target.port === '9229', '恢复只连接临时本机端点。');
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('恢复端点连接超时。')); }, 2000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('恢复端点连接失败。')); }, { once: true });
  });
  let sequence = 0;
  const evaluate = expression => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { socket.removeEventListener('message', receive); reject(new Error('恢复操作超时。')); }, 5000);
    const receive = event => {
      let value; try { value = JSON.parse(event.data); } catch { return; }
      if (value.id !== id) return;
      clearTimeout(timer); socket.removeEventListener('message', receive);
      if (value.error || value.result?.exceptionDetails) reject(new Error('恢复操作未通过本机核对。'));
      else resolve(value.result?.result?.value);
    };
    socket.addEventListener('message', receive);
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  return { socket, evaluate };
}

export async function recoverGeneration({ stateDir, bridgePid, cliPid, bridgeScript = moduleFile, afterActivation }) {
  assert.equal(process.platform, 'win32', '此恢复程序仅用于 Windows 采集旁路。');
  assert.ok(Number.isInteger(bridgePid) && bridgePid > 0 && Number.isInteger(cliPid) && cliPid > 0 && bridgePid !== cliPid, '恢复 PID 无效。');
  stateDir = path.resolve(stateDir);
  const key = /^performance-([a-f0-9]{24})$/.exec(path.basename(stateDir))?.[1];
  assert.ok(key && path.dirname(stateDir).toLowerCase() === path.join(projectRoot, 'runtime').toLowerCase(), '恢复目录不属于监测器。');
  bridgeScript = path.resolve(bridgeScript);
  assert.ok(path.dirname(bridgeScript).toLowerCase() === path.dirname(moduleFile).toLowerCase() &&
    /^generation-bridge(?:\.recovery-fixture-[a-f0-9]{16})?\.mjs$/.test(path.basename(bridgeScript)), '恢复脚本身份无效。');
  await safePath(bridgeScript); await safePath(moduleFile); await safePath(processScript); await safePath(stateDir, true);
  const bindingFile = path.join(stateDir, 'generation', 'binding.json');
  await safePath(bindingFile);
  assert.ok((await lstat(bindingFile)).size <= 16384, '启动绑定超出边界。');
  const binding = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(bindingFile)));
  assert.ok(binding.version === 1 && binding.homeKey === key && /^[a-f0-9]{32}$/.test(binding.launchId) &&
    Number.isInteger(binding.codexPid) && path.isAbsolute(binding.codexExecutable) && Number.isFinite(Date.parse(binding.codexStartedAt)), '启动绑定无效。');
  const before = await identity(binding, bridgePid, cliPid, bridgeScript);
  assert.deepEqual(before.listeners, [], '采集旁路已有监听端点，未改变现有调试会话。');
  assert.deepEqual(before.recoveryPortOwners, [], '临时调试端口已占用，未改变其他进程。');
  assert.equal((await inspectorTargets()).length, 0, '临时调试端口已占用，未改变其他进程。');
  process._debugProcess(bridgePid);
  let connection;
  let owned = false;
  try {
    const activated = await identity(binding, bridgePid, cliPid, bridgeScript);
    assert.equal(activated.bridgeStartedAt, before.bridgeStartedAt, '采集进程发生变化。');
    owned = activated.recoveryPortOwners.includes(bridgePid);
    assert.ok(owned, '恢复端点不属于已核对的采集旁路。');
    await afterActivation?.();
    let target;
    for (let attempt = 0; attempt < 40; attempt++) {
      target = (await inspectorTargets()).find(value => value.type === 'node' && value.webSocketDebuggerUrl);
      if (target) break; await delay(50);
    }
    assert.ok(target, '未能打开采集旁路的临时本机恢复端点。');
    connection = await attachSocket(target.webSocketDebuggerUrl);
    assert.equal(await connection.evaluate('process.pid'), bridgePid, '临时端点不属于本次采集旁路。');
    const moduleUrl = pathToFileURL(moduleFile); moduleUrl.searchParams.set('recovery', String(Date.now()));
    // Inspector 求值上下文没有默认 ESM loader；显式使用本机主上下文 loader。
    const loaderExpression = `process.getBuiltinModule('node:vm').runInThisContext(${JSON.stringify(`import(${JSON.stringify(moduleUrl.href)}).then(m => m.recoverGenerationCapture(${JSON.stringify({ cliPid, launchId: binding.launchId })}))`)}, {importModuleDynamically: process.getBuiltinModule('node:vm').constants.USE_MAIN_CONTEXT_DEFAULT_LOADER})`;
    const result = await connection.evaluate(loaderExpression);
    assert.equal(result?.attached, true, result?.reason || '未恢复采集。');
    assert.equal(result?.status, 'ok', '采集旁路尚未恢复可用写入，未宣称恢复完成。');
    const after = await identity(binding, bridgePid, cliPid, bridgeScript);
    assert.equal(after.bridgeStartedAt, before.bridgeStartedAt, '采集进程发生变化。');
    assert.equal(after.cliStartedAt, before.cliStartedAt, '真实 CLI 发生变化。');
    return { ...result, processIdentitiesUnchanged: true, noCliSpawnOrRpcWrite: true };
  } finally {
    if (!owned) {
      try {
        const current = await identity(binding, bridgePid, cliPid, bridgeScript);
        owned = current.bridgeStartedAt === before.bridgeStartedAt && current.recoveryPortOwners.includes(bridgePid);
      } catch { /* 进程可能已经退出，随后仍只核对指定 PID 的本机端点。 */ }
    }
    // 即使连接或求值失败，也重连已核对属于本次的端点完成关闭。
    if (owned) {
      let scheduled = false;
      for (let attempt = 0; attempt < 3 && !scheduled; attempt++) {
        try {
          if (!connection || connection.socket.readyState !== WebSocket.OPEN) {
            const target = (await inspectorTargets()).find(value => value.type === 'node' && value.webSocketDebuggerUrl);
            assert.ok(target); connection = await attachSocket(target.webSocketDebuggerUrl);
          }
          assert.equal(await connection.evaluate('process.pid'), bridgePid);
          await connection.evaluate("(() => { const inspector = process.getBuiltinModule('node:inspector'); setTimeout(() => inspector.close(), 200); return true; })()");
          scheduled = true;
        } catch { connection?.socket.close(); connection = null; await delay(100); }
      }
      assert.ok(scheduled, '临时恢复端点未能关闭，恢复未完成。');
    }
    connection?.socket.close();
    if (owned) {
      await delay(350);
      assert.equal((await inspectorTargets()).length, 0, '临时恢复端点尚未关闭。');
    }
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { 'state-dir': { type: 'string' }, 'bridge-pid': { type: 'string' },
    'cli-pid': { type: 'string' }, 'bridge-script': { type: 'string' } } });
  const result = await recoverGeneration({ stateDir: values['state-dir'], bridgePid: Number(values['bridge-pid']),
    cliPid: Number(values['cli-pid']), bridgeScript: values['bridge-script'] });
  process.stdout.write(JSON.stringify(result) + '\n');
}
