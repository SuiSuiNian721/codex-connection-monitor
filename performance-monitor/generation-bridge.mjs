import { ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath, pathToFileURL } from 'node:url';

const windowMs = 3000;
const bucketCount = windowMs + 1;
const itemLimit = 20;
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const phaseOf = value => value === 'commentary' || value === 'final_answer' ? value : null;
const captureRegistryKey = Symbol.for('codex.generation.capture.v1');
const unsafeMessages = new Set(['linked-metadata-path', 'invalid-metadata-path', 'invalid-metadata-directory', 'linked-metadata-file', 'invalid-metadata-file']);

function captureRegistry() {
  if (!(globalThis[captureRegistryKey] instanceof Map)) globalThis[captureRegistryKey] = new Map();
  return globalThis[captureRegistryKey];
}

function safeErrorCode(error) {
  if (unsafeMessages.has(error?.message)) return 'UNSAFE_PATH';
  return typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : 'CAPTURE_ERROR';
}

function isAppServerInvocation(args, realCli) {
  let index = 0;
  // Node 进程离线 fixture 的首个参数是脚本路径；生产 Codex CLI 没有此层。
  if (/^node(?:\.exe)?$/i.test(path.basename(realCli)) && /\.[cm]?js$/i.test(args[0] ?? '') && path.isAbsolute(args[0])) index++;
  const valuedOptions = new Set(['-c', '--config', '-p', '--profile', '--enable', '--disable', '--local-provider', '-s', '--sandbox', '-a', '--ask-for-approval', '-C', '--cd', '--add-dir', '-m', '--model', '-i', '--image']);
  for (; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--') return false;
    if (valuedOptions.has(argument)) { index++; continue; }
    if (argument.startsWith('-')) continue;
    // 只判断真正子命令，exec 的提示文字和 --profile 参数值不参与。
    if (argument !== 'app-server') return false;
    const serviceValues = new Set(['-c', '--config', '--enable', '--disable', '--code-mode-host', '--ws-auth', '--ws-token-file', '--ws-token-sha256', '--ws-shared-secret-file', '--ws-issuer', '--ws-audience', '--ws-max-clock-skew-seconds']);
    const serviceFlags = new Set(['--strict-config', '--analytics-default-enabled', '--stdio']);
    for (let cursor = index + 1; cursor < args.length; cursor++) {
      const option = args[cursor];
      if (option === '--listen') {
        if (args[++cursor] !== 'stdio://') return false;
      } else if (option.startsWith('--listen=')) {
        if (option !== '--listen=stdio://') return false;
      } else if (serviceValues.has(option)) {
        if (++cursor >= args.length) return false;
      } else if (option.startsWith('--') && option.includes('=')) {
        if (!serviceValues.has(option.slice(0, option.indexOf('=')))) return false;
      } else if (option.startsWith('-c') && option.length > 2) {
        continue;
      } else if (!serviceFlags.has(option)) {
        // daemon/proxy/schema 等子命令、帮助及未知传输不进入采样。
        return false;
      }
    }
    return true;
  }
  return false;
}

// 固定毫秒桶仅保留数值，极高频的文字片段也不会增长事件数组。
export class GenerationAccumulator {
  #items = new Map();
  #closedTurns = new Map();
  #droppedEvents = 0;
  #monotonicNow;
  #wallNow;

  constructor({ monotonicNow = () => performance.now(), wallNow = () => Date.now() } = {}) {
    this.#monotonicNow = monotonicNow;
    this.#wallNow = wallNow;
  }

  #iso() { return new Date(this.#wallNow()).toISOString(); }

  #key(threadId, turnId, itemId) { return `${threadId}\0${turnId}\0${itemId}`; }

  #get(threadId, turnId, itemId, phase = null, started = false) {
    if (!safeId(threadId) || !safeId(turnId) || !safeId(itemId)) return null;
    if (this.#closedTurns.has(this.#key(threadId, turnId, 'closed'))) return null;
    const key = this.#key(threadId, turnId, itemId);
    let item = this.#items.get(key);
    if (!item) {
      if (this.#items.size >= itemLimit) {
        // Finished background messages must not reset a still streaming item's count.
        const completed = [...this.#items].find(([, candidate]) => candidate.state === 'completed');
        if (!completed) {
          this.#droppedEvents = Math.min(Number.MAX_SAFE_INTEGER, this.#droppedEvents + 1);
          return null;
        }
        this.#items.delete(completed[0]);
      }
      item = {
        threadId, turnId, itemId, phase: phaseOf(phase), state: 'waiting', characters: 0, partial: !started,
        startedAt: this.#iso(), lastDeltaAt: null, completedAt: null, lastDeltaTick: null,
        pendingHighSurrogate: false, buckets: new Float64Array(bucketCount), ticks: new Float64Array(bucketCount).fill(-Infinity),
      };
      this.#items.set(key, item);
    } else if (phaseOf(phase)) {
      item.phase = phaseOf(phase);
    }
    return item;
  }

  #add(item, count) {
    if (!count) return;
    const tick = Math.floor(this.#monotonicNow());
    const slot = ((tick % bucketCount) + bucketCount) % bucketCount;
    if (item.ticks[slot] !== tick) {
      item.ticks[slot] = tick;
      item.buckets[slot] = 0;
    }
    item.buckets[slot] += count;
    item.characters += count;
  }

  #complete(item) {
    if (item.state === 'completed') return;
    if (item.pendingHighSurrogate) this.#add(item, 1);
    item.pendingHighSurrogate = false;
    item.state = 'completed';
    item.completedAt = this.#iso();
  }

  observe(event) {
    if (!event || typeof event !== 'object' || !event.params || typeof event.params !== 'object') return;
    const { method, params } = event;
    const { threadId } = params;
    if (method === 'turn/completed') {
      const turnId = params.turnId ?? params.turn?.id;
      if (!safeId(threadId) || !safeId(turnId)) return;
      for (const item of this.#items.values()) if (item.threadId === threadId && item.turnId === turnId) this.#complete(item);
      this.#closedTurns.set(this.#key(threadId, turnId, 'closed'), true);
      while (this.#closedTurns.size > itemLimit) this.#closedTurns.delete(this.#closedTurns.keys().next().value);
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      if (params.item?.type !== 'agentMessage') return;
      const item = this.#get(threadId, params.turnId, params.item.id, params.item.phase, method === 'item/started');
      if (item && method === 'item/completed') this.#complete(item);
      return;
    }
    if (method !== 'item/agentMessage/delta' || typeof params.delta !== 'string' || !params.delta.length) return;
    const item = this.#get(threadId, params.turnId, params.itemId);
    if (!item || item.state === 'completed') return;
    const text = params.delta;
    let count = 0;
    let index = 0;
    if (item.pendingHighSurrogate) {
      // 单个 Unicode 字符可能被拆成两条 JSON delta，先前的高位只计一次。
      count++;
      if (text.charCodeAt(0) >= 0xDC00 && text.charCodeAt(0) <= 0xDFFF) index = 1;
      item.pendingHighSurrogate = false;
    }
    while (index < text.length) {
      const code = text.charCodeAt(index++);
      if (code >= 0xD800 && code <= 0xDBFF) {
        if (index === text.length) { item.pendingHighSurrogate = true; break; }
        const following = text.charCodeAt(index);
        if (following >= 0xDC00 && following <= 0xDFFF) index++;
      }
      count++;
    }
    this.#add(item, count);
    item.lastDeltaTick = this.#monotonicNow();
    item.lastDeltaAt = this.#iso();
    item.state = 'generating';
  }

  coverage() { return { droppedEvents: this.#droppedEvents }; }

  snapshot() {
    const now = this.#monotonicNow();
    const cutoff = Math.floor(now) - windowMs;
    return [...this.#items.values()].map(item => {
      let windowCharacters = 0;
      if (item.state !== 'completed') {
        for (let slot = 0; slot < bucketCount; slot++) {
          if (item.ticks[slot] > cutoff && item.ticks[slot] <= now) windowCharacters += item.buckets[slot];
        }
      }
      const state = item.state === 'completed' ? 'completed' : item.lastDeltaTick !== null && now - item.lastDeltaTick < 1000 ? 'generating' : 'waiting';
      return {
        threadId: item.threadId, turnId: item.turnId, itemId: item.itemId, phase: item.phase, state, partial: item.partial,
        characters: item.characters, windowCharacters,
        charactersPerSecond: state === 'completed' ? null : windowCharacters / (windowMs / 1000),
        startedAt: item.startedAt, lastDeltaAt: item.lastDeltaAt, completedAt: item.completedAt,
      };
    });
  }
}

// stdout 始终先以原始 Buffer 转发；此解析器仅在旁路解码，超长行整体跳过。
export class JsonlObserver {
  #decoder = new StringDecoder('utf8');
  #callback;
  #maximum;
  #line = '';
  #bytes = 0;
  #discarding = false;

  constructor(callback, { maxLineBytes = 256 * 1024 } = {}) {
    this.#callback = callback;
    this.#maximum = maxLineBytes;
  }

  get retainedBytes() { return this.#bytes; }

  #consume(text) {
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf('\n', offset);
      const end = newline < 0 ? text.length : newline;
      const part = text.slice(offset, end);
      if (!this.#discarding) {
        this.#bytes += Buffer.byteLength(part, 'utf8');
        if (this.#bytes > this.#maximum) {
          this.#line = '';
          this.#bytes = 0;
          this.#discarding = true;
        } else this.#line += part;
      }
      if (newline < 0) break;
      this.#finishLine();
      offset = newline + 1;
    }
  }

  #finishLine() {
    if (!this.#discarding && this.#line.length) {
      try { this.#callback(JSON.parse(this.#line)); } catch { /* 元数据失败不改变 CLI 通信。 */ }
    }
    this.#line = '';
    this.#bytes = 0;
    this.#discarding = false;
  }

  write(buffer) { this.#consume(this.#decoder.write(buffer)); }
  end() { this.#consume(this.#decoder.end()); this.#finishLine(); }
}

async function rejectLinks(absolutePath) {
  const parsed = path.parse(absolutePath);
  let current = parsed.root;
  for (const part of absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error('linked-metadata-path');
    if (current !== absolutePath && !info.isDirectory()) throw new Error('invalid-metadata-path');
  }
}

async function safeStateDirectory(env) {
  const homeKey = env.CODEX_GENERATION_HOME_KEY;
  const launchId = env.CODEX_GENERATION_LAUNCH_ID;
  if (!/^[a-f0-9]{24}$/.test(homeKey ?? '') || !/^[a-f0-9]{32}$/.test(launchId ?? '')) throw new Error('invalid-metadata-identity');
  const expected = path.join(projectRoot, 'runtime', `performance-${homeKey}`, 'generation');
  if (!env.CODEX_GENERATION_STATE_DIR || path.resolve(env.CODEX_GENERATION_STATE_DIR).toLowerCase() !== expected.toLowerCase()) throw new Error('invalid-metadata-directory');
  // 由启动器创建目录；旁路采样绝不根据不可信路径建立任意文件夹。
  await rejectLinks(expected);
  if (!(await lstat(expected)).isDirectory()) throw new Error('invalid-metadata-directory');
  const directory = path.join(expected, launchId);
  await rejectLinks(directory);
  if (!(await lstat(directory)).isDirectory()) throw new Error('invalid-metadata-directory');
  return { directory, homeKey, launchId };
}

class SnapshotWriter {
  #directory;
  #file;
  #identity;
  #collector;
  #pending = Promise.resolve();
  #writing = false;
  #lastWrite = -Infinity;
  #lastAttempt = -Infinity;
  #nextAttemptAt = -Infinity;
  #failures = 0;
  #disabled = false;
  #stopped = false;
  #stopPromise = null;
  #timer;
  #health;

  constructor(configuration, collector, { reattachedAt = null } = {}) {
    this.#directory = configuration.directory;
    this.#identity = { service: 'codex-generation-stream', version: 1, instanceId: randomBytes(16).toString('hex'), launchId: configuration.launchId, homeKey: configuration.homeKey, pid: process.pid };
    this.#file = path.join(this.#directory, `stream-${process.pid}-${this.#identity.instanceId}.json`);
    this.#collector = collector;
    this.#health = { state: 'ok', recoveries: reattachedAt ? 1 : 0, lastErrorCode: null, lastErrorStage: null, lastErrorAt: null, lastRecoveredAt: reattachedAt, reattachedAt };
    this.#timer = setInterval(() => this.request(), 250);
    this.#timer.unref();
    this.request();
  }

  metadata() {
    return { instanceId: this.#identity.instanceId, captureHealth: { ...this.#health } };
  }

  request() {
    const now = performance.now();
    if (this.#disabled || this.#stopped || this.#writing || now - this.#lastWrite < 250 || now < this.#nextAttemptAt) return;
    this.#queue('active');
  }

  #queue(state) {
    // 序列化写入，每次真正写入时再取快照，永远不会保留消息正文。
    if (this.#writing) return;
    this.#writing = true;
    this.#lastAttempt = performance.now();
    this.#pending = (async () => {
      const temporary = `${this.#file}.${randomBytes(8).toString('hex')}.tmp`;
      let stage = 'path-check';
      try {
        if (this.#disabled) return;
        await rejectLinks(this.#directory);
        if (!(await lstat(this.#directory)).isDirectory()) throw new Error('invalid-metadata-directory');
        stage = 'file-check';
        try {
          const info = await lstat(this.#file);
          if (info.isSymbolicLink()) throw new Error('linked-metadata-file');
          if (!info.isFile()) throw new Error('invalid-metadata-file');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const recovering = this.#health.state === 'retrying';
        const captureHealth = { ...this.#health, state: state === 'stopped' ? 'stopped' : 'ok' };
        if (recovering) {
          captureHealth.recoveries++;
          captureHealth.lastRecoveredAt = new Date().toISOString();
        }
        const snapshot = { ...this.#identity, updatedAt: new Date().toISOString(), windowMs, state, items: this.#collector.snapshot(), coverage: this.#collector.coverage(), captureHealth };
        stage = 'write';
        await writeFile(temporary, JSON.stringify(snapshot), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        stage = 'path-check';
        await rejectLinks(this.#directory);
        stage = 'rename';
        await rename(temporary, this.#file);
        // 按实际原子提交节流，异步路径检查和磁盘延迟不会压缩两次落盘的间隔。
        this.#lastWrite = performance.now();
        this.#health = captureHealth;
        this.#failures = 0;
        this.#nextAttemptAt = -Infinity;
      } catch (error) {
        const unsafe = unsafeMessages.has(error?.message);
        this.#health = { ...this.#health, state: unsafe ? 'unsafe' : 'retrying', lastErrorCode: safeErrorCode(error), lastErrorStage: stage, lastErrorAt: new Date().toISOString() };
        if (unsafe) {
          this.#disabled = true;
          clearInterval(this.#timer);
        } else {
          this.#failures++;
          this.#nextAttemptAt = performance.now() + Math.min(2000, 250 * 2 ** Math.min(3, this.#failures - 1));
        }
        // 目录变为 junction 时连清理也不能沿它继续 IO；不切换目的地。
        try { await rejectLinks(this.#directory); await unlink(temporary); } catch { /* 只清理安全目录内自己的随机临时文件。 */ }
      } finally {
        this.#writing = false;
      }
    })();
  }

  stop() {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#stopPromise = (async () => {
      await this.#pending;
      // 最后一份停止记录也遵守每秒最多四次的节奏。
      const now = performance.now();
      const remaining = Math.max(250 - (now - this.#lastWrite), 250 - (now - this.#lastAttempt));
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
      this.#queue('stopped');
      await this.#pending;
    })();
    return this.#stopPromise;
  }
}

function attachCapture(child, writer, collector, observer, launchId, { reattachedAt = null } = {}) {
  const registry = captureRegistry();
  const key = `${launchId}:${child.pid}`;
  const onData = buffer => {
    try { observer.write(buffer); } catch { /* 旁路失败不能改动原始 stdout 管道。 */ }
  };
  let disposed = false;
  let stopPromise = null;
  const record = {
    child, writer, reattachedAt,
    metadata(reused = false) {
      const safe = writer.metadata();
      return { attached: true, reused, cliPid: child.pid, observerPid: process.pid, launchId, instanceId: safe.instanceId, status: disposed ? 'stopped' : safe.captureHealth.state, reason: null, attachedAt: reattachedAt, captureHealth: safe.captureHealth };
    },
    stop() {
      if (stopPromise) return stopPromise;
      disposed = true;
      child.stdout.removeListener('data', onData);
      child.removeListener('close', onClose);
      stopPromise = (async () => {
        try { observer.end(); await writer.stop(); } catch { /* 停止采样不改变 CLI 的退出语义。 */ }
        if (registry.get(key) === record) registry.delete(key);
      })();
      return stopPromise;
    },
  };
  const onClose = () => { record.stop().catch(() => {}); };
  registry.set(key, record);
  child.stdout.on('data', onData);
  child.once('close', onClose);
  return record;
}

export async function recoverGenerationCapture({ cliPid, launchId } = {}) {
  const refused = reason => ({ attached: false, reused: false, cliPid: Number.isSafeInteger(cliPid) ? cliPid : null, observerPid: process.pid, launchId: typeof launchId === 'string' && /^[a-f0-9]{32}$/.test(launchId) ? launchId : null, status: 'unavailable', reason });
  if (!Number.isSafeInteger(cliPid) || cliPid <= 0 || cliPid > 0xFFFFFFFF) return refused('invalid-cli-pid');
  if (typeof launchId !== 'string' || !/^[a-f0-9]{32}$/.test(launchId) || launchId !== process.env.CODEX_GENERATION_LAUNCH_ID) return refused('wrong-launch');
  const realCli = process.env.CODEX_GENERATION_REAL_CLI;
  if (!realCli || !path.isAbsolute(realCli) || typeof process._getActiveHandles !== 'function') return refused('capture-unavailable');
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const child = process._getActiveHandles().find(handle => handle instanceof ChildProcess && handle.pid === cliPid);
  if (!child || typeof child.spawnfile !== 'string' || normalize(child.spawnfile) !== normalize(realCli)) return refused('wrong-cli');
  if (!Array.isArray(child.spawnargs) || !isAppServerInvocation(child.spawnargs.slice(1), realCli)) return refused('not-stdio-app-server');
  if (child.exitCode !== null || child.signalCode !== null || !child.stdout || child.stdout.destroyed) return refused('cli-stopped');
  let configuration;
  try { configuration = await safeStateDirectory(process.env); } catch { return refused('unsafe-capture-directory'); }
  if (child.exitCode !== null || child.signalCode !== null || child.stdout.destroyed) return refused('cli-stopped');
  const registry = captureRegistry();
  const key = `${launchId}:${cliPid}`;
  const existing = registry.get(key);
  if (existing?.child === child) {
    if (existing.writer.metadata().captureHealth.state === 'unsafe') return refused('capture-unsafe');
    return existing.metadata(true);
  }
  if (registry.size >= 4) return refused('capture-limit');
  const reattachedAt = new Date().toISOString();
  const collector = new GenerationAccumulator();
  const writer = new SnapshotWriter(configuration, collector, { reattachedAt });
  const observer = new JsonlObserver(event => { collector.observe(event); writer.request(); });
  const record = attachCapture(child, writer, collector, observer, launchId, { reattachedAt });
  return record.metadata();
}

export async function runForwarder(args = process.argv.slice(2), env = process.env) {
  const realCli = env.CODEX_GENERATION_REAL_CLI;
  if (!realCli || !path.isAbsolute(realCli)) {
    process.stderr.write('Codex generation bridge: 未配置真实 CLI。\n');
    return 2;
  }
  let writer = null;
  let observer = null;
  let capture = null;
  const collector = new GenerationAccumulator();
  const appServer = isAppServerInvocation(args, realCli);
  if (appServer) {
    try {
      writer = new SnapshotWriter(await safeStateDirectory(env), collector);
      observer = new JsonlObserver(event => { collector.observe(event); writer.request(); });
    } catch { /* 禁用采样仍然完整转发 CLI。 */ }
  }

  const child = spawn(realCli, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let closing = false;
  let spawnFailed = false;
  let forcedCode = null;
  const stopChild = signal => {
    if (closing) return;
    closing = true;
    forcedCode = signal === 'SIGINT' ? 130 : 143;
    try { child.kill(signal); } catch {}
  };
  const onExit = () => { if (child.exitCode === null) { try { child.kill(); } catch {} } };
  const onInt = () => stopChild('SIGINT');
  const onTerm = () => stopChild('SIGTERM');
  const onOutputError = () => stopChild('SIGTERM');
  process.once('exit', onExit);
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  process.stdout.on('error', onOutputError);
  process.stderr.on('error', onOutputError);
  child.stdin.on('error', () => { /* CLI 可能在输入流读完之前正常退出。 */ });
  process.stdin.on('error', onTerm);
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  if (observer && child.pid) capture = attachCapture(child, writer, collector, observer, env.CODEX_GENERATION_LAUNCH_ID);
  child.once('error', () => { spawnFailed = true; process.stderr.write('Codex generation bridge: 无法启动真实 CLI。\n'); });

  const exitCode = await new Promise(resolve => child.once('close', (code, signal) => resolve(spawnFailed ? 2 : forcedCode ?? code ?? (signal === 'SIGINT' ? 130 : 143))));
  process.stdin.unpipe(child.stdin);
  process.stdin.pause();
  process.stdin.removeListener('error', onTerm);
  process.removeListener('exit', onExit);
  process.removeListener('SIGINT', onInt);
  process.removeListener('SIGTERM', onTerm);
  process.stdout.removeListener('error', onOutputError);
  process.stderr.removeListener('error', onOutputError);
  try { if (capture) await capture.stop(); else { observer?.end(); await writer?.stop(); } } catch { /* 退出码属于真实 CLI，指标写入不影响它。 */ }
  return exitCode;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runForwarder();
}
