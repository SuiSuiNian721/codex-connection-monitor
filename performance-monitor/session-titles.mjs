import { lstat, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const MAX_SESSIONS = 200;
const MAX_TITLE_CHARACTERS = 256;
const INDEX_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 16 * 1024;
const REFRESH_MS = 10000;
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
const titleText = value => typeof value === 'string'
  ? [...value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, MAX_TITLE_CHARACTERS).join('') || null : null;

async function fileInfo(file) {
  try {
    const info = await lstat(file);
    return info.isFile() && !info.isSymbolicLink() ? info : null;
  } catch { return null; }
}

export class SessionTitleReader {
  #home;
  #clock;
  #loadDatabase;
  #databaseModule;
  #titles = new Map();
  #signature = null;
  #refreshedAt = null;
  #polling = null;

  constructor({ codexHome, clock = Date.now, loadDatabase = () => import('node:sqlite') }) {
    this.#home = resolve(codexHome);
    this.#clock = clock;
    this.#loadDatabase = loadDatabase;
  }

  get(sessionId) { return this.#titles.get(sessionId) ?? null; }

  poll(sessionIds) {
    if (this.#polling) return this.#polling;
    const ids = [...new Set(sessionIds.filter(identifier))].slice(0, MAX_SESSIONS);
    this.#polling = this.#read(ids).catch(() => {
      // Optional display metadata must never fail token collection.
    }).finally(() => { this.#polling = null; });
    return this.#polling;
  }

  async #read(ids) {
    const wanted = new Set(ids);
    for (const id of this.#titles.keys()) if (!wanted.has(id)) this.#titles.delete(id);
    if (!ids.length) { this.#signature = null; return; }
    const databaseFile = join(this.#home, 'state_5.sqlite');
    const indexFile = join(this.#home, 'session_index.jsonl');
    const infos = await Promise.all([databaseFile, `${databaseFile}-wal`, indexFile].map(fileInfo));
    const signature = JSON.stringify([ids, infos.map(info => info ? [info.dev, info.ino, info.size, info.mtimeMs] : null)]);
    if (signature === this.#signature && this.#refreshedAt !== null && this.#clock() - this.#refreshedAt < REFRESH_MS) return;
    const titles = await this.#readIndex(indexFile, infos[2], wanted);
    if (infos[0] && infos[0].size <= 64 * 1024 * 1024) {
      const databaseTitles = await this.#readDatabase(databaseFile, ids);
      for (const [id, title] of databaseTitles) titles.set(id, title);
    }
    this.#titles = titles;
    this.#signature = signature;
    this.#refreshedAt = this.#clock();
  }

  async #readIndex(file, info, wanted) {
    const titles = new Map();
    if (!info) return titles;
    let handle;
    try {
      handle = await open(file, 'r');
      const length = Math.min(info.size, INDEX_BYTES);
      const position = Math.max(0, info.size - length);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      let text = buffer.subarray(0, bytesRead).toString('utf8');
      if (position > 0) {
        const end = text.indexOf('\n');
        text = end >= 0 ? text.slice(end + 1) : '';
      }
      const updated = new Map();
      for (const line of text.split('\n').slice(-10000)) {
        if (!line || Buffer.byteLength(line) > MAX_LINE_BYTES) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if (!identifier(row?.id) || !wanted.has(row.id)) continue;
        const at = typeof row.updated_at === 'string' ? Date.parse(row.updated_at) : NaN;
        const title = titleText(row.thread_name);
        if (!Number.isFinite(at) || !title || (updated.has(row.id) && at < updated.get(row.id))) continue;
        updated.set(row.id, at);
        titles.set(row.id, title);
      }
    } catch { /* Missing, changing or unreadable index: SQLite can still supply titles. */ }
    finally { await handle?.close().catch(() => {}); }
    return titles;
  }

  async #readDatabase(file, ids) {
    const titles = new Map();
    let database;
    try {
      // Node 20 can continue using the bounded JSONL index without a dependency install.
      this.#databaseModule ??= Promise.resolve().then(() => this.#loadDatabase()).catch(() => null);
      const sqlite = await this.#databaseModule;
      if (typeof sqlite?.DatabaseSync !== 'function') return titles;
      database = new sqlite.DatabaseSync(file, { readOnly: true });
      database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=50; PRAGMA trusted_schema=OFF;');
      const schema = database.prepare('PRAGMA table_info(threads)').all();
      // Require the inspected indexed identity column; never scan unrelated tables.
      if (schema.filter(column => column.pk > 0).length !== 1 ||
          !schema.some(column => column.name === 'id' && column.pk === 1 && column.type.toUpperCase() === 'TEXT') ||
          !schema.some(column => column.name === 'title' && column.type.toUpperCase() === 'TEXT')) return titles;
      const rows = database.prepare(`SELECT id, substr(title, 1, ${MAX_TITLE_CHARACTERS}) AS title FROM threads WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
      for (const row of rows) {
        const title = titleText(row.title);
        if (identifier(row.id) && title) titles.set(row.id, title);
      }
    } catch { /* A locked, absent or newer database must not prevent index fallback. */ }
    finally { try { database?.close(); } catch { /* Keep the token collector independent. */ } }
    return titles;
  }
}
