import { lstat, open, opendir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const processScript = fileURLToPath(new URL('./generation-process.ps1', import.meta.url));
const hex = (value, length) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value) ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const safePid = value => Number.isInteger(value) && value > 0 && value <= 2147483647;

async function safeDirectory(directory) {
  let current = path.resolve(directory);
  while (true) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('采集目录不可核对');
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function boundedJson(file, limit) {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit) throw new Error('快照超出边界');
  const handle = await open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > limit || opened.ino !== before.ino || opened.birthtimeMs !== before.birthtimeMs) throw new Error('快照身份变化');
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error('快照超出边界');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)));
  } finally { await handle.close(); }
}

export function verifyGenerationBinding(binding, { signal, timeoutMs = 8000 } = {}) {
  if (process.platform !== 'win32' || signal?.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const child = spawn('pwsh.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', processScript,
      '-RootProcessId', String(binding.codexPid), '-StartedAt', binding.codexStartedAt, '-Executable', binding.codexExecutable],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let invalid = false;
    const stop = () => { invalid = true; child.kill(); };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', value => { output += value; if (output.length > 2048) stop(); });
    child.stderr.on('data', () => {});
    child.on('error', () => { invalid = true; });
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', stop);
      try { resolve(!invalid && code === 0 && JSON.parse(output).verified === true); } catch { resolve(false); }
    });
  });
}

function validateBinding(raw, homeKey) {
  if (raw?.version !== 1 || !hex(raw.launchId, 32) || raw.homeKey !== homeKey || !safePid(raw.codexPid) ||
      !date(raw.codexStartedAt) || typeof raw.codexExecutable !== 'string' || raw.codexExecutable.length > 4096 ||
      !path.isAbsolute(raw.codexExecutable)) return null;
  return { version: 1, launchId: raw.launchId, homeKey, codexPid: raw.codexPid,
    codexStartedAt: raw.codexStartedAt, codexExecutable: raw.codexExecutable };
}

function normalizeItem(raw, now) {
  if (!id(raw?.threadId) || !id(raw.turnId) || !id(raw.itemId) || !['generating', 'waiting', 'completed'].includes(raw.state)) return null;
  const characters = count(raw.characters);
  const windowCharacters = count(raw.windowCharacters);
  const startedAt = date(raw.startedAt);
  const lastDeltaAt = date(raw.lastDeltaAt);
  const completedAt = date(raw.completedAt);
  if (characters === null || windowCharacters === null || windowCharacters > characters || !startedAt ||
      Date.parse(startedAt) > now + 2000 || (lastDeltaAt && Date.parse(lastDeltaAt) > now + 2000) ||
      (completedAt && Date.parse(completedAt) > now + 2000)) return null;
  return { threadId: raw.threadId, turnId: raw.turnId, itemId: raw.itemId,
    phase: ['final_answer', 'commentary'].includes(raw.phase) ? raw.phase : null, state: raw.state,
    characters, windowCharacters, partial: raw.partial === true,
    charactersPerSecond: raw.state !== 'completed' && lastDeltaAt ? windowCharacters / 3 : null,
    startedAt, lastDeltaAt, completedAt };
}

function normalizeCaptureHealth(raw) {
  if (!raw || typeof raw !== 'object' || !['ok', 'retrying', 'unsafe', 'stopped'].includes(raw.state) || count(raw.recoveries) === null) return null;
  return { state: raw.state, recoveries: raw.recoveries,
    lastErrorCode: typeof raw.lastErrorCode === 'string' && /^[A-Z0-9_]{1,40}$/.test(raw.lastErrorCode) ? raw.lastErrorCode : null,
    lastErrorStage: ['path-check', 'file-check', 'write', 'rename', 'parse'].includes(raw.lastErrorStage) ? raw.lastErrorStage : null,
    lastErrorAt: date(raw.lastErrorAt), lastRecoveredAt: date(raw.lastRecoveredAt), reattachedAt: date(raw.reattachedAt) };
}

export class GenerationCollector {
  constructor({ stateDir, homeKey, clock = Date.now, verifyBinding = verifyGenerationBinding }) {
    this.directory = path.join(path.resolve(stateDir), 'generation');
    this.homeKey = homeKey;
    this.clock = clock;
    this.verifyBinding = verifyBinding;
    this.identity = null;
    this.verifiedAt = null;
    this.verified = false;
    this.value = { updatedAt: null, status: 'waiting-launch', reason: '实时采集将在下次正常启动 Codex 时启用。', windowMs: 3000, streams: [] };
    this.staleAfterMs = 5000;
    this.polling = null;
    this.controller = null;
    this.closed = false;
  }

  poll() {
    if (this.closed) return Promise.resolve();
    if (!this.polling) this.polling = this.read().catch(() => {
      this.value = { updatedAt: null, status: 'unavailable', reason: '实时采集信息暂不可核对，不显示旧速度。', windowMs: 3000, streams: [] };
    }).finally(() => { this.polling = null; });
    return this.polling;
  }

  async read() {
    try { await safeDirectory(this.directory); }
    catch (error) {
      if (error.code === 'ENOENT') {
        this.value = { updatedAt: null, status: 'waiting-launch', reason: '实时采集将在下次正常启动 Codex 时启用。', windowMs: 3000, streams: [] };
        return;
      }
      throw error;
    }
    if (this.closed) return;
    let rawBinding;
    try { rawBinding = await boundedJson(path.join(this.directory, 'binding.json'), 16384); }
    catch (error) {
      if (error.code === 'ENOENT') {
        this.value = { updatedAt: null, status: 'waiting-launch', reason: '实时采集将在下次正常启动 Codex 时启用。', windowMs: 3000, streams: [] };
        return;
      }
      throw error;
    }
    if (this.closed) return;
    const binding = validateBinding(rawBinding, this.homeKey);
    if (!binding) throw new Error('启动绑定无效');
    const identity = JSON.stringify(binding);
    const now = this.clock();
    if (identity !== this.identity || this.verifiedAt === null || now - this.verifiedAt >= 30000) {
      const changed = identity !== this.identity;
      this.identity = identity;
      if (changed) {
        this.verified = false;
        this.value = { updatedAt: null, status: 'unavailable', reason: '正在核对实时采集的启动会话。', windowMs: 3000, streams: [] };
      }
      this.controller = new AbortController();
      try { this.verified = await this.verifyBinding(binding, { signal: this.controller.signal }); }
      finally { this.controller = null; }
      this.verifiedAt = this.clock();
      if (this.closed) return;
    }
    if (!this.verified) {
      this.value = { updatedAt: null, status: 'unavailable', reason: '采集对应的 Codex 会话已退出或身份不可核对。', windowMs: 3000, streams: [] };
      return;
    }
    // 每次启动只查看自己的子目录，历史快照数量不会挤掉本次流。
    const streamDirectory = path.join(this.directory, binding.launchId);
    await safeDirectory(streamDirectory);
    if (this.closed) return;
    const directory = await opendir(streamDirectory);
    if (this.closed) { await directory.close(); return; }
    const candidates = [];
    let visited = 0;
    for await (const entry of directory) {
      if (this.closed) return;
      if (++visited > 256) break;
      const match = /^stream-(\d{1,10})-([a-f0-9]{32})\.json$/.exec(entry.name);
      if (!match || !entry.isFile()) continue;
      try {
        const info = await lstat(path.join(streamDirectory, entry.name));
        if (!info.isSymbolicLink()) candidates.push({ name: entry.name, pid: Number(match[1]), instanceId: match[2], mtime: info.mtimeMs });
      } catch { /* 原子写入替换期间，下轮再读。 */ }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    let invalid = 0;
    let updatedAt = null;
    let activeUpdatedAt = null;
    let latestHealth = null;
    let activeHealth = null;
    let droppedEvents = 0;
    const streams = new Map();
    for (const candidate of candidates.slice(0, 16)) {
      if (this.closed) return;
      try {
        const raw = await boundedJson(path.join(streamDirectory, candidate.name), 65536);
        if (this.closed) return;
        if (raw.launchId !== binding.launchId || raw.homeKey !== this.homeKey) continue;
        const observed = date(raw.updatedAt);
        if (raw.service !== 'codex-generation-stream' || raw.version !== 1 || raw.instanceId !== candidate.instanceId ||
            raw.pid !== candidate.pid || !safePid(raw.pid) || raw.windowMs !== 3000 || !['active', 'stopped'].includes(raw.state) ||
            !observed || Date.parse(observed) > this.clock() + 2000 || !Array.isArray(raw.items)) { invalid++; continue; }
        const health = normalizeCaptureHealth(raw.captureHealth);
        if (raw.captureHealth && !health) { invalid++; continue; }
        const dropped = raw.coverage == null ? 0 : count(raw.coverage.droppedEvents);
        if (dropped === null) { invalid++; continue; }
        droppedEvents = Math.min(Number.MAX_SAFE_INTEGER, droppedEvents + dropped);
        if (!updatedAt || observed > updatedAt) { updatedAt = observed; latestHealth = health; }
        const fresh = raw.state === 'active' && (!health || health.state === 'ok') && this.clock() - Date.parse(observed) <= this.staleAfterMs;
        if (fresh && (!activeUpdatedAt || observed > activeUpdatedAt)) { activeUpdatedAt = observed; activeHealth = health; }
        for (const item of raw.items.slice(0, 20)) {
          const normalized = normalizeItem(item, this.clock());
          if (!normalized) continue;
          normalized.observedAt = observed;
          const key = JSON.stringify([normalized.threadId, normalized.turnId, normalized.itemId]);
          const previous = streams.get(key);
          if (!fresh) normalized.charactersPerSecond = null;
          if (!previous || (fresh && !previous.fresh) || (fresh === previous.fresh && observed > previous.observed)) {
            streams.set(key, { observed, fresh, item: normalized });
          }
        }
      } catch { invalid++; }
    }
    const items = [...streams.values()].sort((a, b) => (b.item.lastDeltaAt ?? b.observed).localeCompare(a.item.lastDeltaAt ?? a.observed))
      .slice(0, 40).map(value => value.item);
    let status = items.some(item => item.state === 'generating' && item.charactersPerSecond !== null) ? 'collecting' : 'idle';
    let reason = status === 'collecting' ? '按最近 3 秒接收到的可见文字计数，不代表服务端纯生成速度。' : '等待新的文字输出。';
    if (updatedAt && !activeUpdatedAt) {
      if (latestHealth && ['retrying', 'unsafe'].includes(latestHealth.state) && this.clock() - Date.parse(updatedAt) <= this.staleAfterMs) {
        status = 'unavailable'; reason = latestHealth.state === 'unsafe'
          ? '本地实时采集路径核对失败，已停止采集，不显示旧速度。'
          : '本地实时采集快照写入失败，正在自动重试，不显示旧速度。';
      } else { status = 'stale'; reason = '本地实时采集快照已停止更新，不显示旧速度。'; }
    } else if (invalid && !updatedAt) {
      status = 'unavailable'; reason = '实时快照无效或超出读取边界。';
    }
    const captureHealth = activeUpdatedAt ? activeHealth : latestHealth;
    if (activeUpdatedAt && captureHealth?.reattachedAt) reason += ' 采集旁路已恢复，累计从恢复后开始，未补算中断时段。';
    else if (activeUpdatedAt && captureHealth?.recoveries) reason += ' 本地快照写入已自动恢复。';
    if (droppedEvents) reason += ' 活动消息达到保留上限，部分事件未计入；局部采集只包含已观测片段。';
    this.value = { updatedAt: activeUpdatedAt ?? updatedAt, status, reason, windowMs: 3000, captureHealth, coverage: { droppedEvents }, streams: items };
  }

  snapshot() {
    const result = structuredClone(this.value);
    if (this.verifiedAt !== null && this.clock() - this.verifiedAt > 65000) {
      result.status = 'stale'; result.reason = '实时采集的进程身份确认已过期，不显示旧速度。';
    } else if (result.updatedAt && this.clock() - Date.parse(result.updatedAt) > this.staleAfterMs) {
      result.status = 'stale'; result.reason = '本地实时采集快照已停止更新，不显示旧速度。';
    }
    for (const item of result.streams) {
      if (!['collecting', 'idle'].includes(result.status) || this.clock() - Date.parse(item.observedAt) > this.staleAfterMs) {
        item.charactersPerSecond = null;
      }
    }
    return result;
  }

  async close() {
    this.closed = true;
    this.controller?.abort();
    await this.polling;
  }
}
