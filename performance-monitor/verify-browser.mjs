import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startMonitor } from './server.mjs';

const runtimeModule = process.env.PLAYWRIGHT_MODULE_PATH || path.join(process.env.USERPROFILE, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright', 'index.mjs');
const { chromium } = await import(pathToFileURL(runtimeModule).href);
const diagnosticsDir = fileURLToPath(new URL('../diagnostics/', import.meta.url));
await mkdir(diagnosticsDir, { recursive: true });
const outputDir = await mkdtemp(path.join(diagnosticsDir, 'performance-monitor-readonly-'));
const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'codex-performance-browser-'));
let polls = 0;
const telemetry = {
  updatedAt: new Date().toISOString(), source: { scannedFiles: 3, errors: 0, truncatedFiles: 0 }, warnings: [],
  turns: Array.from({ length: 12 }, (_, i) => ({ id: `fixture-turn-${i}`, sessionId: 'fixture-session',
    startedAt: new Date(Date.now() - i * 600000 - 30000).toISOString(), completedAt: i === 0 ? null : new Date(Date.now() - i * 600000).toISOString(),
    status: i === 0 ? 'running' : 'completed', model: i === 1 ? 'fixture-alternate' : 'fixture-model', effort: 'medium', provider: 'fixture',
    outputTokens: 720 + i * 25, reasoningTokens: 240, durationMs: i === 0 ? null : 30000, ttftMs: i < 2 ? null : 2300,
    throughputTps: i < 2 ? null : 24 + i * .8, warnings: i === 0 ? ['端到端平均吞吐包含推理和工具等待，不代表实时纯生成速度。', '来源未提供首 token 耗时。'] : [],
    messageOutput: i < 2 ? { itemId: `fixture-message-${i}`, phase: 'final_answer', startedAt: new Date(Date.now() - i * 600000 - 10000).toISOString(), completedAt: new Date(Date.now() - i * 600000).toISOString(), durationMs: i === 1 ? 500 : 10000, characters: 305, charactersPerSecond: i === 1 ? null : 30.5, reason: i === 1 ? 'short-window' : null } : null,
  })),
};
function healthyNetwork() {
  const updatedAt = new Date().toISOString();
  return {
    updatedAt, checking: false,
    context: { source: 'watchdog', label: '当前 Codex 的已核对入口', codexEntry: 'http://127.0.0.1:47831', systemProxy: 'http://127.0.0.1:7897', relayUpstream: 'http://127.0.0.1:7897', attribution: '已核对启动器主进程与代理入口' },
    stages: Object.fromEntries(['local', 'proxy', 'vpn', 'openai'].map(id => [id, {
      id, status: 'ok', summary: `${id} 对照检测成功`, detail: '合成测试数据，不产生外网请求', checkedAt: updatedAt,
      latencyMs: id === 'local' ? null : 42, kind: 'fixture', httpStatus: id === 'openai' ? 200 : null,
      failedStep: null, errorCode: null, evidence: ['测试目标已返回响应。'], suggestion: [], staleAfterMs: 45000,
    }])),
    diagnosis: { status: 'ok', confidence: 'confirmed', summary: '当前检测路径可连接', evidence: ['四个环节均有新的检测记录。'], suggestion: [], failedStage: null, failedStep: null, since: null },
    history: Array.from({ length: 25 }, (_, index) => ({ at: new Date(Date.now() - (25 - index) * 1000).toISOString(), summary: `合成状态变化 ${index}`, confidence: 'confirmed', stage: 'local', status: 'ok' })),
  };
}
let network = healthyNetwork();
function activeGeneration() {
  const updatedAt = new Date().toISOString();
  const stream = { threadId: 'fixture-session', turnId: 'fixture-turn-0', itemId: 'fixture-live-message', phase: 'final_answer', state: 'generating', characters: 100, windowCharacters: 60, charactersPerSecond: 20, startedAt: new Date(Date.now() - 5000).toISOString(), lastDeltaAt: updatedAt, completedAt: null };
  const unknownStartedAt = new Date(Date.parse(telemetry.turns.find(turn => turn.id === 'fixture-turn-0').startedAt) - 10000).toISOString();
  return { updatedAt, status: 'collecting', reason: '', windowMs: 3000, streams: [stream, { ...stream, startedAt: unknownStartedAt, threadId: 'unknown-session', turnId: 'unknown-turn', itemId: 'fixture-unbound-message', text: 'PRIVATE_FIXTURE_BODY_NOT_FOR_DISPLAY' }] };
}
let generation = activeGeneration();
const service = await startMonitor({ codexHome: path.join(fixtureRoot, 'home'), stateDir: path.join(fixtureRoot, 'state'), pollMs: 20,
  collector: { async poll() { polls += 1; }, snapshot() { return structuredClone(telemetry); } },
  networkCollector: { async poll() {}, snapshot() { return structuredClone(network); }, async close() {} },
  generationCollector: { async poll() {}, snapshot() { return structuredClone(generation); }, async close() {} },
});
let browser;
async function checkTrendProportions(page) {
  await page.waitForFunction(() => {
    const svg = document.querySelector('#trend-container svg');
    if (!svg) return false;
    const matrix = svg.getScreenCTM();
    return Math.abs(matrix.a - matrix.d) < .001 && Math.abs(svg.viewBox.baseVal.width - svg.getBoundingClientRect().width) < 1;
  });
  const geometry = await page.locator('#trend-container svg').evaluate(svg => {
    const matrix = svg.getScreenCTM();
    const point = svg.querySelector('circle').getBoundingClientRect();
    return { scaleX: matrix.a, scaleY: matrix.d, pointWidth: point.width, pointHeight: point.height };
  });
  assert.ok(Math.abs(geometry.scaleX - geometry.scaleY) < .001, '图中文字不得横向或纵向拉伸');
  assert.ok(Math.abs(geometry.pointWidth - geometry.pointHeight) < .01, '图表圆点应保持圆形');
}
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const requests = [];
  context.on('request', request => requests.push({ method: request.method(), pathname: new URL(request.url()).pathname }));
  let page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(service.url);
  await page.waitForFunction(() => document.querySelector('#metric-output')?.textContent === '720');
  assert.equal(await page.locator('#metric-message-speed').count(), 1, '需要显示完成消息输出速度');
  assert.equal(await page.locator('#metric-message-speed').innerText(), '30.5');
  assert.equal(await page.locator('#metric-live-speed').innerText(), '20');
  assert.equal(await page.locator('#metric-ttft').innerText(), '待本轮完成');
  assert.equal(await page.locator('#metric-throughput').innerText(), '待本轮完成');
  assert.doesNotMatch(await page.locator('#latest-turn-label').innerText(), /采集提示|异常/);
  assert.match(await page.locator('#generation-boundary').innerText(), /不足 3 秒.*偏低/);
  const knownTaskKey = JSON.stringify(['fixture-session', 'fixture-turn-0']);
  const unknownTaskKey = JSON.stringify(['unknown-session', 'unknown-turn']);
  const taskButton = key => page.locator('#task-list button').filter({ has: page.locator('span') }).evaluateAll((buttons, key) => buttons.find(button => button.dataset.taskKey === key)?.click(), key);
  assert.equal(await page.locator('#task-list [aria-pressed="true"]').getAttribute('data-task-key'), knownTaskKey);
  await taskButton(unknownTaskKey);
  assert.equal(await page.locator('#metric-output').innerText(), '未提供', '未知任务不能借用另一个会话的 token 用量');
  assert.match(await page.locator('#latest-turn-label').innerText(), /未知模型/);
  await taskButton(knownTaskKey);
  assert.equal(await page.locator('#metric-output').innerText(), '720');

  const selectedTurn = telemetry.turns.find(turn => turn.id === 'fixture-turn-0');
  selectedTurn.status = 'completed';
  selectedTurn.completedAt = new Date().toISOString();
  generation = activeGeneration();
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => document.querySelector('#metric-live-speed')?.textContent === '已完成');
  assert.equal(await page.locator('#generation-status').innerText(), '本轮已完成', '已确认整轮完成优先于延迟到达的活动流快照');
  assert.equal(await page.locator('[data-item="fixture-live-message"] [data-rate]').getAttribute('data-rate'), '', '实时详情同样不能保留终态轮次的旧速度');
  assert.match(await page.locator('[data-item="fixture-live-message"]').textContent(), /已完成/);
  selectedTurn.status = 'running';
  selectedTurn.completedAt = null;
  generation = activeGeneration();
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => document.querySelector('#metric-live-speed')?.textContent === '20');
  const parallelKey = JSON.stringify(['parallel-session', 'parallel-turn']);
  telemetry.turns.unshift({ ...telemetry.turns[0], sessionId: 'parallel-session', id: 'parallel-turn', model: 'parallel-model', startedAt: new Date().toISOString(), outputTokens: 1664, messageOutput: null });
  generation = activeGeneration();
  generation.streams.push({ ...generation.streams[0], threadId: 'parallel-session', turnId: 'parallel-turn', itemId: 'parallel-message', characters: 200, windowCharacters: 120, charactersPerSecond: 40 });
  await page.locator('#refresh-button').click();
  await page.waitForFunction(key => [...document.querySelectorAll('#task-list button')].some(button => button.dataset.taskKey === key), parallelKey);
  assert.equal(await page.locator('#task-list [aria-pressed="true"]').getAttribute('data-task-key'), knownTaskKey, '新任务不能抢走固定选择');
  assert.equal(await page.locator('#metric-output').innerText(), '720');
  await taskButton(parallelKey);
  assert.equal(await page.locator('#metric-output').innerText(), '1,664');
  assert.equal(await page.locator('#metric-live-speed').innerText(), '40');
  assert.equal(await page.locator('#metric-message-speed').innerText(), '等待消息完成');
  assert.match(await page.locator('#latest-turn-label').innerText(), /parallel-model/);
  telemetry.turns.shift();
  generation = activeGeneration();
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => document.querySelector('#metric-output')?.textContent === '请选择任务');
  assert.match(await page.locator('#latest-turn-label').innerText(), /重新选择.*不会自动切到/);
  await taskButton(knownTaskKey);
  assert.equal(await page.locator('#metric-output').innerText(), '720');

  const oldStatus = await (await fetch(new URL('/api/status', service.url))).json();
  let delayedStatusFinished = false;
  await page.route('**/api/status', async route => {
    await delay(800);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(oldStatus) });
    delayedStatusFinished = true;
  }, { times: 1 });
  await page.locator('#refresh-button').click();
  generation = activeGeneration();
  generation.streams[0].characters = 200;
  generation.streams[0].windowCharacters = 120;
  generation.streams[0].charactersPerSecond = 40;
  await page.waitForFunction(() => document.querySelector('#metric-live-speed')?.textContent === '40');
  await page.waitForFunction(() => !document.querySelector('#refresh-button')?.disabled);
  assert.equal(delayedStatusFinished, true);
  assert.equal(await page.locator('#metric-live-speed').innerText(), '40', '迟到的整页状态响应不能覆盖更快接口的新速度');
  generation = activeGeneration();
  await page.waitForFunction(() => document.querySelector('#metric-live-speed')?.textContent === '20');
  const fastReadBefore = requests.filter(request => request.pathname === '/api/generation').length;
  await delay(850);
  assert.ok(requests.filter(request => request.pathname === '/api/generation').length >= fastReadBefore + 2, '接收数据应独立于整页状态快速读取');
  await page.route('**/api/generation', route => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'legacy server' }) }));
  generation = activeGeneration();
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => !document.querySelector('#refresh-button')?.disabled);
  assert.match(await page.locator('#connection-label').innerText(), /本地采集器已连接/, '快速接口缺失不能误报正常状态接口离线');
  assert.equal(await page.locator('#metric-live-speed').innerText(), '20', '缺少快速接口时仍通过状态接口读取接收数据');
  await page.unroute('**/api/generation');
  assert.equal(await page.locator('#generation-streams li').count(), 2);
  await page.locator('.generation-details > summary').click();
  assert.match(await page.locator('#generation-streams').innerText(), /未知模型/);
  assert.doesNotMatch(await page.locator('body').innerText(), /PRIVATE_FIXTURE_BODY_NOT_FOR_DISPLAY/, '任何聊天正文都不能出现在面板');
  assert.match(await page.locator('#generation-boundary').innerText(), /字符.*网络.*不是/);
  assert.equal(await page.locator('#generation-capture-note').count(), 1, '需要独立显示采集恢复的计数边界');
  generation = activeGeneration();
  generation.captureHealth = { state: 'ok', recoveries: 1, reattachedAt: new Date().toISOString() };
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => document.querySelector('#generation-capture-note')?.textContent.includes('累计从恢复后开始'));
  assert.match(await page.locator('#generation-capture-note').innerText(), /未补算中断时段/);
  generation = activeGeneration();
  generation.captureHealth = { state: 'ok', recoveries: 2, reattachedAt: null };
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => document.querySelector('#generation-capture-note')?.textContent === '本地快照写入曾失败，现已自动恢复。');
  assert.doesNotMatch(await page.locator('#generation-capture-note').innerText(), /未补算|累计从恢复/);
  generation = activeGeneration();
  generation.coverage = { droppedEvents: 7 };
  generation.streams[0].partial = true;
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => document.querySelector('#generation-capture-note')?.textContent.includes('已跳过 7 个事件'));
  assert.match(await page.locator('#generation-capture-note').innerText(), /局部采集.*已观测片段/);
  assert.match(await page.locator('[data-item="fixture-live-message"]').innerText(), /已观测 100 字符.*局部采集/);
  assert.match(await page.locator('[data-item="fixture-unbound-message"]').innerText(), /累计 100 字符/);
  assert.equal(await page.locator('#metric-live-speed').innerText(), '20', '局部采集提示不能改写已观测窗口速度');
  generation = activeGeneration();
  const retainedStream = generation.streams[0];
  generation.streams = Array.from({ length: 40 }, (_, index) => index === 0 ? retainedStream : {
    ...retainedStream, threadId: `detail-session-${index}`, turnId: `detail-turn-${index}`, itemId: `detail-message-${index}`, partial: index === 39,
  });
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => document.querySelectorAll('#generation-streams li').length === 40);
  assert.match(await page.locator('#generation-stream-count').innerText(), /^40 条/);
  assert.match(await page.locator('[data-item="detail-message-39"]').textContent(), /已观测 100 字符.*局部采集/);
  assert.match(await page.locator('#generation-capture-note').innerText(), /局部采集/);
  assert.equal(await page.locator('#metric-live-speed').innerText(), '20', '其他39条会话不能改变所选任务速度');
  generation = { ...activeGeneration(), status: 'stale', reason: '本地实时采集快照已停止更新，不显示旧速度。', captureHealth: { state: 'stopped', recoveries: 0, reattachedAt: null } };
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => document.querySelector('#generation-status')?.textContent === '实时数据已过期');
  assert.match(await page.locator('#live-speed-description').innerText(), /快照已停止更新/);
  assert.doesNotMatch(await page.locator('#live-speed-description').innerText(), /超过 5 秒/);
  assert.equal(await page.locator('#metric-live-speed').innerText(), '数据过期');
  generation = activeGeneration();
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => document.querySelector('#metric-live-speed')?.textContent === '20');
  assert.equal(await page.locator('form, #selftest-form, #start-test, #cancel-test, #test-history').count(), 0, '页面不应保留自检表单、按钮或历史');
  assert.doesNotMatch(await page.locator('body').innerText(), /能力自检|自检历史|测试模型/);
  assert.match(await page.locator('#connection-label').innerText(), /本地采集器已连接/);
  assert.match(await page.locator('.intro-copy').innerText(), /不代表外网连接正常/);
  await page.waitForFunction(() => document.querySelector('[data-stage="openai"]')?.dataset.status === 'ok');
  assert.equal(await page.locator('#network-stages article').count(), 4);
  assert.equal(await page.locator('#network-confidence').innerText(), '已确认');
  assert.match(await page.locator('#network-context').innerText(), /当前 Codex 的已核对入口/);
  assert.match(await page.locator('#network-context').innerText(), /中转上游/);
  assert.equal(await page.locator('#network-history li').count(), 20, '变化记录展示最多 20 条');
  await page.locator('.network-history > summary').click();
  assert.match(await page.locator('#network-history li').first().innerText(), /合成状态变化 24/);
  assert.ok(await page.evaluate(() => document.querySelector('#network-title').getBoundingClientRect().top < document.querySelector('#telemetry-title').getBoundingClientRect().top), '网络模块应在 token 统计上方');
  const autoRefreshBefore = requests.filter(request => request.pathname === '/api/status').length;
  await delay(1250);
  assert.ok(requests.filter(request => request.pathname === '/api/status').length > autoRefreshBefore, '页面应每秒自动读取状态');
  const desktopOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  assert.equal(desktopOverflow, false, '桌面宽度不应整页横向溢出');
  await checkTrendProportions(page);
  await page.screenshot({ path: path.join(outputDir, 'desktop-fixture.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 1000 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, '1280 宽度不应整页横向溢出');
  await checkTrendProportions(page);
  await page.screenshot({ path: path.join(outputDir, 'desktop-1280-fixture.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await checkTrendProportions(page);
  await page.locator('#model-filter').selectOption('fixture-alternate');
  assert.equal(await page.locator('#turn-rows tr').count(), 1);
  assert.equal(await page.locator('#metric-throughput').innerText(), '未提供');
  assert.equal(await page.locator('#metric-ttft').innerText(), '未提供');
  assert.equal(await page.locator('#metric-message-speed').innerText(), '无法计算');
  assert.match(await page.locator('#message-speed-description').innerText(), /时窗过短/);
  assert.equal(await page.locator('#metric-live-speed').innerText(), '已完成', '不能把未知模型或其他模型流算入当前模型');
  assert.match(await page.locator('#live-speed-description').innerText(), /所选任务已完成/);
  await page.locator('#model-filter').selectOption('fixture-model');
  assert.equal(await page.locator('#trend-container svg').count(), 1, '同模型趋势应继续绘制');
  const statusRequestsBeforeRefresh = requests.filter(request => request.pathname === '/api/status').length;
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => !document.querySelector('#refresh-button')?.disabled);
  assert.ok(requests.filter(request => request.pathname === '/api/status').length > statusRequestsBeforeRefresh, '刷新应重新读取后台状态');
  generation = { updatedAt: new Date().toISOString(), status: 'waiting-launch', reason: '等待当前会话启用实时采集。', windowMs: 3000, streams: [] };
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => document.querySelector('#generation-status')?.textContent === '等待正常启动');
  assert.equal(await page.locator('#metric-live-speed').innerText(), '等待启用');
  assert.match(await page.locator('#live-speed-description').innerText(), /下次正常启动/);
  assert.doesNotMatch(await page.locator('#live-speed-description').innerText(), /立即重启/);
  generation = { ...generation, updatedAt: new Date().toISOString(), status: 'idle', reason: '等待文字输出。' };
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => document.querySelector('#generation-status')?.textContent === '等待文字输出');
  assert.equal(await page.locator('#metric-live-speed').innerText(), '等待文字');
  generation = activeGeneration();
  for (const stream of generation.streams) stream.lastDeltaAt = new Date(Date.now() - 4000).toISOString();
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => document.querySelector('#metric-live-speed')?.textContent === '0');
  assert.match(await page.locator('#live-speed-description').innerText(), /没有收到新文字/);
  generation = activeGeneration();
  for (const stream of generation.streams) { stream.state = 'completed'; stream.completedAt = new Date().toISOString(); }
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => document.querySelector('#generation-status')?.textContent === '等待文字输出');
  assert.equal(await page.locator('#metric-live-speed').innerText(), '等待文字', '单条消息完成不能冒充整轮任务完成');
  generation = activeGeneration();
  generation.status = 'stale';
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => document.querySelector('#generation-status')?.textContent === '实时数据已过期');
  assert.equal(await page.locator('#metric-live-speed').innerText(), '数据过期');
  assert.equal(await page.locator('#generation-streams [data-rate]').evaluateAll(items => items.every(item => item.dataset.rate === '')), true);
  assert.equal(await page.locator('#metric-message-speed').innerText(), '30.5', '实时旧数据不应破坏历史均速');
  generation = activeGeneration();
  generation.streams[0].observedAt = new Date(Date.now() - 6000).toISOString();
  generation.streams[1].observedAt = generation.updatedAt;
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => document.querySelector('[data-item="fixture-live-message"] [data-rate]')?.dataset.rate === ''
    && document.querySelector('[data-item="fixture-unbound-message"] [data-rate]')?.dataset.rate === '20');
  assert.match(await page.locator('[data-item="fixture-live-message"]').textContent(), /旧记录/);
  assert.equal(await page.locator('[data-item="fixture-unbound-message"] [data-rate]').getAttribute('data-rate'), '20', '另一个 writer 的新记录仍可显示速度');
  assert.equal(await page.locator('#metric-live-speed').innerText(), '数据过期', '当前模型不能采用自己已过期的 writer');
  await page.locator('#model-filter').selectOption('');
  await taskButton(unknownTaskKey);
  assert.equal(await page.locator('#metric-live-speed').innerText(), '20', '明确选择另一个任务后采用对应的新记录');
  assert.match(await page.locator('#live-speed-description').innerText(), /未知模型/);
  await page.locator('#model-filter').selectOption('fixture-model');
  generation = activeGeneration();
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => document.querySelector('#metric-live-speed')?.textContent === '20');
  await page.waitForFunction(() => document.querySelector('#metric-live-speed')?.textContent === '0');
  assert.match(await page.locator('#live-speed-description').innerText(), /没有收到新文字/, '窗口中的旧片段应随本地时间移出，不继续显示旧速度');
  await page.waitForFunction(() => document.querySelector('#generation-status')?.textContent === '实时数据已过期');
  assert.equal(await page.locator('#metric-live-speed').innerText(), '数据过期', '没有新快照时页面也应按本地时间标记过期');
  network = healthyNetwork();
  network.stages.vpn = { ...network.stages.vpn, status: 'error', summary: '代理 CONNECT 超时', failedStep: 'proxy-connect', errorCode: 'ETIMEDOUT', latencyMs: 8000, evidence: ['本机代理端口可连接，CONNECT 未返回。'], suggestion: ['检查 VPN 出口连接。'] };
  network.stages.openai = { ...network.stages.openai, status: 'error', summary: 'OpenAI 路径未完成', failedStep: 'proxy-connect', errorCode: 'ETIMEDOUT', httpStatus: null, latencyMs: 8000 };
  network.diagnosis = { status: 'error', confidence: 'suspected', summary: '疑似 VPN 出口路径异常', failedStage: 'vpn', failedStep: 'proxy-connect', since: new Date(Date.now() - 6000).toISOString(), evidence: ['代理端口正常，但对照和 OpenAI 路径均在 CONNECT 阶段超时。'], suggestion: ['检查 VPN 出口。'] };
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => document.querySelector('[data-stage="vpn"]')?.dataset.status === 'error');
  assert.equal(await page.locator('#network-confidence').innerText(), '疑似');
  assert.match(await page.locator('[data-stage="vpn"]').innerText(), /代理 CONNECT/);
  assert.match(await page.locator('#network-advice').innerText(), /已持续/);
  assert.match(await page.locator('#connection-label').innerText(), /本地采集器已连接/, '网络异常不应混淆本地采集器连接');
  await page.locator('[data-stage="vpn"] details').evaluate(element => { element.open = true; });
  assert.match(await page.locator('[data-stage="vpn"] details').innerText(), /本机代理端口可连接/);
  await page.screenshot({ path: path.join(outputDir, 'network-connect-failure.png'), fullPage: true });

  network = healthyNetwork();
  network.stages.openai = { ...network.stages.openai, status: 'warning', summary: 'OpenAI 返回 HTTP 403', httpStatus: 403, detail: '路径已收到 HTTP 响应，服务拒绝访问。', evidence: ['HTTP 403 是可观测的服务响应。'], suggestion: ['结合实际请求的权限和策略排查。'] };
  network.diagnosis = { status: 'warning', confidence: 'insufficient', summary: '路径有响应，需排查 HTTP 403', evidence: ['OpenAI 路径返回 HTTP 403。'], suggestion: ['这不是没有网络响应的情况。'] };
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => document.querySelector('[data-stage="openai"]')?.dataset.status === 'warning');
  assert.match(await page.locator('[data-stage="openai"]').innerText(), /HTTP 403/);
  assert.doesNotMatch(await page.locator('[data-stage="openai"]').innerText(), /断网|网络超时/);
  assert.equal(await page.locator('#network-confidence').innerText(), '信息不足');

  network = healthyNetwork();
  for (const stage of Object.values(network.stages)) stage.checkedAt = new Date(Date.now() - 90000).toISOString();
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-status="stale"]').length === 4);
  assert.match(await page.locator('#network-summary').innerText(), /已过期/);
  assert.equal(await page.locator('#network-confidence').innerText(), '信息不足');
  assert.equal(await page.locator('.network-tone-ok').count(), 0, '旧记录不能保持绿灯');

  network = healthyNetwork();
  network.stages.local.staleAfterMs = 500;
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => !document.querySelector('#refresh-button')?.disabled);
  await page.waitForFunction(() => document.querySelector('[data-stage="local"]')?.dataset.status === 'stale');
  const firstAge = await page.locator('[data-stage="local"] .network-stage-time').getAttribute('data-age');
  assert.match(firstAge, /^\d+$/, '已有检测记录必须具有可读的数据年龄');
  const firstAgeSeconds = Number(firstAge);
  await page.waitForFunction(firstAge => {
    const age = document.querySelector('[data-stage="local"] .network-stage-time')?.dataset.age;
    return age !== undefined && age !== '' && Number(age) >= firstAge + 1;
  }, firstAgeSeconds);
  const laterAgeSeconds = Number(await page.locator('[data-stage="local"] .network-stage-time').getAttribute('data-age'));
  assert.ok(laterAgeSeconds >= firstAgeSeconds + 1, '没有新检测结果时，数据年龄仍应按实际时间增长');

  network = null;
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => document.querySelector('#network-summary')?.textContent === '正在准备网络检测');
  assert.equal(await page.locator('#metric-output').innerText(), '720', '网络尚未准备时仍显示 token 数据');
  network = healthyNetwork();
  network.context = { source: 'system-proxy', label: '当前系统代理', systemProxy: 'http://127.0.0.1:7897', attribution: '当前系统代理，未绑定 Codex', warning: '这些结果不能直接代表当前 Codex 的连接。' };
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => document.querySelector('#network-context')?.textContent.includes('未绑定 Codex'));
  assert.doesNotMatch(await page.locator('#network-context').innerText(), /Codex 入口/);
  const beforeClose = polls;
  await page.close();
  await delay(100);
  assert.ok(polls > beforeClose, '关闭页面后后台应继续轮询');
  page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.setViewportSize({ width: 800, height: 1000 });
  generation = activeGeneration();
  await page.goto(service.url);
  await page.waitForFunction(() => document.querySelector('#metric-output')?.textContent === '720');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  assert.equal(overflow, false, '电脑窄窗口不应整页横向溢出');
  await checkTrendProportions(page);
  await page.screenshot({ path: path.join(outputDir, 'compact-window-fixture.png'), fullPage: true });
  await page.route('**/api/status', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '测试连接中断' }) }));
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => !document.querySelector('#connection-error')?.hidden);
  assert.equal(await page.locator('#metric-output').innerText(), '720', '断线应保留上次数据');
  assert.equal(await page.locator('#metric-live-speed').innerText(), '20', '状态接口失败不能隐藏仍由实时接口返回的有效速度');
  assert.match(await page.locator('#connection-label').innerText(), /状态.*暂不可用.*实时采集仍连接/);
  await page.route('**/api/generation', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '测试实时接口中断' }) }));
  await page.waitForFunction(() => document.querySelector('#metric-live-speed')?.textContent === '数据过期');
  assert.equal(await page.locator('#metric-live-speed').innerText(), '数据过期', '断线不能保留跳动的实时速度');
  assert.equal(await page.locator('#metric-message-speed').innerText(), '30.5', '断线仍可参考上次历史均速');
  assert.equal(await page.locator('#generation-status').innerText(), '实时数据已过期');
  assert.match(await page.locator('#connection-label').innerText(), /无法连接本地采集器/);
  assert.match(await page.locator('#connection-error').innerText(), /不能判断外网、VPN 或 OpenAI/);
  assert.equal(await page.locator('[data-status="stale"]').count(), 4, '采集器离线时网络卡应明确为旧记录');
  assert.equal(await page.locator('#network-confidence').innerText(), '信息不足');
  assert.match(await page.locator('#network-summary').innerText(), /当前网络状态未知/);
  await page.close();
  generation = activeGeneration();
  page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/api/status', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '测试初次状态读取失败' }) }));
  await page.goto(service.url);
  await page.waitForFunction(() => document.querySelector('#metric-live-speed')?.textContent === '20');
  assert.equal(await page.locator('#metric-output').innerText(), '未提供', '首次只拿到文字流时不能虚构 token 用量');
  assert.match(await page.locator('#latest-turn-label').innerText(), /未知模型/, '首次状态读取失败时仍可查看有独立身份的实时任务');
  assert.match(await page.locator('#connection-label').innerText(), /实时采集仍连接/);
  assert.equal(await page.locator('form, #selftest-form, #start-test, #cancel-test, #test-history').count(), 0);
  assert.deepEqual(requests.filter(request => request.method === 'POST'), [], '页面交互不能发送 POST 请求');
  assert.ok(requests.every(request => request.method === 'GET'), '页面只应读取状态和静态资源');
  assert.ok(requests.every(request => !request.pathname.includes('self-test')), '页面不能请求已删除的自检接口');
  assert.deepEqual(pageErrors, []);
  const report = { passed: true, source: 'synthetic-fixture-readonly-no-model-calls', browser: 'Microsoft Edge headless', checks: ['desktop-render', 'desktop-no-overflow', 'desktop-1280', 'trend-text-proportions', 'trend-circle-proportions', 'trend-resize', 'model-filter', 'null-metrics', 'same-model-trend', 'manual-refresh', 'background-after-page-close', 'compact-window-no-overflow', 'offline-keeps-data', 'local-collector-status-label', 'network-visible-above-token', 'network-four-stages', 'network-one-second-refresh', 'network-context-binding', 'network-connect-failure', 'network-http403-response', 'network-stale-no-green', 'network-ages-without-new-results', 'network-unavailable-keeps-token', 'network-offline-unknown', 'network-history-20', 'completed-message-speed', 'short-message-window', 'live-reception-speed', 'live-unknown-model-labelled', 'live-model-identity-filter', 'live-waiting-normal-launch', 'live-idle-no-zero-estimate', 'live-observed-pause-zero', 'live-completed-hides-last-rate', 'live-expired-hides-rate', 'live-per-writer-freshness', 'live-window-ages-without-new-data', 'live-freshness-ages-without-new-data', 'live-offline-hides-rate', 'live-reattachment-counter-boundary', 'live-write-retry-recovery-note', 'live-stopped-backend-reason', 'no-chat-body-display', 'no-selftest-ui', 'only-get-no-post'], postRequests: 0, polls, outputDir };
  report.checks.push('task-selection-exact-identity', 'new-task-does-not-steal-selection', 'parallel-task-separate-model-and-rate', 'selected-task-retirement-prompts-reselect', 'completed-turn-overrides-delayed-active-stream', 'running-metrics-show-waiting', 'measurement-note-not-fault', 'fast-generation-poll', 'slow-status-cannot-replace-fast-generation', 'fast-endpoint-404-falls-back');
  report.checks.push('status-failure-keeps-live-endpoint-data', 'both-read-endpoints-offline-hides-live-rate', 'first-status-failure-still-shows-live-task', 'completed-turn-overrides-stream-detail');
  report.checks.push('capture-retention-limit-note', 'partial-stream-observed-count-label', 'partial-capture-keeps-observed-window-rate');
  report.checks.push('all-40-retained-streams-visible', 'last-retained-stream-partial-note');
  await writeFile(path.join(outputDir, 'browser-fixture-report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  await service.close();
  const relative = path.relative(tmpdir(), fixtureRoot);
  if (!relative.startsWith('codex-performance-browser-') || relative.includes(path.sep)) throw new Error('临时目录边界校验失败。');
  await rm(fixtureRoot, { recursive: true, force: true });
}
