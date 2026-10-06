import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GenerationCollector } from './generation.mjs';

const homeKey = 'a'.repeat(24);
const launchId = 'b'.repeat(32);
const instanceId = 'c'.repeat(32);
const binding = () => ({ version: 1, launchId, homeKey, codexPid: 42,
  codexStartedAt: new Date(90000).toISOString(), codexExecutable: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_test\\app\\ChatGPT.exe' });
const stream = (time = 100000) => ({ service: 'codex-generation-stream', version: 1, instanceId, launchId,
  homeKey, pid: 70, updatedAt: new Date(time).toISOString(), windowMs: 3000, state: 'active',
  items: [{ threadId: 'session-a', turnId: 'turn-a', itemId: 'message-a', phase: 'final_answer', state: 'generating',
    characters: 120, windowCharacters: 60, charactersPerSecond: 20, startedAt: new Date(98000).toISOString(),
    lastDeltaAt: new Date(time).toISOString(), completedAt: null }] });

async function fixture(t, options = {}) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'codex-generation-reader-'));
  const generationRoot = path.join(stateDir, 'generation');
  const directory = path.join(generationRoot, launchId);
  await mkdir(directory, { recursive: true });
  let now = 100000;
  const calls = [];
  const collector = new GenerationCollector({ stateDir, homeKey, clock: () => now,
    verifyBinding: async value => { calls.push(value); return true; }, ...options });
  t.after(async () => { await collector.close(); await rm(stateDir, { recursive: true, force: true }); });
  return { collector, directory, generationRoot, calls, advance: ms => { now += ms; },
    bind: async value => {
      const actual = value ?? binding();
      await mkdir(path.join(generationRoot, actual.launchId), { recursive: true });
      await writeFile(path.join(generationRoot, 'binding.json'), JSON.stringify(actual), 'utf8');
    },
    write: (value = stream(), name = `stream-70-${instanceId}.json`) => writeFile(path.join(directory, name), JSON.stringify(value), 'utf8') };
}

test('当前旧会话没有接线时显示等待下次正常启动，不伪造速度', async t => {
  const f = await fixture(t); await f.collector.poll();
  const snapshot = f.collector.snapshot();
  assert.equal(snapshot.status, 'waiting-launch');
  assert.match(snapshot.reason, /下次正常启动/);
  assert.deepEqual(snapshot.streams, []);
});

test('数百份旧启动快照不会阻止发现本次启动的流', async t => {
  const f = await fixture(t); await f.bind();
  const old = stream(); old.launchId = 'f'.repeat(32);
  await Promise.all(Array.from({ length: 260 }, (_, i) => writeFile(
    path.join(f.generationRoot, `stream-${i + 100}-${instanceId}.json`), JSON.stringify({ ...old, pid: i + 100 }), 'utf8')));
  await f.write(); await f.collector.poll();
  assert.equal(f.collector.snapshot().status, 'collecting');
  assert.equal(f.collector.snapshot().streams[0].charactersPerSecond, 20);
});

test('经过绑定与进程身份核对的流只公开安全计数，重新计算最近3秒速率', async t => {
  const f = await fixture(t); await f.bind();
  const raw = stream(); raw.prompt = 'DO-NOT-EXPOSE'; raw.items[0].text = 'DO-NOT-EXPOSE'; raw.items[0].charactersPerSecond = 999;
  await f.write(raw); await f.collector.poll();
  const snapshot = f.collector.snapshot();
  assert.equal(snapshot.status, 'collecting');
  assert.equal(snapshot.streams[0].charactersPerSecond, 20);
  assert.equal(f.calls.length, 1);
  assert.ok(!JSON.stringify(snapshot).includes('DO-NOT-EXPOSE'));
  assert.ok(!JSON.stringify(snapshot).includes('codexExecutable'));
  snapshot.streams[0].characters = 0;
  assert.equal(f.collector.snapshot().streams[0].characters, 120);
});

test('心跳或身份确认过期后清除实时数值；未知数据不当真实零', async t => {
  const f = await fixture(t); await f.bind(); await f.write(); await f.collector.poll();
  f.advance(5001);
  assert.equal(f.collector.snapshot().status, 'stale');
  assert.equal(f.collector.snapshot().streams[0].charactersPerSecond, null);
  await f.write(stream(106000)); f.advance(1000); await f.collector.poll();
  assert.equal(f.collector.snapshot().status, 'collecting');
});

test('已观测输出暂停可显示零，但完成或没有增量时不显示实时速率', async t => {
  const f = await fixture(t); await f.bind();
  const paused = stream(); paused.items[0].windowCharacters = 0; paused.items[0].state = 'waiting';
  await f.write(paused); await f.collector.poll();
  assert.equal(f.collector.snapshot().streams[0].charactersPerSecond, 0);
  assert.equal(f.collector.snapshot().status, 'idle');
  paused.items[0].state = 'completed'; paused.items[0].completedAt = new Date(100000).toISOString();
  await f.write(paused); await f.collector.poll();
  assert.equal(f.collector.snapshot().streams[0].charactersPerSecond, null);
  paused.items[0].state = 'waiting'; paused.items[0].lastDeltaAt = null;
  await f.write(paused); await f.collector.poll();
  assert.equal(f.collector.snapshot().streams[0].charactersPerSecond, null);
});

test('错误 home/launch/process binding 不会附着旧会话', async t => {
  const f = await fixture(t); await f.bind();
  const wrong = stream(); wrong.launchId = 'd'.repeat(32); await f.write(wrong); await f.collector.poll();
  assert.equal(f.collector.snapshot().status, 'idle');
  assert.deepEqual(f.collector.snapshot().streams, []);
  const invalid = await fixture(t, { verifyBinding: async () => false });
  await invalid.bind(); await invalid.write(); await invalid.collector.poll();
  assert.equal(invalid.collector.snapshot().status, 'unavailable');
  assert.deepEqual(invalid.collector.snapshot().streams, []);
});

test('停止/坏JSON/超大文件/未来时间不会保留正常结论', async t => {
  const f = await fixture(t); await f.bind();
  const stopped = stream(); stopped.state = 'stopped'; await f.write(stopped); await f.collector.poll();
  assert.equal(f.collector.snapshot().status, 'stale');
  assert.equal(f.collector.snapshot().streams[0].charactersPerSecond, null);
  await f.write(stream(110000)); await f.collector.poll();
  assert.equal(f.collector.snapshot().status, 'unavailable');
  await writeFile(path.join(f.directory, `stream-70-${instanceId}.json`), '{'); await f.collector.poll();
  assert.equal(f.collector.snapshot().status, 'unavailable');
  await f.write(); await appendFile(path.join(f.directory, `stream-70-${instanceId}.json`), ' '.repeat(65537));
  await f.collector.poll(); assert.equal(f.collector.snapshot().status, 'unavailable');
});

test('同一条消息跨快照重复不叠加，过量条目及错误字段被界限过滤', async t => {
  const f = await fixture(t); await f.bind();
  const first = stream(); first.items = Array.from({ length: 100 }, (_, i) => ({ ...first.items[0], itemId: `message-${i}` }));
  await f.write(first); const second = stream(); second.pid = 71; second.instanceId = 'd'.repeat(32);
  await f.write(second, `stream-71-${second.instanceId}.json`); await f.collector.poll();
  const snapshot = f.collector.snapshot();
  assert.ok(snapshot.streams.length <= 40);
  assert.equal(snapshot.streams.filter(value => value.itemId === 'message-a').length, 1);
});

test('其中一个旁路进程停止不会遮掉另一个仍有新心跳的流', async t => {
  const f = await fixture(t); await f.bind(); await f.write(stream());
  const stopped = stream(100100); stopped.pid = 71; stopped.instanceId = 'd'.repeat(32); stopped.state = 'stopped';
  stopped.items = [{ ...stopped.items[0], itemId: 'stopped-message' }];
  await f.write(stopped, `stream-71-${stopped.instanceId}.json`); f.advance(100);
  await f.collector.poll();
  assert.equal(f.collector.snapshot().status, 'collecting');
  assert.equal(f.collector.snapshot().streams.find(value => value.itemId === 'message-a').charactersPerSecond, 20);
});

test('同一消息的新鲜可用采集优先于较新的停止记录', async t => {
  const f = await fixture(t); await f.bind(); await f.write(stream());
  const stopped = stream(100100); stopped.pid = 71; stopped.instanceId = 'd'.repeat(32); stopped.state = 'stopped';
  await f.write(stopped, `stream-71-${stopped.instanceId}.json`); f.advance(100); await f.collector.poll();
  assert.equal(f.collector.snapshot().streams[0].charactersPerSecond, 20);
});

test('本地快照写入恢复有安全诊断，不能暴露任意错误正文或路径', async t => {
  const f = await fixture(t); await f.bind();
  const raw = stream(); raw.captureHealth = { state: 'ok', recoveries: 1, lastErrorCode: 'EPERM', lastErrorStage: 'rename',
    lastErrorAt: new Date(99000).toISOString(), lastRecoveredAt: new Date(100000).toISOString(), reattachedAt: null,
    message: 'PRIVATE-AUTH-TEXT', path: 'PRIVATE-AUTH-PATH' };
  await f.write(raw); await f.collector.poll();
  const result = f.collector.snapshot();
  assert.equal(result.status, 'collecting');
  assert.equal(result.captureHealth.lastErrorCode, 'EPERM');
  assert.equal(result.captureHealth.lastErrorStage, 'rename');
  assert.equal(result.captureHealth.recoveries, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-AUTH/);
  assert.match(result.reason, /恢复/);
  for (const state of ['retrying', 'unsafe']) {
    raw.captureHealth.state = state;
    await f.write(raw); await f.collector.poll();
    assert.equal(f.collector.snapshot().status, 'unavailable');
    assert.equal(f.collector.snapshot().streams[0].charactersPerSecond, null);
    assert.match(f.collector.snapshot().reason, /本地|采集/);
  }
});

test('只有快照过期时明确定位本地采集心跳，不能混称进程身份过期', async t => {
  const f = await fixture(t); await f.bind(); await f.write(); await f.collector.poll(); f.advance(5001);
  assert.match(f.collector.snapshot().reason, /本地.*快照/);
  assert.doesNotMatch(f.collector.snapshot().reason, /身份确认/);
});

test('其他流的新心跳不能延长旧流的实时速率有效期', async t => {
  const f = await fixture(t); await f.bind(); await f.write(stream());
  const newer = stream(104000); newer.pid = 71; newer.instanceId = 'd'.repeat(32);
  newer.items = [{ ...newer.items[0], itemId: 'newer-message' }];
  await f.write(newer, `stream-71-${newer.instanceId}.json`); f.advance(4000); await f.collector.poll();
  f.advance(1001);
  const snapshot = f.collector.snapshot();
  assert.equal(snapshot.status, 'collecting');
  assert.equal(snapshot.streams.find(value => value.itemId === 'message-a').charactersPerSecond, null);
  assert.equal(snapshot.streams.find(value => value.itemId === 'newer-message').charactersPerSecond, 20);
});

test('轮询刚开始即关闭时，不再创建晚到的进程身份核对', async t => {
  let calls = 0;
  let release;
  const f = await fixture(t, { verifyBinding: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  await f.bind();
  const pending = f.collector.poll();
  const closing = f.collector.close();
  const closed = await Promise.race([closing.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 100))]);
  release?.(false);
  await Promise.all([pending, closing]);
  assert.equal(closed, true);
  assert.equal(calls, 0);
});

test('文件名与载荷pid不符、目录链接不允许读取', async t => {
  const f = await fixture(t); await f.bind(); const wrong = stream(); wrong.pid = 71;
  await f.write(wrong); await f.collector.poll(); assert.equal(f.collector.snapshot().status, 'unavailable');
  const linked = await fixture(t); await linked.bind(); await rm(linked.directory, { recursive: true });
  await symlink(f.directory, linked.directory, process.platform === 'win32' ? 'junction' : 'dir');
  await linked.collector.poll(); assert.equal(linked.collector.snapshot().status, 'unavailable');
});

test('身份缓存按30秒复核，launch变更立即失效，close取消正在核对', async t => {
  const f = await fixture(t); await f.bind(); await f.write(); await f.collector.poll(); await f.collector.poll();
  assert.equal(f.calls.length, 1); f.advance(30001); await f.write(stream(130001)); await f.collector.poll();
  assert.equal(f.calls.length, 2);
  const next = binding(); next.launchId = 'e'.repeat(32); await f.bind(next); await f.collector.poll();
  assert.equal(f.calls.length, 3); assert.deepEqual(f.collector.snapshot().streams, []);
  const hanging = await fixture(t, { verifyBinding: (value, { signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve(false), { once: true })) });
  await hanging.bind(); const pending = hanging.collector.poll();
  await new Promise(resolve => setTimeout(resolve, 30));
  await hanging.collector.close(); await pending;
});
