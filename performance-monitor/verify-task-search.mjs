import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startMonitor } from './server.mjs';

const runtimeModule = process.env.PLAYWRIGHT_MODULE_PATH || path.join(process.env.USERPROFILE, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright', 'index.mjs');
const { chromium } = await import(pathToFileURL(runtimeModule).href);
const diagnosticsDir = fileURLToPath(new URL('../diagnostics/', import.meta.url));
await mkdir(diagnosticsDir, { recursive: true });
const outputDir = await mkdtemp(path.join(diagnosticsDir, 'task-search-readonly-'));
const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'codex-task-search-browser-'));
const base = Date.now() - 10000;
const identifier = index => String(index).padStart(4, '0');
const key = index => JSON.stringify([`session-${identifier(index)}`, `turn-${identifier(index)}`]);
const unsafeTitle = '<img src=x onerror=alert("bad")> 标题字面展示';
const telemetry = {
  updatedAt: new Date().toISOString(), source: { scannedFiles: 45, errors: 0, truncatedFiles: 0 }, warnings: [],
  turns: Array.from({ length: 45 }, (_, index) => ({
    sessionId: `session-${identifier(index)}`, id: `turn-${identifier(index)}`,
    sessionTitle: index === 0 ? '监测器界面整理' : index === 1 ? '语音接口调试' : index === 35 ? '离线语音合成工具' : index === 37 ? unsafeTitle : index === 40 ? null : index === 44 ? '历史未结束轮次' : `电脑工程 ${identifier(index)}`,
    startedAt: new Date(base - index * 60000).toISOString(), completedAt: index === 44 ? null : new Date(base - index * 60000 + 1000).toISOString(),
    status: index === 44 ? 'running' : 'completed', model: index % 2 ? 'alpha-model' : 'beta-model', effort: 'medium', provider: 'fixture',
    outputTokens: 1000 + index, reasoningTokens: 100, durationMs: index === 44 ? null : 1000,
    ttftMs: index === 44 ? null : 500, throughputTps: index === 44 ? null : 10,
    messageOutput: null, warnings: [], text: 'PRIVATE_CHAT_BODY_NOT_A_TITLE',
  })),
};
const service = await startMonitor({ codexHome: path.join(fixtureRoot, 'home'), stateDir: path.join(fixtureRoot, 'state'), pollMs: 50,
  collector: { async poll() {}, snapshot() { return structuredClone(telemetry); } },
  networkCollector: { async poll() {}, snapshot() { return null; }, async close() {} },
  generationCollector: { async poll() {}, snapshot() { return { updatedAt: new Date().toISOString(), status: 'idle', windowMs: 3000, streams: [] }; }, async close() {} },
});
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { errors.push(`unexpected dialog: ${dialog.type()}`); void dialog.dismiss(); });
  context.on('request', request => requests.push({ method: request.method(), url: request.url() }));
  const buttons = page.locator('#task-list button');
  const selectedKey = () => page.locator('#task-list [aria-pressed="true"]').getAttribute('data-task-key');
  const taskKeys = () => buttons.evaluateAll(items => items.map(item => item.dataset.taskKey));
  const search = async query => { await page.locator('#task-search').fill(query); };
  const selectTask = async taskKey => {
    await buttons.evaluateAll((items, taskKey) => items.find(item => item.dataset.taskKey === taskKey)?.click(), taskKey);
  };
  const assertSorted = async order => {
    const keys = await taskKeys();
    const times = keys.map(taskKey => {
      const [sessionId, turnId] = JSON.parse(taskKey);
      return Date.parse(telemetry.turns.find(turn => turn.sessionId === sessionId && turn.id === turnId).startedAt);
    });
    assert.ok(times.every((time, index) => index === 0 || (order === 'asc' ? times[index - 1] <= time : times[index - 1] >= time)), '任务必须严格依开始时间排序');
  };
  await page.goto(service.url);
  await page.waitForFunction(() => document.querySelector('#task-count')?.textContent === '匹配 45 条 · 展示 30 条');
  assert.equal(await page.locator('#task-sort').inputValue(), 'desc');
  assert.equal(await selectedKey(), key(0), '最新已完成任务不能被更早的未结束任务抢到后面');
  assert.equal(await buttons.first().getAttribute('data-task-key'), key(0));
  await assertSorted('desc');
  assert.match(await page.locator('#latest-turn-label').innerText(), /监测器界面整理/);

  await search('语音');
  assert.equal(await buttons.count(), 2);
  assert.equal(await page.locator('#task-count').innerText(), '匹配 2 条 · 展示 2 条');
  assert.ok((await taskKeys()).includes(key(35)), '搜索需覆盖默认30条之外的已采集记录');
  assert.equal(await selectedKey(), key(1));
  await page.locator('#task-sort').selectOption('asc');
  assert.equal(await buttons.first().getAttribute('data-task-key'), key(35));
  assert.equal(await selectedKey(), key(1), '切换排序保留当前选中任务');
  await assertSorted('asc');
  await search('语音 alpha-model');
  assert.equal(await buttons.count(), 2, '多个关键词按AND匹配，标题和模型可共同匹配');
  await search('ALPHA-MODEL');
  assert.equal(await buttons.count(), 22, '模型关键词应不区分大小写');
  assert.ok((await buttons.locator('.task-option-heading').allTextContents()).every(text => text.includes('alpha-model')));

  await search('SESSION-0022');
  assert.deepEqual(await taskKeys(), [key(22)], '可搜索会话ID');
  await search('turn-0031');
  assert.deepEqual(await taskKeys(), [key(31)], '可搜索轮次ID');
  await page.locator('#model-filter').selectOption('beta-model');
  assert.equal(await buttons.count(), 0, '模型筛选与关键词必须共同生效');
  assert.match(await page.locator('#task-list').innerText(), /没有匹配/);
  assert.equal(await page.locator('#metric-output').innerText(), '等待记录');
  await page.locator('#model-filter').selectOption('');
  assert.deepEqual(await taskKeys(), [key(31)]);
  await search('不应存在的关键词');
  assert.equal(await buttons.count(), 0);
  assert.equal(await page.locator('#task-count').innerText(), '匹配 0 条 · 展示 0 条');
  await page.locator('#task-search-clear').click();
  assert.equal(await page.locator('#task-search').inputValue(), '');
  assert.equal(await page.locator('#task-search-clear').isDisabled(), true);
  assert.equal(await buttons.first().getAttribute('data-task-key'), key(44), '清空搜索保留最早优先排序');
  assert.equal(await selectedKey(), key(44));
  await search('   ');
  assert.equal(await page.locator('#task-search-clear').isEnabled(), true);
  await page.locator('#task-search-clear').click();

  await search('turn-0040');
  assert.equal(await buttons.locator('.task-option-title').innerText(), '未命名会话');
  assert.doesNotMatch(await page.locator('#latest-turn-label').innerText(), /PRIVATE_CHAT_BODY_NOT_A_TITLE/);
  await search('字面展示');
  assert.equal(await buttons.locator('.task-option-title').innerText(), unsafeTitle);
  assert.equal(await page.locator('#task-list img, #latest-turn-label img').count(), 0, '会话标题不得作为HTML执行');
  assert.doesNotMatch(await page.locator('body').innerText(), /PRIVATE_CHAT_BODY_NOT_A_TITLE/);

  await page.locator('#task-search-clear').click();
  await page.locator('#task-sort').selectOption('desc');
  await selectTask(key(0));
  telemetry.turns.unshift({ ...telemetry.turns.find(turn => turn.id === 'turn-0000'), sessionId: 'new-session', id: 'new-turn', sessionTitle: '后到达的新任务', startedAt: new Date(base + 5000).toISOString(), outputTokens: 7777 });
  await page.locator('#refresh-button').click();
  await page.waitForFunction(() => document.querySelector('#task-count')?.textContent === '匹配 46 条 · 展示 30 条');
  assert.equal(await selectedKey(), key(0), '新任务按时间进入列表但不抢走选择');
  assert.equal(await page.locator('#metric-output').innerText(), '1,000');
  assert.match(await buttons.first().innerText(), /后到达的新任务/);
  await assertSorted('desc');

  for (const width of [1280, 1440]) {
    await page.setViewportSize({ width, height: 1050 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, '电脑页面不得整页横向溢出');
    assert.equal(await page.locator('#task-search').isVisible(), true);
    assert.equal(await page.locator('#task-sort').isVisible(), true);
    await page.locator('.task-card').screenshot({ path: path.join(outputDir, `task-search-${width}.png`) });
  }
  assert.deepEqual(errors, []);
  assert.ok(requests.every(request => request.method === 'GET'));
  assert.ok(requests.every(request => new URL(request.url).origin === new URL(service.url).origin), '验证仅访问本地合成服务');
  const report = { passed: true, browser: 'Microsoft Edge headless', source: 'synthetic-fixture-readonly-no-model-calls',
    checks: ['strict-latest-first', 'strict-earliest-first', 'completed-not-displaced-by-old-running', 'title-keywords', 'search-before-30-limit', 'multiple-keywords-and', 'case-insensitive-model', 'session-id-search', 'turn-id-search', 'combined-model-filter', 'no-matches', 'clear-search', 'whitespace-clear', 'unnamed-title', 'title-text-not-html', 'no-body-display', 'sort-preserves-selection', 'new-arrival-preserves-selection', 'desktop-1280', 'desktop-1440', 'local-get-only', 'no-js-errors'], outputDir };
  await writeFile(path.join(outputDir, 'task-search-report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  await service.close();
  const relative = path.relative(tmpdir(), fixtureRoot);
  if (!relative.startsWith('codex-task-search-browser-') || relative.includes(path.sep)) throw new Error('临时目录边界校验失败。');
  await rm(fixtureRoot, { recursive: true, force: true });
}
