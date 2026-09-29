/** Dedicated local authorization and receipt database; it never contains Session history or plaintext tokens. */
import { DatabaseSync } from 'node:sqlite'
import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { ConnectFailure } from './validation.ts'

/** Application id protecting unrelated databases from being opened as connection storage. */
const APPLICATION_ID = 0x5153434e
/**
 * Current durable schema version. Authorizations recorded here outlive a restart
 * and a device may still hold one, so a version difference migrates in place
 * rather than resetting the file.
 */
const SCHEMA_VERSION = 2

/**
 * Create the current schema in an empty database.
 * @param db - Owned handle before any table exists.
 */
function createSchema(db: DatabaseSync): void {
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE grants(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, label TEXT NOT NULL, mode TEXT NOT NULL,
      secret_hash TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
      last_access_at INTEGER, accepted_commands INTEGER NOT NULL DEFAULT 0,
      pc_id TEXT, device_id TEXT) STRICT;
    CREATE TABLE receipts(grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE, request_id TEXT NOT NULL,
      body_hash TEXT NOT NULL, rpc_id TEXT NOT NULL, state TEXT NOT NULL, accepted_at INTEGER,
      PRIMARY KEY(grant_id,request_id)) STRICT;
    PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION}; COMMIT;`)
}

/**
 * Add the device and PC columns to a version-1 database.
 *
 * Existing grants keep working: both columns are nullable, and a grant without
 * them remains reachable by any holder of its bearer, which is exactly the
 * version-1 behavior. A grant created after this version always carries both.
 * @param db - Owned handle already verified as this application's version 1.
 */
function migrateV1ToV2(db: DatabaseSync): void {
  db.exec(`BEGIN IMMEDIATE;
    ALTER TABLE grants ADD COLUMN pc_id TEXT;
    ALTER TABLE grants ADD COLUMN device_id TEXT;
    PRAGMA user_version=${SCHEMA_VERSION}; COMMIT;`)
}

/**
 * Open the connection database, creating or migrating it to the current schema.
 * @param filename - Explicit database path.
 * @returns The owned SQLite handle.
 */
export async function openConnectDatabase(filename: string): Promise<DatabaseSync> {
  const path = filename === ':memory:' ? filename : resolve(filename)
  if (path !== ':memory:') {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    try { const file = await open(path, 'wx', 0o600); await file.close() }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new ConnectFailure('storage-failed', 503) }
  }
  const db = new DatabaseSync(path)
  try {
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version)
    const app = Number(db.prepare('PRAGMA application_id').get()?.application_id)
    const fresh = version === 0 && app === 0 && !db.prepare("SELECT name FROM sqlite_master WHERE type='table'").get()
    if (!fresh && app !== APPLICATION_ID) throw new ConnectFailure('storage-failed', 503)
    if (!fresh && (version < 1 || version > SCHEMA_VERSION)) throw new ConnectFailure('storage-failed', 503)
    db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON; PRAGMA busy_timeout=3000')
    if (fresh) createSchema(db)
    else if (version === 1) migrateV1ToV2(db)
    return db
  } catch (error) { db.close(); throw error }
}
