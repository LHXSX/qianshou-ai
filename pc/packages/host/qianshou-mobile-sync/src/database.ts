/** Dedicated binding and receipt database; it holds neither Session history, message text nor any credential. */
import { DatabaseSync } from 'node:sqlite'
import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { MobileSyncFailure } from './failure.ts'

/** Application id refusing unrelated SQLite files, including the session-connect database. */
const APPLICATION_ID = 0x51534d53
/** Current durable schema version; a foreign or newer version is refused. */
const SCHEMA_VERSION = 1

function createSchema(db: DatabaseSync): void {
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE bindings(key TEXT PRIMARY KEY, account_id TEXT NOT NULL, pc_id TEXT NOT NULL, session_id TEXT NOT NULL,
      device_id TEXT NOT NULL, created_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, last_access_at INTEGER,
      issued_sequence INTEGER NOT NULL DEFAULT 0) STRICT;
    CREATE TABLE receipts(binding_key TEXT NOT NULL REFERENCES bindings(key) ON DELETE CASCADE, request_id TEXT NOT NULL,
      sequence INTEGER NOT NULL, body_hash TEXT NOT NULL, rpc_id TEXT NOT NULL, state TEXT NOT NULL, reason TEXT,
      accepted_at INTEGER, PRIMARY KEY(binding_key,request_id)) STRICT;
    PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION}; COMMIT;`)
}

/**
 * Open the mobile-sync database, creating the schema in an empty file and refusing any other format.
 * @param filename - Explicit database path or `:memory:`.
 * @returns The owned SQLite handle.
 */
export async function openMobileSyncDatabase(filename: string): Promise<DatabaseSync> {
  const path = filename === ':memory:' ? filename : resolve(filename)
  if (path !== ':memory:') {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    try { const file = await open(path, 'wx', 0o600); await file.close() }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new MobileSyncFailure('STORAGE_FAILED') }
  }
  const db = new DatabaseSync(path)
  try {
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version)
    const app = Number(db.prepare('PRAGMA application_id').get()?.application_id)
    const fresh = version === 0 && app === 0 && !db.prepare("SELECT name FROM sqlite_master WHERE type='table'").get()
    if (!fresh && (app !== APPLICATION_ID || version !== SCHEMA_VERSION)) throw new MobileSyncFailure('STORAGE_FAILED')
    db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON; PRAGMA busy_timeout=3000')
    if (fresh) createSchema(db)
    return db
  } catch (error) { db.close(); throw error }
}
