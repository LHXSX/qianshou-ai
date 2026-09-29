/** Device and PC binding on an owner grant: real SQLite, real Session events, no network. */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { ConnectStore } from '../src/store.ts'
import { ConnectService } from '../src/service.ts'
import { openConnectDatabase } from '../src/database.ts'
import { PHONE_TURN_BYTE_LIMIT, projectConnectionPage, VIEW_TURN_BYTE_LIMIT } from '../src/projection.ts'
import type { ConnectSessionPort } from '../src/session-port.ts'
import { ConnectFailure } from '../src/validation.ts'

const sessionId = SessionId('fixture-bound')
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'session-connect-binding-')); cleanups.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'private', 'v1.sqlite'), store = await ConnectStore.open(path, 8, 8)
  const ctx = new Context(); await ctx.plugin(SessionStore); cleanups.push(() => ctx.fiber.dispose())
  ctx.sessions.create(sessionId)
  let clock = 1000
  const port: ConnectSessionPort = {
    inspect: async (id, requestSignal) => {
      requestSignal.throwIfAborted()
      return { events: ctx.sessions.get(id)!.snapshotEvents(), running: false }
    },
    admitted: async () => false,
    submit: async () => undefined,
  }
  const service = new ConnectService(store, port, 4, 1000, () => clock)
  cleanups.push(() => service.dispose())
  return { store, service, path, advance: () => { clock += 60001 } }
}

/** Read one grant's stored pc_id/device_id straight from SQLite. */
function storedBinding(path: string, id: string): { pc: unknown; device: unknown } {
  const db = new DatabaseSync(path)
  try {
    const row = db.prepare('SELECT pc_id, device_id FROM grants WHERE id=?').get(id) as { pc_id: unknown; device_id: unknown } | undefined
    return { pc: row?.pc_id, device: row?.device_id }
  } finally { db.close() }
}

describe('grant device and PC binding', () => {
  it('records the binding and returns it on the grant view', async () => {
    const f = await fixture()
    const created = await f.service.create({ sessionId, label: '我的手机', mode: 'read',
      durationMinutes: 1, pcId: 'pc-office', deviceId: 'device-phone-a' })
    expect(created.grant.pcId).toBe('pc-office')
    expect(created.grant.deviceId).toBe('device-phone-a')
    expect(storedBinding(f.path, created.grant.id)).toEqual({ pc: 'pc-office', device: 'device-phone-a' })
  })

  it('refuses a bearer presented from a different device', async () => {
    const f = await fixture()
    const created = await f.service.create({ sessionId, label: '我的手机', mode: 'read', durationMinutes: 1, deviceId: 'device-phone-a' })
    const token = created.path.split('#')[1]!

    expect(() => { f.service.authorize(token, 'device-phone-b') }).toThrow(ConnectFailure)
    try { f.service.authorize(token, 'device-phone-b') } catch (error) {
      expect((error as ConnectFailure).code).toBe('device-mismatch')
      expect((error as ConnectFailure).status).toBe(403)
    }
    expect(() => { f.service.authorize(token, 'device-phone-a') }).not.toThrow()
  })

  it('reports mismatch, expiry and revocation as distinct reasons', async () => {
    const f = await fixture()
    const bound = await f.service.create({ sessionId, label: '绑定设备', mode: 'read', durationMinutes: 1, deviceId: 'device-a' })
    const boundToken = bound.path.split('#')[1]!
    const expiring = await f.service.create({ sessionId, label: '将到期', mode: 'read', durationMinutes: 1 })
    const expiringToken = expiring.path.split('#')[1]!
    const revoked = await f.service.create({ sessionId, label: '将撤销', mode: 'read', durationMinutes: 1 })
    const revokedToken = revoked.path.split('#')[1]!
    f.service.revoke(sessionId, revoked.grant.id)

    const codeOf = (token: string, device?: string): string => {
      try { f.service.authorize(token, device); return 'accepted' }
      catch (error) { return (error as ConnectFailure).code }
    }
    expect(codeOf(boundToken, 'device-b')).toBe('device-mismatch')
    expect(codeOf(revokedToken)).toBe('revoked')

    f.advance()
    expect(codeOf(expiringToken)).toBe('expired')
    // Revocation is checked before expiry, so an old revoked grant keeps saying revoked.
    expect(codeOf(revokedToken)).toBe('revoked')
  })

  it('keeps a grant created without a device reachable by any bearer holder', async () => {
    const f = await fixture()
    const created = await f.service.create({ sessionId, label: '任意持有者', mode: 'read', durationMinutes: 1 })
    const token = created.path.split('#')[1]!
    expect(created.grant.deviceId).toBeNull()
    expect(() => { f.service.authorize(token) }).not.toThrow()
    expect(() => { f.service.authorize(token, 'device-unknown') }).not.toThrow()
  })

  it('rejects a device-bound grant when no device is presented at all', async () => {
    const f = await fixture()
    const created = await f.service.create({ sessionId, label: '必须带设备', mode: 'read', durationMinutes: 1, deviceId: 'device-a' })
    const token = created.path.split('#')[1]!
    try { f.service.authorize(token) } catch (error) {
      expect((error as ConnectFailure).code).toBe('device-mismatch')
    }
    expect.assertions(1)
  })
})

describe('per-route turn length', () => {
  it('truncates a turn at the phone limit and at the browser limit independently', async () => {
    const ctx = new Context(); await ctx.plugin(SessionStore); cleanups.push(() => ctx.fiber.dispose())
    const session = ctx.sessions.create(SessionId('fixture-length'))
    session.append('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(5000) }] } } as never, { surfaceOp: 'append' })
    const grant = { id: 'grant-1', sessionId: SessionId('fixture-length'), label: 'x', mode: 'read' as const, createdAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER, revoked: false, lastAccessAt: null, acceptedCommands: 0, pcId: null, deviceId: null }
    const snapshot = session.snapshotEvents()

    const phone = projectConnectionPage(grant, snapshot, null, false, PHONE_TURN_BYTE_LIMIT)
    const view = projectConnectionPage(grant, snapshot, null, false, VIEW_TURN_BYTE_LIMIT)

    expect(phone.turns[0]!.text.length).toBe(4096)
    expect(phone.turns[0]!.truncated).toBe(true)
    expect(view.turns[0]!.text.length).toBe(5000)
    expect(view.turns[0]!.truncated).toBe(false)
  })
})

describe('schema migration', () => {
  it('adds the binding columns to a version-1 database without dropping existing grants', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-connect-migrate-')); cleanups.push(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'v1.sqlite')

    // Build a genuine version-1 file with the old column set.
    const legacy = new DatabaseSync(path)
    legacy.exec(`BEGIN IMMEDIATE;
      CREATE TABLE grants(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, label TEXT NOT NULL, mode TEXT NOT NULL,
        secret_hash TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
        last_access_at INTEGER, accepted_commands INTEGER NOT NULL DEFAULT 0) STRICT;
      CREATE TABLE receipts(grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE, request_id TEXT NOT NULL,
        body_hash TEXT NOT NULL, rpc_id TEXT NOT NULL, state TEXT NOT NULL, accepted_at INTEGER,
        PRIMARY KEY(grant_id,request_id)) STRICT;
      INSERT INTO grants(id,session_id,label,mode,secret_hash,created_at,expires_at)
        VALUES('legacy-grant','fixture-bound','旧授权','read','deadbeef',1,9999999999999);
      PRAGMA application_id=1364411214; PRAGMA user_version=1; COMMIT;`)
    legacy.close()

    const migrated = await openConnectDatabase(path)
    try {
      expect(Number(migrated.prepare('PRAGMA user_version').get()?.user_version)).toBe(2)
      const row = migrated.prepare('SELECT id,label,pc_id,device_id FROM grants').get() as Record<string, unknown>
      expect(row['id']).toBe('legacy-grant')
      expect(row['label']).toBe('旧授权')
      expect(row['pc_id']).toBeNull()
      expect(row['device_id']).toBeNull()
    } finally { migrated.close() }
  })

  it('refuses a database stamped by another application', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-connect-foreign-')); cleanups.push(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'foreign.sqlite')
    const foreign = new DatabaseSync(path)
    foreign.exec('CREATE TABLE t(x); PRAGMA application_id=123; PRAGMA user_version=2;')
    foreign.close()
    await expect(openConnectDatabase(path)).rejects.toThrow(ConnectFailure)
  })

  it('refuses a version newer than this writer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-connect-future-')); cleanups.push(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'future.sqlite')
    const future = new DatabaseSync(path)
    future.exec('CREATE TABLE t(x); PRAGMA application_id=1364411214; PRAGMA user_version=99;')
    future.close()
    await expect(openConnectDatabase(path)).rejects.toThrow(ConnectFailure)
  })
})
