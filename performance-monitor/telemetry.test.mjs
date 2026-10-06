import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rename, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelemetryCollector } from './telemetry.mjs';

const time = (second) => new Date(Date.UTC(2026, 9, 5, 8, 0, second)).toISOString();
const row = (type, payload, second = 0) => ({ timestamp: time(second), type, payload });
const event = (type, payload = {}, second = 0) => row('event_msg', { type, ...payload }, second);
const meta = (id = 'session-a') => row('session_meta', { id, session_id: id, model_provider: 'openai' });
const started = (id = 'turn-a', second = 0) => event('task_started', { turn_id: id }, second);
const context = (id = 'turn-a') => row('turn_context', { turn_id: id, model: 'gpt-6.1-sol', effort: 'high' });
const usage = (id = 'turn-a', output = 120, second = 2) => row('token_usage_record', {
  turn_id: id, response_id: `response-${id}`, turn_token_usage: { output_tokens: output, reasoning_output_tokens: 40 },
}, second);
const complete = (id = 'turn-a', second = 12) => event('task_complete', {
  turn_id: id, duration_ms: 12000, time_to_first_token_ms: 1500,
}, second);
const message = ({ turnId = 'turn-a', itemId = 'message-a', phase = 'final_answer', text = '测试，Hello 🙂\n', startedAt = Date.parse(time(2)), completedAt = Date.parse(time(4)), ...extra } = {}) => event('item_completed', {
  turn_id: turnId,
  item: { type: 'AgentMessage', id: itemId, phase, content: [{ type: 'Text', text }] },
  started_at_ms: startedAt, completed_at_ms: completedAt, ...extra,
}, 4);
const jsonl = (rows) => rows.map((entry) => JSON.stringify(entry)).join('\n') + '\n';

async function setup(t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'codex-telemetry-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const now = new Date();
  const day = join(home, 'sessions', String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'), String(now.getUTCDate()).padStart(2, '0'));
  await mkdir(day, { recursive: true });
  return { home, day, collector: new TelemetryCollector({ codexHome: home, ...options }) };
}

test('whole-turn totals and repeated token_count records never double count', async (t) => {
  const { day, collector } = await setup(t);
  const tokenCount = event('token_count', { info: { last_token_usage: { output_tokens: 120 }, total_token_usage: { output_tokens: 99999 } } }, 3);
  await writeFile(join(day, 'rollout-a.jsonl'), jsonl([meta(), started(), context(), usage(), usage(), tokenCount, tokenCount, complete()]));
  await collector.poll();
  await collector.poll();
  const [turn] = collector.snapshot().turns;
  assert.equal(turn.outputTokens, 120);
  assert.equal(turn.reasoningTokens, 40);
  assert.equal(turn.durationMs, 12000);
  assert.equal(turn.ttftMs, 1500);
  assert.equal(turn.throughputTps, 10);
  assert.equal(turn.status, 'completed');
  assert.equal(turn.model, 'gpt-6.1-sol');
  assert.equal(turn.effort, 'high');
  assert.equal(turn.provider, 'openai');
  assert.match(turn.warnings.join(' '), /端到端.*推理.*工具/);
});

test('session and turn identity survive overlapping files and context rotation', async (t) => {
  const { day, collector } = await setup(t);
  await writeFile(join(day, 'rollout-a.jsonl'), jsonl([meta(), started(), context(), usage()]));
  await writeFile(join(day, 'rollout-b.jsonl'), jsonl([meta(), context(), usage('turn-a', 240, 5), complete()]));
  await writeFile(join(day, 'rollout-c.jsonl'), jsonl([meta('session-b'), started(), usage('turn-a', 30, 6), complete()]));
  await writeFile(join(day, 'rollout-d.jsonl'), jsonl([meta(), started('turn-b', 20), usage('turn-b', 60, 22), complete('turn-b', 32)]));
  await collector.poll();
  const turns = collector.snapshot().turns;
  assert.equal(turns.length, 3);
  assert.equal(turns.find((turn) => turn.sessionId === 'session-a' && turn.id === 'turn-a').outputTokens, 240);
  assert.equal(turns.find((turn) => turn.sessionId === 'session-b').outputTokens, 30);
  assert.equal(turns[0].id, 'turn-b');
});

test('missing and legacy-only counters stay null instead of producing a false rate', async (t) => {
  const { day, collector } = await setup(t);
  await writeFile(join(day, 'rollout-a.jsonl'), jsonl([meta(), started(), event('token_count', { info: { total_token_usage: { output_tokens: 9000 } } }), complete()]));
  await collector.poll();
  const [turn] = collector.snapshot().turns;
  assert.equal(turn.outputTokens, null);
  assert.equal(turn.reasoningTokens, null);
  assert.equal(turn.throughputTps, null);
  assert.match(turn.warnings.join(' '), /token/);
});

test('response-level fallback deduplicates response IDs and yields to authoritative totals', async (t) => {
  const { day, collector } = await setup(t);
  const response = (id, count) => row('token_usage_record', { turn_id: 'turn-a', response_id: id, usage: { output_tokens: count } }, 2);
  const file = join(day, 'rollout-a.jsonl');
  await writeFile(file, jsonl([meta(), started(), response('one', 30), response('one', 30), response('two', 50), complete()]));
  await collector.poll();
  assert.equal(collector.snapshot().turns[0].outputTokens, 80);
  assert.equal(collector.snapshot().turns[0].reasoningTokens, null);
  await appendFile(file, jsonl([usage('turn-a', 100, 14)]));
  await collector.poll();
  assert.equal(collector.snapshot().turns[0].outputTokens, 100);
});

test('a UTF-8 character and JSON record split across polls are retained exactly once', async (t) => {
  const { day, collector } = await setup(t);
  const file = join(day, 'rollout-a.jsonl');
  await writeFile(file, jsonl([meta(), started()]));
  const record = Buffer.from(jsonl([{ ...usage(), ignored: '机密内容' }]));
  const split = record.indexOf(Buffer.from('机')) + 1;
  await appendFile(file, record.subarray(0, split));
  await collector.poll();
  assert.equal(collector.snapshot().turns[0].outputTokens, null);
  await appendFile(file, record.subarray(split));
  await collector.poll();
  assert.equal(collector.snapshot().turns[0].outputTokens, 120);
  assert.equal(collector.snapshot().source.errors, 0);
});

test('truncation and file replacement restart the byte cursor without mixing sessions', async (t) => {
  const { day, collector } = await setup(t);
  const file = join(day, 'rollout-a.jsonl');
  await writeFile(file, jsonl([meta(), started(), usage(), complete()]));
  await collector.poll();
  await writeFile(file, jsonl([meta('session-b'), started('turn-b', 20)]));
  await collector.poll();
  await rename(file, join(day, 'old.log'));
  await writeFile(file, jsonl([meta('session-c'), started('turn-c', 30), usage('turn-c', 60, 31), complete('turn-c', 42)]));
  await collector.poll();
  assert.deepEqual(new Set(collector.snapshot().turns.map((turn) => turn.sessionId)), new Set(['session-a', 'session-b', 'session-c']));
  assert.equal(collector.snapshot().turns.find((turn) => turn.sessionId === 'session-c').outputTokens, 60);
});

test('snapshot contains only whitelisted metadata and cannot mutate collector state', async (t) => {
  const { day, collector } = await setup(t);
  const file = join(day, 'rollout-a.jsonl');
  const secret = 'PRIVATE_BODY_SENTINEL';
  const original = jsonl([meta(), started(), { ...context(), private: secret }, event('agent_message', { message: secret }), row('response_item', { type: 'function_call', arguments: secret }), { ...usage(), api_key: secret }, { ...complete(), payload: { ...complete().payload, last_agent_message: secret } }]);
  await writeFile(file, original);
  await collector.poll();
  const snapshot = collector.snapshot();
  assert.equal(JSON.stringify(snapshot).includes(secret), false);
  assert.deepEqual(Object.keys(snapshot.turns[0]).sort(), ['id', 'sessionId', 'startedAt', 'completedAt', 'status', 'model', 'effort', 'provider', 'outputTokens', 'reasoningTokens', 'durationMs', 'ttftMs', 'throughputTps', 'messageOutput', 'warnings'].sort());
  snapshot.turns[0].outputTokens = 999;
  assert.equal(collector.snapshot().turns[0].outputTokens, 120);
  assert.equal(await readFile(file, 'utf8'), original);
});

test('oversized and malformed lines are bounded and later valid metadata remains readable', async (t) => {
  const { day, collector } = await setup(t);
  const file = join(day, 'rollout-a.jsonl');
  await writeFile(file, jsonl([meta(), started()]) + JSON.stringify({ type: 'response_item', payload: 'x'.repeat(400000) }) + '\n{broken json}\n' + jsonl([usage(), complete()]));
  for (let index = 0; index < 3; index++) await collector.poll();
  assert.equal(collector.snapshot().turns[0].outputTokens, 120);
  assert.ok(collector.snapshot().source.errors >= 1);
  assert.ok(collector.snapshot().source.truncatedFiles >= 1);
  assert.ok(collector.snapshot().warnings.length < 20);
});

test('file discovery and retained turns respect configured limits', async (t) => {
  const { day, collector } = await setup(t, { maxFiles: 2, maxTurns: 3 });
  for (let index = 0; index < 5; index++) {
    const file = join(day, `rollout-${index}.jsonl`);
    await writeFile(file, jsonl([meta(`session-${index}`), ...Array.from({ length: 6 }, (_, turn) => started(`turn-${turn}`, index * 8 + turn))]));
    await utimes(file, new Date(Date.now() + index * 1000), new Date(Date.now() + index * 1000));
  }
  await collector.poll();
  const snapshot = collector.snapshot();
  assert.ok(snapshot.source.scannedFiles <= 2);
  assert.equal(snapshot.turns.length, 3);
  assert.ok(snapshot.turns.every((turn) => ['session-3', 'session-4'].includes(turn.sessionId)));
  assert.ok(snapshot.warnings.length > 0);
});

test('an already tracked active file is followed after moving beyond lookback dates', async (t) => {
  const { home, day, collector } = await setup(t);
  const file = join(day, 'rollout-a.jsonl');
  await writeFile(file, jsonl([meta(), started()]));
  await collector.poll();
  // Moving the directory simulates rotation; its replacement is discovered on the next poll.
  await rename(day, `${day}-rotated`);
  await mkdir(day);
  await writeFile(file, jsonl([meta(), context(), usage(), complete()]));
  await collector.poll();
  assert.equal(collector.snapshot().turns.length, 1);
  assert.equal(collector.snapshot().turns[0].outputTokens, 120);
  assert.equal(collector.snapshot().turns[0].status, 'completed');
  assert.ok(home);
});

test('missing sessions directory and unknown records do not crash polling', async (t) => {
  const { home, day, collector } = await setup(t);
  await writeFile(join(day, 'rollout-a.jsonl'), jsonl([row('future_event', { unknown: 'PRIVATE_BODY_SENTINEL' }), row('turn_context', {}), row('token_usage_record', {})]));
  await collector.poll();
  assert.equal(collector.snapshot().turns.length, 0);
  await rm(join(home, 'sessions'), { recursive: true });
  await collector.poll();
  assert.equal(collector.snapshot().turns.length, 0);
});

test('thread settings supply model metadata and usage without a turn identity is ignored', async (t) => {
  const { day, collector } = await setup(t);
  await writeFile(join(day, 'rollout-a.jsonl'), jsonl([
    meta(), event('thread_settings_applied', { thread_settings: { model: 'gpt-6-astra', reasoning_effort: 'ultra', model_provider_id: 'provider-a' } }),
    started(), row('token_usage_record', { usage: { output_tokens: 9999 }, response_id: 'unidentified' }), complete(),
  ]));
  await collector.poll();
  const [turn] = collector.snapshot().turns;
  assert.equal(turn.model, 'gpt-6-astra');
  assert.equal(turn.effort, 'ultra');
  assert.equal(turn.provider, 'provider-a');
  assert.equal(turn.outputTokens, null);
});

test('tracked running files continue after the lookback window advances', async (t) => {
  const { day, collector } = await setup(t);
  const file = join(day, 'rollout-a.jsonl');
  await writeFile(file, jsonl([meta(), started()]));
  await collector.poll();
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 5 * 86400000 });
  await appendFile(file, jsonl([usage(), complete()]));
  await collector.poll();
  assert.equal(collector.snapshot().turns[0].outputTokens, 120);
  assert.equal(collector.snapshot().turns[0].status, 'completed');
});

test('only explicit completion timings produce rate and first-token metrics', async (t) => {
  const { day, collector } = await setup(t);
  await writeFile(join(day, 'rollout-a.jsonl'), jsonl([meta(), started(), usage(), event('task_complete', { turn_id: 'turn-a' }, 12)]));
  await collector.poll();
  const [turn] = collector.snapshot().turns;
  assert.equal(turn.durationMs, null);
  assert.equal(turn.ttftMs, null);
  assert.equal(turn.throughputTps, null);
});

test('completion in another context file releases stale active-file priority', async (t) => {
  const { day, collector } = await setup(t, { maxFiles: 2 });
  const first = join(day, 'rollout-a.jsonl');
  const second = join(day, 'rollout-b.jsonl');
  await writeFile(first, jsonl([meta(), started()]));
  await writeFile(second, jsonl([meta(), context()]));
  await collector.poll();
  await appendFile(second, jsonl([complete()]));
  await collector.poll();
  for (const [index, session] of ['session-c', 'session-d'].entries()) {
    const file = join(day, `${session}.jsonl`);
    await writeFile(file, jsonl([meta(session), started(session, 40 + index)]));
    await utimes(file, new Date(Date.now() + 10000 + index * 1000), new Date(Date.now() + 10000 + index * 1000));
  }
  await collector.poll();
  assert.ok(collector.snapshot().turns.some((turn) => turn.sessionId === 'session-c'));
  assert.ok(collector.snapshot().turns.some((turn) => turn.sessionId === 'session-d'));
});

test('forked history cannot replace the owner thread or contribute inherited turns', async (t) => {
  const { day, collector } = await setup(t);
  const indexed = (entry, ordinal) => ({ ...entry, ordinal });
  await writeFile(join(day, 'rollout-child.jsonl'), jsonl([
    indexed(row('session_meta', { id: 'child', session_id: 'parent', forked_from_id: 'parent', subagent_history_start_ordinal: 13, model_provider: 'child-provider' }), 0),
    indexed(meta('parent'), 1), indexed(started('parent-turn'), 2), indexed(context('parent-turn'), 3),
    indexed(usage('parent-turn', 900), 4), indexed(complete('parent-turn'), 5),
    indexed(started('child-turn', 20), 14), indexed(context('child-turn'), 15),
    indexed(row('token_usage_record', { ...usage('child-turn').payload, thread_id: 'child', session_id: 'parent' }), 16),
    indexed(complete('child-turn', 32), 17),
  ]));
  await collector.poll();
  const turns = collector.snapshot().turns;
  assert.equal(turns.length, 1);
  assert.equal(turns[0].sessionId, 'child');
  assert.equal(turns[0].id, 'child-turn');
  assert.equal(turns[0].provider, 'child-provider');
  assert.equal(turns[0].outputTokens, 120);
  assert.equal(turns[0].status, 'completed');
});

test('forks with an unknown history boundary report incomplete data instead of inherited counts', async (t) => {
  const { day, collector } = await setup(t);
  await writeFile(join(day, 'rollout-child.jsonl'), jsonl([
    row('session_meta', { id: 'child', session_id: 'parent', forked_from_id: 'parent' }),
    meta('parent'), started(), usage(), complete(),
  ]));
  await collector.poll();
  const snapshot = collector.snapshot();
  assert.equal(snapshot.turns.length, 0);
  assert.match(snapshot.warnings.join(' '), /继承.*边界/);
});

test('explicit usage thread identity must match the file owner even when the root session differs', async (t) => {
  const { day, collector } = await setup(t);
  await writeFile(join(day, 'rollout-child.jsonl'), jsonl([
    row('session_meta', { id: 'child', session_id: 'parent' }), started(),
    row('token_usage_record', { ...usage().payload, thread_id: 'other-thread', session_id: 'parent' }), complete(),
  ]));
  await collector.poll();
  const snapshot = collector.snapshot();
  assert.equal(snapshot.turns[0].sessionId, 'child');
  assert.equal(snapshot.turns[0].outputTokens, null);
  assert.equal(snapshot.turns[0].throughputTps, null);
  assert.match(snapshot.warnings.join(' '), /线程.*归属/);
});

test('completed message speed uses its explicit output window and Unicode code points without retaining text', async (t) => {
  const { day, collector } = await setup(t);
  const text = 'PRIVATE_BODY_SENTINEL，中文🙂\n';
  await writeFile(join(day, 'rollout-a.jsonl'), jsonl([meta(), started(), context(), usage(), message({ text }), complete()]));
  await collector.poll();
  const snapshot = collector.snapshot();
  const [turn] = snapshot.turns;
  assert.deepEqual(turn.messageOutput, {
    itemId: 'message-a', phase: 'final_answer', startedAt: time(2), completedAt: time(4), durationMs: 2000,
    characters: [...text].length, charactersPerSecond: [...text].length / 2, reason: null,
  });
  assert.equal(turn.throughputTps, 10);
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE_BODY_SENTINEL'), false);
  turn.messageOutput.characters = 999;
  assert.equal(collector.snapshot().turns[0].messageOutput.characters, [...text].length);
});

test('messages without a measurable window expose a reason and never synthesize a speed from turn duration', async (t) => {
  const cases = [
    { itemId: 'missing', started_at_ms: undefined, completed_at_ms: undefined, reason: 'missing-timing' },
    { itemId: 'reversed', startedAt: Date.parse(time(4)), completedAt: Date.parse(time(2)), reason: 'invalid-timing' },
    { itemId: 'non-number', startedAt: time(2), reason: 'invalid-timing' },
    { itemId: 'short', completedAt: Date.parse(time(2)) + 999, reason: 'short-window' },
    { itemId: 'empty', text: '', reason: 'empty-output' },
  ];
  const { day, collector } = await setup(t);
  await writeFile(join(day, 'rollout-a.jsonl'), jsonl([meta(), ...cases.flatMap((entry) => [
    started(entry.itemId), message({ ...entry, turnId: entry.itemId }), complete(entry.itemId),
  ])]));
  await collector.poll();
  for (const entry of cases) {
    const value = collector.snapshot().turns.find((turn) => turn.id === entry.itemId).messageOutput;
    assert.equal(value.reason, entry.reason);
    assert.equal(value.charactersPerSecond, null);
  }
});

test('final answers take priority over commentary and repeated item records do not add characters', async (t) => {
  const { day, collector } = await setup(t);
  const firstFinal = message({ itemId: 'final-first', text: '第一条最终答复', completedAt: Date.parse(time(4)) });
  const lastFinal = message({ itemId: 'final-last', text: '最后答复', completedAt: Date.parse(time(8)) });
  await writeFile(join(day, 'rollout-a.jsonl'), jsonl([meta(), started(),
    firstFinal, firstFinal, message({ phase: 'commentary', itemId: 'later-progress', text: '进度', completedAt: Date.parse(time(10)) }),
    lastFinal, lastFinal, complete(),
  ]));
  await collector.poll();
  await collector.poll();
  const output = collector.snapshot().turns[0].messageOutput;
  assert.equal(output.itemId, 'final-last');
  assert.equal(output.characters, 4);
  assert.equal(output.charactersPerSecond, 4 / 6);
});

test('latest completed commentary is used when there is no final answer, including a running turn', async (t) => {
  const { day, collector } = await setup(t);
  await writeFile(join(day, 'rollout-a.jsonl'), jsonl([meta(), started(),
    message({ phase: 'commentary', itemId: 'commentary-first', completedAt: Date.parse(time(4)) }),
    message({ phase: 'commentary', itemId: 'commentary-last', completedAt: Date.parse(time(8)) }),
  ]));
  await collector.poll();
  assert.equal(collector.snapshot().turns[0].status, 'running');
  assert.equal(collector.snapshot().turns[0].messageOutput.itemId, 'commentary-last');
});

test('message measurements reject wrong owner, implicit turns, inherited history, and non-message items', async (t) => {
  const { day, collector } = await setup(t);
  const indexed = (entry, ordinal) => ({ ...entry, ordinal });
  await writeFile(join(day, 'rollout-child.jsonl'), jsonl([
    indexed(row('session_meta', { id: 'child', session_id: 'parent', forked_from_id: 'parent', subagent_history_start_ordinal: 10 }), 0),
    indexed(meta('parent'), 1), indexed(started('parent-turn'), 2), indexed(message({ turnId: 'parent-turn' }), 3),
    indexed(started('child-turn'), 10),
    indexed(message({ turnId: 'child-turn', thread_id: 'parent' }), 11),
    indexed(message({ turnId: 'child-turn', turn_id: undefined, itemId: 'implicit' }), 12),
    indexed(message({ turnId: 'child-turn', item: { type: 'Reasoning', id: 'reasoning', phase: 'final_answer', content: [{ type: 'Text', text: 'PRIVATE_BODY_SENTINEL' }] } }), 13),
    indexed(message({ turnId: 'child-turn', item: { type: 'Tool', id: 'tool', phase: 'final_answer', content: [{ type: 'Text', text: 'PRIVATE_BODY_SENTINEL' }] } }), 14),
    indexed(complete('child-turn'), 15),
  ]));
  await collector.poll();
  const snapshot = collector.snapshot();
  assert.equal(snapshot.turns.length, 1);
  assert.equal(snapshot.turns[0].sessionId, 'child');
  assert.equal(snapshot.turns[0].messageOutput, null);
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE_BODY_SENTINEL'), false);
});

test('older logs without message completion fields preserve null output measurements', async (t) => {
  const { day, collector } = await setup(t);
  await writeFile(join(day, 'rollout-a.jsonl'), jsonl([meta(), started(), event('agent_message', { turn_id: 'turn-a', message: 'PRIVATE_BODY_SENTINEL' }), usage(), complete()]));
  await collector.poll();
  assert.equal(collector.snapshot().turns[0].messageOutput, null);
});

test('message retention stays bounded while preserving the latest explicit final answer', async (t) => {
  const { day, collector } = await setup(t);
  await writeFile(join(day, 'rollout-a.jsonl'), jsonl([meta(), started(), message({ itemId: 'final-answer' }),
    ...Array.from({ length: 40 }, (_, index) => message({ itemId: `commentary-${index}`, phase: 'commentary', completedAt: Date.parse(time(5)) + index * 1000 })),
  ]));
  await collector.poll();
  assert.equal(collector.snapshot().turns[0].messageOutput.itemId, 'final-answer');
});

test('message content counts only Text parts and malformed content cannot report a valid rate', async (t) => {
  const { day, collector } = await setup(t);
  const item = (id, content) => ({ type: 'AgentMessage', id, phase: 'final_answer', content });
  await writeFile(join(day, 'rollout-a.jsonl'), jsonl([meta(),
    started('mixed'), message({ turnId: 'mixed', item: item('mixed-message', [{ type: 'Text', text: '🙂中' }, { type: 'Image', text: 'PRIVATE_BODY_SENTINEL' }, { type: 'Text', text: '\n ' }]) }),
    started('malformed'), message({ turnId: 'malformed', item: item('malformed-message', [{ type: 'Text', text: 123 }]) }),
    started('unknown-phase'), message({ turnId: 'unknown-phase', item: { ...item('unknown-message', [{ type: 'Text', text: 'PRIVATE_BODY_SENTINEL' }]), phase: 'unknown' } }),
  ]));
  await collector.poll();
  const snapshot = collector.snapshot();
  const mixed = snapshot.turns.find((turn) => turn.id === 'mixed').messageOutput;
  assert.equal(mixed.characters, 4);
  assert.equal(mixed.charactersPerSecond, 2);
  const malformed = snapshot.turns.find((turn) => turn.id === 'malformed').messageOutput;
  assert.equal(malformed.characters, null);
  assert.equal(malformed.charactersPerSecond, null);
  assert.equal(malformed.reason, 'invalid-content');
  assert.equal(snapshot.turns.find((turn) => turn.id === 'unknown-phase').messageOutput, null);
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE_BODY_SENTINEL'), false);
});

test('context rotation and truncated replay preserve message identity instead of mixing owners', async (t) => {
  const { day, collector } = await setup(t);
  const first = join(day, 'rollout-a.jsonl');
  const second = join(day, 'rollout-b.jsonl');
  await writeFile(first, jsonl([meta(), started(), message()]));
  await writeFile(second, jsonl([meta(), context(), message(), complete()]));
  await collector.poll();
  assert.equal(collector.snapshot().turns.length, 1);
  assert.equal(collector.snapshot().turns[0].messageOutput.characters, 11);
  await writeFile(first, jsonl([meta('other-owner'), started(), message({ text: '不同主人' })]));
  await collector.poll();
  const turns = collector.snapshot().turns;
  assert.equal(turns.length, 2);
  assert.equal(turns.find((turn) => turn.sessionId === 'session-a').messageOutput.characters, 11);
  assert.equal(turns.find((turn) => turn.sessionId === 'other-owner').messageOutput.characters, 4);
});
