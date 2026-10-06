import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskView } from './public/performance-view.mjs';

const now = Date.parse('2026-10-06T12:00:10Z');
const stamp = milliseconds => new Date(now + milliseconds).toISOString();
const turn = (sessionId, id, model = 'alpha', offset = -10000) => ({ sessionId, id, model, status: 'running', startedAt: stamp(offset), outputTokens: 120 });
const stream = (threadId, turnId, itemId, count = 60) => ({ threadId, turnId, itemId, state: 'generating', phase: 'commentary',
  characters: count, windowCharacters: count, charactersPerSecond: count / 3, startedAt: stamp(-2000), lastDeltaAt: stamp(-250), observedAt: stamp(0) });
const generation = streams => ({ status: 'collecting', updatedAt: stamp(0), windowMs: 3000, streams });
const options = extra => ({ now, ...extra });

test('并行任务按会话和轮次分别计算，不能因相同模型或turn ID串线', () => {
  const telemetry = { turns: [turn('s1', 'same'), turn('s2', 'same'), turn('s1', 'next', 'alpha', -1000)] };
  const view = buildTaskView(telemetry, generation([stream('s1', 'same', 'm1'), stream('s2', 'same', 'm2', 120), stream('s1', 'next', 'm3', 30)]), options());
  assert.equal(view.tasks.length, 3);
  assert.equal(view.tasks.find(task => task.sessionId === 's1' && task.turnId === 'same').rate, 20);
  assert.equal(view.tasks.find(task => task.sessionId === 's2').rate, 40);
  assert.equal(view.tasks.find(task => task.turnId === 'next').rate, 10);
});

test('同一任务多个活动消息相加，但不重复计数或保留完成消息的旧速率', () => {
  const first = stream('s', 't', 'm1');
  const view = buildTaskView({ turns: [turn('s', 't')] }, generation([first, first, stream('s', 't', 'm2', 30), { ...stream('s', 't', 'done', 900), state: 'completed' }]), options());
  assert.equal(view.selected.rate, 30);
  assert.equal(view.selected.windowCharacters, 90);
});

test('选中任务不会被新开始的任务抢走，淘汰后不会默默换成其他任务', () => {
  const key = JSON.stringify(['s', 'old']);
  const data = { turns: [turn('s', 'old'), turn('other', 'new', 'beta', -100)] };
  const view = buildTaskView(data, generation([]), options({ selectedKey: key }));
  assert.equal(view.selectedKey, key);
  assert.equal(view.selected.turnId, 'old');
  const expired = buildTaskView({ turns: [data.turns[1]] }, generation([]), options({ selectedKey: key }));
  assert.equal(expired.selected, null);
  assert.equal(expired.selectedKey, key);
});

test('文字完成与整轮完成不同，等待、暂停和真正过期明确区分', () => {
  const item = stream('s', 't', 'm');
  const completedItem = { ...item, state: 'completed', completedAt: stamp(-10) };
  const running = { turns: [turn('s', 't')] };
  const waiting = buildTaskView(running, generation([completedItem]), options()).selected;
  assert.equal(waiting.receptionState, 'waiting');
  assert.equal(waiting.rate, null);
  const completed = buildTaskView({ turns: [{ ...turn('s', 't'), status: 'completed' }] }, generation([completedItem]), options()).selected;
  assert.equal(completed.receptionState, 'completed');
  const paused = buildTaskView(running, generation([{ ...item, lastDeltaAt: stamp(-3001) }]), options()).selected;
  assert.equal(paused.receptionState, 'paused');
  assert.equal(paused.rate, 0);
  const stale = buildTaskView(running, generation([{ ...item, observedAt: stamp(-5001) }]), options()).selected;
  assert.equal(stale.receptionState, 'stale');
  assert.equal(stale.rate, null);
  const disconnected = buildTaskView(running, generation([item]), options({ connected: false })).selected;
  assert.equal(disconnected.receptionState, 'stale');
});

test('未知实时任务保留独立身份，不冒充模型筛选结果', () => {
  const data = generation([stream('unknown', 't', 'm')]);
  const all = buildTaskView({ turns: [] }, data, options());
  assert.equal(all.selected.model, null);
  assert.equal(all.selected.rate, 20);
  assert.equal(buildTaskView({ turns: [] }, data, options({ model: 'alpha' })).tasks.length, 0);
});

test('已确认的轮次终态不被迟到的活动快照或过期快照覆盖', () => {
  for (const status of ['completed', 'cancelled', 'error', 'interrupted']) {
    const telemetry = { turns: [{ ...turn('s', 't'), status }] };
    for (const connected of [true, false]) {
      const task = buildTaskView(telemetry, generation([stream('s', 't', 'm')]), options({ connected })).selected;
      assert.equal(task.status, status);
      assert.equal(task.receptionState, 'completed');
      assert.equal(task.rate, null);
    }
  }
});

test('只有消息完成记录时不能断定未知轮次已经完成', () => {
  const task = buildTaskView({ turns: [] }, generation([{ ...stream('s', 't', 'm'), state: 'completed' }]), options()).selected;
  assert.equal(task.status, 'incomplete');
  assert.equal(task.receptionState, 'waiting');
  assert.equal(task.rate, null);
});

test('另一个正常采集器的心跳不能恢复后端已经撤销的速率', () => {
  const stopped = { ...stream('s', 'stopped', 'm1'), charactersPerSecond: null };
  const healthy = stream('s', 'healthy', 'm2', 120);
  const telemetry = { turns: [turn('s', 'stopped'), turn('s', 'healthy')] };
  const view = buildTaskView(telemetry, generation([stopped, healthy]), options());
  const task = view.tasks.find(item => item.turnId === 'stopped');
  assert.equal(task.rate, null);
  assert.equal(task.receptionState, 'unavailable');
  assert.equal(view.tasks.find(item => item.turnId === 'healthy').rate, 40);
  const partial = buildTaskView(telemetry, generation([stopped, { ...healthy, turnId: 'stopped' }]), options({ selectedKey: task.key })).selected;
  assert.equal(partial.rate, null);
});

test('任务列表有界，固定任务保持可查看，严格按时间而非活动状态排序', () => {
  const turns = Array.from({ length: 100 }, (_, i) => ({ ...turn('s', `t${i}`, 'alpha', -i * 1000), status: i === 50 ? 'running' : 'completed' }));
  const key = JSON.stringify(['s', 't99']);
  const view = buildTaskView({ turns }, generation([]), options({ selectedKey: key }));
  assert.equal(view.tasks.length, 30);
  assert.equal(view.tasks[0].turnId, 't0');
  assert.equal(view.selected.turnId, 't99');
  assert.ok(view.tasks.some(task => task.key === key));
});

test('支持时间正反序，缺少时间排在末尾，切换顺序不改变选中任务', () => {
  const turns = [turn('s', 'old', 'alpha', -9000), { ...turn('s', 'new', 'alpha', -1000), status: 'completed' }, { ...turn('s', 'unknown'), startedAt: null }];
  const selectedKey = JSON.stringify(['s', 'old']);
  const descending = buildTaskView({ turns }, generation([]), options({ selectedKey }));
  assert.deepEqual(descending.tasks.map(item => item.turnId), ['new', 'old', 'unknown']);
  const ascending = buildTaskView({ turns }, generation([]), options({ selectedKey, sortOrder: 'asc' }));
  assert.deepEqual(ascending.tasks.map(item => item.turnId), ['old', 'new', 'unknown']);
  assert.equal(descending.selectedKey, ascending.selectedKey);
});

test('实时流时间使用实际时刻比较，带不同时区的时间不会排错', () => {
  const data = generation([
    { ...stream('s', 'a', 'm1'), startedAt: '2026-10-06T12:00:00+08:00' },
    { ...stream('s', 'a', 'm2'), startedAt: '2026-10-06T05:00:00Z' },
    { ...stream('s', 'b', 'm3'), startedAt: '2026-10-06T04:30:00Z' },
  ]);
  const view = buildTaskView({ turns: [] }, data, options());
  assert.deepEqual(view.tasks.map(item => item.turnId), ['b', 'a']);
  assert.equal(Date.parse(view.tasks[1].startedAt), Date.parse('2026-10-06T04:00:00Z'));
});

test('标题的字符上限与后端一致，不因补充平面字符而丢弃有效标题', () => {
  const title = '🙂'.repeat(256);
  const view = buildTaskView({ turns: [{ ...turn('s', 't'), sessionTitle: title }] }, generation([]), options({ query: '🙂' }));
  assert.equal(view.selected.sessionTitle, title);
});

test('关键词检索会话标题、模型与完整任务身份，支持中文及多个词并先搜索后限量', () => {
  const turns = Array.from({ length: 50 }, (_, i) => ({ ...turn(`session-${i}`, `turn-${i}`, i === 49 ? 'GPT-Alpha' : 'beta', -i * 1000), sessionTitle: i === 49 ? '修复监测器采集' : '其他工作' }));
  const view = buildTaskView({ turns }, generation([]), options({ query: '监测器 gpt-alpha' }));
  assert.equal(view.tasks.length, 1);
  assert.equal(view.matchCount, 1);
  assert.equal(view.selected.turnId, 'turn-49');
  assert.equal(view.selected.sessionTitle, '修复监测器采集');
  assert.equal(buildTaskView({ turns }, generation([]), options({ query: 'SESSION-49 turn-49' })).tasks.length, 1);
  assert.equal(buildTaskView({ turns }, generation([]), options({ query: '监测器', model: 'beta' })).tasks.length, 0);
  assert.equal(buildTaskView({ turns }, generation([]), options({ query: '没有这项任务' })).selected, null);
});

test('缺少合法身份和计数不造数，也不复制正文与凭据字段', () => {
  const raw = { ...stream('s', 't', 'm'), text: 'PRIVATE_CONTENT', token: 'SECRET_TOKEN', windowCharacters: 1000 };
  const view = buildTaskView({ turns: [{ ...turn('s', 't'), text: 'PRIVATE_CONTENT' }] }, generation([raw, stream('', 't', 'bad')]), options());
  assert.equal(view.tasks.length, 1);
  assert.equal(view.selected.rate, null);
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE_CONTENT|SECRET_TOKEN/);
});

test('任务流白名单保留明确的局部采集标记，不据此补算计数或速度', () => {
  const view = buildTaskView({ turns: [turn('s', 't')] }, generation([{ ...stream('s', 't', 'm'), partial: true }]), options());
  assert.equal(view.selected.streams[0].partial, true);
  assert.equal(view.selected.rate, 20);
  const unmarked = buildTaskView({ turns: [turn('s', 't')] }, generation([{ ...stream('s', 't', 'm'), partial: 'true' }]), options());
  assert.equal(unmarked.selected.streams[0].partial, false);
});
