import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkCollector } from './network.mjs';

const system = () => ({
  observedAt: new Date(100000).toISOString(), platform: 'win32',
  local: { activeAdapterCount: 2, hasDefaultRoute: true, dnsConfigured: true },
  systemProxyUri: 'http://127.0.0.1:7890', clientProxyUri: 'http://127.0.0.1:60629',
  upstreamProxyUri: 'http://127.0.0.1:7890', proxySource: 'relay',
  codex: { running: true, monitored: true, pid: 42, startedAt: new Date(90000).toISOString() },
  relay: { known: true, ready: true, errorKind: null }, message: null,
});

function fixture(overrides = {}) {
  let now = 100000;
  let inventory = system();
  let httpResult = {};
  let tcpResult = {};
  const calls = [];
  const collector = new NetworkCollector({
    clock: () => now,
    readSystem: async () => structuredClone(inventory),
    probeTcp: async options => {
      calls.push({ type: 'tcp', ...options });
      return { transportOk: true, kind: 'tcp-connected', elapsedMs: 2, ...tcpResult };
    },
    probeHttp: async options => {
      calls.push({ type: 'http', ...options });
      return { transportOk: true, kind: 'http-response', httpStatus: 200, elapsedMs: 12,
        failedStep: null, errorCode: null, ...httpResult[options.targetUrl.includes('chatgpt') ? 'openai' : options.proxyUri ? 'control' : 'direct'] };
    },
    ...overrides,
  });
  return { collector, calls, advance: ms => { now += ms; },
    inventory: value => { inventory = value; }, http: value => { httpResult = value; }, tcp: value => { tcpResult = value; } };
}

async function collect(f) { await f.collector.poll(); await f.collector.poll(); return f.collector.snapshot(); }
const stage = (snapshot, id) => snapshot.stages.find(value => value.id === id);

test('绑定 relay 的四个环节正常，探测使用实际 Codex 入口', async t => {
  const f = fixture(); t.after(() => f.collector.close());
  const snapshot = await collect(f);
  assert.deepEqual(snapshot.stages.map(value => value.status), ['ok', 'ok', 'ok', 'ok']);
  assert.equal(snapshot.context.codexEntry, 'http://127.0.0.1:60629');
  assert.equal(snapshot.context.relayUpstream, 'http://127.0.0.1:7890');
  assert.equal(snapshot.diagnosis.confidence, 'confirmed');
  assert.ok(f.calls.filter(value => value.type === 'http' && value.proxyUri).every(value => value.proxyUri === snapshot.context.codexEntry));
  assert.equal(f.calls.filter(value => value.type === 'tcp').length, 2);
});

test('目标 HTTP 403/429/503 是有响应，不会显示网络断开', async t => {
  for (const [code, kind] of [[403, 'http-restricted'], [429, 'rate-limited'], [503, 'server-error']]) {
    const f = fixture(); t.after(() => f.collector.close());
    f.http({ openai: { httpStatus: code, kind } });
    const snapshot = await collect(f);
    assert.equal(stage(snapshot, 'openai').status, 'warning');
    assert.equal(stage(snapshot, 'openai').httpStatus, code);
    assert.equal(snapshot.diagnosis.failedStage, 'openai');
    assert.match(stage(snapshot, 'openai').summary, new RegExp(String(code)));
    assert.doesNotMatch(snapshot.diagnosis.summary, /OpenAI.*断网|OpenAI 服务故障/);
  }
});

test('CONNECT 拒绝归于代理隧道；双目标失败只提示疑似出口路径', async t => {
  const f = fixture(); t.after(() => f.collector.close());
  const failure = { transportOk: false, kind: 'proxy-restricted', httpStatus: 403, failedStep: 'proxy-connect' };
  f.http({ control: failure, openai: failure });
  const snapshot = await collect(f);
  assert.equal(stage(snapshot, 'proxy').status, 'ok');
  assert.equal(snapshot.diagnosis.failedStage, 'vpn');
  assert.equal(snapshot.diagnosis.failedStep, 'proxy-connect');
  assert.equal(snapshot.diagnosis.confidence, 'suspected');
  assert.match(snapshot.diagnosis.evidence.join(' '), /403/);
});

test('对照目标返回 403/429/503 时不归责 VPN，OpenAI 异常仍单独显示', async t => {
  for (const [code, kind] of [[403, 'http-restricted'], [429, 'rate-limited'], [503, 'server-error']]) {
    const f = fixture(); t.after(() => f.collector.close());
    f.http({ control: { httpStatus: code, kind } });
    const snapshot = await collect(f);
    assert.equal(snapshot.diagnosis.confidence, 'confirmed');
    assert.match(snapshot.diagnosis.summary, new RegExp(`HTTP ${code}`));
    assert.doesNotMatch(snapshot.diagnosis.summary, /VPN.*异常/);
    f.http({ control: { httpStatus: code, kind }, openai: { transportOk: false, kind: 'timeout', failedStep: 'tls' } });
    f.advance(30001); const next = await collect(f);
    assert.equal(next.diagnosis.failedStage, 'openai');
    assert.equal(next.diagnosis.confidence, 'suspected');
  }
});

test('本地代理端口拒绝能直接定位；不归责 OpenAI', async t => {
  const f = fixture(); t.after(() => f.collector.close());
  f.tcp({ transportOk: false, kind: 'tcp-failure', failedStep: 'tcp', errorCode: 'ECONNREFUSED' });
  f.http({ control: { transportOk: false, kind: 'tcp-failure', failedStep: 'tcp' }, openai: { transportOk: false, kind: 'tcp-failure', failedStep: 'tcp' } });
  const snapshot = await collect(f);
  assert.equal(stage(snapshot, 'proxy').status, 'error');
  assert.equal(snapshot.diagnosis.failedStage, 'proxy');
  assert.equal(snapshot.diagnosis.confidence, 'confirmed');
});

test('对照成功、OpenAI 超时只能确认目标路径异常，不能证明服务故障', async t => {
  const f = fixture(); t.after(() => f.collector.close());
  f.http({ openai: { transportOk: false, kind: 'timeout', failedStep: 'tls', errorCode: 'ETIMEDOUT' } });
  const snapshot = await collect(f);
  assert.equal(snapshot.diagnosis.failedStage, 'openai');
  assert.equal(snapshot.diagnosis.confidence, 'suspected');
  assert.match(snapshot.diagnosis.summary, /路径/);
  assert.match(snapshot.diagnosis.evidence.join(' '), /不同.*规则|规则.*不同/);
});

test('数据过期不保留正常灯；无代理/元数据缺失不伪造 VPN 正常', async t => {
  const f = fixture(); t.after(() => f.collector.close());
  await collect(f); f.advance(70000);
  const stale = f.collector.snapshot();
  assert.ok(stale.stages.every(value => value.status === 'stale'));
  assert.equal(stale.diagnosis.confidence, 'insufficient');
  assert.match(stale.context.label, /上次核对/);
  const empty = fixture({ readSystem: async () => ({ platform: 'other', local: {}, codex: {}, relay: {} }) });
  t.after(() => empty.collector.close());
  const unknown = await collect(empty);
  assert.equal(stage(unknown, 'vpn').status, 'unknown');
  assert.equal(stage(unknown, 'proxy').status, 'unknown');
  assert.match(unknown.context.attribution, /未绑定/);
});

test('新鲜库存故障不能被旧直连成功盖过，远端 pending 时即时反馈', async () => {
  let pending = false;
  const f = fixture({ probeHttp: options => {
    if (!pending) return Promise.resolve({ transportOk: true, kind: 'http-response', httpStatus: 200 });
    return new Promise(resolve => options.signal.addEventListener('abort', () => resolve({ kind: 'aborted' }), { once: true }));
  } });
  await collect(f);
  pending = true;
  const inventory = system(); inventory.local.activeAdapterCount = 0; inventory.local.hasDefaultRoute = false;
  f.inventory(inventory); f.advance(30001);
  const inFlight = f.collector.poll();
  await new Promise(resolve => setImmediate(resolve));
  const snapshot = f.collector.snapshot();
  assert.equal(stage(snapshot, 'local').status, 'error');
  assert.equal(snapshot.diagnosis.failedStage, 'local');
  assert.equal(snapshot.diagnosis.confidence, 'confirmed');
  await f.collector.close(); await inFlight;
});

test('VPN 拆分路由不能因缺少默认路由误判本地已断网', async t => {
  const f = fixture(); t.after(() => f.collector.close());
  const inventory = system(); inventory.local.hasDefaultRoute = false; f.inventory(inventory);
  f.http({ direct: { transportOk: false, kind: 'timeout', failedStep: 'http' } });
  const snapshot = await collect(f);
  assert.equal(stage(snapshot, 'local').status, 'warning');
  assert.equal(snapshot.diagnosis.confidence, 'insufficient');
  assert.match(stage(snapshot, 'local').evidence.join(' '), /拆分路由/);
});

test('本地 relay 明确未就绪归于本地转发，不能归责 VPN 出口', async t => {
  const f = fixture(); t.after(() => f.collector.close());
  const inventory = system(); inventory.relay.ready = false; inventory.relay.errorKind = 'SystemProxyDisabled';
  inventory.upstreamProxyUri = null; f.inventory(inventory);
  const failure = { transportOk: false, kind: 'proxy-server-error', httpStatus: 502, failedStep: 'proxy-connect' };
  f.http({ control: failure, openai: failure });
  const snapshot = await collect(f);
  assert.equal(snapshot.diagnosis.failedStage, 'proxy');
  assert.equal(snapshot.diagnosis.confidence, 'confirmed');
  assert.match(stage(snapshot, 'proxy').evidence.join(' '), /系统代理已关闭/);
});

test('路由变化立即淘汰旧远端结果，系统字段不泄漏凭证或任意额外信息', async t => {
  const f = fixture(); t.after(() => f.collector.close());
  await collect(f);
  const next = system(); next.clientProxyUri = 'http://127.0.0.1:60630'; next.secret = 'DO-NOT-EXPOSE';
  next.systemProxyUri = 'http://user:password@127.0.0.1:7890';
  f.inventory(next); f.advance(30001);
  await f.collector.poll();
  const snapshot = f.collector.snapshot();
  assert.equal(snapshot.context.codexEntry, next.clientProxyUri);
  assert.equal(stage(snapshot, 'openai').status, 'unknown');
  assert.equal(stage(snapshot, 'proxy').status, 'unknown');
  assert.ok(!JSON.stringify(snapshot).includes('DO-NOT-EXPOSE'));
  assert.ok(!JSON.stringify(snapshot).includes('password'));
  await f.collector.poll();
  assert.equal(stage(f.collector.snapshot(), 'openai').status, 'ok');
});

test('远端请求未完成时本地检查照常执行，无同类重叠，关闭取消未完成请求', async () => {
  const pending = [];
  const f = fixture({ probeHttp: options => new Promise(resolve => {
    pending.push(options);
    options.signal.addEventListener('abort', () => resolve({ transportOk: false, kind: 'aborted' }), { once: true });
  }) });
  const first = f.collector.poll();
  await new Promise(resolve => setImmediate(resolve));
  f.collector.poll(); await new Promise(resolve => setImmediate(resolve));
  f.advance(3001); f.collector.poll(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 3);
  assert.equal(f.calls.filter(value => value.type === 'tcp').length, 4);
  await f.collector.close(); await first;
  assert.ok(pending.every(value => value.signal.aborted));
});

test('变更记录不因时间/延迟重复增长，恢复事件及数量受限', async t => {
  const f = fixture(); t.after(() => f.collector.close());
  await collect(f); const count = f.collector.snapshot().history.length;
  f.advance(30001); await collect(f);
  assert.equal(f.collector.snapshot().history.length, count);
  for (let i = 0; i < 30; i += 1) {
    f.http({ openai: i % 2 === 0 ? { httpStatus: 403, kind: 'http-restricted' } : {} });
    f.advance(30001); await collect(f);
  }
  const snapshot = f.collector.snapshot();
  assert.equal(snapshot.history.length, 20);
  assert.equal(stage(snapshot, 'openai').status, 'ok');
  assert.ok(snapshot.history.some(value => value.status === 'ok'));
  assert.ok(snapshot.history.every((value, i) => i === 0 || Date.parse(value.at) >= Date.parse(snapshot.history[i - 1].at)));
});

test('同一故障持续时间不会因其他目标响应变化而重置', async t => {
  const f = fixture(); t.after(() => f.collector.close());
  const failure = { transportOk: false, kind: 'timeout', failedStep: 'tls' };
  f.http({ openai: failure });
  const initial = await collect(f);
  f.advance(30001);
  f.http({ openai: failure, control: { httpStatus: 403, kind: 'http-restricted' } });
  const next = await collect(f);
  assert.equal(next.diagnosis.failedStage, 'openai');
  assert.equal(next.diagnosis.since, initial.diagnosis.since);
  assert.ok(next.history.length > initial.history.length);
});
