/** Atomic bounded grant/command claims. The Session's own log remains the sole history. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { openConnectDatabase } from './database.ts'
import { ConnectFailure } from './validation.ts'
import type { ConnectionGrant, ConnectionGrantCreated, ConnectionGrantInput, ConnectionReceipt } from './types.ts'

/**
 * Hash a fixed protocol value without retaining its plaintext.
 * @param value - Token or command content admitted by the owning parser.
 * @returns SHA-256 hexadecimal digest.
 */
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
interface GrantRow { id: string; session_id: string; label: string; mode: 'read' | 'text'; secret_hash: string; created_at: number; expires_at: number; revoked: number; last_access_at: number | null; accepted_commands: number; pc_id: string | null; device_id: string | null }
/** Durable request identity used only by the admission coordinator. */
export interface StoredReceipt extends ConnectionReceipt { rpcId: string; bodyHash: string }
const view = (row: GrantRow): ConnectionGrant => ({ id: row.id, sessionId: row.session_id as SessionId, label: row.label,
  mode: row.mode, createdAt: row.created_at, expiresAt: row.expires_at, revoked: row.revoked === 1,
  lastAccessAt: row.last_access_at, acceptedCommands: row.accepted_commands,
  pcId: row.pc_id, deviceId: row.device_id })

/** One private SQLite owner; every write is synchronous and committed before publication. */
export class ConnectStore {
  private closed = false
  private constructor(private readonly db: DatabaseSync, private readonly maxGrants: number, private readonly maxReceipts: number) {}
  /**
   * Acquire the dedicated store.
   * @param path - Private database path.
   * @param maxGrants - Retained grant count ceiling.
   * @param maxReceipts - Total request receipt ceiling.
   * @returns An owned store.
   */
  static async open(path: string, maxGrants: number, maxReceipts: number): Promise<ConnectStore> {
    return new ConnectStore(await openConnectDatabase(path), maxGrants, maxReceipts)
  }
  /** Release the SQLite handle once all owner operations have settled. */
  close(): void { if (!this.closed) { this.closed = true; this.db.close() } }
  private ensure(): void { if (this.closed) throw new ConnectFailure('closed', 503) }
  /**
   * Read only a selected Session's grants, excluding all token material.
   * @param sessionId - Owner-selected Session.
   * @returns Bounded newest-first grants.
   */
  list(sessionId: SessionId): ConnectionGrant[] {
    this.ensure()
    return (this.db.prepare('SELECT * FROM grants WHERE session_id=? ORDER BY created_at DESC').all(sessionId) as unknown as GrantRow[]).map(view)
  }
  /**
   * Create a bearer link and persist only its digest.
   * @param input - Validated explicit owner choice.
   * @param now - Current clock.
   * @returns Safe grant plus its one-time-returned secret fragment.
   */
  create(input: ConnectionGrantInput, now: number): ConnectionGrantCreated {
    this.ensure()
    const total = Number(this.db.prepare('SELECT count(*) AS total FROM grants').get()?.total)
    if (total >= this.maxGrants) this.db.prepare('DELETE FROM grants WHERE id IN (SELECT id FROM grants WHERE revoked=1 OR expires_at<=? ORDER BY created_at LIMIT 1)').run(now)
    if (Number(this.db.prepare('SELECT count(*) AS total FROM grants').get()?.total) >= this.maxGrants) throw new ConnectFailure('capacity', 409)
    const id = randomUUID(), secret = randomBytes(32).toString('base64url')
    this.db.prepare('INSERT INTO grants(id,session_id,label,mode,secret_hash,created_at,expires_at,pc_id,device_id) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, input.sessionId, input.label, input.mode, digest(`${id}.${secret}`), now, now + input.durationMinutes * 60000,
        input.pcId ?? null, input.deviceId ?? null)
    return { grant: this.get(id), path: `/qianshou-connect/#${id}.${secret}` }
  }
  private get(id: string): ConnectionGrant {
    const row = this.db.prepare('SELECT * FROM grants WHERE id=?').get(id) as unknown as GrantRow | undefined
    if (!row) throw new ConnectFailure('unauthorized', 401)
    return view(row)
  }
  /**
   * Verify the bearer and current revocation/expiry without updating activity.
   *
   * A presented device is checked only against a grant that names one. A grant
   * created without a device predates device binding and stays reachable by any
   * bearer holder, so an older link keeps working after an upgrade.
   * @param token - Untrusted Authorization bearer.
   * @param now - Current clock.
   * @param deviceId - Device the request claims to come from, when it presents one.
   * @returns The exact granted Session and actions.
   */
  authorize(token: string, now: number, deviceId?: string): ConnectionGrant {
    this.ensure()
    if (!/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/u.test(token)) throw new ConnectFailure('unauthorized', 401)
    const id = token.slice(0, 36)
    const row = this.db.prepare('SELECT * FROM grants WHERE id=?').get(id) as unknown as GrantRow | undefined
    if (!row || !timingSafeEqual(Buffer.from(row.secret_hash, 'hex'), Buffer.from(digest(token), 'hex'))) throw new ConnectFailure('unauthorized', 401)
    if (row.revoked) throw new ConnectFailure('revoked', 403)
    if (row.expires_at <= now) throw new ConnectFailure('expired', 403)
    // Checked after revocation and expiry so a caller can tell "this grant is
    // gone" from "this grant is not yours", which need different messages.
    if (row.device_id !== null && row.device_id !== deviceId) throw new ConnectFailure('device-mismatch', 403)
    return view(row)
  }
  /**
   * Revoke only a grant belonging to the owner-selected Session.
   * @param sessionId - Explicit Session fence.
   * @param id - Grant id, never its bearer.
   * @returns Whether an authorization belonging to this Session was matched.
   */
  revoke(sessionId: SessionId, id: string): boolean {
    this.ensure()
    return this.db.prepare('UPDATE grants SET revoked=1 WHERE id=? AND session_id=?').run(id, sessionId).changes > 0
  }
  /**
   * Record a successful observation without retaining network addresses.
   * @param grantId - Verified grant.
   * @param now - Current clock.
   */
  touch(grantId: string, now: number): void { this.db.prepare('UPDATE grants SET last_access_at=? WHERE id=?').run(now, grantId) }
  /**
   * Read a request's durable outcome.
   * @param grantId - Verified grant.
   * @param requestId - Stable client request identity.
   * @returns The existing receipt or undefined when never claimed.
   */
  receipt(grantId: string, requestId: string): StoredReceipt | undefined {
    const row = this.db.prepare('SELECT * FROM receipts WHERE grant_id=? AND request_id=?').get(grantId, requestId)
    return row ? { requestId, state: row.state as ConnectionReceipt['state'], acceptedAt: row.accepted_at as number | null,
      rpcId: row.rpc_id as string, bodyHash: row.body_hash as string } : undefined
  }
  /**
   * Claim a request once before Session admission; a crash leaves an honest uncertain outcome.
   * @param grantId - Verified grant.
   * @param requestId - Stable client identity.
   * @param text - Validated bounded text, retained only as a digest.
   * @returns Durable existing or newly claimed receipt.
   */
  claim(grantId: string, requestId: string, text: string): StoredReceipt {
    this.ensure()
    const hash = digest(text), previous = this.receipt(grantId, requestId)
    if (previous) { if (previous.bodyHash !== hash) throw new ConnectFailure('conflict', 409); return previous }
    if (Number(this.db.prepare('SELECT count(*) AS total FROM receipts').get()?.total) >= this.maxReceipts) throw new ConnectFailure('capacity', 409)
    const rpcId = `qianshou-connect:${digest(`${grantId}:${requestId}`)}`
    this.db.prepare('INSERT INTO receipts VALUES(?,?,?,?,\'uncertain\',NULL)').run(grantId, requestId, hash, rpcId)
    return { requestId, state: 'uncertain', acceptedAt: null, rpcId, bodyHash: hash }
  }
  /**
   * Publish admission only after the original Session durability barrier succeeds.
   * @param grantId - Verified grant.
   * @param requestId - Claimed client identity.
   * @param now - Admission time.
   * @returns Durable safe receipt.
   */
  received(grantId: string, requestId: string, now: number): ConnectionReceipt {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const change = this.db.prepare("UPDATE receipts SET state='received',accepted_at=? WHERE grant_id=? AND request_id=? AND state!='received'").run(now, grantId, requestId)
      if (change.changes) this.db.prepare('UPDATE grants SET accepted_commands=accepted_commands+1 WHERE id=?').run(grantId)
      this.db.exec('COMMIT')
      return { requestId, state: 'received', acceptedAt: this.receipt(grantId, requestId)?.acceptedAt ?? now }
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
}
