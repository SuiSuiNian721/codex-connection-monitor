import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';
import { startMonitor } from './server.mjs';

async function fixture(t, overrides = {}) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'codex-performance-server-'));
  let polls = 0;
  let networkPolls = 0;
  let generationPolls = 0;
  const collector = {
    async poll() { polls += 1; },
    snapshot() { return { updatedAt: new Date().toISOString(), source: { scannedFiles: 1, errors: 0, truncatedFiles: 0 }, turns: [], warnings: [] }; },
  };
  const networkCollector = {
    async poll() { networkPolls += 1; },
    snapshot() { return { updatedAt: null, checking: false, stages: [], context: {}, diagnosis: {}, history: [] }; },
    async close() {},
  };
  const generationCollector = {
    async poll() { generationPolls += 1; },
    snapshot() { return { updatedAt: null, status: 'waiting-launch', reason: '等待下次正常启动', windowMs: 3000, streams: [] }; },
    async close() {},
  };
  const options = { stateDir, codexHome: path.join(stateDir, 'home'), collector, networkCollector,
    generationCollector, pollMs: 20, networkPollMs: 20, generationPollMs: 20, ...overrides };
  const service = await startMonitor(options);
  t.after(async () => { await service.close(); await rm(stateDir, { recursive: true, force: true }); });
  return { service, stateDir, options, counters: () => ({ polls, networkPolls, generationPolls }) };
}

test('已删除能力自检接口及其状态字段', async t => {
  const { service } = await fixture(t);
  const status = await (await fetch(`${service.url}api/status`)).json();
  for (const key of ['selfTest', 'capabilities', 'csrfToken']) {
    assert.equal(Object.hasOwn(status, key), false, `状态不得再暴露 ${key}`);
  }
  for (const endpoint of ['api/self-test', 'api/self-test/cancel']) {
    assert.equal((await fetch(`${service.url}${endpoint}`)).status, 404);
    assert.equal((await fetch(`${service.url}${endpoint}`, { method: 'POST', body: '{}' })).status, 405);
  }
});

test('无需 Codex CLI 即可查看统计；无页面请求时仍继续采集', async t => {
  const { service, counters } = await fixture(t);
  const page = await fetch(service.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  const firstPolls = counters().polls;
  await delay(90);
  const response = await fetch(`${service.url}api/status`);
  const body = await response.json();
  assert.equal(body.version, 1);
  assert.ok(body.telemetry);
  assert.ok(body.network);
  assert.ok(body.generation);
  assert.ok(counters().polls > firstPolls);
  assert.ok(counters().networkPolls > 1);
  assert.ok(counters().generationPolls > 1);
});

test('实时采集等待身份核对期间不阻止 token、网络和状态读取', async t => {
  let release;
  let closed = false;
  const waiting = new Promise(resolve => { release = resolve; });
  const generationCollector = {
    poll() { return waiting; },
    snapshot() { return { status: 'unavailable', reason: '核对中', windowMs: 3000, streams: [] }; },
    async close() { closed = true; release(); },
  };
  const { service, counters } = await fixture(t, { generationCollector });
  await delay(90);
  const snapshot = await (await fetch(`${service.url}api/status`)).json();
  assert.equal(snapshot.generation.status, 'unavailable');
  assert.ok(counters().polls > 2);
  assert.ok(counters().networkPolls > 2);
  await service.close(); assert.equal(closed, true);
});

test('轻量实时接口只返回采集元数据，请求不会启动额外采集', async t => {
  let generationPolls = 0;
  const generation = { updatedAt: '2026-10-06T12:00:00.000Z', status: 'collecting', windowMs: 3000,
    streams: [{ threadId: 'thread-a', turnId: 'turn-a', itemId: 'message-a', characters: 21, charactersPerSecond: 7 }] };
  const { service } = await fixture(t, {
    collector: { async poll() {}, snapshot() { throw new Error('轻量接口不应读取完整轮次'); } },
    networkCollector: { async poll() {}, snapshot() { throw new Error('轻量接口不应读取网络诊断'); }, async close() {} },
    generationCollector: { async poll() { generationPolls += 1; }, snapshot() { return generation; }, async close() {} },
    generationPollMs: 60000,
  });
  const initialPolls = generationPolls;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${service.url}api/generation`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await response.json(), { version: 1, generation });
  }
  assert.equal(generationPolls, initialPolls);
  assert.equal(initialPolls, 1);
});

test('默认实时轮询在一秒内更新，慢轮询不会并发且不阻塞只读接口', async t => {
  let polls = 0;
  let active = 0;
  let maximumActive = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const generationCollector = {
    async poll() {
      polls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try { if (polls === 1) await pending; } finally { active -= 1; }
    },
    snapshot() { return { status: 'idle', windowMs: 3000, streams: [] }; },
    async close() { release(); },
  };
  const { service, counters } = await fixture(t, { generationCollector, generationPollMs: undefined });
  await delay(320);
  assert.equal(polls, 1, '默认周期已到达，首轮未结束时不能启动第二轮');
  assert.equal((await fetch(`${service.url}api/generation`)).status, 200);
  assert.ok(counters().polls > 2);
  release();
  await delay(320);
  assert.ok(polls >= 2, '默认实时采集周期应小于一秒');
  assert.equal(maximumActive, 1);
  await service.close();
  const pollsAtClose = polls;
  await delay(280);
  assert.equal(polls, pollsAtClose, '关闭后不能继续轮询');
});

test('轻量实时接口沿用同源限制且不提供写入方法', async t => {
  const { service } = await fixture(t);
  const endpoint = `${service.url}api/generation`;
  assert.equal((await fetch(endpoint, { headers: { Origin: 'https://example.invalid' } })).status, 403);
  assert.equal((await fetch(endpoint, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    const req = http.get(endpoint, { headers: { Host: 'attacker.example' } }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
  });
  assert.equal(badHostStatus, 403);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    assert.equal((await fetch(endpoint, { method, body: '{}' })).status, 405);
  }
  assert.equal((await fetch(endpoint, { headers: { Origin: service.url.slice(0, -1) } })).status, 200);
});

test('未完成的网络探测不阻止 token 轮询及只读状态请求，关闭会取消网络采集', async t => {
  let release;
  let closed = false;
  const pending = new Promise(resolve => { release = resolve; });
  const networkCollector = {
    poll() { return pending; },
    snapshot() { return { checking: true, stages: [], context: {}, diagnosis: {}, history: [] }; },
    async close() { closed = true; release(); },
  };
  const { service, counters } = await fixture(t, { networkCollector });
  await delay(90);
  const response = await fetch(`${service.url}api/status`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).network.checking, true);
  assert.ok(counters().polls > 2);
  await service.close();
  assert.equal(closed, true);
});

test('拒绝跨站读取、DNS rebinding Host 和不支持的方法', async t => {
  const { service } = await fixture(t);
  assert.equal((await fetch(`${service.url}api/status`, { headers: { Origin: 'https://example.invalid' } })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    const req = http.get(`${service.url}api/status`, { headers: { Host: 'attacker.example' } }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await fetch(`${service.url}api/status`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(`${service.url}api/status`, { method: 'POST', body: '{}' })).status, 405);
  assert.equal((await fetch(`${service.url}missing-file`)).status, 404);
});

test('同一目录重复启动复用原服务，关闭复用句柄不停止原服务', async t => {
  const { service, options, stateDir } = await fixture(t);
  const reused = await startMonitor(options);
  assert.equal(reused.reused, true);
  assert.equal(reused.url, service.url);
  await reused.close();
  assert.equal((await fetch(`${service.url}api/health`)).status, 200);
  const manifest = JSON.parse(await readFile(path.join(stateDir, 'service.json'), 'utf8'));
  assert.equal(manifest.url, service.url);
  assert.equal(manifest.pid, process.pid);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.runtimeRevision, '2026.10.06-panel.2');
  assert.ok(!JSON.stringify(manifest).includes('csrfToken'));
});

test('运行状态清单丢失时重复启动会恢复清单并继续复用后台进程', async t => {
  const { service, options, stateDir } = await fixture(t);
  await unlink(path.join(stateDir, 'service.json'));
  const reused = await startMonitor(options);
  assert.equal(reused.reused, true);
  const manifest = JSON.parse(await readFile(path.join(stateDir, 'service.json'), 'utf8'));
  const health = await (await fetch(`${service.url}api/health`)).json();
  assert.equal(manifest.instanceId, health.instanceId);
  assert.equal(manifest.pid, health.pid);
  assert.equal(manifest.startedAt, health.startedAt);
  assert.equal(manifest.runtimeRevision, health.runtimeRevision);
});

test('健康响应和状态清单公布独立运行版本，并提供页面导入的任务模块', async t => {
  const { service, stateDir } = await fixture(t);
  const health = await (await fetch(`${service.url}api/health`)).json();
  const manifest = JSON.parse(await readFile(path.join(stateDir, 'service.json'), 'utf8'));
  assert.equal(health.version, 1, '运行版本不改变数据格式版本');
  assert.equal(health.runtimeRevision, '2026.10.06-panel.2');
  assert.equal(manifest.runtimeRevision, health.runtimeRevision);
  const script = await fetch(`${service.url}app.js`);
  assert.match(await script.text(), /import .*performance-view\.mjs/);
  const module = await fetch(`${service.url}performance-view.mjs`);
  assert.equal(module.status, 200);
  assert.match(module.headers.get('content-type'), /text\/javascript/);
  assert.match(await module.text(), /export function buildTaskView/);
});

test('同一数据目录的旧后台必须拒绝复用，不覆盖清单或终止旧服务', async t => {
  const { service, stateDir, options } = await fixture(t);
  const health = await (await fetch(`${service.url}api/health`)).json();
  await service.close();
  let legacyHealth;
  const legacy = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(legacyHealth));
  });
  await new Promise((resolve, reject) => { legacy.once('error', reject); legacy.listen(service.port, '127.0.0.1', resolve); });
  t.after(async () => { legacy.closeAllConnections(); await new Promise(resolve => legacy.close(resolve)); });
  for (const revision of [undefined, '2026.10.05-panel.1']) {
    legacyHealth = { ...health, runtimeRevision: revision };
    const manifestText = JSON.stringify({ ...legacyHealth, port: service.port, url: service.url });
    await writeFile(path.join(stateDir, 'service.json'), manifestText, 'utf8');
    await assert.rejects(startMonitor({ ...options, port: service.port }), error => {
      assert.equal(error.code, 'ERR_MONITOR_RUNTIME_MISMATCH');
      assert.match(error.message, /运行版本.*不一致/);
      return true;
    });
    assert.equal(await readFile(path.join(stateDir, 'service.json'), 'utf8'), manifestText, '失败不覆盖原实例清单');
    assert.equal((await fetch(`${service.url}api/health`)).status, 200, '旧服务仍保持运行，升级由启动器核验处理');
  }
});
