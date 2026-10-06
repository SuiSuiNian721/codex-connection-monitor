const isMetric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const numberFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

export function formatNumber(value) {
  return isMetric(value) ? numberFormatter.format(value) : '—';
}

export function formatDuration(value) {
  if (!isMetric(value)) return '—';
  if (value < 1000) return `${numberFormatter.format(Math.round(value))} ms`;
  if (value < 60000) return `${numberFormatter.format(value / 1000)} s`;
  const minutes = Math.floor(value / 60000);
  const seconds = Math.floor((value % 60000) / 1000);
  return `${numberFormatter.format(minutes)} min ${seconds} s`;
}

export function selectTurns(turns, model = '') {
  if (!Array.isArray(turns)) return [];
  return turns.filter(turn => turn && (!model || turn.model === model))
    .sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0));
}

export function trendSamples(turns, model = '', limit = 12) {
  const sorted = selectTurns(turns);
  const selectedModel = model || sorted.find(turn => typeof turn.model === 'string' && turn.model)?.model || '';
  return {
    model: selectedModel,
    turns: selectedModel ? selectTurns(sorted, selectedModel).slice(0, limit).reverse() : [],
  };
}

const messageReasons = {
  'missing-timing': '缺少消息开始或完成时间。',
  'invalid-timing': '消息时间记录无效，无法计算速度。',
  'short-window': '记录时窗过短，可能是补记或重放，不计算速度。',
  'empty-output': '没有可统计的文字输出。',
  'invalid-content': '文字记录不完整，无法计算速度。',
};

export function messageOutputState(output) {
  if (!output || typeof output !== 'object') return { rate: null, reason: '本轮尚无可计算的已完成文字消息。' };
  const startedAt = Date.parse(output.startedAt);
  const completedAt = Date.parse(output.completedAt);
  const valid = !output.reason && isMetric(output.charactersPerSecond) && isMetric(output.characters)
    && isMetric(output.durationMs) && output.durationMs >= 1000 && Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt > startedAt;
  return { rate: valid ? output.charactersPerSecond : null,
    reason: valid ? '' : messageReasons[output.reason] || '缺少有效的完成消息时窗。' };
}

export function generationState(generation, turns = [], model = '', connected = true, now = Date.now()) {
  const timestamp = Date.parse(generation?.updatedAt);
  const ageMs = Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : null;
  const known = ['waiting-launch', 'collecting', 'idle', 'stale', 'unavailable'];
  let status = known.includes(generation?.status) ? generation.status : 'unavailable';
  if (!connected || (ageMs !== null && (ageMs > 5000 || timestamp > now + 1000))) status = 'stale';
  if (ageMs === null && ['collecting', 'idle'].includes(status)) status = 'unavailable';
  const fresh = connected && ['collecting', 'idle'].includes(status);
  const windowMs = isMetric(generation?.windowMs) && generation.windowMs > 0 ? generation.windowMs : 3000;
  const streams = (Array.isArray(generation?.streams) ? generation.streams : []).filter(item => item && typeof item === 'object').slice(0, 20).map(item => {
    const turn = selectTurns(turns).find(turn => typeof item.threadId === 'string' && typeof item.turnId === 'string'
      && item.threadId === turn.sessionId && item.turnId === turn.id);
    const deltaAt = Date.parse(item.lastDeltaAt);
    const deltaAgeMs = Number.isFinite(deltaAt) ? Math.max(0, now - deltaAt) : null;
    const observedAt = Object.hasOwn(item, 'observedAt') ? item.observedAt : generation?.updatedAt;
    const observedTimestamp = Date.parse(observedAt);
    const observationAgeMs = Number.isFinite(observedTimestamp) ? Math.max(0, now - observedTimestamp) : null;
    const streamFresh = fresh && observationAgeMs !== null && observationAgeMs <= 5000 && observedTimestamp <= now + 1000;
    const measurable = streamFresh && ['generating', 'waiting'].includes(item.state) && isMetric(item.charactersPerSecond)
      && isMetric(item.characters) && item.characters > 0 && deltaAgeMs !== null && deltaAt <= now + 1000;
    const paused = deltaAgeMs !== null && deltaAgeMs >= windowMs;
    return { threadId: typeof item.threadId === 'string' ? item.threadId : '', turnId: typeof item.turnId === 'string' ? item.turnId : '',
      itemId: typeof item.itemId === 'string' ? item.itemId : '', phase: ['final_answer', 'commentary'].includes(item.phase) ? item.phase : null,
      state: ['generating', 'waiting', 'completed'].includes(item.state) ? item.state : null,
      model: typeof turn?.model === 'string' && turn.model ? turn.model : null,
      characters: isMetric(item.characters) ? item.characters : null,
      windowCharacters: measurable ? paused ? 0 : isMetric(item.windowCharacters) ? item.windowCharacters : null : null,
      rate: measurable ? paused ? 0 : item.charactersPerSecond : null,
      startedAt: item.startedAt, lastDeltaAt: item.lastDeltaAt, completedAt: item.completedAt, deltaAgeMs,
      observedAt, observationAgeMs, fresh: streamFresh };
  }).sort((a, b) => (Date.parse(b.lastDeltaAt || b.startedAt) || 0) - (Date.parse(a.lastDeltaAt || a.startedAt) || 0));
  const primary = fresh ? streams.find(item => item.fresh && ['generating', 'waiting'].includes(item.state) && (!model || item.model === model)) || null : null;
  return { status, ageMs, fresh, windowMs, streams, primary };
}

export function generationCaptureNote(generation, state) {
  const health = generation?.captureHealth;
  if (!state?.fresh || health?.state !== 'ok' || !Number.isSafeInteger(health.recoveries) || health.recoveries < 0) return '';
  if (typeof health.reattachedAt === 'string' && Number.isFinite(Date.parse(health.reattachedAt))) return '采集已恢复，累计从恢复后开始，未补算中断时段。';
  return health.recoveries > 0 ? '本地快照写入曾失败，现已自动恢复。' : '';
}

function displayText(value) {
  if (value === null || value === undefined || value === '') return '—';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function node(tag, className = '', content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = displayText(content);
  return element;
}

function statusName(status) {
  return ({ running: '进行中', completed: '已完成', cancelled: '已取消', error: '运行错误', failed: '运行错误', idle: '尚未开始', interrupted: '已中断', incomplete: '记录不完整' })[status] || displayText(status);
}

const networkStageNames = { local: '本地网络', proxy: '本机代理', vpn: 'VPN / 出口路径', openai: 'OpenAI 路径' };
const networkStatusNames = { ok: '正常', warning: '需关注', error: '异常', unknown: '信息不足', checking: '检测中', stale: '已过期' };
const networkStepNames = { dns: 'DNS 解析', tcp: 'TCP 连接', 'proxy-connect': '代理 CONNECT', 'proxy-tls': '代理 TLS', tls: 'TLS 握手', http: 'HTTP 响应', inventory: '网络信息读取' };
const confidenceNames = { confirmed: '已确认', suspected: '疑似', insufficient: '信息不足' };

function networkText(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function networkLines(value) {
  return (Array.isArray(value) ? value : [value]).map(networkText).filter(Boolean);
}

function networkAge(value, now = Date.now()) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : null;
}

export function networkStageState(stage, connected = true, now = Date.now()) {
  if (!stage || typeof stage !== 'object') return { status: 'unknown', ageMs: null };
  const ageMs = networkAge(stage.checkedAt, now);
  const staleAfterMs = isMetric(stage.staleAfterMs) ? stage.staleAfterMs : 45000;
  if (!connected && ageMs !== null) return { status: 'stale', ageMs };
  if (!connected) return { status: 'unknown', ageMs };
  if (ageMs !== null && ageMs > staleAfterMs) return { status: 'stale', ageMs };
  const status = Object.hasOwn(networkStatusNames, stage.status) ? stage.status : 'unknown';
  if (ageMs === null && (status === 'ok' || status === 'warning' || status === 'error')) return { status: 'unknown', ageMs };
  return { status, ageMs };
}

function networkAgeText(ageMs) {
  if (ageMs === null) return '尚无检测时间';
  return ageMs < 1000 ? '刚刚' : `${formatDuration(ageMs)} 前`;
}

function svgNode(tag, attributes, content) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  if (content !== undefined) element.textContent = content;
  return element;
}

function drawTrend(container, samples) {
  container.replaceChildren();
  const measurable = samples.turns.filter(turn => isMetric(turn.throughputTps));
  if (!measurable.length) {
    container.append(node('p', 'trend-empty', '还没有可计算整轮吞吐的记录'));
    return;
  }
  const containerStyle = getComputedStyle(container);
  const width = Math.max(70, container.clientWidth - parseFloat(containerStyle.paddingLeft) - parseFloat(containerStyle.paddingRight));
  const height = 145;
  const left = 50;
  const right = 18;
  const top = 14;
  const bottom = 29;
  const maximum = Math.max(1, ...measurable.map(turn => turn.throughputTps));
  const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-labelledby': 'trend-title trend-description', preserveAspectRatio: 'xMidYMid meet' });
  svg.append(svgNode('title', { id: 'trend-title' }, `${samples.model} 的整轮平均吞吐趋势`));
  svg.append(svgNode('desc', { id: 'trend-description' }, samples.turns.map(turn => `${formatDate(turn.startedAt)}：${formatNumber(turn.throughputTps)} token/秒`).join('；')));
  for (const ratio of [0, .5, 1]) {
    const y = top + (height - top - bottom) * (1 - ratio);
    svg.append(svgNode('line', { x1: left, y1: y, x2: width - right, y2: y, class: 'trend-grid' }));
    svg.append(svgNode('text', { x: left - 10, y: y + 4, 'text-anchor': 'end', class: 'trend-axis-label' }, formatNumber(maximum * ratio)));
  }
  const points = [];
  let segment = [];
  const appendSegment = () => {
    if (segment.length > 1) svg.append(svgNode('polyline', { points: segment.join(' '), class: 'trend-line' }));
    segment = [];
  };
  samples.turns.forEach((turn, index) => {
    const x = samples.turns.length === 1 ? (width + left - right) / 2 : left + (width - left - right) * index / (samples.turns.length - 1);
    if (!isMetric(turn.throughputTps)) { appendSegment(); return; }
    const y = top + (height - top - bottom) * (1 - turn.throughputTps / maximum);
    segment.push(`${x},${y}`);
    const point = svgNode('circle', { cx: x, cy: y, r: 4.5, class: 'trend-point' });
    point.append(svgNode('title', {}, `${formatDate(turn.startedAt)} · ${formatNumber(turn.throughputTps)} token/s`));
    points.push(point);
  });
  appendSegment();
  svg.append(...points);
  svg.append(svgNode('text', { x: left, y: height - 5, class: 'trend-axis-label' }, '较早'));
  svg.append(svgNode('text', { x: width - right, y: height - 5, 'text-anchor': 'end', class: 'trend-axis-label' }, '较新'));
  container.append(svg);
}

function preserveDetails(container, render) {
  const open = new Set([...container.querySelectorAll('details[open][data-persist]')].map(item => item.dataset.persist));
  const focused = document.activeElement?.closest('details[data-persist]');
  const focusedId = focused && container.contains(focused) ? focused.dataset.persist : null;
  render();
  container.querySelectorAll('details[data-persist]').forEach(item => {
    item.open = open.has(item.dataset.persist);
    if (focusedId && item.dataset.persist === focusedId) item.querySelector('summary')?.focus({ preventScroll: true });
  });
}

function startDashboard() {
  const $ = id => document.getElementById(id);
  let snapshot = null;
  let refreshPromise = null;
  let timer = null;
  let telemetrySignature = '';
  let modelsSignature = '';
  let collectorConnected = false;
  let networkSignature = '';
  let generationSignature = '';

  function setConnection(ok, error = '') {
    collectorConnected = ok;
    $('connection-dot').className = `status-dot ${ok ? 'connected' : 'offline'}`;
    $('connection-label').textContent = ok ? '本地采集器已连接 · 关闭此页面不影响采集' : '暂时无法连接本地采集器';
    $('connection-error').hidden = ok;
    $('connection-error').textContent = ok ? '' : `${snapshot ? '已保留上次成功读取的数据。' : '尚未读取到后台数据。'}${error} 页面会自动重试；此状态仅反映与本地采集器的连接，不能判断外网、VPN 或 OpenAI 的网络状况。`;
    renderNetwork();
    renderGeneration();
    updateControls();
  }

  function updateControls() {
    $('refresh-button').disabled = Boolean(refreshPromise);
  }

  function updateModels(turns) {
    const models = [...new Set(selectTurns(turns).map(turn => turn.model).filter(model => typeof model === 'string' && model))];
    const signature = JSON.stringify(models);
    if (signature !== modelsSignature) {
      const selected = $('model-filter').value;
      if (selected && !models.includes(selected)) models.push(selected);
      $('model-filter').replaceChildren(node('option', '', '全部模型'));
      $('model-filter').firstChild.value = '';
      models.forEach(model => {
        const filterOption = node('option', '', model);
        filterOption.value = model;
        $('model-filter').append(filterOption);
      });
      $('model-filter').value = selected;
      modelsSignature = signature;
    }
  }

  function renderTelemetry(force = false) {
    const telemetry = snapshot.telemetry || {};
    const filter = $('model-filter').value;
    const signature = JSON.stringify([telemetry, filter]);
    if (!force && signature === telemetrySignature) return;
    telemetrySignature = signature;
    const turns = selectTurns(telemetry.turns, filter);
    const latest = turns[0];
    $('metric-ttft').textContent = formatDuration(latest?.ttftMs);
    $('metric-output').textContent = formatNumber(latest?.outputTokens);
    $('metric-reasoning').textContent = formatNumber(latest?.reasoningTokens);
    $('metric-throughput').textContent = formatNumber(latest?.throughputTps);
    const message = messageOutputState(latest?.messageOutput);
    $('metric-message-speed').textContent = formatNumber(message.rate);
    $('message-speed-description').textContent = message.reason || `${latest.messageOutput.phase === 'final_answer' ? '最终回答' : '中间回复'} · ${formatNumber(latest.messageOutput.characters)} 字符 / ${formatDuration(latest.messageOutput.durationMs)} · 完成于 ${formatDate(latest.messageOutput.completedAt)}`;
    $('latest-turn-label').textContent = latest
      ? `${formatDate(latest.startedAt)} · ${displayText(latest.model)} · ${displayText(latest.effort)} · ${statusName(latest.status)}${latest.warnings?.length ? ' · 此轮存在采集提示，见下表' : ''}`
      : filter ? '这个模型暂无轮次记录；指标显示为“—”。' : '等待本地会话记录；没有记录时，指标显示为“—”。';
    $('record-count').textContent = `${turns.length} 条${turns.length > 50 ? ' · 展示最近 50 条' : ''}`;
    const rows = document.createDocumentFragment();
    turns.slice(0, 50).forEach(turn => {
      const row = node('tr');
      const time = node('td', '', formatDate(turn.startedAt));
      time.append(node('span', 'cell-secondary', statusName(turn.status)));
      time.title = `轮次 ${displayText(turn.id)} · 会话 ${displayText(turn.sessionId)}`;
      const model = node('td', '', displayText(turn.model));
      model.append(node('span', 'cell-secondary', `${displayText(turn.effort)} · ${displayText(turn.provider)}`));
      if (Array.isArray(turn.warnings) && turn.warnings.length) {
        const details = node('details', 'cell-secondary cell-warning');
        details.dataset.persist = `turn-${turn.id}`;
        details.append(node('summary', '', `${turn.warnings.length} 条采集提示`));
        turn.warnings.forEach(warning => details.append(node('p', '', displayText(warning))));
        model.append(details);
      }
      const message = messageOutputState(turn.messageOutput);
      const messageSpeed = node('td', '', formatNumber(message.rate));
      messageSpeed.title = message.reason || `${turn.messageOutput.phase === 'final_answer' ? '最终回答' : '中间回复'} · ${formatNumber(turn.messageOutput.characters)} 字符 / ${formatDuration(turn.messageOutput.durationMs)}`;
      row.append(time, model, node('td', '', formatDuration(turn.ttftMs)), node('td', '', formatNumber(turn.outputTokens)), node('td', '', formatNumber(turn.reasoningTokens)), node('td', '', formatDuration(turn.durationMs)), node('td', '', formatNumber(turn.throughputTps)), messageSpeed);
      rows.append(row);
    });
    if (!turns.length) {
      const row = node('tr');
      const cell = node('td', 'empty-cell', '暂无轮次记录。继续使用 Codex，后台会自动采集可观测数据。');
      cell.colSpan = 8;
      row.append(cell);
      rows.append(row);
    }
    preserveDetails($('turn-rows'), () => $('turn-rows').replaceChildren(rows));
    const samples = trendSamples(telemetry.turns, filter);
    $('trend-caption').textContent = samples.model ? `${samples.model} · ${samples.turns.length} 个轮次 · 整轮平均 token/s` : '等待同一模型的轮次记录';
    drawTrend($('trend-container'), samples);
    const source = telemetry.source || {};
    $('source-summary').textContent = `扫描 ${formatNumber(source.scannedFiles)} 个文件 · 错误 ${formatNumber(source.errors)} · 截断 ${formatNumber(source.truncatedFiles)}`;
    const sourceContent = document.createDocumentFragment();
    sourceContent.append(node('p', '', `采集更新时间：${formatDate(telemetry.updatedAt)}。记录缺失、截断或时间不可观测时，不将未知指标填为 0。`));
    const warnings = Array.isArray(telemetry.warnings) ? telemetry.warnings : [];
    if (warnings.length) {
      const list = node('ul');
      warnings.forEach(warning => list.append(node('li', '', displayText(warning))));
      sourceContent.append(list);
    } else sourceContent.append(node('p', '', '暂无额外采集提示。'));
    $('source-warnings').replaceChildren(sourceContent);
  }

  function renderGeneration() {
    const generation = snapshot?.generation;
    const filter = $('model-filter').value;
    const state = generationState(generation, snapshot?.telemetry?.turns, filter, collectorConnected);
    const signature = JSON.stringify([generation, collectorConnected, filter, state.status, Math.floor((state.ageMs || 0) / 1000), state.streams]);
    if (signature === generationSignature) return;
    generationSignature = signature;
    const completed = state.fresh && !state.primary && state.streams.length > 0 && state.streams.every(stream => stream.fresh && stream.state === 'completed');
    const labels = { 'waiting-launch': '等待正常启动', collecting: '正在接收文字', idle: '等待文字输出', stale: '实时数据已过期', unavailable: '实时采集不可用' };
    $('generation-status').textContent = completed ? '本条已完成'
      : state.status === 'collecting' && !state.primary ? '实时采集已连接'
      : state.fresh && state.primary?.rate === null ? '等待文字输出'
      : state.primary?.rate === 0 ? '本窗口无新文字' : labels[state.status];
    $('metric-live-speed').textContent = formatNumber(state.primary?.rate);
    $('metric-live-speed').closest('.live-speed-card').dataset.state = state.status;
    let description;
    if (state.status === 'waiting-launch') description = '实时采集将在下次正常启动 Codex 后生效；当前会话继续正常使用即可。';
    else if (state.status === 'stale') description = !collectorConnected ? '本地采集器未连接，当前速度未知；已停止显示上次实时速度。'
      : ['stale', 'unavailable'].includes(generation?.status) && networkText(generation?.reason) ? generation.reason
      : '实时记录超过 5 秒未更新，当前速度未知。下方保留旧记录供参考。';
    else if (state.status === 'unavailable') description = networkText(generation?.reason) || '暂时没有可用的实时采集数据，历史消息均速仍可查看。';
    else if (completed) description = '本条文字消息已完成。等待下一条文字输出，不将最后一个窗口的速度继续显示。';
    else if (state.primary) {
      const stream = state.primary;
      const identity = stream.model || '未知模型（尚未与本地轮次记录匹配）';
      description = `${identity} · ${stream.phase === 'final_answer' ? '最终回答' : '中间回复'} · ${stream.rate === 0 ? '最近 3 秒没有收到新文字；这不代表断网。' : stream.rate === null ? '等待可统计的文字片段。' : `窗口收到 ${formatNumber(stream.windowCharacters)} 字符；本条累计 ${formatNumber(stream.characters)} 字符。`}`;
    } else description = filter ? '当前模型暂无已绑定的实时输出；下方独立列出其他模型与未知模型的记录。' : '等待文字输出。思考或工具执行期间可能没有文字片段。';
    $('live-speed-description').textContent = description;
    const captureNote = generationCaptureNote(generation, state);
    $('generation-capture-note').textContent = captureNote;
    $('generation-capture-note').hidden = !captureNote;
    $('generation-updated-at').textContent = `采集更新 ${formatDate(generation?.updatedAt)} · ${networkAgeText(state.ageMs)}`;
    $('generation-stream-count').textContent = `${state.streams.length} 条 · 独立列出全部实时会话`;
    const streams = document.createDocumentFragment();
    const shortId = value => value ? value.length > 12 ? `${value.slice(0, 12)}…` : value : '未知';
    state.streams.forEach(stream => {
      const item = node('li');
      item.dataset.item = stream.itemId;
      const heading = node('div', 'generation-stream-heading');
      const phase = stream.phase === 'final_answer' ? '最终回答' : '中间回复';
      const streamState = !stream.fresh ? '旧记录' : stream.state === 'completed' ? '已完成' : stream.rate === 0 ? '本窗口无新文字' : stream.state === 'waiting' ? '等待文字' : '接收中';
      heading.append(node('span', '', `${stream.model || '未知模型'} · ${phase} · ${streamState}`));
      const rate = node('span', 'generation-stream-rate', `${formatNumber(stream.rate)} 字符/s`);
      rate.dataset.rate = stream.rate === null ? '' : String(stream.rate);
      heading.append(rate);
      item.append(heading);
      item.append(node('p', 'generation-stream-meta', `会话 ${shortId(stream.threadId)} · 轮次 ${shortId(stream.turnId)} · 累计 ${formatNumber(stream.characters)} 字符 · 最近片段 ${formatDate(stream.lastDeltaAt)}`));
      streams.append(item);
    });
    if (!state.streams.length) streams.append(node('li', '', state.status === 'waiting-launch' ? '下次正常启动后，文字流记录会显示在这里。' : '暂无实时文字流记录。'));
    $('generation-streams').replaceChildren(streams);
  }

  function renderNetwork() {
    const network = snapshot?.network;
    const stages = Array.isArray(network?.stages)
      ? Object.fromEntries(network.stages.filter(stage => stage && typeof stage.id === 'string').map(stage => [stage.id, stage]))
      : network?.stages || {};
    const now = Date.now();
    const states = Object.fromEntries(Object.keys(networkStageNames).map(id => [id, networkStageState(stages[id], collectorConnected, now)]));
    const signature = JSON.stringify([network, collectorConnected, Object.values(states).map(state => [state.status, state.ageMs === null ? null : Math.floor(state.ageMs / 1000)])]);
    if (signature === networkSignature) return;
    networkSignature = signature;
    const old = Object.values(states).some(state => state.status === 'stale');
    const diagnosis = network?.diagnosis || {};
    const unavailable = !network || !collectorConnected || old;
    const confidence = unavailable ? 'insufficient' : confidenceNames[diagnosis.confidence] ? diagnosis.confidence : 'insufficient';
    const status = unavailable ? 'unknown' : Object.hasOwn(networkStatusNames, diagnosis.status) ? diagnosis.status : 'unknown';
    $('network-diagnosis').className = `network-diagnosis network-tone-${status}`;
    $('network-confidence').textContent = confidenceNames[confidence];
    $('network-summary').textContent = !network ? '正在准备网络检测'
      : !collectorConnected ? '本地采集器未连接，当前网络状态未知'
      : old ? '部分检测结果已过期，等待新结果'
      : networkText(diagnosis.summary) || (network.checking ? '正在检测网络各环节' : '等待足够的检测依据');
    const advice = unavailable
      ? !network ? ['等待后台返回本地网络、代理、VPN 出口和 OpenAI 路径的检测结果。']
        : !collectorConnected ? ['保留上次检测记录供参考；重新连接前，不把旧结果视为当前正常。'] : ['已保留上次记录。以各环节的最近检测时间为准，后台会继续检测。']
      : networkLines(diagnosis.suggestion);
    const diagnosisEvidence = unavailable ? [] : networkLines(diagnosis.evidence);
    const failedStage = networkStageNames[diagnosis.failedStage];
    const failedStep = networkStepNames[diagnosis.failedStep] || networkText(diagnosis.failedStep);
    const incident = !unavailable && failedStage ? `${failedStep ? '失败' : '提示'}环节：${failedStage}${failedStep ? ` / ${failedStep}` : ''}。` : '';
    const sinceAge = networkAge(diagnosis.since, now);
    const duration = !unavailable && sinceAge !== null && status !== 'ok' ? `已持续 ${formatDuration(sinceAge)}。` : '';
    $('network-advice').textContent = [incident, duration, ...diagnosisEvidence, ...advice].filter(Boolean).join(' ');
    $('network-updated-at').textContent = network?.updatedAt
      ? `检测更新 ${formatDate(network.updatedAt)}${network.checking ? ' · 检测中' : ''}` : '等待首次检测';

    const context = network?.context || {};
    const contextContent = document.createDocumentFragment();
    contextContent.append(node('p', 'network-route-label', networkText(context.label) || '等待确认当前检测路径'));
    const route = node('dl', 'network-route');
    const entryLabel = context.boundToCodex === false || context.source === 'system' || context.source === 'unknown' ? '当前检测入口' : 'Codex 入口';
    for (const [key, label] of [['codexEntry', entryLabel], ['systemProxy', '系统代理'], ['relayUpstream', '中转上游']]) {
      const value = networkText(context[key]);
      if (value) route.append(node('dt', '', label), node('dd', '', value));
    }
    if (route.childElementCount) contextContent.append(route);
    contextContent.append(node('p', 'small muted', networkText(context.attribution) || '尚未确认检测路径是否对应当前 Codex；检测结果只描述所选路径。'));
    if (networkText(context.warning)) contextContent.append(node('p', 'small network-context-warning', context.warning));
    $('network-context').replaceChildren(contextContent);

    preserveDetails($('network-stages'), () => {
      const cards = document.createDocumentFragment();
      Object.entries(networkStageNames).forEach(([id, label], index) => {
        const stage = stages[id] || {};
        const state = states[id];
        const card = node('article', `network-stage network-tone-${state.status}`);
        card.dataset.stage = id;
        card.dataset.status = state.status;
        const heading = node('div', 'network-stage-heading');
        heading.append(node('h3', '', `${index + 1}. ${label}`), node('span', 'network-badge', networkStatusNames[state.status]));
        card.append(heading);
        card.append(node('p', 'network-stage-summary', networkText(stage.summary) || '等待检测结果'));
        if (state.status === 'stale') card.append(node('p', 'network-stage-stale', collectorConnected ? '此结果已过期，不代表当前状态。' : '采集器未连接，此处为上次记录。'));
        if (networkText(stage.detail)) card.append(node('p', 'network-stage-detail', stage.detail));
        const facts = node('dl', 'network-facts');
        facts.append(node('dt', '', '检测耗时'), node('dd', '', formatDuration(stage.latencyMs)));
        const failedStep = networkStepNames[stage.failedStep] || networkText(stage.failedStep);
        if (failedStep) facts.append(node('dt', '', '失败步骤'), node('dd', '', failedStep));
        if (isMetric(stage.httpStatus)) facts.append(node('dt', '', 'HTTP 响应'), node('dd', '', String(stage.httpStatus)));
        if (networkText(stage.errorCode)) facts.append(node('dt', '', '错误代码'), node('dd', '', stage.errorCode));
        card.append(facts);
        const evidence = networkLines(stage.evidence);
        const suggestions = networkLines(stage.suggestion);
        if (evidence.length || suggestions.length) {
          const details = node('details', 'network-stage-evidence');
          details.dataset.persist = `network-${id}`;
          details.append(node('summary', '', '检测依据与建议'));
          evidence.forEach(text => details.append(node('p', '', text)));
          suggestions.forEach(text => details.append(node('p', 'network-suggestion', `建议：${text}`)));
          card.append(details);
        }
        const checked = node('p', 'network-stage-time', `最近检测 ${formatDate(stage.checkedAt)} · ${networkAgeText(state.ageMs)}`);
        checked.dataset.age = state.ageMs === null ? '' : String(Math.floor(state.ageMs / 1000));
        card.append(checked);
        cards.append(card);
      });
      $('network-stages').replaceChildren(cards);
    });

    const history = Array.isArray(network?.history) ? network.history.filter(event => event && typeof event === 'object').slice(-20).reverse() : [];
    $('network-history-count').textContent = `${history.length} 条 · 最多保留 20 条`;
    const historyContent = document.createDocumentFragment();
    history.forEach(event => {
      const item = node('li');
      item.append(node('time', '', formatDate(event.at)), node('span', '', [networkStageNames[event.stage], networkText(event.summary) || networkStatusNames[event.status], confidenceNames[event.confidence]].filter(Boolean).join(' · ')));
      historyContent.append(item);
    });
    if (!history.length) historyContent.append(node('li', '', '暂无状态变化记录。'));
    $('network-history').replaceChildren(historyContent);
  }

  function render() {
    updateModels(snapshot.telemetry?.turns);
    renderTelemetry();
    renderNetwork();
    renderGeneration();
    $('updated-at').textContent = `读取于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} · 每秒`;
    $('service-info').textContent = `Monitor v${displayText(snapshot.version)} · 启动于 ${formatDate(snapshot.startedAt)}`;
    updateControls();
  }

  async function readResponse(response) {
    let data;
    try { data = await response.json(); } catch { throw new Error(`后台返回了无法读取的响应（HTTP ${response.status}）。`); }
    if (!response.ok) {
      const message = typeof data.error === 'string' ? data.error : data.error?.message || data.message;
      throw new Error(message || `请求失败（HTTP ${response.status}）。`);
    }
    return data;
  }

  function refreshStatus() {
    if (refreshPromise) return refreshPromise;
    clearTimeout(timer);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    refreshPromise = (async () => {
      try {
        const data = await readResponse(await fetch('/api/status', { cache: 'no-store', signal: controller.signal }));
        if (!data || typeof data !== 'object' || !data.telemetry) throw new Error('后台状态数据不完整。');
        snapshot = data;
        setConnection(true);
        render();
      } catch (error) {
        setConnection(false, error.name === 'AbortError' ? '读取状态超时。' : error.message);
      } finally {
        clearTimeout(timeout);
        refreshPromise = null;
        timer = setTimeout(refreshStatus, 1000);
        updateControls();
      }
    })();
    updateControls();
    return refreshPromise;
  }

  $('refresh-button').addEventListener('click', refreshStatus);
  $('model-filter').addEventListener('change', () => { if (snapshot) { renderTelemetry(true); renderGeneration(); } });
  let trendWidth = null;
  const trendObserver = new ResizeObserver(([entry]) => {
    if (entry.contentRect.width === trendWidth) return;
    trendWidth = entry.contentRect.width;
    if (snapshot) drawTrend($('trend-container'), trendSamples(snapshot.telemetry?.turns, $('model-filter').value));
  });
  trendObserver.observe($('trend-container'));
  renderNetwork();
  renderGeneration();
  setInterval(() => { renderNetwork(); renderGeneration(); }, 1000);
  refreshStatus();
}

if (typeof document !== 'undefined') startDashboard();
