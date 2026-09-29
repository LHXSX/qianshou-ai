/** Private SQLite medium for original knowledge, history and a disposable FTS index. */
import { DatabaseSync } from 'node:sqlite'
import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { MemoryError } from './validation.ts'

const APPLICATION_ID = 0x51534d45

/** Open an owner-only database, rejecting other schemas before any DDL runs. */
export async function openMemoryDatabase(path: string): Promise<DatabaseSync> {
  const actual = path === ':memory:' ? path : resolve(path)
  if (actual !== ':memory:') {
    await mkdir(dirname(actual), { recursive: true, mode: 0o700 })
    try { const file = await open(actual, 'wx', 0o600); await file.close() }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
  const db = new DatabaseSync(actual)
  try {
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version)
    const application = Number(db.prepare('PRAGMA application_id').get()?.application_id)
    if ((version !== 0 && version !== 1) || (application !== 0 && application !== APPLICATION_ID)) throw new MemoryError('MEMORY_SCHEMA_MISMATCH', 503)
    if (application === 0 && db.prepare("SELECT name FROM sqlite_master WHERE type='table'").get()) throw new MemoryError('MEMORY_DATABASE_NOT_EMPTY', 503)
    db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON; PRAGMA busy_timeout=3000')
    db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL,
        kind TEXT NOT NULL, scope TEXT NOT NULL, workspace TEXT,
        status TEXT NOT NULL, source TEXT NOT NULL, evidence TEXT NOT NULL,
        revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        expires_at INTEGER, content_bytes INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS revisions (
        entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(entry_id, revision)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY, entry_id TEXT NOT NULL, action TEXT NOT NULL,
        actor TEXT NOT NULL, time INTEGER NOT NULL, revision INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, content TEXT NOT NULL
      ) STRICT;
      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_search USING fts5(tokens, tokenize='unicode61');
      CREATE INDEX IF NOT EXISTS entries_scope ON entries(scope, workspace, status);
      CREATE INDEX IF NOT EXISTS chunks_entry ON chunks(entry_id);
      PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;
    `)
    return db
  } catch (error) { db.close(); throw error }
}
