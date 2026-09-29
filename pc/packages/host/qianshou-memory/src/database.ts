/** New device-owner SQLite format; never opens or migrates the legacy memory path. */
import { DatabaseSync } from 'node:sqlite'
import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MemoryFailure } from './validation.ts'
const APPLICATION_ID = 0x5153444d
/**
 * Open and validate a dedicated vault before any schema changes.
 * @param path - Explicit new-format path.
 * @returns Owned SQLite handle.
 */
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
    const fresh = version === 0 && application === 0 && !db.prepare("SELECT name FROM sqlite_master WHERE type='table'").get()
    if (!fresh && (version !== 1 || application !== APPLICATION_ID)) throw new MemoryFailure('storage-failed')
    db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON; PRAGMA busy_timeout=3000')
    if (fresh) {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1), vault_id TEXT NOT NULL, revision INTEGER NOT NULL) STRICT;
        CREATE TABLE entries (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL,
          kind TEXT NOT NULL, scope TEXT NOT NULL, workspace_id TEXT, workspace_path TEXT,
          status TEXT NOT NULL, source TEXT NOT NULL, evidence TEXT NOT NULL,
          source_session TEXT, source_call TEXT,
          revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          expires_at INTEGER, content_bytes INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE revisions (entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE, revision INTEGER NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(entry_id,revision)) STRICT;
        CREATE TABLE receipts (seq INTEGER PRIMARY KEY, entry_id TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, time INTEGER NOT NULL, revision INTEGER NOT NULL) STRICT;
        CREATE TABLE proposals (session_id TEXT NOT NULL, call_id TEXT NOT NULL, entry_id TEXT NOT NULL, PRIMARY KEY(session_id,call_id)) STRICT;
        CREATE TABLE chunks (id INTEGER PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, content TEXT NOT NULL) STRICT;
        CREATE VIRTUAL TABLE chunk_search USING fts5(tokens, tokenize='unicode61');
        CREATE INDEX entries_scope ON entries(scope,workspace_id,status);
        CREATE INDEX chunks_entry ON chunks(entry_id);
        PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;`)
      db.prepare('INSERT INTO meta VALUES (1,?,1)').run(randomUUID())
      db.exec('COMMIT')
    }
    if (!db.prepare('SELECT vault_id,revision FROM meta WHERE id=1').get()) throw new MemoryFailure('storage-failed')
    return db
  } catch (error) { db.close(); throw error }
}
