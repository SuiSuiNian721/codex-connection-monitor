import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionTitleReader } from './session-titles.mjs';

let sqlite;
try { sqlite = await import('node:sqlite'); } catch { /* Node 20 uses the JSONL fallback. */ }
const noDatabase = async () => { throw new Error('node:sqlite unavailable'); };
const row = (id, thread_name, updated_at = '2026-10-06T12:00:00Z') => JSON.stringify({ id, thread_name, updated_at });

async function setup(t, options = {}) {
  const codexHome = await mkdtemp(join(tmpdir(), 'codex-session-titles-'));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  return { codexHome, reader: new SessionTitleReader({ codexHome, ...options }) };
}

test('只读取已有 SQLite 标题元数据并以当前数据库覆盖旧索引，不改写数据库', { skip: !sqlite }, async t => {
  const { codexHome, reader } = await setup(t);
  const file = join(codexHome, 'state_5.sqlite');
  const database = new sqlite.DatabaseSync(file);
  database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at INTEGER NOT NULL, body TEXT);');
  const insert = database.prepare('INSERT INTO threads VALUES (?, ?, 1, ?)');
  insert.run('session-a', '当前任务标题', 'PRIVATE_BODY');
  insert.run('not-requested', 'UNREQUESTED_TITLE', 'SECRET');
  database.close();
  const before = await readFile(file);
  await writeFile(join(codexHome, 'session_index.jsonl'), `${row('session-a', '旧标题')}\n${row('session-b', '索引标题')}\n`);
  await reader.poll(['session-a', 'session-b']);
  assert.equal(reader.get('session-a'), '当前任务标题');
  assert.equal(reader.get('session-b'), '索引标题');
  assert.equal(reader.get('not-requested'), null);
  assert.deepEqual(await readFile(file), before);
});

test('没有内置 SQLite 时使用最新有效索引标题，坏行和无关字段不影响结果', async t => {
  let imports = 0;
  const { codexHome, reader } = await setup(t, { loadDatabase: async () => { imports++; return noDatabase(); } });
  await writeFile(join(codexHome, 'state_5.sqlite'), 'present but unavailable without node:sqlite');
  await writeFile(join(codexHome, 'session_index.jsonl'), [
    row('session-a', '新标题', '2026-10-06T12:00:01Z'),
    row('session-a', '旧标题', '2026-10-06T12:00:00Z'),
    '{"broken":',
    JSON.stringify({ id: 'session-b', text: 'PRIVATE_BODY', thread_name: '  带\n空白的标题  ', updated_at: '2026-10-06T12:00:00Z' }),
    row('session-c', '无效时间', 'not-a-date'),
  ].join('\n'));
  await reader.poll(['session-a', 'session-b', 'session-c']);
  assert.equal(reader.get('session-a'), '新标题');
  assert.equal(reader.get('session-b'), '带 空白的标题');
  assert.equal(reader.get('session-c'), null);
  assert.equal(imports, 1);
});

test('SQLite 写入锁只短暂等待并使用索引回退，不拖住采集', { skip: !sqlite }, async t => {
  const { codexHome, reader } = await setup(t);
  const database = new sqlite.DatabaseSync(join(codexHome, 'state_5.sqlite'));
  database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL); INSERT INTO threads VALUES ('a', '数据库标题'); BEGIN EXCLUSIVE;");
  try {
    await writeFile(join(codexHome, 'session_index.jsonl'), row('a', '索引回退标题'));
    const started = performance.now();
    await reader.poll(['a']);
    assert.ok(performance.now() - started < 1000);
    assert.equal(reader.get('a'), '索引回退标题');
  } finally { database.exec('ROLLBACK;'); database.close(); }
});

test('索引改名立即刷新；缓存到期也会刷新，离开当前范围的会话不保留', async t => {
  let now = 10000;
  const { codexHome, reader } = await setup(t, { loadDatabase: noDatabase, clock: () => now });
  const file = join(codexHome, 'session_index.jsonl');
  await writeFile(file, row('a', '最初标题'));
  await reader.poll(['a']);
  assert.equal(reader.get('a'), '最初标题');
  await writeFile(file, row('a', '修改后的标题'));
  await utimes(file, new Date(20000), new Date(20000));
  await reader.poll(['a']);
  assert.equal(reader.get('a'), '修改后的标题');
  now += 10001;
  await reader.poll(['a']);
  assert.equal(reader.get('a'), '修改后的标题');
  await reader.poll(['other']);
  assert.equal(reader.get('a'), null);
});

test('标题与会话数量有界，损坏的数据库可降级且缺文件返回空值', async t => {
  const { codexHome, reader } = await setup(t);
  await writeFile(join(codexHome, 'state_5.sqlite'), 'not a database');
  await writeFile(join(codexHome, 'session_index.jsonl'), Array.from({ length: 205 }, (_, i) => row(`s${i}`, '🙂'.repeat(300))).join('\n'));
  await reader.poll(Array.from({ length: 205 }, (_, i) => `s${i}`));
  assert.equal([...reader.get('s0')].length, 256);
  assert.equal(reader.get('s199')?.length > 0, true);
  assert.equal(reader.get('s200'), null);
  await reader.poll([]);
  assert.equal(reader.get('s0'), null);
  const empty = new SessionTitleReader({ codexHome: join(codexHome, 'missing'), loadDatabase: noDatabase });
  await empty.poll(['a']);
  assert.equal(empty.get('a'), null);
});

test('大索引只读取有界尾部，超长行和部分 JSON 不制造标题', async t => {
  const { codexHome, reader } = await setup(t, { loadDatabase: noDatabase });
  await writeFile(join(codexHome, 'session_index.jsonl'), `${'x'.repeat(2 * 1024 * 1024)}\n${row('a', '尾部标题')}\n${'{"id":"a"'}`);
  await reader.poll(['a']);
  assert.equal(reader.get('a'), '尾部标题');
});
