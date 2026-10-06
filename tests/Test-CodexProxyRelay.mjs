import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

const moduleUrl = new URL('../proxy-relay/relay.mjs', import.meta.url);
const relayPath = fileURLToPath(moduleUrl);
let implementation;
try { implementation = await import(moduleUrl); } catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

function api() {
  assert.ok(implementation, 'The stable proxy relay module must exist.');
  return implementation;
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function fakeProxy(label, tlsOptions) {
  const sockets = new Set();
  const transports = new Set();
  const createServer = tlsOptions ? tls.createServer : net.createServer;
  const server = createServer({ allowHalfOpen: true, ...tlsOptions }, socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let headers = Buffer.alloc(0);
    let tunnel = false;
    socket.on('data', chunk => {
      if (tunnel) { socket.write(chunk); return; }
      headers = Buffer.concat([headers, chunk]);
      const end = headers.indexOf('\r\n\r\n');
      if (end === -1) return;
      assert.match(headers.subarray(0, end).toString(), /^CONNECT /);
      socket.write(`HTTP/1.1 200 Connection Established\r\nX-Fixture: ${label}\r\n\r\n`);
      tunnel = true;
      const tail = headers.subarray(end + 4);
      if (tail.length) socket.write(tail);
    });
    socket.on('end', () => socket.end());
  });
  server.on('connection', socket => {
    transports.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => transports.delete(socket));
  });
  const port = await listen(server);
  return {
    uri: `${tlsOptions ? 'https://localhost' : 'http://127.0.0.1'}:${port}`,
    sockets,
    async close() {
      for (const socket of [...sockets, ...transports]) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function connect(uri) {
  const address = new URL(uri);
  const socket = net.createConnection({ host: address.hostname, port: address.port });
  socket.on('error', () => {});
  await once(socket, 'connect');
  return socket;
}

function receive(socket, predicate = buffer => buffer.length > 0) {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const timer = setTimeout(() => done(new Error('fixture receive timed out')), 3000);
    const onData = chunk => {
      data = Buffer.concat([data, chunk]);
      if (predicate(data)) done(null, data);
    };
    const onError = error => done(error);
    const onEnd = () => done(new Error('connection ended before fixture response'));
    function done(error, result) {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onEnd);
      if (error) reject(error); else resolve(result);
    }
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('end', onEnd);
  });
}

async function openTunnel(uri, label) {
  const socket = await connect(uri);
  try {
    const response = receive(socket, data => data.includes('\r\n\r\n'));
    socket.write('CONNECT fixture.invalid:443 HTTP/1.1\r\nHost: fixture.invalid:443\r\n\r\n');
    assert.match((await response).toString(), new RegExp(`X-Fixture: ${label}`));
    return socket;
  } catch (error) { socket.destroy(); throw error; }
}

async function echo(socket, bytes) {
  const response = receive(socket, data => data.length >= bytes.length);
  socket.write(bytes);
  assert.deepEqual(await response, bytes);
}

function statusRequest(uri, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = http.request(uri, { headers, method, agent: false, timeout: 3000 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('timeout', () => request.destroy(new Error('status request timed out')));
    request.on('error', reject);
    request.end();
  });
}

test('accepts only credential-free loopback HTTP proxies and registry protocol mappings', () => {
  const { normalizeProxyUri, parseSystemProxyOutput } = api();
  assert.equal(normalizeProxyUri('127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(normalizeProxyUri('http=127.0.0.1:7890;https=127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(normalizeProxyUri('https://localhost:9674'), 'https://localhost:9674');
  assert.equal(normalizeProxyUri('http://[::1]:7890'), 'http://[::1]:7890');
  for (const value of ['http://example.com:7890', 'http://127.0.0.1:7890/path', 'http://user:secret@127.0.0.1:7890', 'socks=127.0.0.1:7890', 'http://127.0.0.1:7890?secret=x', 'http://0.0.0.0:7890', 'http://127.0.0.1:0', 'http://127.0.0.1', 'file:///tmp/123', 'http://127.0.0.1:7890#hash']) {
    assert.equal(normalizeProxyUri(value), null, value);
  }
  assert.equal(parseSystemProxyOutput('HKEY_CURRENT_USER\\Internet Settings\r\n    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    127.0.0.1:7890\r\n'), 'http://127.0.0.1:7890');
  assert.equal(parseSystemProxyOutput('    ProxyEnable    REG_DWORD    0x0\n    ProxyServer    REG_SZ    127.0.0.1:7890'), null);
  assert.throws(() => parseSystemProxyOutput('unexpected output'), /SystemProxyReadFailed/);
  assert.throws(() => parseSystemProxyOutput('    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    remote.invalid:7890'), /InvalidSystemProxy/);
});

test('refresh polling observes a changed upstream without replacing the client listener', async () => {
  const { createProxyRelay } = api();
  const first = await fakeProxy('A');
  const second = await fakeProxy('B');
  let current = first.uri;
  let relay;
  let tunnel;
  try {
    relay = await createProxyRelay({ mode: 'System', systemProxyResolver: async () => current, pollIntervalMs: 20 });
    const entry = relay.clientProxyUri;
    current = second.uri;
    const deadline = Date.now() + 1000;
    while (relay.getConfigSnapshot().upstreamProxyUri !== current && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(relay.getConfigSnapshot().upstreamProxyUri, current);
    assert.equal(relay.clientProxyUri, entry);
    tunnel = await openTunnel(entry, 'B');
  } finally { tunnel?.destroy(); await relay?.close(); await first.close(); await second.close(); }
});

test('HTTP proxy requests and binary bodies pass through without parsing or rewriting', async () => {
  const { createProxyRelay } = api();
  const expectedBody = Buffer.from([0, 1, 255, 128, 42]);
  let received;
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      received = { url: request.url, method: request.method, header: request.headers['x-test-header'], body: Buffer.concat(chunks) };
      response.writeHead(418, { 'X-Test-Response': 'unchanged', Connection: 'close' });
      response.end(expectedBody);
    });
  });
  const port = await listen(upstream);
  let relay;
  try {
    relay = await createProxyRelay({ mode: 'Explicit', initialProxyUri: `http://127.0.0.1:${port}` });
    const result = await new Promise((resolve, reject) => {
      const target = new URL(relay.clientProxyUri);
      const request = http.request({ hostname: target.hostname, port: target.port, method: 'POST', path: 'http://fixture.invalid/example?x=1', headers: { 'X-Test-Header': 'unchanged' }, agent: false }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, header: response.headers['x-test-response'], body: Buffer.concat(chunks) }));
      });
      request.on('error', reject);
      request.end(expectedBody);
    });
    assert.deepEqual(received, { url: 'http://fixture.invalid/example?x=1', method: 'POST', header: 'unchanged', body: expectedBody });
    assert.deepEqual(result, { status: 418, header: 'unchanged', body: expectedBody });
  } finally { await relay?.close(); await new Promise(resolve => upstream.close(resolve)); }
});

test('half-close forwards a complete large response to a temporarily paused client', async () => {
  const { createProxyRelay } = api();
  const payload = Buffer.alloc(2 * 1024 * 1024, 0xA5);
  const sockets = new Set();
  const upstream = net.createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.resume();
    socket.on('end', () => socket.end(payload));
  });
  const port = await listen(upstream);
  let relay;
  let client;
  try {
    relay = await createProxyRelay({ mode: 'Explicit', initialProxyUri: `http://127.0.0.1:${port}` });
    client = await connect(relay.clientProxyUri);
    client.pause();
    const body = new Promise((resolve, reject) => {
      const chunks = [];
      client.on('data', chunk => chunks.push(chunk));
      client.once('end', () => resolve(Buffer.concat(chunks)));
      client.once('error', reject);
    });
    client.end('request ends with FIN');
    await new Promise(resolve => setTimeout(resolve, 100));
    client.resume();
    assert.deepEqual(await body, payload);
  } finally {
    client?.destroy();
    await relay?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('a fixed relay port can be reused after the prior relay has closed', async () => {
  const { createProxyRelay } = api();
  const upstream = await fakeProxy('RESTART');
  let first;
  let second;
  let tunnel;
  try {
    first = await createProxyRelay({ mode: 'Explicit', initialProxyUri: upstream.uri });
    const original = first.clientProxyUri;
    await first.close();
    second = await createProxyRelay({ mode: 'Explicit', initialProxyUri: upstream.uri, listenPort: Number(new URL(original).port) });
    assert.equal(second.clientProxyUri, original);
    tunnel = await openTunnel(second.clientProxyUri, 'RESTART');
  } finally { tunnel?.destroy(); await first?.close(); await second?.close(); await upstream.close(); }
});

test('closing preserves its port lease and cannot overwrite a replacement manifest', async () => {
  const { createProxyRelay } = api();
  const upstream = await fakeProxy('A');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'codex-relay-state-test-'));
  const stateFile = path.join(temporary, 'service.json');
  let relay;
  try {
    relay = await createProxyRelay({ mode: 'Explicit', initialProxyUri: upstream.uri, stateFile, instanceId: 'mine' });
    assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).instanceId, 'mine');
    const entry = relay.clientProxyUri;
    await relay.close();
    const retained = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(retained.clientProxyUri, entry);
    assert.equal(retained.ready, false);
    assert.equal(retained.listening, false);
    relay = await createProxyRelay({ mode: 'Explicit', initialProxyUri: upstream.uri, stateFile, instanceId: 'mine-again' });
    await writeFile(stateFile, JSON.stringify({ instanceId: 'replacement', pid: process.pid }), 'utf8');
    await relay.close();
    assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).instanceId, 'replacement');
  } finally { await relay?.close(); await upstream.close(); await rm(temporary, { recursive: true, force: true }); }
});

function localhostCertificate() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$key = [Security.Cryptography.RSA]::Create(2048)',
    "$request = [Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=localhost', $key, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)",
    '$san = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()',
    "$san.AddDnsName('localhost')",
    '$request.CertificateExtensions.Add($san.Build())',
    '$certificate = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1), [DateTimeOffset]::UtcNow.AddDays(1))',
    '@{ key=$key.ExportPkcs8PrivateKeyPem(); cert=$certificate.ExportCertificatePem() } | ConvertTo-Json -Compress',
    '$certificate.Dispose()',
    '$key.Dispose()',
  ].join('\n');
  return JSON.parse(execFileSync('pwsh.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true }));
}

test('HTTPS upstreams use certificate validation and reject an untrusted certificate', async () => {
  const { createProxyRelay } = api();
  const upstream = await fakeProxy('TLS', localhostCertificate());
  let relay;
  let socket;
  try {
    relay = await createProxyRelay({ mode: 'Explicit', initialProxyUri: upstream.uri });
    socket = await connect(relay.clientProxyUri);
    const closed = new Promise(resolve => socket.once('close', resolve));
    socket.write('CONNECT fixture.invalid:443 HTTP/1.1\r\n\r\n');
    await closed;
    assert.equal(relay.getConfigSnapshot().lastConnectionError, 'UpstreamTlsFailed');
    assert.equal(upstream.sockets.size, 0);
  } finally { socket?.destroy(); await relay?.close(); await upstream.close(); }
});

test('CONNECT bytes keep their old upstream while new connections follow the new upstream', async () => {
  const { createProxyRelay } = api();
  const first = await fakeProxy('A');
  const second = await fakeProxy('B');
  let upstream = first.uri;
  let relay;
  let oldTunnel;
  let newTunnel;
  try {
    relay = await createProxyRelay({ mode: 'System', systemProxyResolver: async () => upstream, pollIntervalMs: 0 });
    oldTunnel = await openTunnel(relay.clientProxyUri, 'A');
    const bytes = Buffer.from([0, 255, 128, 22, 3, 3, 10, 13, 250]);
    await echo(oldTunnel, bytes);
    upstream = second.uri;
    await relay.refreshUpstream();
    newTunnel = await openTunnel(relay.clientProxyUri, 'B');
    await echo(newTunnel, Buffer.from('new TLS/WebSocket stream'));
    await echo(oldTunnel, Buffer.from('old stream remains on A'));
    assert.equal(relay.getConfigSnapshot().upstreamProxyUri, second.uri);
    assert.equal(relay.getConfigSnapshot().upstreamGeneration, 2);
  } finally {
    oldTunnel?.destroy();
    newTunnel?.destroy();
    await relay?.close();
    await first.close();
    await second.close();
  }
});

test('System mode never falls back to an initial URI and refuses new connections when disabled', async () => {
  const { createProxyRelay } = api();
  const fallback = await fakeProxy('UNSAFE-FALLBACK');
  let relay;
  let socket;
  try {
    relay = await createProxyRelay({ mode: 'System', initialProxyUri: fallback.uri, systemProxyResolver: async () => null, pollIntervalMs: 0 });
    assert.equal(relay.getConfigSnapshot().upstreamProxyUri, null);
    assert.equal(relay.getConfigSnapshot().ready, false);
    assert.equal(relay.getConfigSnapshot().error, 'SystemProxyDisabled');
    socket = await connect(relay.clientProxyUri);
    const closed = new Promise(resolve => socket.once('close', resolve));
    socket.write('CONNECT direct-must-never-happen.invalid:443 HTTP/1.1\r\n\r\n');
    await closed;
    assert.equal(fallback.sockets.size, 0);
  } finally { socket?.destroy(); await relay?.close(); await fallback.close(); }
});

test('a failed registry refresh disables new routing without interrupting an existing tunnel', async () => {
  const { createProxyRelay } = api();
  const upstream = await fakeProxy('A');
  let fail = false;
  let relay;
  let tunnel;
  try {
    relay = await createProxyRelay({ mode: 'System', systemProxyResolver: async () => {
      if (fail) throw new Error('fixture contains private details which must not escape');
      return upstream.uri;
    }, pollIntervalMs: 0 });
    tunnel = await openTunnel(relay.clientProxyUri, 'A');
    fail = true;
    await relay.refreshUpstream();
    assert.equal(relay.getConfigSnapshot().upstreamProxyUri, null);
    assert.equal(relay.getConfigSnapshot().error, 'SystemProxyReadFailed');
    assert.doesNotMatch(JSON.stringify(relay.getConfigSnapshot()), /private details/);
    await echo(tunnel, Buffer.from('existing streams survive a registry read failure'));
  } finally { tunnel?.destroy(); await relay?.close(); await upstream.close(); }
});

test('status is authenticated, read-only, restricted to the expected Host and rejects browser origins', async () => {
  const { createProxyRelay } = api();
  const upstream = await fakeProxy('A');
  let relay;
  try {
    relay = await createProxyRelay({ mode: 'Explicit', initialProxyUri: upstream.uri, pollIntervalMs: 0 });
    const headers = { Authorization: `Bearer ${relay.statusToken}` };
    const good = await statusRequest(relay.statusUri, headers);
    assert.equal(good.status, 200);
    const parsed = JSON.parse(good.body);
    assert.equal(parsed.instanceId, relay.getConfigSnapshot().instanceId);
    assert.equal(parsed.clientProxyUri, relay.clientProxyUri);
    assert.equal(parsed.statusToken, undefined);
    assert.notEqual((await statusRequest(relay.statusUri)).status, 200);
    assert.notEqual((await statusRequest(relay.statusUri, { ...headers, Origin: 'https://example.com' })).status, 200);
    assert.notEqual((await statusRequest(relay.statusUri, { ...headers, Host: 'example.com' })).status, 200);
    assert.equal((await statusRequest(relay.statusUri.replace('/status', '/upstream'), headers, 'PUT')).status, 404);
    assert.equal((await statusRequest(relay.statusUri, headers, 'POST')).status, 404);
  } finally { await relay?.close(); await upstream.close(); }
});

test('rejects relay self-loops and cannot steal an occupied fixed listener port', async () => {
  const { createProxyRelay } = api();
  const upstream = await fakeProxy('A');
  let current = upstream.uri;
  let relay;
  try {
    relay = await createProxyRelay({ mode: 'System', systemProxyResolver: async () => current, pollIntervalMs: 0 });
    current = relay.clientProxyUri;
    await relay.refreshUpstream();
    assert.equal(relay.getConfigSnapshot().upstreamProxyUri, null);
    assert.equal(relay.getConfigSnapshot().error, 'ProxyLoop');
    await assert.rejects(createProxyRelay({ mode: 'Explicit', initialProxyUri: upstream.uri, listenPort: Number(new URL(relay.clientProxyUri).port), pollIntervalMs: 0 }), { code: 'EADDRINUSE' });
  } finally { await relay?.close(); await upstream.close(); }
});

test('CLI atomically publishes identity state and honors its explicit upstream', async () => {
  api();
  const upstream = await fakeProxy('CLI');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'codex-relay-test-'));
  const stateFile = path.join(temporary, 'service.json');
  let child;
  let tunnel;
  let exitPromise;
  try {
    child = spawn(process.execPath, [relayPath, '--mode', 'Explicit', '--initial-proxy-uri', upstream.uri, '--state-file', stateFile, '--instance-id', 'fixture-cli', '--listen-port', '0'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    exitPromise = once(child, 'exit');
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const deadline = Date.now() + 5000;
    let state;
    while (!state && Date.now() < deadline) {
      try { state = JSON.parse(await readFile(stateFile, 'utf8')); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (!state) await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(state, `CLI did not become ready: ${stderr}`);
    assert.equal(state.pid, child.pid);
    assert.equal(state.instanceId, 'fixture-cli');
    assert.equal(state.mode, 'Explicit');
    assert.equal(state.service, 'codex-proxy-relay');
    assert.equal(state.upstreamProxyUri, upstream.uri);
    assert.equal(state.ready, true);
    assert.equal((await readFile(stateFile))[0], '{'.charCodeAt(0));
    assert.deepEqual(await readdir(temporary), ['service.json']);
    const response = await statusRequest(state.statusUri, { Authorization: `Bearer ${state.statusToken}` });
    assert.equal(response.status, 200);
    tunnel = await openTunnel(state.clientProxyUri, 'CLI');
    await echo(tunnel, Buffer.from('no real VPN was contacted'));
  } finally {
    tunnel?.destroy();
    if (child && child.exitCode === null) child.kill();
    if (exitPromise) await exitPromise;
    await upstream.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
