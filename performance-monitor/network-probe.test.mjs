import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { probeHttp, probeTcp } from './network-probe.mjs';

// 仅用于本地测试的自签名证书；成功 TLS 测试通过子进程单独信任它。
const cert = `-----BEGIN CERTIFICATE-----
MIIBSzCB86ADAgECAggiuo/mUA1rXjAKBggqhkjOPQQDAjAUMRIwEAYDVQQDEwls
b2NhbGhvc3QwHhcNMjAwMTAxMDAwMDAwWhcNNDAwMTAxMDAwMDAwWjAUMRIwEAYD
VQQDEwlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAQc+Bc31YDB
KByjNUVaMDodRUgSpCBpcd46/aWZSfi7YZ290ihdrgs+dWTQdGUezEEqD8xAWv6i
NrAXVujBHeyVoy8wLTAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwDwYDVR0T
AQH/BAUwAwEB/zAKBggqhkjOPQQDAgNHADBEAiADcCwIT5vnocWhKEQ5PrtRJtut
fkLfL3l7xS51gFPKIwIgYQu5j80BllpOAZB+Lq6I7vhwwPyv05vXJUgg1k936/I=
-----END CERTIFICATE-----`;
const key = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg51s2DijJwxlZ+5mQ
2A5IvOaR8ik9DySnF/sn3Bhf8w2hRANCAAQc+Bc31YDBKByjNUVaMDodRUgSpCBp
cd46/aWZSfi7YZ290ihdrgs+dWTQdGUezEEqD8xAWv6iNrAXVujBHeyV
-----END PRIVATE KEY-----`;

async function listen(t, server) {
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { port: server.address().port, sockets };
}

test('直接 HEAD 保留 HTTP 403 的连接证据，并及时关闭套接字', async t => {
  let method;
  const fixture = await listen(t, http.createServer((req, res) => {
    method = req.method;
    res.writeHead(403, { 'Content-Length': '99999999' });
    res.flushHeaders();
  }));
  const result = await probeHttp({ targetUrl: `http://127.0.0.1:${fixture.port}/health` });
  assert.equal(method, 'HEAD');
  assert.equal(result.transportOk, true);
  assert.equal(result.httpStatus, 403);
  assert.equal(result.kind, 'http-restricted');
  assert.equal(result.failedStep, null);
  assert.equal(result.errorCode, null);
  assert.equal(result.targetHost, '127.0.0.1');
  assert.ok(result.timings.tcp >= 0);
  assert.ok(result.timings.http >= 0);
  await delay(30);
  assert.equal(fixture.sockets.size, 0);
});

test('HTTP 429 和 5xx 单独分类，但仍然是成功收到响应', async t => {
  for (const [status, kind] of [[200, 'http-response'], [429, 'rate-limited'], [503, 'server-error']]) {
    const fixture = await listen(t, http.createServer((_req, res) => res.writeHead(status).end()));
    const result = await probeHttp({ targetUrl: `http://127.0.0.1:${fixture.port}/` });
    assert.equal(result.kind, kind);
    assert.equal(result.transportOk, true);
    assert.equal(result.httpStatus, status);
  }
});

test('拒绝远程代理、账号、路径和不支持的代理协议，错误不泄漏配置', async () => {
  for (const proxyUri of ['http://user:secret@127.0.0.1:1', 'http://127.0.0.1:1/path',
    'http://example.com:1', 'socks5://127.0.0.1:1', 'http://127.0.0.1:1/?x=secret']) {
    const result = await probeHttp({ targetUrl: 'https://example.invalid/', proxyUri });
    assert.equal(result.kind, 'invalid-proxy');
    assert.equal(result.transportOk, false);
    assert.doesNotMatch(JSON.stringify(result), /secret|user:|\/path/);
  }
});

test('TCP 检测连接成功和端口拒绝，且成功后不保留连接', async t => {
  const fixture = await listen(t, net.createServer());
  const result = await probeTcp({ host: '127.0.0.1', port: fixture.port });
  assert.equal(result.transportOk, true);
  assert.equal(result.kind, 'tcp-connected');
  assert.equal(result.failedStep, null);
  await delay(30);
  assert.equal(fixture.sockets.size, 0);
  const unused = net.createServer();
  await new Promise(resolve => unused.listen(0, '127.0.0.1', resolve));
  const unusedPort = unused.address().port;
  await new Promise(resolve => unused.close(resolve));
  const rejected = await probeTcp({ host: '127.0.0.1', port: unusedPort });
  assert.equal(rejected.kind, 'tcp-failure');
  assert.equal(rejected.failedStep, 'tcp');
  assert.equal(rejected.errorCode, 'ECONNREFUSED');
});

test('请求无 HTTP 响应时按共同 deadline 超时，并关闭连接', async t => {
  const fixture = await listen(t, net.createServer(socket => socket.on('data', () => {})));
  const result = await probeHttp({ targetUrl: `http://127.0.0.1:${fixture.port}/`, timeoutMs: 70 });
  assert.equal(result.kind, 'timeout');
  assert.equal(result.failedStep, 'http');
  assert.ok(result.elapsedMs < 1000);
  await delay(30);
  assert.equal(fixture.sockets.size, 0);
});

test('预先取消及请求中取消均可结束，取消不伪造 HTTP 结果', async t => {
  const fixture = await listen(t, net.createServer(socket => socket.on('data', () => {})));
  const targetUrl = `http://127.0.0.1:${fixture.port}/`;
  const early = new AbortController();
  early.abort();
  assert.equal((await probeHttp({ targetUrl, signal: early.signal })).kind, 'aborted');
  const running = new AbortController();
  const pending = probeHttp({ targetUrl, signal: running.signal });
  await delay(25);
  running.abort();
  const result = await pending;
  assert.equal(result.kind, 'aborted');
  assert.equal(result.transportOk, false);
  assert.equal(result.httpStatus, null);
  await delay(30);
  assert.equal(fixture.sockets.size, 0);
});

test('CONNECT 的代理拒绝响应与目标 HTTP 响应分开分类', async t => {
  for (const [status, kind] of [[407, 'proxy-authentication'], [403, 'proxy-restricted'],
    [429, 'proxy-rate-limited'], [503, 'proxy-server-error']]) {
    let firstLine;
    const fixture = await listen(t, net.createServer(socket => socket.once('data', data => {
      firstLine = data.toString().split('\r\n')[0];
      socket.write(`HTTP/1.1 ${status} Status\r\nContent-Length: 100000\r\n\r\n`);
    })));
    const result = await probeHttp({ targetUrl: 'https://example.invalid/', proxyUri: `http://127.0.0.1:${fixture.port}` });
    assert.equal(firstLine, 'CONNECT example.invalid:443 HTTP/1.1');
    assert.equal(result.kind, kind);
    assert.equal(result.transportOk, false);
    assert.equal(result.failedStep, 'proxy-connect');
    assert.equal(result.httpStatus, status);
  }
});

test('CONNECT 和最终 HTTP 头都有 32 KiB 上限', async t => {
  const fixture = await listen(t, net.createServer(socket => socket.once('data', () => {
    socket.write(`HTTP/1.1 200 OK\r\nX-Oversized: ${'x'.repeat(32768)}\r\n\r\n`);
  })));
  for (const proxied of [false, true]) {
    const result = await probeHttp({
      targetUrl: proxied ? 'https://example.invalid/' : `http://127.0.0.1:${fixture.port}/`,
      proxyUri: proxied ? `http://127.0.0.1:${fixture.port}` : null,
    });
    assert.equal(result.kind, 'response-failure');
    assert.equal(result.failedStep, proxied ? 'proxy-connect' : 'http');
    assert.equal(result.errorCode, 'HEADER_TOO_LARGE');
  }
});

test('TLS 证书失败定位在 TLS，不当作网络超时', async t => {
  const fixture = await listen(t, https.createServer({ cert, key }, (_req, res) => res.end()));
  const result = await probeHttp({ targetUrl: `https://127.0.0.1:${fixture.port}/` });
  assert.equal(result.kind, 'tls-failure');
  assert.equal(result.failedStep, 'tls');
  assert.equal(result.httpStatus, null);
  assert.equal(result.transportOk, false);
});

async function trustedProbe(t, options) {
  const temp = await mkdtemp(path.join(tmpdir(), 'codex-network-ca-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const caFile = path.join(temp, 'test-ca.pem');
  await writeFile(caFile, cert, 'utf8');
  const script = `import {probeHttp} from ${JSON.stringify(new URL('./network-probe.mjs', import.meta.url).href)};
    const result = await probeHttp(JSON.parse(process.argv[1])); process.stdout.write(JSON.stringify(result));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(options)], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: caFile }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('exit', code => {
      if (code !== 0) reject(new Error(stderr));
      else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
    });
  });
}

test('经本机 HTTP 代理 CONNECT 可完成 TLS 和 HEAD，各阶段有实际耗时', async t => {
  let method;
  const target = await listen(t, https.createServer({ cert, key }, (req, res) => {
    method = req.method;
    res.writeHead(200).end();
  }));
  const proxyServer = http.createServer();
  proxyServer.on('connect', (req, socket, head) => {
    assert.equal(req.url, `127.0.0.1:${target.port}`);
    const upstream = net.connect(target.port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
  });
  const proxy = await listen(t, proxyServer);
  const result = await trustedProbe(t, {
    targetUrl: `https://127.0.0.1:${target.port}/`, proxyUri: `http://127.0.0.1:${proxy.port}`,
  });
  assert.equal(method, 'HEAD');
  assert.equal(result.transportOk, true);
  assert.equal(result.kind, 'http-response');
  for (const phase of ['tcp', 'proxyConnect', 'tls', 'http']) assert.ok(result.timings[phase] >= 0, phase);
  assert.equal(Object.hasOwn(result.timings, 'dns'), false);
});

test('本机 HTTPS 代理先验证代理 TLS，再建立目标 TLS', async t => {
  const target = await listen(t, https.createServer({ cert, key }, (_req, res) => res.writeHead(429).end()));
  const proxyServer = https.createServer({ cert, key });
  proxyServer.on('connect', (_req, socket) => {
    const upstream = net.connect(target.port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
  });
  const proxy = await listen(t, proxyServer);
  const result = await trustedProbe(t, {
    targetUrl: `https://127.0.0.1:${target.port}/`, proxyUri: `https://127.0.0.1:${proxy.port}`,
  });
  assert.equal(result.kind, 'rate-limited');
  assert.equal(result.transportOk, true);
  assert.ok(result.timings.proxyTls >= 0);
  assert.ok(result.timings.tls >= 0);
});

test('CONNECT 后按目标 IP 校验证书，不误用代理主机名称', async t => {
  const target = await listen(t, https.createServer({ cert, key }, (_req, res) => res.end()));
  const proxyServer = http.createServer();
  proxyServer.on('connect', (_req, socket) => {
    const upstream = net.connect(target.port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
  });
  const proxy = await listen(t, proxyServer);
  const result = await trustedProbe(t, {
    targetUrl: `https://127.0.0.2:${target.port}/`, proxyUri: `http://127.0.0.1:${proxy.port}`,
  });
  assert.equal(result.kind, 'tls-failure');
  assert.equal(result.failedStep, 'tls');
  assert.equal(result.errorCode, 'ERR_TLS_CERT_ALTNAME_INVALID');
});

test('缺少 HTTP 响应头的 EOF 返回具体失败阶段，拒绝格式异常的响应', async t => {
  for (const data of ['', 'THIS IS NOT HTTP\r\n\r\n']) {
    const fixture = await listen(t, net.createServer(socket => socket.once('data', () => socket.end(data))));
    const result = await probeHttp({ targetUrl: `http://127.0.0.1:${fixture.port}/` });
    assert.equal(result.kind, 'response-failure');
    assert.equal(result.failedStep, 'http');
    assert.equal(result.httpStatus, null);
  }
});

test('CONNECT 等待与 TLS 握手等待沿用总超时，不伪造后续阶段', async t => {
  for (const acceptConnect of [false, true]) {
    const fixture = await listen(t, net.createServer(socket => socket.once('data', () => {
      if (acceptConnect) socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.on('data', () => {});
    })));
    const result = await probeHttp({
      targetUrl: 'https://example.invalid/', proxyUri: `http://127.0.0.1:${fixture.port}`, timeoutMs: 60,
    });
    assert.equal(result.kind, 'timeout');
    assert.equal(result.failedStep, acceptConnect ? 'tls' : 'proxy-connect');
    assert.equal(Object.hasOwn(result.timings, 'http'), false);
    assert.ok(result.elapsedMs < 1000);
    await delay(30);
    assert.equal(fixture.sockets.size, 0);
  }
});
