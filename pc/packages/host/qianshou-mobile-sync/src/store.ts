/**
 * Durable bindings and idempotent command claims. The original Session's log remains the sole history; this
 * store records only which phone requests were claimed and what admission could be proven for them. The
 * claim/received pattern mirrors qianshou-session-connect's `ConnectStore`; extracting a shared store package
 * is deferred until a third consumer appears.
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { openMobileSyncDatabase } from './database.ts'
import { MobileSyncFailure } from './failure.ts'
import type { DeliveryState, WindowBinding } from './types.ts'

/**
 * Hash a bounded value without retaining its plaintext.
 * @param value - Text or serialized command admitted by the parser.
 * @returns SHA-256 hexadecimal digest.
 */
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
/**
 * Storage key of one binding; every axis participates so accounts and PCs cannot collide.
 * @param binding - Validated binding.
 * @returns Deterministic key.
 */
export const bindingKey = (binding: WindowBinding): string => JSON.stringify([binding.accountId, binding.pcId, binding.sessionId, binding.sourceDeviceId])

interface BindingRow { key: string; account_id: string; pc_id: string; session_id: string; device_id: string; created_at: number; revoked: number; last_access_at: number | null; issued_sequence: number }
interface ReceiptRow { binding_key: string; request_id: string; sequence: number; body_hash: string; rpc_id: string; state: DeliveryState; reason: string | null; accepted_at: number | null }

/** One durable binding with its receipt-stream position. */
export interface BindingRecord {
  readonly key: string
  readonly binding: WindowBinding
  readonly createdAt: number
  readonly revoked: boolean
  readonly lastAccessAt: number | null
  readonly issuedSequence: number
}
/** Durable request identity and its provable outcome. */
export interface StoredReceipt {
  readonly requestId: string
  readonly sequence: number
  readonly bodyHash: string
  readonly rpcId: string
  readonly state: DeliveryState
  readonly reason: string | null
  readonly acceptedAt: number | null
}
const bindingView = (row: BindingRow): BindingRecord => ({ key: row.key,
  binding: { accountId: row.account_id, pcId: row.pc_id, sessionId: row.session_id, sourceDeviceId: row.device_id },
  createdAt: row.created_at, revoked: row.revoked === 1, lastAccessAt: row.last_access_at, issuedSequence: row.issued_sequence })
const receiptView = (row: ReceiptRow): StoredReceipt => ({ requestId: row.request_id, sequence: row.sequence, bodyHash: row.body_hash,
  rpcId: row.rpc_id, state: row.state, reason: row.reason, acceptedAt: row.accepted_at })

/** One private SQLite owner; every write commits before publication. */
export class MobileSyncStore {
  private closed = false
  private constructor(private readonly db: DatabaseSync, private readonly maxBindings: number, private readonly maxReceipts: number) {}
  /**
   * Acquire the dedicated store.
   * @param path - Private database path.
   * @param maxBindings - Retained binding ceiling including revoked bindings until reclaimed.
   * @param maxReceipts - Retained receipt ceiling; receipts are never evicted while their binding lives.
   * @returns An owned store.
   */
  static async open(path: string, maxBindings: number, maxReceipts: number): Promise<MobileSyncStore> {
    return new MobileSyncStore(await openMobileSyncDatabase(path), maxBindings, maxReceipts)
  }
  /** Release the SQLite handle once owner operations have settled. */
  close(): void { if (!this.closed) { this.closed = true; this.db.close() } }
  private ensure(): void { if (this.closed) throw new MobileSyncFailure('CLOSED') }
  /**
   * Read one binding by its exact axes.
   * @param binding - Validated binding.
   * @returns The record or undefined when never registered.
   */
  binding(binding: WindowBinding): BindingRecord | undefined {
    this.ensure()
    const row = this.db.prepare('SELECT * FROM bindings WHERE key=?').get(bindingKey(binding)) as unknown as BindingRow | undefined
    return row ? bindingView(row) : undefined
  }
  /**
   * Create a binding or restore a revoked one. The receipt sequence is kept, so re-pairing never rewinds a cursor.
   * @param binding - Validated binding for the signed-in account and this PC.
   * @param now - Current clock.
   * @returns The live record.
   */
  register(binding: WindowBinding, now: number): BindingRecord {
    this.ensure()
    const key = bindingKey(binding)
    const existing = this.db.prepare('SELECT * FROM bindings WHERE key=?').get(key) as unknown as BindingRow | undefined
    if (existing) {
      this.db.prepare('UPDATE bindings SET revoked=0,last_access_at=? WHERE key=?').run(now, key)
      return bindingView({ ...existing, revoked: 0, last_access_at: now })
    }
    if (this.count('bindings') >= this.maxBindings) this.db.prepare('DELETE FROM bindings WHERE key IN (SELECT key FROM bindings WHERE revoked=1 ORDER BY created_at LIMIT 1)').run()
    if (this.count('bindings') >= this.maxBindings) throw new MobileSyncFailure('CAPACITY', 409)
    this.db.prepare('INSERT INTO bindings(key,account_id,pc_id,session_id,device_id,created_at,last_access_at) VALUES(?,?,?,?,?,?,?)')
      .run(key, binding.accountId, binding.pcId, binding.sessionId, binding.sourceDeviceId, now, now)
    return bindingView(this.db.prepare('SELECT * FROM bindings WHERE key=?').get(key) as unknown as BindingRow)
  }
  /**
   * Revoke every binding. Called when the signed-in account changes or signs out; receipts stay durable.
   * @returns Number of bindings that were live.
   */
  revokeAll(): number {
    this.ensure()
    return Number(this.db.prepare('UPDATE bindings SET revoked=1 WHERE revoked=0').run().changes)
  }
  /**
   * Count live bindings for diagnostics.
   * @returns Live binding count.
   */
  activeBindings(): number {
    this.ensure()
    return Number(this.db.prepare('SELECT count(*) AS total FROM bindings WHERE revoked=0').get()?.total)
  }
  /**
   * Record an observation time without retaining network addresses.
   * @param key - Binding key.
   * @param now - Current clock.
   */
  touch(key: string, now: number): void { this.db.prepare('UPDATE bindings SET last_access_at=? WHERE key=?').run(now, key) }
  /**
   * Read one request's durable outcome.
   * @param key - Binding key.
   * @param requestId - Stable client request id.
   * @returns The receipt or undefined when never claimed.
   */
  receipt(key: string, requestId: string): StoredReceipt | undefined {
    this.ensure()
    const row = this.db.prepare('SELECT * FROM receipts WHERE binding_key=? AND request_id=?').get(key, requestId) as unknown as ReceiptRow | undefined
    return row ? receiptView(row) : undefined
  }
  /**
   * Claim a request once before Session admission. A changed body under the same id is a conflict; a crash after
   * the claim leaves an honest `uncertain` outcome.
   * @param key - Binding key.
   * @param requestId - Stable client request id.
   * @param bodyHash - Digest of the validated command body.
   * @returns The existing or newly claimed receipt.
   */
  claim(key: string, requestId: string, bodyHash: string): StoredReceipt {
    this.ensure()
    const previous = this.receipt(key, requestId)
    if (previous) { if (previous.bodyHash !== bodyHash) throw new MobileSyncFailure('REQUEST_CONFLICT'); return previous }
    if (this.count('receipts') >= this.maxReceipts) throw new MobileSyncFailure('CAPACITY', 409)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare('SELECT issued_sequence FROM bindings WHERE key=? AND revoked=0').get(key)
      if (!row) throw new MobileSyncFailure('BINDING_UNKNOWN')
      const sequence = Number(row.issued_sequence) + 1
      const rpcId = `qianshou-mobile-sync:${digest(`${key}:${requestId}`)}`
      this.db.prepare('UPDATE bindings SET issued_sequence=? WHERE key=?').run(sequence, key)
      this.db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,'uncertain',NULL,NULL)").run(key, requestId, sequence, bodyHash, rpcId)
      this.db.exec('COMMIT')
      return { requestId, sequence, bodyHash, rpcId, state: 'uncertain', reason: null, acceptedAt: null }
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  /**
   * Publish admission only after the original Session's durability barrier succeeded.
   * @param key - Binding key.
   * @param requestId - Claimed request id.
   * @param now - Admission time.
   * @returns The durable receipt.
   */
  received(key: string, requestId: string, now: number): StoredReceipt {
    this.ensure()
    this.db.prepare("UPDATE receipts SET state='received',accepted_at=?,reason='session-admitted' WHERE binding_key=? AND request_id=? AND state!='received'").run(now, key, requestId)
    const receipt = this.receipt(key, requestId)
    if (!receipt) throw new MobileSyncFailure('STORAGE_FAILED')
    return receipt
  }
  /**
   * Record why an attempt could not be proven; the state stays `uncertain` and never permits automatic resend.
   * @param key - Binding key.
   * @param requestId - Claimed request id.
   * @param reason - Stable refusal code.
   */
  unproven(key: string, requestId: string, reason: string): void {
    this.db.prepare("UPDATE receipts SET reason=? WHERE binding_key=? AND request_id=? AND state='uncertain'").run(reason, key, requestId)
  }
  /**
   * Read receipts after a stream position, oldest first.
   * @param key - Binding key.
   * @param afterSequence - Last sequence the phone has seen.
   * @param limit - Page ceiling.
   * @returns Receipts in sequence order.
   */
  receiptsAfter(key: string, afterSequence: number, limit: number): StoredReceipt[] {
    this.ensure()
    return (this.db.prepare('SELECT * FROM receipts WHERE binding_key=? AND sequence>? ORDER BY sequence LIMIT ?')
      .all(key, afterSequence, limit) as unknown as ReceiptRow[]).map(receiptView)
  }
  private count(table: 'bindings' | 'receipts'): number {
    return Number(this.db.prepare(`SELECT count(*) AS total FROM ${table}`).get()?.total)
  }
}
