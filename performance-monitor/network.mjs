import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { probeHttp, probeTcp } from './network-probe.mjs';

const inventoryScript = fileURLToPath(new URL('./network-system.ps1', import.meta.url));
const stageLabels = { local: '本地网络', proxy: '本地代理', vpn: 'VPN / 出口路径', openai: 'OpenAI 访问路径' };
const targets = {
  direct: 'http://www.msftconnecttest.com/connecttest.txt',
  control: 'https://www.microsoft.com/favicon.ico',
  openai: 'https://chatgpt.com/favicon.ico',
};
const stepLabels = { dns: 'DNS 解析', tcp: 'TCP 连接', 'proxy-connect': '代理 CONNECT 隧道',
  'proxy-tls': '代理 TLS 握手', tls: '目标 TLS 握手', http: 'HTTP 响应' };
const resultKinds = new Set(['tcp-connected', 'http-response', 'http-restricted', 'rate-limited', 'server-error',
  'proxy-authentication', 'proxy-restricted', 'proxy-rate-limited', 'proxy-server-error', 'dns-failure',
  'tcp-failure', 'tls-failure', 'timeout', 'response-failure', 'invalid-proxy', 'aborted']);
const relayErrors = {
  RelayUnavailable: '本地转发状态暂不可核对', ClientProxyMismatch: '转发入口不一致',
  RelayIdentityMismatch: '转发器身份不一致', SystemProxyDisabled: '系统代理已关闭',
  SystemProxyReadFailed: '无法读取系统代理', InvalidSystemProxy: '系统代理配置无效',
  InvalidExplicitProxy: '指定代理配置无效', ProxyLoop: '代理链路发生回环', UnsafeStatePath: '转发状态路径不可核对',
};

function safeEndpoint(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
        url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}

function normalizeSystem(raw) {
  const boolean = value => typeof value === 'boolean' ? value : null;
  const count = raw?.local?.activeAdapterCount;
  return {
    local: { activeAdapterCount: Number.isInteger(count) && count >= 0 ? count : null,
      hasDefaultRoute: boolean(raw?.local?.hasDefaultRoute), dnsConfigured: boolean(raw?.local?.dnsConfigured) },
    systemProxyUri: safeEndpoint(raw?.systemProxyUri), clientProxyUri: safeEndpoint(raw?.clientProxyUri),
    upstreamProxyUri: safeEndpoint(raw?.upstreamProxyUri),
    proxySource: ['relay', 'watchdog', 'system'].includes(raw?.proxySource) ? raw.proxySource : 'unknown',
    codex: { monitored: raw?.codex?.monitored === true, running: boolean(raw?.codex?.running),
      pid: Number.isInteger(raw?.codex?.pid) && raw.codex.pid > 0 ? raw.codex.pid : null,
      startedAt: Number.isFinite(Date.parse(raw?.codex?.startedAt)) ? raw.codex.startedAt : null },
    relay: { known: boolean(raw?.relay?.known), ready: boolean(raw?.relay?.ready),
      errorKind: Object.hasOwn(relayErrors, raw?.relay?.errorKind) ? raw.relay.errorKind : null },
    warning: raw?.message ? '部分系统信息暂不可核对。' : null,
  };
}

function normalizeProbe(raw, now) {
  return {
    checkedAt: new Date(now).toISOString(), transportOk: raw?.transportOk === true,
    kind: resultKinds.has(raw?.kind) ? raw.kind : 'response-failure',
    httpStatus: Number.isInteger(raw?.httpStatus) && raw.httpStatus >= 100 && raw.httpStatus <= 599 ? raw.httpStatus : null,
    elapsedMs: Number.isFinite(raw?.elapsedMs) && raw.elapsedMs >= 0 ? Math.round(raw.elapsedMs) : null,
    failedStep: Object.hasOwn(stepLabels, raw?.failedStep) ? raw.failedStep : null,
    errorCode: typeof raw?.errorCode === 'string' && /^[A-Z0-9_]{1,64}$/.test(raw.errorCode) ? raw.errorCode : null,
  };
}

// 只启动本次库存读取的临时进程；错误输出不进入面板，防止路径或凭据泄漏。
export function readNetworkSystem({ signal, timeoutMs = 12000, executable = 'pwsh.exe' } = {}) {
  if (process.platform !== 'win32') return Promise.resolve({ message: '平台信息不可用' });
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('库存读取已取消')); return; }
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', inventoryScript],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let failure = null;
    const stop = message => { failure ??= message; child.kill(); };
    const abort = () => stop('库存读取已取消');
    const timer = setTimeout(() => stop('库存读取超时'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (Buffer.byteLength(output, 'utf8') > 65536) stop('库存响应超出限制');
    });
    child.stderr.on('data', () => {});
    child.once('error', () => { failure ??= '库存进程无法启动'; });
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (failure || code !== 0) { reject(new Error(failure ?? '库存读取未完成')); return; }
      try { resolve(JSON.parse(output)); } catch { reject(new Error('库存响应无效')); }
    });
  });
}

function emptyStage(id, detail, staleAfterMs) {
  return { id, label: stageLabels[id], status: 'unknown', summary: '等待检测', detail,
    checkedAt: null, latencyMs: null, kind: null, httpStatus: null, failedStep: null, errorCode: null,
    evidence: [], suggestion: '等待后台完成本轮检测。', staleAfterMs };
}

function setProbe(stage, result) {
  if (!result) return stage;
  Object.assign(stage, { checkedAt: result.checkedAt, latencyMs: result.elapsedMs, kind: result.kind,
    httpStatus: result.httpStatus, failedStep: result.failedStep, errorCode: result.errorCode });
  if (result.transportOk) {
    const restricted = result.httpStatus >= 400;
    stage.status = restricted ? 'warning' : 'ok';
    stage.summary = restricted ? `已收到 HTTP ${result.httpStatus}` : '连接正常';
    stage.evidence.push(`目标已返回 HTTP ${result.httpStatus ?? '响应'}，传输链路已连通。`);
    stage.suggestion = restricted ? '这是目标返回的限制或错误响应；继续观察实际请求和官方状态，不据此判定断网。' : '当前探测可达，继续观察。';
  } else {
    stage.status = result.kind === 'aborted' ? 'unknown' : 'warning';
    const step = stepLabels[result.failedStep] ?? '连接探测';
    stage.summary = result.kind === 'timeout' ? `${step}超时` : `${step}未完成`;
    stage.evidence.push(`失败步骤：${step}${result.httpStatus ? `；HTTP ${result.httpStatus}` : ''}${result.errorCode ? `；${result.errorCode}` : ''}。`);
    stage.suggestion = '对照相邻环节与后续检测，单次失败不能确定责任方。';
  }
  return stage;
}

export class NetworkCollector {
  constructor(options = {}) {
    this.clock = options.clock ?? Date.now;
    this.readSystem = options.readSystem ?? readNetworkSystem;
    this.probeHttp = options.probeHttp ?? probeHttp;
    this.probeTcp = options.probeTcp ?? probeTcp;
    this.systemIntervalMs = options.systemIntervalMs ?? 30000;
    this.localIntervalMs = options.localIntervalMs ?? 3000;
    this.normalRemoteIntervalMs = options.normalRemoteIntervalMs ?? 30000;
    this.suspectRemoteIntervalMs = options.suspectRemoteIntervalMs ?? 10000;
    this.jobs = new Map();
    this.lastAttempts = new Map();
    this.results = {};
    this.system = null;
    this.systemAt = null;
    this.systemError = false;
    this.routeKey = null;
    this.generation = 0;
    this.history = [];
    this.lastSignature = null;
    this.lastDiagnosisSignature = null;
    this.diagnosisSince = null;
    this.updatedAt = null;
    this.closed = false;
  }

  route() {
    const system = this.system;
    const bound = system?.codex.monitored && system.codex.running === true && system.codex.pid && system.codex.startedAt &&
      ['relay', 'watchdog'].includes(system.proxySource) && system.clientProxyUri;
    return { bound: Boolean(bound), client: bound ? system.clientProxyUri : system?.systemProxyUri ?? null,
      upstream: bound ? system.upstreamProxyUri : null };
  }

  launch(name, interval, work, commit, routeSpecific = false) {
    const now = this.clock();
    if (this.closed || this.jobs.has(name) || now - (this.lastAttempts.get(name) ?? -Infinity) < interval) return null;
    const controller = new AbortController();
    const generation = this.generation;
    this.lastAttempts.set(name, now);
    const job = { controller, promise: null, routeSpecific };
    job.promise = Promise.resolve().then(() => work(controller.signal)).then(value => {
      if (this.closed || (routeSpecific && generation !== this.generation)) return;
      commit(value);
      this.updatedAt = new Date(this.clock()).toISOString();
      this.recordChange();
    }).catch(() => {
      if (this.closed || (routeSpecific && generation !== this.generation)) return;
      if (name === 'system') this.systemError = true;
      else this.results[name] = normalizeProbe({ kind: 'response-failure' }, this.clock());
      this.updatedAt = new Date(this.clock()).toISOString();
      this.recordChange();
    }).finally(() => { if (this.jobs.get(name) === job) this.jobs.delete(name); });
    this.jobs.set(name, job);
    return job.promise;
  }

  acceptSystem(raw) {
    this.system = normalizeSystem(raw);
    this.systemAt = new Date(this.clock()).toISOString();
    this.systemError = false;
    const route = this.route();
    const key = JSON.stringify([route, this.system.proxySource, this.system.codex.pid, this.system.codex.startedAt,
      this.system.relay.known, this.system.relay.ready, this.system.relay.errorKind]);
    if (key !== this.routeKey) {
      this.routeKey = key; this.generation += 1;
      for (const name of ['client', 'upstream', 'control', 'openai']) {
        delete this.results[name]; this.lastAttempts.delete(name);
        this.jobs.get(name)?.controller.abort();
      }
    }
  }

  // 每个任务独立调度。远端最长 8 秒的请求不会阻止 3 秒一次的本地端口检查。
  poll() {
    if (this.closed) return Promise.resolve();
    const pending = [];
    const schedule = (...args) => { const promise = this.launch(...args); if (promise) pending.push(promise); };
    schedule('system', this.systemIntervalMs, signal => this.readSystem({ signal }), raw => this.acceptSystem(raw));
    const remoteInterval = this.snapshot().diagnosis.status === 'ok' ? this.normalRemoteIntervalMs : this.suspectRemoteIntervalMs;
    const save = name => raw => { this.results[name] = normalizeProbe(raw, this.clock()); };
    schedule('direct', remoteInterval, signal => this.probeHttp({ targetUrl: targets.direct, signal, timeoutMs: 8000 }), save('direct'));
    if (this.system) {
      const route = this.route();
      for (const [name, endpoint] of [['client', route.client], ['upstream', route.upstream !== route.client ? route.upstream : null]]) {
        if (!endpoint) continue;
        const url = new URL(endpoint);
        schedule(name, this.localIntervalMs, signal => this.probeTcp({ host: url.hostname.replace(/^\[|\]$/g, ''),
          port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)), timeoutMs: 1500, signal }), save(name), true);
      }
      if (route.client) schedule('control', remoteInterval, signal => this.probeHttp({ targetUrl: targets.control,
        proxyUri: route.client, timeoutMs: 8000, signal }), save('control'), true);
      schedule('openai', remoteInterval, signal => this.probeHttp({ targetUrl: targets.openai,
        proxyUri: route.client, timeoutMs: 8000, signal }), save('openai'), true);
    }
    return Promise.all(pending);
  }

  buildStages(applyFreshness = true) {
    const route = this.route();
    const { direct, client, upstream, control, openai } = this.results;
    const local = emptyStage('local', `直连对照：${new URL(targets.direct).host}。TUN 和分流规则可能影响实际路径。`, 65000);
    const metadata = this.system?.local;
    if (this.systemAt) {
      local.checkedAt = this.systemAt;
      if (metadata.activeAdapterCount !== null) local.evidence.push(`活动网卡：${metadata.activeAdapterCount} 个。`);
      if (metadata.hasDefaultRoute !== null) local.evidence.push(`默认路由：${metadata.hasDefaultRoute ? '已发现' : '未发现'}。`);
      if (metadata.dnsConfigured !== null) local.evidence.push(`DNS 配置：${metadata.dnsConfigured ? '已发现' : '未发现'}。`);
    }
    setProbe(local, direct);
    // 端点可达比库存缺失更直接；库存缺失本身不等于断网。
    const directOverridesInventory = direct?.transportOk && Date.parse(direct.checkedAt) >= Date.parse(this.systemAt);
    if (!directOverridesInventory && metadata && (metadata.activeAdapterCount === 0 || metadata.hasDefaultRoute === false)) {
      local.status = metadata.activeAdapterCount === 0 ? 'error' : 'warning';
      local.summary = metadata.activeAdapterCount === 0 ? '未发现活动网卡' : '默认路由未发现，直连对照待核对';
      local.checkedAt = this.systemAt; local.failedStep = 'tcp';
      local.suggestion = '检查 Wi-Fi / 网线及当前网络路由，等待本地状态恢复。';
      if (metadata.hasDefaultRoute === false) local.evidence.push('VPN 可能使用拆分路由；缺少单条默认路由不能证明本地断网。');
    } else if (!direct && metadata?.hasDefaultRoute && metadata?.activeAdapterCount > 0) {
      local.status = 'checking'; local.summary = '本地配置可用，等待对照响应';
    }
    if (this.systemError) local.evidence.push('最近一次系统信息读取未完成，保留已取得的数据。');

    const proxy = emptyStage('proxy', route.client ? `${route.bound ? 'Codex' : '当前检测'}入口：${route.client}${route.upstream ? `；出口代理：${route.upstream}` : ''}` : '未发现可核对的本地代理入口；可能使用直连或 TUN。', 10000);
    if (client) {
      Object.assign(proxy, { checkedAt: client.checkedAt, latencyMs: client.elapsedMs, kind: client.kind,
        failedStep: client.failedStep, errorCode: client.errorCode });
      proxy.status = client.transportOk ? 'ok' : 'error';
      proxy.summary = client.transportOk ? '本地入口可连接' : '本地入口连接失败';
      proxy.evidence.push(`${route.client}：${client.transportOk ? 'TCP 已连接' : `TCP 未连接${client.errorCode ? `（${client.errorCode}）` : ''}`}。`);
      proxy.suggestion = client.transportOk ? '端口监听正常；远端可达性由后续两项检查。' : '检查本地转发器或代理是否仍在运行、监听端口是否变化。';
    }
    if (upstream) {
      proxy.evidence.push(`出口代理端口：${upstream.transportOk ? 'TCP 已连接' : 'TCP 未连接'}。`);
      if (!upstream.transportOk) {
        Object.assign(proxy, { status: 'error', summary: '出口代理端口连接失败', checkedAt: upstream.checkedAt,
          latencyMs: upstream.elapsedMs, kind: upstream.kind, failedStep: upstream.failedStep, errorCode: upstream.errorCode,
          suggestion: '检查 VPN / 代理客户端是否运行，以及它的本地监听端口。' });
      } else if (proxy.checkedAt && Date.parse(upstream.checkedAt) < Date.parse(proxy.checkedAt)) proxy.checkedAt = upstream.checkedAt;
    }
    if (this.system?.proxySource === 'relay') {
      if (this.system.relay.known && this.system.relay.ready === false) {
        Object.assign(proxy, { status: 'error', summary: '本地转发器未就绪', kind: 'relay-not-ready',
          checkedAt: this.systemAt, failedStep: 'proxy-connect', errorCode: null,
          staleAfterMs: 65000,
          suggestion: '检查转发器报告的上游配置或系统代理状态。' });
        proxy.evidence.push(relayErrors[this.system.relay.errorKind] ?? '已核对的转发器报告尚未就绪。');
      } else if (!this.system.relay.known) proxy.evidence.push('当前转发器身份或上游不可核对；TCP 连接仅证明端口在监听。');
    }

    const vpn = emptyStage('vpn', `经同一入口访问对照目标 ${new URL(targets.control).host}；不同目标仍可能走不同分流规则。`, 60000);
    if (route.client) setProbe(vpn, control);
    else { vpn.summary = '无法单独核对 VPN'; vpn.suggestion = '未发现显式代理入口；直连 / TUN 情况不能单独归责 VPN。'; }
    if (control?.transportOk && control.httpStatus < 400) vpn.summary = '代理对照路径可达';
    const openaiStage = setProbe(emptyStage('openai', `${route.client ? '经同一入口' : '当前直连方式'}访问 ${new URL(targets.openai).host}；探测不调用模型。`, 60000), openai);
    if (openai?.transportOk && openai.httpStatus < 400) openaiStage.summary = 'OpenAI 边缘路径可达';
    openaiStage.evidence.push('边缘探测成功不保证模型请求、流式输出或账户状态正常。');
    const stages = [local, proxy, vpn, openaiStage];
    const now = this.clock();
    const inventoryStale = this.systemAt && now - Date.parse(this.systemAt) > 65000;
    for (const stage of stages) {
      if (applyFreshness && ((stage.checkedAt && now - Date.parse(stage.checkedAt) > stage.staleAfterMs) ||
          (inventoryStale && stage.checkedAt))) {
        stage.status = 'stale'; stage.summary = '检测数据已过期';
        stage.suggestion = '等待下一次后台检测；历史结果不能代表当前连接。';
      }
    }
    return stages;
  }

  diagnose(stages) {
    const [local, proxy, vpn, openai] = stages;
    let diagnosis = { status: 'unknown', confidence: 'insufficient', summary: '正在收集连接依据', evidence: [],
      suggestion: '等待本地与远端探测完成。', failedStage: null, failedStep: null, since: this.diagnosisSince };
    const use = (stage, confidence, summary) => {
      diagnosis = { ...diagnosis, status: stage.status, confidence, summary, evidence: [...stage.evidence],
        suggestion: stage.suggestion, failedStage: stage.id, failedStep: stage.failedStep };
    };
    if (local.status === 'error') use(local, 'confirmed', local.summary);
    else if (proxy.status === 'error') use(proxy, 'confirmed', proxy.summary);
    else if (stages.some(stage => stage.status === 'stale')) {
      diagnosis.status = 'stale'; diagnosis.summary = '部分检测结果已过期，当前状态信息不足';
      diagnosis.suggestion = '等待新结果，不使用旧的正常状态判断当前连接。';
    } else if (vpn.status === 'warning' && !this.results.control?.transportOk) {
      use(vpn, 'suspected', '疑似代理 / VPN 出口路径异常');
      diagnosis.evidence.push('本地端口与对照探测只能定位路径，不能证明 VPN 服务或远端责任。');
    } else if (openai.status === 'warning') {
      const response = this.results.openai?.transportOk;
      use(openai, response ? 'confirmed' : 'suspected', response ? `OpenAI 路径返回 HTTP ${openai.httpStatus}` : '疑似 OpenAI 专用访问路径异常');
      diagnosis.evidence.push('对照目标与 OpenAI 可能使用不同分流规则，不能据此断定 OpenAI 服务故障。');
    } else if (vpn.status === 'warning') {
      use(vpn, 'confirmed', `对照路径返回 HTTP ${vpn.httpStatus}，传输已连通`);
    } else if (local.status === 'warning') use(local, 'insufficient', '直连对照未完成，需结合实际代理路径判断');
    else if (local.status === 'ok' && openai.status === 'ok' && (!this.route().client || (proxy.status === 'ok' && vpn.status === 'ok'))) {
      diagnosis.status = 'ok'; diagnosis.confidence = 'confirmed'; diagnosis.summary = '已检测的网络路径正常';
      diagnosis.evidence = ['本地与目标探测已响应；只反映这些检查的完成时刻。'];
      diagnosis.suggestion = '若输出停顿，结合当前思考 / 工具步骤及 token 统计观察；停顿本身不等于断网。';
    }
    if (!this.route().bound && this.system) diagnosis.evidence.push('当前路径未绑定到已核对的 Codex 启动器会话。');
    return diagnosis;
  }

  recordChange() {
    // 新结果到达前的短暂数据年龄变化不算连接故障或恢复事件。
    const stages = this.buildStages(false);
    const diagnosis = this.diagnose(stages);
    const signature = JSON.stringify([this.routeKey, diagnosis.status, diagnosis.confidence, diagnosis.failedStage,
      stages.map(stage => [stage.status, stage.kind, stage.httpStatus, stage.failedStep, stage.errorCode])]);
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    const at = new Date(this.clock()).toISOString();
    const diagnosisSignature = JSON.stringify([this.routeKey, diagnosis.status, diagnosis.confidence,
      diagnosis.failedStage, diagnosis.failedStep, diagnosis.summary]);
    if (diagnosisSignature !== this.lastDiagnosisSignature) {
      this.lastDiagnosisSignature = diagnosisSignature; this.diagnosisSince = at;
    }
    this.history.push({ at, summary: diagnosis.summary, confidence: diagnosis.confidence,
      stage: diagnosis.failedStage, status: diagnosis.status });
    if (this.history.length > 20) this.history.shift();
  }

  snapshot() {
    const stages = this.buildStages();
    const route = this.route();
    const identityStale = this.systemAt && this.clock() - Date.parse(this.systemAt) > 65000;
    return {
      updatedAt: this.updatedAt, checking: this.jobs.size > 0,
      context: { source: this.system?.proxySource ?? 'unknown',
        boundToCodex: route.bound,
        label: identityStale ? '上次核对的连接入口（等待重新核对）'
          : route.bound ? '已核对当前 Codex 连接入口' : '当前系统网络（未绑定 Codex）',
        codexEntry: route.client, systemProxy: this.system?.systemProxyUri ?? null, relayUpstream: route.upstream,
        attribution: identityStale ? '上次核对的信息已过期' : route.bound ? '已核对启动器主进程与代理入口' : '当前系统代理，未绑定Codex',
        warning: identityStale ? '链路身份信息已过期，等待重新核对。'
          : this.systemError ? '系统信息读取未完成，链路身份可能过期。' : this.system?.warning ?? null,
        observedAt: this.systemAt, codexPid: route.bound ? this.system.codex.pid : null },
      stages, diagnosis: this.diagnose(stages), history: this.history.map(value => ({ ...value })),
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map(job => job.promise));
  }
}
