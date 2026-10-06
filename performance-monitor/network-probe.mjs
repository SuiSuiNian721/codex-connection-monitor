import net from 'node:net';
import tls from 'node:tls';
import { performance } from 'node:perf_hooks';

const HEADER_LIMIT = 32 * 1024;
const unbracket = host => host.replace(/^\[|\]$/g, '');
const elapsed = since => Math.max(0, Math.round((performance.now() - since) * 10) / 10);

function safeCode(code, fallback) {
  return typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code) ? code : fallback;
}

function failureKind(step) {
  if (step === 'dns') return 'dns-failure';
  if (step === 'tcp') return 'tcp-failure';
  if (step === 'tls' || step === 'proxy-tls') return 'tls-failure';
  return 'response-failure';
}

function responseKind(status, proxy = false) {
  if (proxy) {
    if (status === 407) return 'proxy-authentication';
    if (status === 429) return 'proxy-rate-limited';
    if (status >= 500) return 'proxy-server-error';
    return 'proxy-restricted';
  }
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'server-error';
  if ([401, 403, 407].includes(status)) return 'http-restricted';
  return 'http-response';
}

// 所有 DNS、TCP、CONNECT、TLS 和 HTTP 阶段共享一个截止时间。
function attempt({ targetHost, timeoutMs, signal }, start) {
  return new Promise(resolve => {
    const began = performance.now();
    const sockets = new Set();
    const result = {
      targetHost, startedAt: new Date().toISOString(), checkedAt: null,
      transportOk: false, kind: null, httpStatus: null, elapsedMs: null,
      failedStep: null, errorCode: null, timings: {},
    };
    let done = false;
    let step = 'tcp';
    let phaseBegan = began;
    let timer;
    const setStep = next => { step = next; phaseBegan = performance.now(); };
    const record = name => { result.timings[name] = elapsed(phaseBegan); };
    function finish(values) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      for (const socket of sockets) socket.destroy();
      resolve({ ...result, ...values, checkedAt: new Date().toISOString(), elapsedMs: elapsed(began) });
    }
    function fail(code, kind = failureKind(step)) {
      finish({ kind, failedStep: step, errorCode: safeCode(code, 'PROBE_FAILED') });
    }
    const abort = () => fail('ABORTED', 'aborted');
    function track(socket) {
      sockets.add(socket);
      socket.on('error', error => fail(error.code));
      socket.on('close', () => { if (!done) fail('CONNECTION_CLOSED'); });
      return socket;
    }
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    const deadline = Number.isFinite(timeoutMs) ? Math.min(8000, Math.max(1, timeoutMs)) : 8000;
    timer = setTimeout(() => fail('ETIMEDOUT', 'timeout'), deadline);
    try { start({ setStep, record, track, finish, fail, isDone: () => done }); }
    catch (error) { fail(error.code); }
  });
}

function connect(host, port, state, ready) {
  state.setStep(net.isIP(host) ? 'tcp' : 'dns');
  const socket = state.track(net.createConnection({ host, port }));
  socket.once('lookup', error => {
    if (state.isDone() || error) return;
    state.record('dns');
    state.setStep('tcp');
  });
  socket.once('connect', () => {
    if (state.isDone()) return;
    state.record('tcp');
    ready(socket);
  });
}

function secure(socket, host, proxy, state, ready) {
  state.setStep(proxy ? 'proxy-tls' : 'tls');
  const secureSocket = state.track(tls.connect({
    socket, host, servername: net.isIP(host) ? undefined : host,
    rejectUnauthorized: true, ALPNProtocols: ['http/1.1'],
  }));
  secureSocket.once('secureConnect', () => {
    if (state.isDone()) return;
    state.record(proxy ? 'proxyTls' : 'tls');
    ready(secureSocket);
  });
}

// 只解析响应头。HEAD 响应和 CONNECT 失败均不读取响应正文。
function readHeaders(socket, state, received) {
  let pending = Buffer.alloc(0);
  let consumed = 0;
  const onData = chunk => {
    if (state.isDone()) return;
    pending = Buffer.concat([pending, chunk]);
    while (true) {
      const end = pending.indexOf('\r\n\r\n');
      const bytes = end < 0 ? pending.length : end + 4;
      if (consumed + bytes > HEADER_LIMIT) {
        socket.removeListener('data', onData);
        state.fail('HEADER_TOO_LARGE', 'response-failure');
        return;
      }
      if (end < 0) return;
      const firstLine = pending.subarray(0, end).toString('latin1').split('\r\n')[0];
      const match = /^HTTP\/1\.[01] ([1-5]\d\d)(?:[ \t][^\r\n]*)?$/.exec(firstLine);
      if (!match) { state.fail('INVALID_HTTP_RESPONSE', 'response-failure'); return; }
      const status = Number(match[1]);
      consumed += bytes;
      pending = pending.subarray(bytes);
      if (status >= 100 && status < 200 && status !== 101) continue;
      socket.removeListener('data', onData);
      socket.pause();
      if (pending.length) socket.unshift(pending);
      received(status);
      return;
    }
  };
  socket.on('data', onData);
  socket.resume();
}

function parseProxy(proxyUri) {
  if (typeof proxyUri !== 'string' || !/^https?:\/\/(?:\[[^\]]+\]|[^/?#:@\s]+)(?::\d+)?\/?$/i.test(proxyUri)) return null;
  try {
    const url = new URL(proxyUri);
    const host = unbracket(url.hostname);
    const loopback = host === 'localhost' || host === '::1' || (net.isIP(host) === 4 && host.startsWith('127.'));
    if (!loopback || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return { host, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)), secure: url.protocol === 'https:' };
  } catch { return null; }
}

export function probeTcp({ host, port, timeoutMs = 1500, signal } = {}) {
  return attempt({ targetHost: typeof host === 'string' ? host : null, timeoutMs, signal }, state => {
    if (typeof host !== 'string' || !Number.isInteger(port) || port < 1 || port > 65535) {
      state.fail('INVALID_ENDPOINT', 'tcp-failure');
      return;
    }
    connect(unbracket(host), port, state, () => state.finish({ kind: 'tcp-connected', transportOk: true }));
  });
}

export function probeHttp({ targetUrl, proxyUri = null, timeoutMs = 8000, signal } = {}) {
  let target;
  try {
    target = new URL(targetUrl);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hash) target = null;
  } catch { target = null; }
  const targetHost = target ? unbracket(target.hostname) : null;
  return attempt({ targetHost, timeoutMs, signal }, state => {
    if (!target) { state.setStep('http'); state.fail('INVALID_TARGET', 'response-failure'); return; }
    const proxy = proxyUri === null ? null : parseProxy(proxyUri);
    if (proxyUri !== null && (!proxy || target.protocol !== 'https:')) {
      state.setStep('proxy-connect');
      state.fail('INVALID_PROXY', 'invalid-proxy');
      return;
    }
    const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
    const head = socket => {
      state.setStep('http');
      readHeaders(socket, state, status => {
        state.record('http');
        state.finish({ kind: responseKind(status), transportOk: true, httpStatus: status });
      });
      socket.write(`HEAD ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.host}\r\nUser-Agent: Codex-Local-Network-Monitor/1\r\nConnection: close\r\n\r\n`);
    };
    if (!proxy) {
      connect(targetHost, port, state, socket => {
        if (target.protocol === 'https:') secure(socket, targetHost, false, state, head);
        else head(socket);
      });
      return;
    }
    const tunnel = socket => {
      state.setStep('proxy-connect');
      readHeaders(socket, state, status => {
        state.record('proxyConnect');
        if (status !== 200) {
          state.finish({ kind: responseKind(status, true), httpStatus: status, failedStep: 'proxy-connect' });
          return;
        }
        secure(socket, targetHost, false, state, head);
      });
      const authority = `${target.hostname}:${port}`;
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nUser-Agent: Codex-Local-Network-Monitor/1\r\n\r\n`);
    };
    connect(proxy.host, proxy.port, state, socket => {
      if (proxy.secure) secure(socket, proxy.host, true, state, tunnel);
      else tunnel(socket);
    });
  });
}
