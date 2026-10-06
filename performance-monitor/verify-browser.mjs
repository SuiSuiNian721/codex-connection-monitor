import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startMonitor } from './server.mjs';

const runtimeModule = process.env.PLAYWRIGHT_MODULE_PATH || (() => { throw new Error('请设置 PLAYWRIGHT_MODULE_PATH，指向自行安装的 playwright/index.mjs。'); })();
const { chromium } = await import(pathToFileURL(runtimeModule).href);
const diagnosticsDir = fileURLToPath(new URL('../diagnostics/', import.meta.url));
await mkdir(diagnosticsDir, { recursive: true });
const outputDir = await mkdtemp(path.join(diagnosticsDir, 'performance-monitor-readonly-'));
const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'codex-performance-browser-'));
let polls = 0;
const telemetry = {
  updatedAt: new Date().toISOString(), source: { scannedFiles: 3, errors: 0, truncatedFiles: 0 }, warnings: [],
  turns: Array.from({ length: 12 }, (_, i) => ({ id: `fixture-turn-${i}`, sessionId: 'fixture-session',
    startedAt: new Date(Date.now() - i * 600000).toISOString(), completedAt: new Date(Date.now() - i * 600000 + 30000).toISOString(),
    status: 'completed', model: i === 1 ? 'fixture-alternate' : 'fixture-model', effort: 'medium', provider: 'fixture',
    outputTokens: 720 + i * 25, reasoningTokens: 240, durationMs: 30000, ttftMs: i === 1 ? null : 2300,
    throughputTps: i === 1 ? null : 24 + i * .8, warnings: [],
    messageOutput: i < 2 ? { itemId: `fixture-message-${i}`, phase: 'final_answer', startedAt: new Date(Date.now() - i * 600000 + 20000).toISOString(), completedAt: new Date(Date.now() - i * 600000 + 30000).toISOString(), durationMs: i === 1 ? 500 : 10000, characters: 305, charactersPerSecond: i === 1 ? null : 30.5, reason: i === 1 ? 'short-window' : null } : null,
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
  return { updatedAt, status: 'collecting', reason: '', windowMs: 3000, streams: [stream, { ...stream, threadId: 'unknown-session', turnId: 'unknown-turn', itemId: 'fixture-unbound-message', text: 'PRIVATE_FIXTURE_BODY_NOT_FOR_DISPLAY' }] };
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
  generation = { ...activeGeneration(), status: 'stale', reason: '本地实时采集快照已停止更新，不显示旧速度。', captureHealth: { state: 'stopped', recoveries: 0, reattachedAt: null } };
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => document.querySelector('#generation-status')?.textContent === '实时数据已过期');
  assert.match(await page.locator('#live-speed-description').innerText(), /快照已停止更新/);
  assert.doesNotMatch(await page.locator('#live-speed-description').innerText(), /超过 5 秒/);
  assert.equal(await page.locator('#metric-live-speed').innerText(), '—');
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
  await page.setViewportSize({ width: 900, height: 1000 });
  await checkTrendProportions(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await checkTrendProportions(page);
  await page.locator('#model-filter').selectOption('fixture-alternate');
  assert.equal(await page.locator('#turn-rows tr').count(), 1);
  assert.equal(await page.locator('#metric-throughput').innerText(), '—');
  assert.equal(await page.locator('#metric-ttft').innerText(), '—');
  assert.equal(await page.locator('#metric-message-speed').innerText(), '—');
  assert.match(await page.locator('#message-speed-description').innerText(), /时窗过短/);
  assert.equal(await page.locator('#metric-live-speed').innerText(), '—', '不能把未知模型或其他模型流算入当前模型');
  assert.match(await page.locator('#live-speed-description').innerText(), /未绑定|暂无/);
  await page.locator('#model-filter').selectOption('fixture-model');
  assert.equal(await page.locator('#trend-container svg').count(), 1, '同模型趋势应继续绘制');
  const statusRequestsBeforeRefresh = requests.filter(request => request.pathname === '/api/status').length;
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => !document.querySelector('#refresh-button')?.disabled);
  assert.ok(requests.filter(request => request.pathname === '/api/status').length > statusRequestsBeforeRefresh, '刷新应重新读取后台状态');
  generation = { updatedAt: new Date().toISOString(), status: 'waiting-launch', reason: '等待当前会话启用实时采集。', windowMs: 3000, streams: [] };
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => document.querySelector('#generation-status')?.textContent === '等待正常启动');
  assert.equal(await page.locator('#metric-live-speed').innerText(), '—');
  assert.match(await page.locator('#live-speed-description').innerText(), /下次正常启动/);
  assert.doesNotMatch(await page.locator('#live-speed-description').innerText(), /立即重启/);
  generation = { ...generation, updatedAt: new Date().toISOString(), status: 'idle', reason: '等待文字输出。' };
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => document.querySelector('#generation-status')?.textContent === '等待文字输出');
  assert.equal(await page.locator('#metric-live-speed').innerText(), '—');
  generation = activeGeneration();
  for (const stream of generation.streams) stream.lastDeltaAt = new Date(Date.now() - 4000).toISOString();
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => document.querySelector('#metric-live-speed')?.textContent === '0');
  assert.match(await page.locator('#live-speed-description').innerText(), /没有收到新文字/);
  generation = activeGeneration();
  for (const stream of generation.streams) { stream.state = 'completed'; stream.completedAt = new Date().toISOString(); }
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => document.querySelector('#generation-status')?.textContent === '本条已完成');
  assert.equal(await page.locator('#metric-live-speed').innerText(), '—');
  generation = activeGeneration();
  generation.updatedAt = new Date(Date.now() - 6000).toISOString();
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => document.querySelector('#generation-status')?.textContent === '实时数据已过期');
  assert.equal(await page.locator('#metric-live-speed').innerText(), '—');
  assert.equal(await page.locator('#generation-streams [data-rate]').evaluateAll(items => items.every(item => item.dataset.rate === '')), true);
  assert.equal(await page.locator('#metric-message-speed').innerText(), '30.5', '实时旧数据不应破坏历史均速');
  generation = activeGeneration();
  generation.streams[0].observedAt = new Date(Date.now() - 6000).toISOString();
  generation.streams[1].observedAt = generation.updatedAt;
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => document.querySelector('[data-item="fixture-live-message"] [data-rate]')?.dataset.rate === '');
  assert.match(await page.locator('[data-item="fixture-live-message"]').textContent(), /旧记录/);
  assert.equal(await page.locator('[data-item="fixture-unbound-message"] [data-rate]').getAttribute('data-rate'), '20', '另一个 writer 的新记录仍可显示速度');
  assert.equal(await page.locator('#metric-live-speed').innerText(), '—', '当前模型不能采用自己已过期的 writer');
  await page.locator('#model-filter').selectOption('');
  assert.equal(await page.locator('#metric-live-speed').innerText(), '20', '全部实时视图只能采用未过期的 writer');
  assert.match(await page.locator('#live-speed-description').innerText(), /未知模型/);
  await page.locator('#model-filter').selectOption('fixture-model');
  generation = activeGeneration();
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => document.querySelector('#metric-live-speed')?.textContent === '20');
  await page.waitForFunction(() => document.querySelector('#metric-live-speed')?.textContent === '0');
  assert.match(await page.locator('#live-speed-description').innerText(), /没有收到新文字/, '窗口中的旧片段应随本地时间移出，不继续显示旧速度');
  await page.waitForFunction(() => document.querySelector('#generation-status')?.textContent === '实时数据已过期');
  assert.equal(await page.locator('#metric-live-speed').innerText(), '—', '没有新快照时页面也应按本地时间标记过期');
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
  await page.setViewportSize({ width: 390, height: 844 });
  generation = activeGeneration();
  await page.goto(service.url);
  await page.waitForFunction(() => document.querySelector('#metric-output')?.textContent === '720');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  assert.equal(overflow, false, '手机宽度不应整页横向溢出');
  await checkTrendProportions(page);
  await page.screenshot({ path: path.join(outputDir, 'mobile-fixture.png'), fullPage: true });
  await page.route('**/api/status', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '测试连接中断' }) }));
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => !document.querySelector('#connection-error')?.hidden);
  assert.equal(await page.locator('#metric-output').innerText(), '720', '断线应保留上次数据');
  assert.equal(await page.locator('#metric-live-speed').innerText(), '—', '断线不能保留跳动的实时速度');
  assert.equal(await page.locator('#metric-message-speed').innerText(), '30.5', '断线仍可参考上次历史均速');
  assert.equal(await page.locator('#generation-status').innerText(), '实时数据已过期');
  assert.match(await page.locator('#connection-label').innerText(), /无法连接本地采集器/);
  assert.match(await page.locator('#connection-error').innerText(), /不能判断外网、VPN 或 OpenAI/);
  assert.equal(await page.locator('[data-status="stale"]').count(), 4, '采集器离线时网络卡应明确为旧记录');
  assert.equal(await page.locator('#network-confidence').innerText(), '信息不足');
  assert.match(await page.locator('#network-summary').innerText(), /当前网络状态未知/);
  assert.equal(await page.locator('form, #selftest-form, #start-test, #cancel-test, #test-history').count(), 0);
  assert.deepEqual(requests.filter(request => request.method === 'POST'), [], '页面交互不能发送 POST 请求');
  assert.ok(requests.every(request => request.method === 'GET'), '页面只应读取状态和静态资源');
  assert.ok(requests.every(request => !request.pathname.includes('self-test')), '页面不能请求已删除的自检接口');
  assert.deepEqual(pageErrors, []);
  const report = { passed: true, source: 'synthetic-fixture-readonly-no-model-calls', browser: 'Microsoft Edge headless', checks: ['desktop-render', 'desktop-no-overflow', 'trend-text-proportions', 'trend-circle-proportions', 'trend-resize', 'model-filter', 'null-metrics', 'same-model-trend', 'manual-refresh', 'background-after-page-close', 'mobile-no-overflow', 'offline-keeps-data', 'local-collector-status-label', 'network-visible-above-token', 'network-four-stages', 'network-one-second-refresh', 'network-context-binding', 'network-connect-failure', 'network-http403-response', 'network-stale-no-green', 'network-ages-without-new-results', 'network-unavailable-keeps-token', 'network-offline-unknown', 'network-history-20', 'completed-message-speed', 'short-message-window', 'live-reception-speed', 'live-unknown-model-labelled', 'live-model-identity-filter', 'live-waiting-normal-launch', 'live-idle-no-zero-estimate', 'live-observed-pause-zero', 'live-completed-hides-last-rate', 'live-expired-hides-rate', 'live-per-writer-freshness', 'live-window-ages-without-new-data', 'live-freshness-ages-without-new-data', 'live-offline-hides-rate', 'live-reattachment-counter-boundary', 'live-write-retry-recovery-note', 'live-stopped-backend-reason', 'no-chat-body-display', 'no-selftest-ui', 'only-get-no-post'], postRequests: 0, polls, outputDir };
  await writeFile(path.join(outputDir, 'browser-fixture-report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  await service.close();
  const relative = path.relative(tmpdir(), fixtureRoot);
  if (!relative.startsWith('codex-performance-browser-') || relative.includes(path.sep)) throw new Error('临时目录边界校验失败。');
  await rm(fixtureRoot, { recursive: true, force: true });
}
