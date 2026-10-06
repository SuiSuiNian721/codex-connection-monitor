import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { promisify, parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const execute = promisify(execFile);
const registryKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const configurationErrors = new Set(['SystemProxyDisabled', 'SystemProxyReadFailed', 'InvalidSystemProxy', 'InvalidExplicitProxy', 'ProxyLoop']);

function failure(code) {
  return Object.assign(new Error(code), { code });
}

// Registry https= describes target traffic, not TLS between this relay and the proxy.
export function normalizeProxyUri(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let candidate = value.trim();
  if (candidate.includes('=')) {
    const entries = new Map(candidate.split(';').map(part => {
      const match = /^\s*([^=]+)=(.*?)\s*$/.exec(part);
      return match ? [match[1].trim().toLowerCase(), match[2]] : ['', ''];
    }));
    candidate = entries.get('http') || entries.get('https') || '';
  }
  if (!candidate.includes('://')) candidate = `http://${candidate}`;
  const match = /^(https?):\/\/(127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})\/?$/i.exec(candidate);
  if (!match) return null;
  const port = Number(match[3]);
  if (port < 1 || port > 65535) return null;
  return `${match[1].toLowerCase()}://${match[2].toLowerCase()}:${port}`;
}

export function parseSystemProxyOutput(output) {
  const enabled = /^\s*ProxyEnable\s+REG_DWORD\s+(0x[0-9a-f]+|\d+)\s*$/im.exec(output);
  if (!enabled) throw failure('SystemProxyReadFailed');
  if (Number(enabled[1]) !== 1) return null;
  const server = /^\s*ProxyServer\s+REG_SZ\s+(.+?)\s*$/im.exec(output);
  const proxyUri = normalizeProxyUri(server?.[1]);
  if (!proxyUri) throw failure('InvalidSystemProxy');
  return proxyUri;
}

export async function readSystemProxyUri() {
  if (process.platform !== 'win32') throw failure('SystemProxyReadFailed');
  const systemDirectory = process.env.SystemRoot;
  if (!systemDirectory || !path.isAbsolute(systemDirectory)) throw failure('SystemProxyReadFailed');
  let stdout;
  try {
    ({ stdout } = await execute(path.join(systemDirectory, 'System32', 'reg.exe'), ['query', registryKey], {
      windowsHide: true, encoding: 'utf8', timeout: 2000, maxBuffer: 64 * 1024,
    }));
  } catch { throw failure('SystemProxyReadFailed'); }
  return parseSystemProxyOutput(stdout);
}

export async function getConfigSnapshot({ mode, initialProxyUri, systemProxyResolver = readSystemProxyUri }) {
  if (!['System', 'Explicit'].includes(mode)) throw failure('InvalidMode');
  try {
    const value = mode === 'Explicit' ? initialProxyUri : await systemProxyResolver();
    if (mode === 'System' && value === null) return { upstreamProxyUri: null, error: 'SystemProxyDisabled' };
    const upstreamProxyUri = normalizeProxyUri(value);
    if (!upstreamProxyUri) throw failure(mode === 'System' ? 'InvalidSystemProxy' : 'InvalidExplicitProxy');
    return { upstreamProxyUri, error: null };
  } catch (error) {
    return { upstreamProxyUri: null, error: configurationErrors.has(error.code) ? error.code : 'SystemProxyReadFailed' };
  }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = error => { server.off('listening', onReady); reject(error); };
    const onReady = () => { server.off('error', onError); resolve(server.address().port); };
    server.once('error', onError);
    server.once('listening', onReady);
    server.listen({ host: '127.0.0.1', port, exclusive: true });
  });
}

function portNumber(value) {
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw failure('InvalidListenPort');
  return value;
}

function authorized(request, statusPort, statusToken) {
  if (request.headers.host !== `127.0.0.1:${statusPort}` || request.headers.origin !== undefined) return false;
  const expected = Buffer.from(`Bearer ${statusToken}`);
  const supplied = Buffer.from(request.headers.authorization || '');
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export async function createProxyRelay({
  mode = 'System', initialProxyUri, systemProxyResolver = readSystemProxyUri,
  listenPort = 0, statusPort = 0, stateFile, instanceId = randomBytes(16).toString('hex'),
  pollIntervalMs = 3000, connectTimeoutMs = 8000, maxConnections = 256,
} = {}) {
  portNumber(listenPort);
  portNumber(statusPort);
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(instanceId)) throw failure('InvalidInstanceId');
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 0 ||
      !Number.isInteger(connectTimeoutMs) || connectTimeoutMs < 100 ||
      !Number.isInteger(maxConnections) || maxConnections < 1) throw failure('InvalidRelayOptions');
  if (stateFile && (!path.isAbsolute(stateFile) || path.parse(stateFile).root === stateFile)) throw failure('InvalidStatePath');

  const startedAt = new Date().toISOString();
  const statusToken = randomBytes(32).toString('hex');
  let config = await getConfigSnapshot({ mode, initialProxyUri, systemProxyResolver });
  if (mode === 'Explicit' && config.error) throw failure(config.error);
  let generation = config.upstreamProxyUri ? 1 : 0;
  let updatedAt = startedAt;
  let checkedAt = startedAt;
  let lastConnectionError = null;
  let statePublishError = null;
  let clientProxyUri;
  let statusUri;
  let closed = false;
  let poll;
  let refreshing;
  let closePromise;
  let publishSequence = 0;
  const clients = new Set();
  const upstreamSockets = new Set();
  const statusSockets = new Set();

  function snapshot() {
    return {
      service: 'codex-proxy-relay', version: 1, pid: process.pid, instanceId, mode,
      clientProxyUri, statusUri, upstreamProxyUri: config.upstreamProxyUri,
      upstreamGeneration: generation, ready: !closed && Boolean(config.upstreamProxyUri),
      listening: !closed && Boolean(clientProxyUri), activeTunnels: clients.size,
      startedAt, updatedAt, checkedAt, error: config.error, lastConnectionError, statePublishError,
    };
  }

  function excludeSelf(candidate) {
    if (!candidate.upstreamProxyUri) return candidate;
    const port = Number(new URL(candidate.upstreamProxyUri).port || (candidate.upstreamProxyUri.startsWith('https:') ? 443 : 80));
    if (port === listenPort || port === statusPort) return { upstreamProxyUri: null, error: 'ProxyLoop' };
    return candidate;
  }

  async function publish(includeClosed = false) {
    if (!stateFile || (closed && !includeClosed)) return;
    const temporary = `${stateFile}.${instanceId}.${++publishSequence}.tmp`;
    try {
      await mkdir(path.dirname(stateFile), { recursive: true });
      await writeFile(temporary, `${JSON.stringify({ ...snapshot(), statusToken }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await rename(temporary, stateFile);
      statePublishError = null;
    } catch (error) {
      statePublishError = 'StatePublishFailed';
      throw error;
    } finally {
      try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') statePublishError = 'StatePublishFailed'; }
    }
  }

  async function refreshUpstream() {
    if (closed) return snapshot();
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const next = excludeSelf(await getConfigSnapshot({ mode, initialProxyUri, systemProxyResolver }));
      if (closed) return snapshot();
      checkedAt = new Date().toISOString();
      if (next.upstreamProxyUri !== config.upstreamProxyUri || next.error !== config.error) {
        if (next.upstreamProxyUri !== config.upstreamProxyUri) generation++;
        config = next;
        updatedAt = checkedAt;
        lastConnectionError = null;
      }
      await publish();
      return snapshot();
    })();
    try { return await refreshing; } finally { refreshing = null; }
  }

  const proxyServer = net.createServer({ allowHalfOpen: true }, client => {
    client.on('error', () => {});
    const selected = config.upstreamProxyUri;
    if (closed || !selected || clients.size >= maxConnections) { client.destroy(); return; }
    clients.add(client);
    client.setNoDelay(true);
    client.pause();
    const target = new URL(selected);
    const secure = target.protocol === 'https:';
    const hostname = target.hostname.replace(/^\[|\]$/g, '');
    const options = {
      host: hostname === 'localhost' ? '127.0.0.1' : hostname,
      port: Number(target.port || (secure ? 443 : 80)), allowHalfOpen: true,
    };
    let connected = false;
    let upstream;
    const dispose = () => { client.destroy(); upstream?.destroy(); };
    const timeout = setTimeout(() => { lastConnectionError = 'UpstreamConnectTimeout'; dispose(); }, connectTimeoutMs);
    try {
      upstream = secure
        ? tls.connect({ ...options, rejectUnauthorized: true, servername: hostname === 'localhost' ? hostname : undefined })
        : net.createConnection(options);
      upstreamSockets.add(upstream);
      upstream.setNoDelay(true);
      upstream.once(secure ? 'secureConnect' : 'connect', () => {
        connected = true;
        clearTimeout(timeout);
        if (client.destroyed) { upstream.destroy(); return; }
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on('error', () => {
        lastConnectionError = secure && !connected ? 'UpstreamTlsFailed' : 'UpstreamConnectionFailed';
        dispose();
      });
      upstream.once('close', () => {
        clearTimeout(timeout);
        upstreamSockets.delete(upstream);
        client.destroy();
      });
    } catch {
      lastConnectionError = 'UpstreamConnectionFailed';
      clearTimeout(timeout);
      dispose();
    }
    client.once('close', () => {
      clearTimeout(timeout);
      clients.delete(client);
      upstream?.destroy();
    });
  });

  const statusServer = http.createServer({ maxHeaderSize: 4096 }, (request, response) => {
    if (request.method !== 'GET' || request.url !== '/status' || !authorized(request, statusPort, statusToken)) {
      response.writeHead(404, { 'Content-Type': 'text/plain', Connection: 'close' });
      response.end('Not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' });
    response.end(JSON.stringify(snapshot()));
  });
  statusServer.headersTimeout = 5000;
  statusServer.requestTimeout = 5000;
  statusServer.on('connection', socket => {
    statusSockets.add(socket);
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('close', () => statusSockets.delete(socket));
  });

  function close() {
    if (closePromise) return closePromise;
    closed = true;
    clearInterval(poll);
    closePromise = (async () => {
      for (const socket of [...clients, ...upstreamSockets, ...statusSockets]) socket.destroy();
      await Promise.all([proxyServer, statusServer].map(server => new Promise(resolve => {
        if (server.listening) server.close(resolve); else resolve();
      })));
      try { await refreshing; } catch { }
      if (stateFile) {
        try {
          const state = JSON.parse(await readFile(stateFile, 'utf8'));
          // Keep the listener lease so the launcher can restore the same client endpoint.
          if (state.instanceId === instanceId && state.pid === process.pid) await publish(true);
        } catch { }
      }
    })();
    return closePromise;
  }

  try {
    listenPort = await listen(proxyServer, listenPort);
    clientProxyUri = `http://127.0.0.1:${listenPort}`;
    statusPort = await listen(statusServer, statusPort);
    statusUri = `http://127.0.0.1:${statusPort}/status`;
    config = excludeSelf(config);
    if (mode === 'Explicit' && config.error) throw failure(config.error);
    await publish();
    if (mode === 'System' && pollIntervalMs > 0) {
      poll = setInterval(() => { void refreshUpstream().catch(() => {}); }, pollIntervalMs);
      poll.unref();
    }
    return { clientProxyUri, statusUri, statusToken, getConfigSnapshot: snapshot, refreshUpstream, close };
  } catch (error) { await close(); throw error; }
}

async function main() {
  const { values } = parseArgs({ options: {
    mode: { type: 'string', default: 'System' },
    'initial-proxy-uri': { type: 'string' },
    'state-file': { type: 'string' },
    'instance-id': { type: 'string' },
    'listen-port': { type: 'string', default: '0' },
    'status-port': { type: 'string', default: '0' },
  } });
  if (!values['state-file'] || !values['instance-id']) throw failure('MissingStartupIdentity');
  const relay = await createProxyRelay({
    mode: values.mode, initialProxyUri: values['initial-proxy-uri'], stateFile: values['state-file'],
    instanceId: values['instance-id'], listenPort: Number(values['listen-port']), statusPort: Number(values['status-port']),
  });
  const stop = () => { void relay.close().then(() => { process.exitCode = 0; }); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    const code = typeof error.code === 'string' && /^[A-Za-z0-9_]+$/.test(error.code) ? error.code : 'RelayStartFailed';
    process.stderr.write(`${JSON.stringify({ error: code })}\n`);
    process.exitCode = 1;
  });
}
