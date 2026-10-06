import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (await readFile(new URL('./public/app.js', import.meta.url), 'utf8'))
  .replace("'./performance-view.mjs'", JSON.stringify(new URL('./public/performance-view.mjs', import.meta.url).href));
const { formatNumber, formatDuration, selectTurns, trendSamples, networkStageState, messageOutputState, generationState, generationCaptureNote, newerGeneration, mergeStatusGeneration, taskDisplayTitle } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('任务展示实际会话标题，缺失时不拿模型或正文充当标题', () => {
  assert.equal(taskDisplayTitle({ sessionTitle: '  监测器：任务排序  ' }), '监测器：任务排序');
  assert.equal(taskDisplayTitle({ sessionTitle: '<img src=x onerror=alert(1)>' }), '<img src=x onerror=alert(1)>');
  for (const sessionTitle of [null, undefined, '', '   ', 42, {}]) {
    assert.equal(taskDisplayTitle({ sessionTitle, model: 'model-test', text: '私人正文' }), '未命名会话');
  }
});

test('快接口撤销绑定后，迟到的状态响应不能复活带旧时间戳的速度', () => {
  const oldStatus = { updatedAt: '2026-10-06T00:00:10Z', status: 'collecting', streams: [{ charactersPerSecond: 20 }] };
  for (const status of ['unavailable', 'waiting-launch']) {
    const revoked = { updatedAt: null, status, streams: [] };
    assert.equal(mergeStatusGeneration(revoked, oldStatus, 4, 5), revoked);
    assert.equal(mergeStatusGeneration(revoked, oldStatus, 5, 5), oldStatus, '本次请求没有新的快接口响应时，状态接口仍可提供回退数据');
  }
});

test('慢状态响应不覆盖快速接口的新数据，同时间保留已接收快照', () => {
  const current = { updatedAt: '2026-10-06T00:00:10Z', streams: ['new'] };
  assert.equal(newerGeneration(current, { updatedAt: '2026-10-06T00:00:09Z', streams: ['old'] }), current);
  assert.equal(newerGeneration(current, { updatedAt: current.updatedAt, streams: ['old'] }), current);
  const stopped = { updatedAt: current.updatedAt, status: 'stale' };
  assert.equal(newerGeneration(current, stopped, true), stopped, '快接口可更新同一快照的不可用状态');
  assert.equal(newerGeneration(current, { updatedAt: null }), current);
  const unbound = { updatedAt: null, status: 'unavailable', streams: [] };
  assert.equal(newerGeneration(current, unbound), current);
  assert.equal(newerGeneration(current, unbound, true), unbound, '可信的新请求可立即撤销已失效的采集绑定');
  const next = { updatedAt: '2026-10-06T00:00:11Z', streams: [] };
  assert.equal(newerGeneration(current, next), next);
  assert.equal(newerGeneration(null, next), next);
});

test('未知指标不会被显示为零，真实零仍可识别', () => {
  for (const value of [null, undefined, NaN, Infinity, -1, '0']) {
    assert.equal(formatNumber(value), '—');
    assert.equal(formatDuration(value), '—');
  }
  assert.equal(formatNumber(0), '0');
  assert.equal(formatNumber(1234), '1,234');
  assert.equal(formatDuration(0), '0 ms');
  assert.equal(formatDuration(1250), '1.25 s');
});

test('模型筛选为精确匹配并按最新轮次排序，保留源记录', () => {
  const turns = [
    { id: 'older', model: 'alpha', startedAt: '2026-10-01T10:00:00Z' },
    { id: 'other', model: 'alpha-mini', startedAt: '2026-10-03T10:00:00Z' },
    { id: 'latest', model: 'alpha', startedAt: '2026-10-02T10:00:00Z' },
  ];
  assert.deepEqual(selectTurns(turns, 'alpha').map(turn => turn.id), ['latest', 'older']);
  assert.deepEqual(turns.map(turn => turn.id), ['older', 'other', 'latest']);
  assert.deepEqual(selectTurns(null, 'alpha'), []);
  assert.equal(selectTurns(turns, '').length, 3);
});

test('全部模型视图的趋势只采用最近已知模型，保留缺值位置', () => {
  const turns = [
    { id: 'unknown', model: null, startedAt: '2026-10-05T10:00:00Z', throughputTps: 9 },
    { id: 'new-beta', model: 'beta', startedAt: '2026-10-04T10:00:00Z', throughputTps: 10 },
    { id: 'alpha', model: 'alpha', startedAt: '2026-10-03T10:00:00Z', throughputTps: 50 },
    { id: 'old-beta', model: 'beta', startedAt: '2026-10-02T10:00:00Z', throughputTps: null },
  ];
  const trend = trendSamples(turns, '', 3);
  assert.equal(trend.model, 'beta');
  assert.deepEqual(trend.turns.map(turn => turn.id), ['old-beta', 'new-beta']);
  assert.equal(trend.turns[0].throughputTps, null);
  assert.deepEqual(trendSamples(turns, 'missing', 3), { model: 'missing', turns: [] });
});

test('过期或断线的旧网络记录不能继续显示正常', () => {
  const now = Date.parse('2026-10-05T10:00:00Z');
  const stage = { status: 'ok', checkedAt: '2026-10-05T09:59:55Z', staleAfterMs: 10000 };
  assert.deepEqual(networkStageState(stage, true, now), { status: 'ok', ageMs: 5000 });
  assert.deepEqual(networkStageState(stage, true, now + 6000), { status: 'stale', ageMs: 11000 });
  assert.deepEqual(networkStageState(stage, false, now), { status: 'stale', ageMs: 5000 });
  assert.deepEqual(networkStageState({ status: 'ok' }, true, now), { status: 'unknown', ageMs: null });
  assert.deepEqual(networkStageState(null, true, now), { status: 'unknown', ageMs: null });
  assert.deepEqual(networkStageState({ status: 'checking' }, true, now), { status: 'checking', ageMs: null });
});

test('消息平均速度只采用有效完成时窗，过短或缺失样本保留原因', () => {
  assert.equal(typeof messageOutputState, 'function', '需要独立的完成消息指标');
  const output = { phase: 'final_answer', startedAt: '2026-10-06T00:00:00Z', completedAt: '2026-10-06T00:00:10Z', durationMs: 10000, characters: 305, charactersPerSecond: 30.5, reason: null };
  assert.equal(messageOutputState(output).rate, 30.5);
  assert.equal(messageOutputState({ ...output, durationMs: 500, charactersPerSecond: null, reason: 'short-window' }).rate, null);
  assert.match(messageOutputState({ ...output, durationMs: 500, charactersPerSecond: null, reason: 'short-window' }).reason, /过短/);
  assert.match(messageOutputState(null).reason, /尚无/);
  assert.match(messageOutputState({ ...output, reason: 'missing-timing', charactersPerSecond: null }).reason, /时间/);
  assert.equal(messageOutputState({ ...output, startedAt: null }).rate, null);
});

test('实时速度按会话和轮次共同绑定模型，未知流不能冒充选中模型', () => {
  assert.equal(typeof generationState, 'function', '需要独立的实时接收指标');
  const now = Date.parse('2026-10-06T00:00:10Z');
  const stream = { threadId: 'session-a', turnId: 'turn-a', itemId: 'message-a', phase: 'final_answer', state: 'generating', characters: 90, windowCharacters: 60, charactersPerSecond: 20, startedAt: '2026-10-06T00:00:04Z', lastDeltaAt: '2026-10-06T00:00:09Z', completedAt: null };
  const generation = { updatedAt: '2026-10-06T00:00:10Z', status: 'collecting', reason: '', windowMs: 3000, streams: [stream, { ...stream, threadId: 'session-unknown', itemId: 'message-unknown' }] };
  const turns = [{ sessionId: 'session-a', id: 'turn-a', model: 'alpha' }, { sessionId: 'session-b', id: 'turn-a', model: 'beta' }];
  const selected = generationState(generation, turns, 'alpha', true, now);
  assert.equal(selected.primary.rate, 20);
  assert.equal(selected.primary.model, 'alpha');
  assert.equal(selected.streams.length, 2);
  assert.equal(selected.streams.find(item => item.threadId === 'session-unknown').model, null);
  assert.equal(generationState(generation, turns, 'beta', true, now).primary, null);
});

test('实时输出停顿归零，完成、过期与采集器断线清除实时速度', () => {
  assert.equal(typeof generationState, 'function');
  const now = Date.parse('2026-10-06T00:00:10Z');
  const stream = { threadId: 's', turnId: 't', itemId: 'm', state: 'generating', characters: 100, windowCharacters: 30, charactersPerSecond: 10, startedAt: '2026-10-06T00:00:00Z', lastDeltaAt: '2026-10-06T00:00:06Z' };
  const generation = { updatedAt: '2026-10-06T00:00:10Z', status: 'collecting', windowMs: 3000, streams: [stream] };
  assert.equal(generationState(generation, [], '', true, now).primary.rate, 0);
  assert.equal(generationState(generation, [], '', true, now).primary.windowCharacters, 0);
  assert.equal(generationState({ ...generation, streams: [{ ...stream, state: 'completed' }] }, [], '', true, now).primary, null);
  assert.equal(generationState(generation, [], '', true, now + 5001).status, 'stale');
  assert.equal(generationState(generation, [], '', true, now + 5001).streams[0].rate, null);
  assert.equal(generationState(generation, [], '', false, now).streams[0].rate, null);
  assert.equal(generationState({ ...generation, status: 'waiting-launch' }, [], '', true, now).primary, null);
});

test('实时会话详情也以已确认的轮次终态为准，不显示迟到活动流的旧速度', () => {
  const now = Date.parse('2026-10-06T00:00:10Z');
  const stream = { threadId: 's', turnId: 't', itemId: 'm', state: 'generating', characters: 100, windowCharacters: 60, charactersPerSecond: 20,
    startedAt: '2026-10-06T00:00:00Z', lastDeltaAt: '2026-10-06T00:00:10Z' };
  const generation = { updatedAt: '2026-10-06T00:00:10Z', status: 'collecting', windowMs: 3000, streams: [stream] };
  for (const status of ['completed', 'cancelled', 'error', 'failed', 'interrupted']) {
    const state = generationState(generation, [{ sessionId: 's', id: 't', model: 'alpha', status }], '', true, now);
    assert.equal(state.primary, null, status);
    assert.equal(state.streams[0].rate, null, status);
    assert.equal(state.streams[0].state, 'completed', status);
  }
  assert.equal(generationState(generation, [{ sessionId: 'other', id: 't', status: 'completed' }], '', true, now).primary.rate, 20,
    '另一会话的同名轮次不能覆盖当前流');
});

test('实时显示状态只提取计数与标识，不保留正文或未知字段', () => {
  const now = Date.parse('2026-10-06T00:00:10Z');
  const generation = { updatedAt: '2026-10-06T00:00:10Z', status: 'collecting', windowMs: 3000,
    text: 'PRIVATE_FIXTURE_BODY_NOT_FOR_DISPLAY', streams: [{ threadId: 's', turnId: 't', itemId: 'm', phase: 'final_answer', state: 'generating', characters: 10, windowCharacters: 10, charactersPerSecond: 10 / 3, startedAt: '2026-10-06T00:00:06Z', lastDeltaAt: '2026-10-06T00:00:10Z', text: 'PRIVATE_FIXTURE_BODY_NOT_FOR_DISPLAY', token: 'SECRET_FIXTURE_CREDENTIAL' }] };
  assert.doesNotMatch(JSON.stringify(generationState(generation, [], '', true, now)), /PRIVATE_FIXTURE|SECRET_FIXTURE|"text"|"token"/);
});

test('多个实时采集器按各自快照过期，新采集器心跳不能保护旧流速度', () => {
  const now = Date.parse('2026-10-06T00:00:10Z');
  const stream = { threadId: 's', turnId: 't', itemId: 'old-writer', phase: 'final_answer', state: 'generating', characters: 10, windowCharacters: 10, charactersPerSecond: 10 / 3, startedAt: '2026-10-06T00:00:06Z', lastDeltaAt: '2026-10-06T00:00:10Z', observedAt: '2026-10-06T00:00:04Z' };
  const generation = { updatedAt: '2026-10-06T00:00:10Z', status: 'collecting', windowMs: 3000, streams: [stream, { ...stream, itemId: 'fresh-writer', observedAt: '2026-10-06T00:00:10Z' }] };
  const state = generationState(generation, [], '', true, now);
  assert.equal(state.streams.find(item => item.itemId === 'old-writer').rate, null);
  assert.equal(state.streams.find(item => item.itemId === 'old-writer').fresh, false);
  assert.equal(state.primary.itemId, 'fresh-writer');
  assert.equal(state.primary.rate, 10 / 3);
  assert.equal(generationState({ ...generation, streams: [{ ...stream, observedAt: 'invalid' }] }, [], '', true, now).primary, null);
});

test('热接恢复说明累计边界，普通写入重试恢复不误报丢字', () => {
  assert.equal(typeof generationCaptureNote, 'function');
  const generation = { captureHealth: { state: 'ok', recoveries: 1, reattachedAt: '2026-10-06T00:00:10Z' } };
  assert.match(generationCaptureNote(generation, { fresh: true }), /累计从恢复后开始.*未补算中断时段/);
  assert.equal(generationCaptureNote({ captureHealth: { state: 'ok', recoveries: 2, reattachedAt: null } }, { fresh: true }), '本地快照写入曾失败，现已自动恢复。');
  assert.equal(generationCaptureNote(generation, { fresh: false }), '');
  assert.equal(generationCaptureNote({ captureHealth: { state: 'PRIVATE_BODY', recoveries: 2, reattachedAt: '2026-10-06T00:00:10Z' } }, { fresh: true }), '');
  assert.equal(generationCaptureNote({ captureHealth: { state: 'ok', recoveries: -1, reattachedAt: null } }, { fresh: true }), '');
});

test('局部采集和保留上限独立说明，只接受明确标记与安全整数事件计数', () => {
  const now = Date.parse('2026-10-06T00:00:10Z');
  const stream = { threadId: 's', turnId: 't', itemId: 'm', state: 'generating', partial: true, characters: 100, windowCharacters: 60,
    charactersPerSecond: 20, startedAt: '2026-10-06T00:00:08Z', lastDeltaAt: '2026-10-06T00:00:10Z' };
  const generation = { updatedAt: '2026-10-06T00:00:10Z', status: 'collecting', windowMs: 3000, streams: [stream],
    coverage: { droppedEvents: 7, privateText: 'PRIVATE_COVERAGE' }, reason: 'PRIVATE_REASON' };
  const state = generationState(generation, [], '', true, now);
  assert.equal(state.streams[0].partial, true);
  assert.equal(state.streams[0].rate, 20, '局部采集不改变已观测窗口的速度');
  const note = generationCaptureNote(generation, state);
  assert.match(note, /保留上限.*7.*事件/);
  assert.match(note, /局部采集.*已观测片段/);
  assert.doesNotMatch(note, /PRIVATE/);
  assert.equal(generationCaptureNote(generation, { ...state, fresh: false }), '');
  for (const partial of [false, null, undefined, 1, 'true']) {
    assert.equal(generationState({ ...generation, streams: [{ ...stream, partial }] }, [], '', true, now).streams[0].partial, false);
  }
  for (const droppedEvents of [0, -1, 1.5, '7', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(generationCaptureNote({ coverage: { droppedEvents } }, { fresh: true, streams: [] }), '');
  }
  assert.match(generationCaptureNote({ coverage: { droppedEvents: Number.MAX_SAFE_INTEGER } }, { fresh: true, streams: [] }), /事件/);
});

test('实时详情保留后端返回的40条流，后半段局部采集信息不再被隐藏', () => {
  const now = Date.parse('2026-10-06T00:00:10Z');
  const timestamp = new Date(now).toISOString();
  const streams = Array.from({ length: 41 }, (_, i) => ({ threadId: `s${i}`, turnId: `t${i}`, itemId: `m${i}`, state: 'generating',
    partial: i === 39, characters: 60, windowCharacters: 60, charactersPerSecond: 20, startedAt: timestamp, lastDeltaAt: timestamp, observedAt: timestamp }));
  const generation = { updatedAt: timestamp, status: 'collecting', windowMs: 3000, streams };
  const state = generationState(generation, [], '', true, now);
  assert.equal(state.streams.length, 40);
  assert.equal(state.streams.find(item => item.itemId === 'm39').rate, 20);
  assert.match(generationCaptureNote(generation, state), /局部采集/);
  assert.equal(state.streams.some(item => item.itemId === 'm40'), false, '仍保持与后端相同的有界白名单');
});
