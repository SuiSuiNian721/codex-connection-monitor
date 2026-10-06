// 任务身份始终由会话和轮次共同决定，模型名称只用于筛选。
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value) ? value : null;
const titleText = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && [...value].length <= 256 && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
const metric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const taskKey = (sessionId, turnId) => JSON.stringify([sessionId, turnId]);
const recent = (value, now) => date(value) !== null && Date.parse(value) <= now + 1000 && now - Date.parse(value) <= 5000;
const epoch = value => Date.parse(value) || 0;
const turnStates = new Set(['running', 'completed', 'cancelled', 'error', 'failed', 'idle', 'interrupted', 'incomplete']);

function cleanMessage(value) {
  if (!value || typeof value !== 'object') return null;
  return { itemId: identifier(value.itemId), phase: ['commentary', 'final_answer'].includes(value.phase) ? value.phase : null,
    startedAt: date(value.startedAt), completedAt: date(value.completedAt), durationMs: metric(value.durationMs),
    characters: count(value.characters), charactersPerSecond: metric(value.charactersPerSecond),
    reason: ['missing-timing', 'invalid-timing', 'short-window', 'empty-output', 'invalid-content'].includes(value.reason) ? value.reason : value.reason ? 'invalid-timing' : null };
}

function cleanTurn(value) {
  if (!identifier(value?.sessionId) || !identifier(value.id)) return null;
  return { sessionId: value.sessionId, id: value.id, sessionTitle: titleText(value.sessionTitle), model: identifier(value.model), effort: identifier(value.effort), provider: identifier(value.provider),
    status: turnStates.has(value.status) ? value.status : 'incomplete', startedAt: date(value.startedAt), completedAt: date(value.completedAt),
    outputTokens: count(value.outputTokens), reasoningTokens: count(value.reasoningTokens), durationMs: metric(value.durationMs),
    ttftMs: metric(value.ttftMs), throughputTps: metric(value.throughputTps), messageOutput: cleanMessage(value.messageOutput),
    warnings: (Array.isArray(value.warnings) ? value.warnings : []).filter(item => typeof item === 'string' && item.length <= 512).slice(0, 16) };
}

function cleanStream(value, updatedAt) {
  if (!identifier(value?.threadId) || !identifier(value.turnId) || !identifier(value.itemId) || !['waiting', 'generating', 'completed'].includes(value.state)) return null;
  const characters = count(value.characters);
  const windowCharacters = count(value.windowCharacters);
  const validWindow = characters !== null && windowCharacters !== null && windowCharacters <= characters;
  return { threadId: value.threadId, turnId: value.turnId, itemId: value.itemId, state: value.state, partial: value.partial === true,
    phase: ['commentary', 'final_answer'].includes(value.phase) ? value.phase : null,
    characters, windowCharacters: validWindow ? windowCharacters : null,
    charactersPerSecond: validWindow && metric(value.charactersPerSecond) !== null && value.state !== 'completed' ? windowCharacters / 3 : null,
    startedAt: date(value.startedAt), lastDeltaAt: date(value.lastDeltaAt), completedAt: date(value.completedAt),
    observedAt: date(Object.hasOwn(value, 'observedAt') ? value.observedAt : updatedAt) };
}

export function buildTaskView(telemetry, generation, { model = '', query = '', sortOrder = 'desc', selectedKey = '', connected = true, now = Date.now() } = {}) {
  const keywords = (typeof query === 'string' ? query.slice(0, 256) : '').normalize('NFKC').toLowerCase().trim().split(/\s+/).filter(Boolean).slice(0, 16);
  const grouped = new Map();
  const get = (sessionId, turnId) => {
    const key = taskKey(sessionId, turnId);
    if (!grouped.has(key)) grouped.set(key, { key, sessionId, turnId, turn: null, items: new Map() });
    return grouped.get(key);
  };
  for (const value of (Array.isArray(telemetry?.turns) ? telemetry.turns : []).slice(0, 200)) {
    const turn = cleanTurn(value);
    if (turn) get(turn.sessionId, turn.id).turn = turn;
  }
  for (const value of (Array.isArray(generation?.streams) ? generation.streams : []).slice(0, 40)) {
    const stream = cleanStream(value, generation?.updatedAt);
    if (!stream) continue;
    const task = get(stream.threadId, stream.turnId);
    const previous = task.items.get(stream.itemId);
    if (!previous || epoch(stream.observedAt) > epoch(previous.observedAt)) task.items.set(stream.itemId, stream);
  }
  const fresh = connected && ['idle', 'collecting'].includes(generation?.status) && recent(generation?.updatedAt, now);
  const tasks = [];
  for (const task of grouped.values()) {
    const taskModel = task.turn?.model ?? null;
    if (model && taskModel !== model) continue;
    const sessionTitle = task.turn?.sessionTitle ?? null;
    const searchable = [sessionTitle, taskModel, task.sessionId, task.turnId].filter(Boolean).join(' ').normalize('NFKC').toLowerCase();
    if (!keywords.every(keyword => searchable.includes(keyword))) continue;
    const streams = [...task.items.values()].sort((a, b) => epoch(b.lastDeltaAt || b.startedAt) - epoch(a.lastDeltaAt || a.startedAt));
    const active = streams.filter(item => item.state !== 'completed');
    const status = task.turn?.status ?? (active.length ? 'running' : 'incomplete');
    const terminal = ['completed', 'cancelled', 'error', 'failed', 'interrupted'].includes(status);
    let receptionState = terminal ? 'completed' : 'waiting';
    let rate = null;
    let windowCharacters = null;
    // 已确认的轮次结束优先于另一路尚未更新的文字快照。
    if (!terminal && !fresh) {
      receptionState = !connected || generation?.status === 'stale' || (date(generation?.updatedAt) && !recent(generation.updatedAt, now)) ? 'stale' : 'unavailable';
    } else if (!terminal && active.length) {
      if (active.some(item => !recent(item.observedAt, now))) receptionState = 'stale';
      else if (active.some(item => item.characters > 0 && item.charactersPerSecond === null)) receptionState = 'unavailable';
      else {
        const measurable = active.filter(item => item.characters > 0 && item.windowCharacters !== null && date(item.lastDeltaAt) && epoch(item.lastDeltaAt) <= now + 1000);
        if (measurable.length) {
          windowCharacters = measurable.reduce((sum, item) => sum + (now - epoch(item.lastDeltaAt) >= 3000 ? 0 : item.windowCharacters), 0);
          rate = windowCharacters / 3;
          receptionState = rate > 0 ? 'receiving' : 'paused';
        }
      }
    }
    tasks.push({ key: task.key, sessionId: task.sessionId, turnId: task.turnId, sessionTitle, model: taskModel,
      startedAt: task.turn?.startedAt ?? streams.map(item => item.startedAt).filter(Boolean).sort((a, b) => epoch(a) - epoch(b))[0] ?? null,
      status, turn: task.turn, streams, rate, windowCharacters, receptionState,
      lastOutputAt: streams.map(item => item.lastDeltaAt).filter(Boolean).sort((a, b) => epoch(a) - epoch(b)).at(-1) ?? null });
  }
  tasks.sort((a, b) => Number(Boolean(b.startedAt)) - Number(Boolean(a.startedAt))
    || (sortOrder === 'asc' ? 1 : -1) * (epoch(a.startedAt) - epoch(b.startedAt)) || a.key.localeCompare(b.key));
  const key = selectedKey || tasks[0]?.key || '';
  const selected = tasks.find(task => task.key === key) ?? null;
  const visible = tasks.slice(0, 30);
  if (selected && !visible.some(task => task.key === selected.key)) visible[visible.length - 1] = selected;
  return { tasks: visible, selected, selectedKey: key, matchCount: tasks.length };
}
