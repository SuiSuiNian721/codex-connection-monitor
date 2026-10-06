import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
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
});
