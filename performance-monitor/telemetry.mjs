import { open, opendir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const MAX_LINE_BYTES = 256 * 1024;
const FILE_BUDGET = 1024 * 1024;
const POLL_BUDGET = 8 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const MAX_RESPONSES = 2048;
const MAX_MESSAGES = 20;
const MEASUREMENT_NOTE = '端到端平均吞吐包含推理和工具等待，不代表实时纯生成速度。';
const identifier = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value) ? value : null;
const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const maximum = (left, right) => left === null ? right : right === null ? left : Math.max(left, right);
const bounded = (value, fallback, limit) => Number.isInteger(value) && value > 0 ? Math.min(value, limit) : fallback;
const identity = (info) => `${info.dev}:${info.ino}:${info.birthtimeMs}`;
const turnKey = (sessionId, turnId) => JSON.stringify([sessionId, turnId]);
const metadata = (payload) => ({
  model: identifier(payload.model),
  effort: identifier(payload.effort ?? payload.reasoning_effort),
  provider: identifier(payload.model_provider_id ?? payload.model_provider),
});
const epochTimestamp = (value) => count(value) !== null && value <= 8640000000000000 ? new Date(value).toISOString() : null;
const messageOrder = (left, right) => Number(right.phase === 'final_answer') - Number(left.phase === 'final_answer')
  || (Date.parse(right.completedAt) || right.observedAt) - (Date.parse(left.completedAt) || left.observedAt)
  || right.observedAt - left.observedAt;

function measureMessage(payload, at) {
  const { item } = payload;
  let characters = 0;
  let validContent = Array.isArray(item.content);
  if (validContent) {
    for (const part of item.content) {
      if (part?.type !== 'Text') continue;
      if (typeof part.text !== 'string') { validContent = false; break; }
      // Count Unicode code points, including whitespace and punctuation. Do not
      // retain a message body or split it into a persistent character array.
      for (const character of part.text) characters++;
    }
  }
  if (!validContent) characters = null;
  const startedAt = epochTimestamp(payload.started_at_ms);
  const completedAt = epochTimestamp(payload.completed_at_ms);
  const missingTiming = payload.started_at_ms == null || payload.completed_at_ms == null;
  const durationMs = startedAt && completedAt && payload.completed_at_ms >= payload.started_at_ms ? payload.completed_at_ms - payload.started_at_ms : null;
  const reason = missingTiming ? 'missing-timing'
    : !startedAt || !completedAt || !(durationMs > 0) ? 'invalid-timing'
      : durationMs < 1000 ? 'short-window'
        : !validContent ? 'invalid-content'
          : characters === 0 ? 'empty-output' : null;
  return {
    itemId: item.id, phase: item.phase, startedAt, completedAt, durationMs, characters,
    charactersPerSecond: reason === null ? characters * 1000 / durationMs : null,
    reason, observedAt: at ? Date.parse(at) : 0,
  };
}

export class TelemetryCollector {
  #home;
  #lookbackDays;
  #maxFiles;
  #maxTurns;
  #files = new Map();
  #turns = new Map();
  #warnings = new Set();
  #source = { scannedFiles: 0, errors: 0, truncatedFiles: 0 };
  #updatedAt = null;
  #polling = null;
  #sequence = 0;
  #readCursor = 0;

  constructor({ codexHome, lookbackDays = 3, maxFiles = 80, maxTurns = 200 }) {
    this.#home = resolve(codexHome);
    this.#lookbackDays = bounded(lookbackDays, 3, 31);
    this.#maxFiles = bounded(maxFiles, 80, 500);
    this.#maxTurns = bounded(maxTurns, 200, 2000);
  }

  async poll() {
    // Concurrent status requests share one cursor update.
    if (!this.#polling) this.#polling = this.#poll().finally(() => { this.#polling = null; });
    return this.#polling;
  }

  async #poll() {
    const candidates = await this.#discover();
    const retained = new Set(candidates.map(({ path }) => path));
    for (const path of this.#files.keys()) if (!retained.has(path)) this.#files.delete(path);
    this.#source.scannedFiles = candidates.length;
    let remaining = POLL_BUDGET;
    // Rotate the read order so a large growing file cannot starve other tracked files.
    const start = candidates.length ? this.#readCursor % candidates.length : 0;
    let visited = 0;
    for (; visited < candidates.length && remaining > 0; visited++) {
      const candidate = candidates[(start + visited) % candidates.length];
      try {
        remaining -= await this.#read(candidate, Math.min(FILE_BUDGET, remaining));
      } catch (error) {
        if (error.code !== 'ENOENT') this.#error('部分会话文件读取失败；统计可能不完整。');
      }
    }
    this.#readCursor = start + visited;
    if (visited < candidates.length) this.#warn('已达到单次读取上限，剩余记录将在后续轮询继续读取。');
    this.#trim();
    this.#updatedAt = new Date().toISOString();
  }

  async #discover() {
    const paths = new Set();
    const directories = new Set();
    for (let offset = 0; offset < this.#lookbackDays; offset++) {
      const day = new Date(Date.now() - offset * 86400000);
      // Codex versions may use local or UTC date folders.
      directories.add(join(this.#home, 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0')));
      directories.add(join(this.#home, 'sessions', String(day.getUTCFullYear()), String(day.getUTCMonth() + 1).padStart(2, '0'), String(day.getUTCDate()).padStart(2, '0')));
    }
    for (const [path, file] of this.#files) {
      // A completion can arrive in a different file after context rotation.
      file.active = this.#turns.get(turnKey(file.sessionId, file.currentTurn))?.status === 'running';
      if (file.active || file.pending) paths.add(path);
    }
    let entries = 0;
    const discoveryLimit = Math.max(1024, this.#maxFiles * 16);
    for (const directory of directories) {
      if (entries >= discoveryLimit) break;
      try {
        const stream = await opendir(directory);
        for await (const entry of stream) {
          entries++;
          if (entry.isFile() && entry.name.endsWith('.jsonl')) paths.add(join(directory, entry.name));
          if (entries >= discoveryLimit) { this.#warn('目录发现达到上限，部分历史文件未纳入统计。'); break; }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') this.#error('部分会话目录无法读取；统计可能不完整。');
      }
    }
    const candidates = [];
    for (const path of paths) {
      try {
        const info = await stat(path);
        if (info.isFile()) candidates.push({ path, info, active: Boolean(this.#files.get(path)?.active) });
      } catch (error) {
        if (error.code !== 'ENOENT') this.#error('部分会话文件无法检查；统计可能不完整。');
      }
    }
    candidates.sort((a, b) => Number(b.active) - Number(a.active) || b.info.mtimeMs - a.info.mtimeMs || a.path.localeCompare(b.path));
    if (candidates.length > this.#maxFiles) this.#warn('文件数量超过保留上限，仅统计已跟踪的活动文件和最近文件。');
    return candidates.slice(0, this.#maxFiles);
  }

  async #read({ path, info }, budget) {
    const handle = await open(path, 'r');
    try {
      let file = this.#files.get(path);
      let replaced = file && (file.identity !== identity(info) || info.size < file.offset);
      if (file?.anchor && !replaced) replaced = await this.#anchor(handle, file.offset) !== file.anchor;
      if (!file || replaced) {
        if (replaced) {
          this.#source.truncatedFiles++;
          this.#warn('检测到会话文件截断或替换，已从文件开头重新识别。');
        }
        file = { identity: identity(info), offset: 0, anchor: null, skipping: false, oversized: false, sessionId: null, currentTurn: null, active: false, pending: false, settings: {}, headerSeen: false, inheritedHistory: false, historyStart: null };
        this.#files.set(path, file);
      }
      let position = file.offset;
      let pending = Buffer.alloc(0);
      let consumed = 0;
      while (consumed < budget && position < info.size) {
        const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, budget - consumed, info.size - position));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        consumed += bytesRead;
        position += bytesRead;
        let begin = 0;
        while (begin < bytesRead) {
          const newline = buffer.indexOf(10, begin);
          const end = newline < 0 || newline >= bytesRead ? bytesRead : newline;
          const segment = buffer.subarray(begin, end);
          if (!file.skipping) {
            if (pending.length + segment.length > MAX_LINE_BYTES) {
              pending = Buffer.alloc(0);
              file.skipping = true;
              if (!file.oversized) { file.oversized = true; this.#source.truncatedFiles++; }
              this.#warn('已跳过超过 256 KiB 的记录，统计可能不完整。');
            } else {
              pending = pending.length ? Buffer.concat([pending, segment]) : Buffer.from(segment);
            }
          }
          if (end < bytesRead) {
            if (!file.skipping && pending.length) this.#parse(pending, file);
            pending = Buffer.alloc(0);
            file.skipping = false;
            file.offset = position - bytesRead + end + 1;
            begin = end + 1;
          } else {
            if (file.skipping) file.offset = position;
            break;
          }
        }
      }
      // Incomplete lines are reread from their byte boundary next time. No raw
      // conversation fragment is retained in collector state between polls.
      file.pending = file.offset < info.size;
      file.anchor = file.offset ? await this.#anchor(handle, file.offset) : null;
      if (position < info.size) this.#warn('已达到单文件读取上限，剩余记录将在后续轮询继续读取。');
      return consumed;
    } finally {
      await handle.close();
    }
  }

  async #anchor(handle, offset) {
    const length = Math.min(128, offset);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset - length);
    return createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex');
  }

  #parse(buffer, file) {
    let row;
    try { row = JSON.parse(buffer.toString('utf8')); } catch { this.#error('存在无法解析的 JSONL 记录，已跳过。'); return; }
    if (!row || !row.payload || typeof row.payload !== 'object') return;
    const payload = row.payload;
    const at = timestamp(row.timestamp);
    const firstHeader = row.type === 'session_meta' && !file.headerSeen;
    if (firstHeader) {
      file.headerSeen = true;
      file.inheritedHistory = Object.hasOwn(payload, 'subagent_history_start_ordinal') || identifier(payload.forked_from_id) !== null;
      file.historyStart = count(payload.subagent_history_start_ordinal);
    }
    // Fork files begin with their owner's header, then a copied parent history
    // that can contain another session_meta. Only the declared live suffix
    // belongs to this file's owner; missing boundaries must never invent usage.
    if (!firstHeader && file.inheritedHistory) {
      const ordinal = count(row.ordinal);
      if (file.historyStart === null || ordinal === null) {
        this.#warn('无法确认继承历史边界，已跳过无法归属的记录；统计可能不完整。');
        return;
      }
      if (ordinal < file.historyStart) return;
    }
    if (row.type === 'session_meta') {
      const sessionId = identifier(payload.id) ?? identifier(payload.session_id);
      if (file.inheritedHistory && !firstHeader && sessionId !== file.sessionId) {
        this.#warn('会话头与文件线程归属不一致，已忽略冲突记录。');
        return;
      }
      if (file.sessionId !== sessionId) { file.currentTurn = null; file.active = false; file.settings = {}; }
      file.sessionId = sessionId;
      const provider = identifier(payload.model_provider);
      if (provider) file.settings.provider = provider;
      return;
    }
    if (Object.hasOwn(payload, 'thread_id') && identifier(payload.thread_id) !== file.sessionId) {
      this.#warn('记录的线程归属与文件不一致，已跳过；统计可能不完整。');
      return;
    }
    if (row.type === 'event_msg' && payload.type === 'thread_settings_applied') {
      const settings = metadata(payload.thread_settings ?? payload);
      for (const [name, value] of Object.entries(settings)) if (value !== null) file.settings[name] = value;
      const current = this.#turns.get(turnKey(file.sessionId, file.currentTurn));
      if (current?.status === 'running') this.#applyMetadata(current, settings, at);
      return;
    }
    const kind = row.type === 'event_msg' ? payload.type : row.type;
    if (!['task_started', 'turn_context', 'token_usage_record', 'task_complete', 'turn_aborted', 'task_interrupted', 'task_failed', 'item_completed'].includes(kind)) return;
    if (kind === 'item_completed' && (row.type !== 'event_msg' || payload.item?.type !== 'AgentMessage'
      || !identifier(payload.item.id) || !['final_answer', 'commentary'].includes(payload.item.phase))) return;
    // Identity must be explicit: a file's last turn is unsafe for usage arriving
    // after compaction, parallel work, or an interrupted turn.
    const id = identifier(payload.turn_id);
    if (!file.sessionId || !id) return;
    const key = turnKey(file.sessionId, id);
    let turn = this.#turns.get(key);
    if (!turn) {
      turn = { id, sessionId: file.sessionId, startedAt: null, completedAt: null, status: 'running', model: null, effort: null, provider: null, durationMs: null, ttftMs: null, outputTotal: null, reasoningTotal: null, responses: new Map(), responseOverflow: false, messages: new Map(), warnings: new Set(), metadataAt: {}, lastActivity: 0, sequence: ++this.#sequence };
      this.#turns.set(key, turn);
    }
    turn.lastActivity = Math.max(turn.lastActivity, at ? Date.parse(at) : 0);
    this.#applyMetadata(turn, file.settings, at, true);
    if (kind === 'task_started' || kind === 'turn_context') {
      file.currentTurn = id;
      file.active = turn.status === 'running';
      if (kind === 'task_started') {
        const startedAt = timestamp(payload.started_at) ?? at;
        if (startedAt && (!turn.startedAt || startedAt < turn.startedAt)) turn.startedAt = startedAt;
      } else {
        this.#applyMetadata(turn, metadata(payload), at);
      }
    } else if (kind === 'token_usage_record') {
      this.#usage(turn, payload);
    } else if (kind === 'item_completed') {
      if (!turn.messages.has(payload.item.id)) {
        const measurement = measureMessage(payload, at);
        turn.messages.set(measurement.itemId, measurement);
        if (turn.messages.size > MAX_MESSAGES) {
          // Keep final answers ahead of commentary so progress messages cannot
          // evict the only explicit final result of a turn.
          const retained = [...turn.messages.values()].sort(messageOrder).slice(0, MAX_MESSAGES);
          turn.messages = new Map(retained.map((entry) => [entry.itemId, entry]));
        }
      }
    } else {
      turn.status = kind === 'task_complete' ? 'completed' : kind === 'task_failed' ? 'failed' : 'interrupted';
      turn.completedAt = timestamp(payload.completed_at) ?? at ?? turn.completedAt;
      turn.startedAt ??= timestamp(payload.started_at);
      turn.durationMs = number(payload.duration_ms) ?? turn.durationMs;
      turn.ttftMs = number(payload.time_to_first_token_ms) ?? turn.ttftMs;
      if (file.currentTurn === id) file.active = false;
    }
    if (this.#turns.size > this.#maxTurns * 2) this.#trim();
  }

  #applyMetadata(turn, values, at, onlyMissing = false) {
    for (const name of ['model', 'effort', 'provider']) {
      if (!values[name] || (onlyMissing && turn[name])) continue;
      const age = at ? Date.parse(at) : 0;
      if (turn[name] === null || age >= (turn.metadataAt[name] ?? 0)) {
        turn[name] = values[name];
        turn.metadataAt[name] = age;
      }
    }
  }

  #usage(turn, payload) {
    const total = payload.turn_token_usage;
    if (total && typeof total === 'object') {
      // Turn counters are cumulative snapshots, including across context files.
      turn.outputTotal = maximum(turn.outputTotal, count(total.output_tokens));
      turn.reasoningTotal = maximum(turn.reasoningTotal, count(total.reasoning_output_tokens));
    }
    const responseId = identifier(payload.response_id);
    const usage = payload.usage;
    if (!responseId || !usage || typeof usage !== 'object') return;
    const previous = turn.responses.get(responseId);
    if (!previous && turn.responses.size >= MAX_RESPONSES) {
      turn.responseOverflow = true;
      turn.warnings.add('响应明细达到保留上限；缺少整轮累计值时不计算 token 总量。');
      return;
    }
    turn.responses.set(responseId, {
      output: maximum(previous?.output ?? null, count(usage.output_tokens)),
      reasoning: maximum(previous?.reasoning ?? null, count(usage.reasoning_output_tokens)),
    });
  }

  #orderedTurns() {
    return [...this.#turns.values()].sort((a, b) => b.lastActivity - a.lastActivity || b.sequence - a.sequence);
  }

  #trim() {
    if (this.#turns.size <= this.#maxTurns) return;
    const ordered = this.#orderedTurns();
    for (const turn of ordered.slice(this.#maxTurns)) this.#turns.delete(turnKey(turn.sessionId, turn.id));
    this.#warn('轮次数量超过保留上限，仅保留最近活动记录。');
  }

  #warn(message) { if (this.#warnings.size < 16) this.#warnings.add(message); }
  #error(message) { this.#source.errors++; this.#warn(message); }

  snapshot() {
    return {
      updatedAt: this.#updatedAt,
      source: { ...this.#source },
      turns: this.#orderedTurns().map((turn) => {
        const sum = (field) => {
          if (turn.responseOverflow || !turn.responses.size) return null;
          let result = 0;
          for (const response of turn.responses.values()) {
            if (response[field] === null) return null;
            result += response[field];
          }
          return Number.isSafeInteger(result) ? result : null;
        };
        const outputTokens = turn.outputTotal ?? sum('output');
        const reasoningTokens = turn.reasoningTotal ?? sum('reasoning');
        const selectedMessage = [...turn.messages.values()].sort(messageOrder)[0];
        const messageOutput = selectedMessage ? {
          itemId: selectedMessage.itemId, phase: selectedMessage.phase,
          startedAt: selectedMessage.startedAt, completedAt: selectedMessage.completedAt,
          durationMs: selectedMessage.durationMs, characters: selectedMessage.characters,
          charactersPerSecond: selectedMessage.charactersPerSecond, reason: selectedMessage.reason,
        } : null;
        const warnings = [MEASUREMENT_NOTE, ...turn.warnings];
        if (outputTokens === null) warnings.push('缺少可归属本轮的 token 用量，无法计算平均吞吐。');
        if (turn.ttftMs === null) warnings.push('来源未提供首 token 耗时。');
        if (turn.durationMs === null) warnings.push('来源未提供整轮耗时。');
        return {
          id: turn.id, sessionId: turn.sessionId,
          startedAt: turn.startedAt, completedAt: turn.completedAt, status: turn.status,
          model: turn.model, effort: turn.effort, provider: turn.provider,
          outputTokens, reasoningTokens, durationMs: turn.durationMs, ttftMs: turn.ttftMs,
          throughputTps: turn.status === 'completed' && outputTokens !== null && turn.durationMs > 0 ? outputTokens * 1000 / turn.durationMs : null,
          messageOutput,
          warnings,
        };
      }),
      warnings: [...this.#warnings],
    };
  }
}
