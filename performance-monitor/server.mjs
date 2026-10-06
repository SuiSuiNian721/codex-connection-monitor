import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const runtimeRevision = '2026.10.06-panel.2';

const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/performance-view.mjs', ['performance-view.mjs', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

function homeKey(codexHome) {
  const normalized = path.resolve(codexHome);
  return createHash('sha256').update(process.platform === 'win32' ? normalized.toLowerCase() : normalized).digest('hex').slice(0, 24);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function existingService(port, key) {
  let health;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    if (!response.ok) return null;
    health = await response.json();
  } catch { return null; /* 占用端口可能属于别的应用；只识别自己的健康响应。 */ }
  if (health?.service === 'codex-performance-monitor' && health.version === 1 && health.homeKey === key && Number.isInteger(health.pid)) {
    if (health.runtimeRevision !== runtimeRevision) {
      const error = new Error('已有性能监测后台的运行版本与当前程序不一致；请通过启动器核验并更新后台后重试。');
      error.code = 'ERR_MONITOR_RUNTIME_MISMATCH';
      throw error;
    }
    return { url: `http://127.0.0.1:${port}/`, port, reused: true, health, close: async () => {} };
  }
  return null;
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const fail = error => { server.off('listening', ready); reject(error); };
    const ready = () => { server.off('error', fail); resolve(); };
    server.once('error', fail);
    server.once('listening', ready);
    server.listen(port, '127.0.0.1');
  });
}

async function atomicJson(file, data) {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(temp, file);
}

export async function startMonitor(options) {
  if (!options?.codexHome || !options?.stateDir) throw new Error('需要指定 Codex 数据目录和监测状态目录。');
  const codexHome = path.resolve(options.codexHome);
  const stateDir = path.resolve(options.stateDir);
  const key = homeKey(codexHome);
  const startedAt = new Date().toISOString();
  const instanceId = randomBytes(16).toString('hex');
  const manifestPath = path.join(stateDir, 'service.json');
  let origin = '';
  let collector = options.collector;
  let networkCollector = options.networkCollector;
  let generationCollector = options.generationCollector;
  let ready = false;
  let stopped = false;
  let backgroundError = null;
  let polling = null;
  let generationPolling = null;
  let timer;
  let networkTimer;
  let generationTimer;

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    try {
      const currentPort = server.address()?.port;
      const expectedHost = `127.0.0.1:${currentPort}`;
      const expectedOrigin = origin || `http://${expectedHost}`;
      if (req.headers.host !== expectedHost ||
          (req.headers.origin && req.headers.origin !== expectedOrigin) ||
          req.headers['sec-fetch-site'] === 'cross-site') {
        sendJson(res, 403, { error: '只接受本机面板的同源请求。' });
        return;
      }
      const url = new URL(req.url, expectedOrigin);
      if (url.pathname === '/api/health' && req.method === 'GET') {
        sendJson(res, 200, { service: 'codex-performance-monitor', version: 1, runtimeRevision, pid: process.pid, instanceId, homeKey: key, startedAt, ready });
        return;
      }
      if (!ready) { sendJson(res, 503, { error: '后台采集器正在准备，请稍候。' }); return; }
      if (url.pathname === '/api/generation' && req.method === 'GET') {
        sendJson(res, 200, { version: 1, generation: generationCollector.snapshot() });
        return;
      }
      if (url.pathname === '/api/status' && req.method === 'GET') {
        const telemetry = collector.snapshot();
        if (backgroundError) telemetry.warnings = [...(telemetry.warnings ?? []), backgroundError];
        sendJson(res, 200, { version: 1, startedAt, telemetry, network: networkCollector.snapshot(), generation: generationCollector.snapshot() });
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { sendJson(res, 405, { error: '不支持此请求方法。' }); return; }
      const asset = assets.get(url.pathname);
      if (!asset) { sendJson(res, 404, { error: '未找到此页面。' }); return; }
      const content = await readFile(path.join(publicDir, asset[0]));
      res.writeHead(200, { 'Content-Type': asset[1], 'Content-Length': content.length });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (res.headersSent || res.destroyed) { res.destroy(); return; }
      sendJson(res, error.status ?? 500, { error: error.status ? error.message : '后台暂时无法处理请求，请稍后重试。' });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 3000;

  // 固定的目录散列端口用于单实例判定；只监听回环，冲突时验证服务身份。
  const firstPort = options.port ?? 38000 + (parseInt(key.slice(0, 8), 16) % 10000);
  let port;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const candidate = firstPort === 0 ? 0 : firstPort + attempt;
    try {
      await listen(server, candidate);
      port = server.address().port;
      break;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      const existing = await existingService(candidate, key);
      if (existing) {
        await mkdir(stateDir, { recursive: true });
        await atomicJson(manifestPath, { version: 1, runtimeRevision, pid: existing.health.pid, port: candidate, url: existing.url,
          instanceId: existing.health.instanceId, homeKey: key, startedAt: existing.health.startedAt });
        delete existing.health;
        return existing;
      }
    }
  }
  if (!port) throw new Error('未找到可用的本机监测端口。');
  origin = `http://127.0.0.1:${port}`;

  try {
    await mkdir(stateDir, { recursive: true });
    if (!collector) {
      const { TelemetryCollector } = await import('./telemetry.mjs');
      collector = new TelemetryCollector({ codexHome });
    }
    if (!networkCollector) {
      const { NetworkCollector } = await import('./network.mjs');
      networkCollector = new NetworkCollector();
    }
    if (!generationCollector) {
      const { GenerationCollector } = await import('./generation.mjs');
      generationCollector = new GenerationCollector({ stateDir, homeKey: key });
    }
    await atomicJson(manifestPath, { version: 1, runtimeRevision, pid: process.pid, port, url: `${origin}/`, instanceId, homeKey: key, startedAt });
    ready = true;
  } catch (error) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    throw error;
  }

  const poll = () => {
    if (polling || stopped) return;
    polling = Promise.resolve().then(() => collector.poll()).then(() => {
      backgroundError = null;
    }).catch(() => {
      backgroundError = '最近一次读取未完成，将自动重试；保留已有统计。';
    }).finally(() => { polling = null; });
  };
  poll();
  timer = setInterval(poll, Math.max(20, options.pollMs ?? 3000));
  // 网络任务内部按环节防重叠，独立于 token 采集与页面请求。
  const pollNetwork = () => {
    if (stopped) return;
    Promise.resolve().then(() => networkCollector.poll()).catch(() => {});
  };
  pollNetwork();
  networkTimer = setInterval(pollNetwork, Math.max(20, options.networkPollMs ?? 1000));
  const pollGeneration = () => {
    if (generationPolling || stopped) return;
    generationPolling = Promise.resolve().then(() => generationCollector.poll()).catch(() => {})
      .finally(() => { generationPolling = null; });
  };
  pollGeneration();
  generationTimer = setInterval(pollGeneration, Math.max(20, options.generationPollMs ?? 250));
  return {
    url: `${origin}/`, port, reused: false,
    async close() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      clearInterval(networkTimer);
      clearInterval(generationTimer);
      await generationCollector.close();
      await generationPolling;
      await networkCollector.close();
      await polling;
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      try {
        const current = JSON.parse(await readFile(manifestPath, 'utf8'));
        if (current.instanceId === instanceId) await unlink(manifestPath);
      } catch { /* 不删除其它进程生成的状态文件。 */ }
    },
  };
}

async function main() {
  const { values } = parseArgs({ options: { 'codex-home': { type: 'string' }, 'state-dir': { type: 'string' } } });
  const service = await startMonitor({ codexHome: values['codex-home'], stateDir: values['state-dir'] });
  process.stdout.write(`${JSON.stringify({ url: service.url, reused: service.reused })}\n`);
  if (service.reused) return;
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await service.close();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    process.stderr.write(error.code === 'ERR_MONITOR_RUNTIME_MISMATCH' ? `${error.message}\n` : '性能监测器启动失败，请检查运行环境与目录权限。\n');
    process.exitCode = 1;
  });
}
