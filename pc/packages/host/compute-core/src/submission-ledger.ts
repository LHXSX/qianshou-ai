/**
 * Local idempotency ledger and unknown-result reconciliation gate for paid
 * workload submission.
 *
 * ## Why this module exists
 *
 * The upstream core accepts `POST /api/v8/workloads` with **no idempotency key
 * field** and only a rate limit (`submit_workload`, 30/min/uid) as anti-flood,
 * so a retry after a timeout can create a second order and freeze budget twice.
 * Until the core grows a verified completion idempotency identifier and quote
 * binding, this ledger is the only local defence: it records the *intent* to
 * submit before anything leaves the machine and makes the "result unknown"
 * outcome a first-class, durable state that nothing can silently resolve.
 *
 * ## The one invariant this module enforces
 *
 * > In any state where the submission result is not known, the process cannot
 * > automatically send the request again.
 *
 * It is enforced structurally rather than by convention:
 *
 * 1. {@link canResubmit} is a total function over every reachable record and
 *    returns `false` for `INTENT_RECORDED`, `SUBMITTING` and `UNKNOWN`. A test
 *    enumerates the whole state × authority × server-observation space and
 *    fails if any unknown-result combination reports `true`.
 * 2. `UNKNOWN` is never a source state for a resolving transition. The only
 *    event that leaves `UNKNOWN` is `reconcile`, whose payload must carry
 *    positive observed server evidence ({@link SubmissionReconciliation}); a
 *    reconciliation that observed nothing converges to `UNKNOWN` again.
 * 3. This module performs **no network I/O at all** — it imports no HTTP
 *    facility. The Host client POSTs `POST /api/v8/developer/tasks` elsewhere
 *    and must consult this ledger before any automatic resend.
 *
 * ## What this module does not do
 *
 * It does not submit, retry, cancel, charge, hold budget, or read the core.
 * It stores no prompts, no outputs, no credentials and no upstream response
 * bodies: only opaque account/task identifiers, an attempt counter, two
 * SHA-256 digests, a status and a timestamp.
 *
 * @module submission-ledger
 */

import { createHash } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { ComputeError } from './errors.ts'

/** Versioned domain separator for the submission idempotency key derivation. */
export const COMPUTE_SUBMISSION_INTENT_PROTOCOL = 'qianshou.workload.submission.v1' as const

/** On-disk schema version of the submission ledger; a bump invalidates old files. */
export const COMPUTE_SUBMISSION_LEDGER_VERSION = 1 as const

/**
 * Lifecycle of one local submission intent.
 *
 * `UNKNOWN` is deliberately a first-class durable state, not an error: a
 * timeout, a socket reset or a process crash all land here, and the outcome is
 * genuinely undecided until server facts are read back.
 */
export type SubmissionIntentStatus =
  /** Intent durably recorded locally; nothing has been sent. */
  | 'INTENT_RECORDED'
  /** A submit attempt is believed to be in flight or was interrupted. Outcome unknown to us. */
  | 'SUBMITTING'
  /** Server facts proved the workload exists. */
  | 'CONFIRMED'
  /** Server facts proved the workload does not exist. */
  | 'REJECTED'
  /** The request may or may not have reached the core. Never folded into success or failure. */
  | 'UNKNOWN'

/**
 * Where the recorded status came from. This is what separates "we read it back"
 * from "we assumed it", and only observed evidence may ever unlock a resend.
 */
export type SubmissionIntentAuthority =
  /** The status is a local observation of our own actions, not of the core. */
  | 'local'
  /** The status was derived from positive facts read back from the core. */
  | 'reconciled'

/** Durable local fact for one submission intent; no content, credentials or response bodies. */
export interface SubmissionIntentRecord {
  /** Deterministic key derived by {@link deriveSubmissionIdempotencyKey}. */
  idempotencyKey: string
  /** Opaque account identity the submission belongs to. */
  accountId: string
  /** Opaque task identity being submitted. */
  taskId: string
  /** Attempt number for this (account, task) pair; each retry is a new intent. */
  attempt: number
  /** SHA-256 of the canonical normalized request content. */
  requestFingerprint: string
  status: SubmissionIntentStatus
  authority: SubmissionIntentAuthority
  /** Canonical UTC timestamp of the last local write. */
  updatedAt: string
}

/** Normalized request content bound to one submission intent. */
export interface SubmissionIntentInput {
  /** Opaque account identity; an email or token must never be passed here. */
  accountId: string
  /** Opaque task identity. */
  taskId: string
  /** Attempt number, 1-based. */
  attempt: number
  /**
   * Request content to submit, as already-normalized plain JSON. Overrides and
   * prices belong in here so that two intents with different amounts cannot
   * share a key.
   */
  request: unknown
}

/** Positive server evidence read back by an operator or a future reconciler. */
export type SubmissionReconciliation =
  /** The core answered that the workload exists for this key/task. */
  | { observed: 'workload-present'; evidence: string }
  /** The core answered that no such workload exists; the key is free to use again. */
  | { observed: 'workload-absent'; evidence: string }
  /** Nothing conclusive was read back; the intent stays `UNKNOWN`. */
  | { observed: 'unresolved'; evidence: string }

/** Events accepted by the submission intent reducer. */
export type SubmissionIntentEvent =
  /** Start the submit attempt. */
  | { type: 'submitting' }
  /** The attempt outcome could not be determined (timeout, reset, crash). */
  | { type: 'unknown' }
  /** Converge on facts read back from the core. */
  | { type: 'reconcile'; reconciliation: SubmissionReconciliation }

/** Storage settings for the bounded submission ledger. */
export interface SubmissionLedgerConfig {
  /** Absolute private path of the ledger file. */
  path: string
  /** Maximum retained intent records; enforced on read and on write. */
  maxRecords: number
  /** Maximum bytes of the serialized ledger; enforced on read and on write. */
  maxBytes: number
}

const statuses = new Set<SubmissionIntentStatus>(['INTENT_RECORDED', 'SUBMITTING', 'CONFIRMED', 'REJECTED', 'UNKNOWN'])
const authorities = new Set<SubmissionIntentAuthority>(['local', 'reconciled'])
const observations = new Set<SubmissionReconciliation['observed']>(['workload-present', 'workload-absent', 'unresolved'])

/**
 * Sources that may legally converge on an observed fact. `CONFIRMED` and
 * `REJECTED` are terminal: a second contradictory server answer must be
 * surfaced as a conflict rather than silently rewriting durable history.
 */
const reconcilable = new Set<SubmissionIntentStatus>(['INTENT_RECORDED', 'SUBMITTING', 'UNKNOWN'])

/**
 * Compute the deterministic SHA-256 fingerprint of the canonical request
 * content.
 *
 * The canonicalization is the same rule `taskFingerprint` uses — recursively
 * sorted object keys, `JSON.stringify` scalars, rejection of non-finite
 * numbers — so the project keeps exactly one hash normalization instead of two
 * mutually incompatible ones. `-0` is folded into `0` because JSON has no
 * negative zero, and every non-JSON value (function, symbol, `undefined`) is
 * rejected rather than hashed into an unstable shape.
 * @param value - Untrusted normalized request content to fingerprint.
 * @returns SHA-256 hex digest of the canonical content.
 */
export function submissionRequestFingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

/**
 * Derive the stable idempotency key for one submission intent.
 *
 * The key is a pure function of (protocol, accountId, taskId, attempt,
 * requestFingerprint), so identical content always yields the identical key and
 * any content change yields a different one. The `requestFingerprint` is
 * applied twice on purpose: once inside the fingerprint and once as an explicit
 * derivation field, which keeps the two ways of detecting a content mismatch
 * (key inequality and stored-fingerprint inequality) independently useful.
 * @param input - Normalized submission intent content.
 * @returns 64-character lowercase hex idempotency key.
 */
export function deriveSubmissionIdempotencyKey(input: SubmissionIntentInput): string {
  const intent = parseSubmissionIntentInput(input)
  const requestFingerprint = submissionRequestFingerprint(intent.request)
  return createHash('sha256')
    .update(canonicalJson({
      protocol: COMPUTE_SUBMISSION_INTENT_PROTOCOL,
      accountId: intent.accountId,
      taskId: intent.taskId,
      attempt: intent.attempt,
      requestFingerprint,
    }))
    .digest('hex')
}

/**
 * Create the initial durable record for a submission intent.
 * @param input - Normalized submission intent content.
 * @param now - Canonical current UTC timestamp.
 * @returns A new `INTENT_RECORDED` / `local` record; the input is never mutated.
 */
export function createSubmissionIntent(input: SubmissionIntentInput, now: string): SubmissionIntentRecord {
  const intent = parseSubmissionIntentInput(input)
  return Object.freeze({
    idempotencyKey: deriveSubmissionIdempotencyKey(intent),
    accountId: intent.accountId,
    taskId: intent.taskId,
    attempt: intent.attempt,
    requestFingerprint: submissionRequestFingerprint(intent.request),
    status: 'INTENT_RECORDED' as const,
    authority: 'local' as const,
    updatedAt: timestamp(now),
  })
}

/**
 * The single resend gate. Callers must consult this before any future submit
 * attempt; there is no second, laxer check anywhere in the project.
 *
 * Returns `true` only for a `REJECTED` intent whose rejection was **observed on
 * the core** (`authority === 'reconciled'`). Every unknown-result state — a
 * recorded intent, an attempt believed to be in flight, and above all
 * `UNKNOWN` — returns `false`, because none of them proves that the core did
 * not already accept the workload.
 * @param record - Intent record to judge, or null when no intent exists yet.
 * @returns Whether a resend is provably safe from the recorded facts.
 */
export function canResubmit(record: SubmissionIntentRecord | null): boolean {
  if (!record) return false
  return record.status === 'REJECTED' && record.authority === 'reconciled'
}

/**
 * Apply one submission intent event and reject illegal changes.
 *
 * The `unknown` event is the only way into `UNKNOWN`, and no event other than
 * `reconcile` can leave it. `reconcile` refuses to resolve a `CONFIRMED` or
 * `REJECTED` record, and maps `observed: 'unresolved'` back to `UNKNOWN` with
 * local authority, so an inconclusive read never manufactures an outcome.
 * @param state - Current record for one submission intent.
 * @param event - Event observed locally or read back from the core.
 * @param now - Canonical current UTC timestamp.
 * @returns A new record value; the input object is never mutated.
 */
export function transitionSubmissionIntent(
  state: SubmissionIntentRecord,
  event: SubmissionIntentEvent,
  now: string,
): SubmissionIntentRecord {
  const current = parseSubmissionIntentRecord(state)
  const at = timestamp(now)
  switch (event.type) {
    case 'submitting':
      if (current.status !== 'INTENT_RECORDED') throw new ComputeError('COMPUTE_TASK_TRANSITION_INVALID', 409)
      return { ...current, status: 'SUBMITTING', authority: 'local', updatedAt: at }
    case 'unknown':
      if (current.status !== 'INTENT_RECORDED' && current.status !== 'SUBMITTING') {
        throw new ComputeError('COMPUTE_TASK_TRANSITION_INVALID', 409)
      }
      return { ...current, status: 'UNKNOWN', authority: 'local', updatedAt: at }
    case 'reconcile': {
      if (!reconcilable.has(current.status)) throw new ComputeError('COMPUTE_TASK_TRANSITION_INVALID', 409)
      const observation = parseReconciliation(event.reconciliation)
      if (observation.observed === 'workload-present') {
        return { ...current, status: 'CONFIRMED', authority: 'reconciled', updatedAt: at }
      }
      if (observation.observed === 'workload-absent') {
        return { ...current, status: 'REJECTED', authority: 'reconciled', updatedAt: at }
      }
      // Inconclusive evidence stays unknown. This is the whole point: a failed
      // reconciliation must never be folded into success or failure.
      return { ...current, status: 'UNKNOWN', authority: 'local', updatedAt: at }
    }
    default:
      return assertNever()
  }
}

/**
 * Parse one persisted submission intent record, rejecting unknown statuses,
 * malformed digests and non-canonical timestamps.
 * @param value - Untrusted persisted intent JSON.
 * @returns Validated record.
 */
export function parseSubmissionIntentRecord(value: unknown): SubmissionIntentRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ComputeError('COMPUTE_TASK_STATE_INVALID', 503)
  const item = value as Record<string, unknown>
  if (typeof item.idempotencyKey !== 'string' || !/^[a-f0-9]{64}$/u.test(item.idempotencyKey)
    || typeof item.accountId !== 'string' || !OPAQUE_ID.test(item.accountId)
    || typeof item.taskId !== 'string' || !OPAQUE_ID.test(item.taskId)
    || typeof item.attempt !== 'number' || !Number.isSafeInteger(item.attempt) || item.attempt < 1
    || typeof item.requestFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(item.requestFingerprint)
    || typeof item.status !== 'string' || !statuses.has(item.status as SubmissionIntentStatus)
    || typeof item.authority !== 'string' || !authorities.has(item.authority as SubmissionIntentAuthority)
    || typeof item.updatedAt !== 'string'
    || !isConsistent(item.status as SubmissionIntentStatus, item.authority as SubmissionIntentAuthority)) {
    throw new ComputeError('COMPUTE_TASK_STATE_INVALID', 503)
  }
  timestamp(item.updatedAt)
  return {
    idempotencyKey: item.idempotencyKey,
    accountId: item.accountId,
    taskId: item.taskId,
    attempt: item.attempt,
    requestFingerprint: item.requestFingerprint,
    status: item.status as SubmissionIntentStatus,
    authority: item.authority as SubmissionIntentAuthority,
    updatedAt: item.updatedAt,
  }
}

/**
 * Bounded, cross-process-serialized submission intent ledger.
 *
 * Persistence reuses the established `task-store` discipline: a `wx` sibling
 * lock serializes read-modify-write cycles across processes, the commit is a
 * rename-based atomic replacement, and the replacement inode is stamped `0600`
 * inside a `0700` directory. Record count and byte ceiling are enforced on both
 * read and write, so a hand-edited oversized file is refused instead of loaded.
 *
 * A crash between `unknown` and its commit is safe by construction: the record
 * keeps whatever status was last durably committed, `canResubmit` stays `false`
 * for every non-rejected status, and reopening never rewrites a status.
 */
export class SubmissionLedger {
  private closed = false
  private readonly pending = new Set<Promise<unknown>>()

  /** Construct a ledger without opening or rewriting the file.
   * @param config - Absolute private path and capacity limits.
   */
  constructor(private readonly config: SubmissionLedgerConfig) {
    if (!Number.isSafeInteger(config.maxRecords) || config.maxRecords < 1) throw new ComputeError('COMPUTE_TASK_STORE_CAPACITY', 409)
    if (!Number.isSafeInteger(config.maxBytes) || config.maxBytes < 1) throw new ComputeError('COMPUTE_TASK_STORE_CAPACITY', 409)
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    const promise = operation()
    this.pending.add(promise)
    void promise.finally(() => this.pending.delete(promise)).catch(() => {})
    return promise
  }

  private async read(): Promise<SubmissionIntentRecord[]> {
    let file
    try { file = await open(this.config.path, 'r') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new ComputeError('COMPUTE_TASK_STORE_UNAVAILABLE', 503)
    }
    try {
      if ((await file.stat()).size > this.config.maxBytes) throw new Error('size')
      const content = await file.readFile('utf8')
      const data: unknown = JSON.parse(content)
      if (!data || typeof data !== 'object' || Array.isArray(data)
        || (data as Record<string, unknown>).version !== COMPUTE_SUBMISSION_LEDGER_VERSION
        || !Array.isArray((data as Record<string, unknown>).records)) throw new Error('schema')
      const records = (data as Record<string, unknown>).records as unknown[]
      if (records.length > this.config.maxRecords) throw new Error('capacity')
      const seen = new Set<string>()
      return records.map((value) => {
        const record = parseSubmissionIntentRecord(value)
        if (seen.has(record.idempotencyKey)) throw new Error('duplicate')
        seen.add(record.idempotencyKey)
        return record
      })
    } catch { throw new ComputeError('COMPUTE_TASK_STORE_INVALID', 503) }
    finally { await file.close() }
  }

  /** Read every recorded intent; these are local facts and prove nothing about the core.
   * @returns Persisted intent records, newest first.
   */
  list(): Promise<SubmissionIntentRecord[]> { return this.track(() => this.read()) }

  /** Return one intent or null; keys are never interpreted as paths.
   * @param idempotencyKey - Key returned by {@link deriveSubmissionIdempotencyKey}.
   * @returns Matching record, or null when absent.
   */
  get(idempotencyKey: string): Promise<SubmissionIntentRecord | null> {
    return this.track(async () => (await this.read()).find(item => item.idempotencyKey === idempotencyKey) ?? null)
  }

  /**
   * Record the intent to submit once, before anything is sent.
   *
   * Replaying the identical content returns the existing record untouched — it
   * never resets a status, so a replay cannot resurrect a resolved intent or
   * clear an `UNKNOWN`. The same key with different content is refused with the
   * established `COMPUTE_TASK_REPLAY_CONFLICT` code, which is how a changed
   * budget or parameter set is caught instead of silently reusing an intent.
   * @param input - Normalized submission intent content.
   * @param now - Canonical current UTC timestamp.
   * @returns The existing or newly persisted record, and whether it was new.
   */
  recordIntent(input: SubmissionIntentInput, now: string): Promise<{ record: SubmissionIntentRecord; inserted: boolean }> {
    return this.recordIntentRecord(() => createSubmissionIntent(input, now), false)
  }

  /** Persist a quoted request with the key already placed in Shanghai's final-spec preview.
   * The caller must allocate a fresh key for every new quote; the ledger still binds that key
   * to the confirmed request fingerprint and refuses any later content change or silent resend.
   */
  recordIntentWithKey(input: SubmissionIntentInput, idempotencyKey: string, now: string): Promise<{ record: SubmissionIntentRecord; inserted: boolean }> {
    return this.recordIntentRecord(() => {
      if (!/^[a-f0-9]{64}$/u.test(idempotencyKey)) throw new ComputeError('COMPUTE_SUBMISSION_INTENT_INVALID')
      return { ...createSubmissionIntent(input, now), idempotencyKey }
    }, true)
  }

  private recordIntentRecord(
    create: () => SubmissionIntentRecord,
    exclusiveTask: boolean,
  ): Promise<{ record: SubmissionIntentRecord; inserted: boolean }> {
    return this.track(async () => {
      const admitted = create()
      await mkdir(dirname(this.config.path), { recursive: true, mode: 0o700 })
      return withFileLock(this.config.path, async () => {
        const records = await this.read()
        const existing = records.find(item => item.idempotencyKey === admitted.idempotencyKey)
        if (existing) {
          if (existing.requestFingerprint !== admitted.requestFingerprint
            || existing.accountId !== admitted.accountId
            || existing.taskId !== admitted.taskId
            || existing.attempt !== admitted.attempt) {
            throw new ComputeError('COMPUTE_TASK_REPLAY_CONFLICT', 409)
          }
          return { record: existing, inserted: false }
        }
        if (exclusiveTask && records.some(item => item.accountId === admitted.accountId
          && item.taskId === admitted.taskId && item.status !== 'REJECTED')) {
          throw new ComputeError('COMPUTE_SUBMISSION_UNKNOWN', 409)
        }
        if (records.length >= this.config.maxRecords) throw new ComputeError('COMPUTE_TASK_STORE_CAPACITY', 409)
        await this.write([admitted, ...records])
        return { record: admitted, inserted: true }
      })
    })
  }

  /**
   * Apply one lifecycle event atomically to a recorded intent.
   * @param idempotencyKey - Key of the intent to update.
   * @param event - Lifecycle event to apply.
   * @param now - Canonical current UTC timestamp.
   * @returns Updated persisted record.
   */
  transition(idempotencyKey: string, event: SubmissionIntentEvent, now: string): Promise<SubmissionIntentRecord> {
    return this.track(async () => {
      await mkdir(dirname(this.config.path), { recursive: true, mode: 0o700 })
      return withFileLock(this.config.path, async () => {
        const records = await this.read()
        const index = records.findIndex(item => item.idempotencyKey === idempotencyKey)
        if (index < 0) throw new ComputeError('COMPUTE_TASK_NOT_FOUND', 404)
        const existing = records[index]
        if (existing === undefined) throw new ComputeError('COMPUTE_TASK_NOT_FOUND', 404)
        const next = transitionSubmissionIntent(existing, event, now)
        records[index] = next
        await this.write(records)
        return next
      })
    })
  }

  /**
   * Converge a recorded intent on facts read back from the core.
   *
   * This is the designated — and only — exit from `UNKNOWN`. Passing
   * `unresolved` leaves the intent `UNKNOWN`, and an already resolved intent is
   * refused rather than rewritten, so reconciliation cannot be used to launder
   * an unknown outcome into a convenient one.
   * @param idempotencyKey - Key of the intent to reconcile.
   * @param reconciliation - Positive observed server evidence.
   * @param now - Canonical current UTC timestamp.
   * @returns Updated persisted record.
   */
  reconcile(idempotencyKey: string, reconciliation: SubmissionReconciliation, now: string): Promise<SubmissionIntentRecord> {
    return this.transition(idempotencyKey, { type: 'reconcile', reconciliation }, now)
  }

  /**
   * The resend gate bound to persisted facts. Reads the durable record so a
   * caller cannot bypass the check with a stale in-memory copy.
   * @param idempotencyKey - Key of the intent to judge.
   * @returns Whether a resend is provably safe; `false` for unknown results.
   */
  canResubmit(idempotencyKey: string): Promise<boolean> {
    return this.track(async () => canResubmit((await this.read()).find(item => item.idempotencyKey === idempotencyKey) ?? null))
  }

  private async write(records: readonly SubmissionIntentRecord[]): Promise<void> {
    const content = JSON.stringify({ version: COMPUTE_SUBMISSION_LEDGER_VERSION, records })
    if (Buffer.byteLength(content) > this.config.maxBytes) throw new ComputeError('COMPUTE_TASK_STORE_CAPACITY', 409)
    try { await writeFileAtomic(this.config.path, content, { mode: 0o600, dirMode: 0o700 }) }
    catch { throw new ComputeError('COMPUTE_TASK_STORE_UNAVAILABLE', 503) }
  }

  /** Stop new operations and drain accepted writes before plugin disposal. */
  async close(): Promise<void> { this.closed = true; await Promise.allSettled(this.pending) }
}

/** Opaque identities are printable and path-free; they are never used as filenames. */
const OPAQUE_ID = /^[A-Za-z0-9._:@-]{1,128}$/u

/** Only local observations may accompany a non-reconciled status. */
function isConsistent(status: SubmissionIntentStatus, authority: SubmissionIntentAuthority): boolean {
  if (authority === 'reconciled') return status === 'CONFIRMED' || status === 'REJECTED'
  return status !== 'CONFIRMED' && status !== 'REJECTED'
}

function parseSubmissionIntentInput(value: unknown): SubmissionIntentInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ComputeError('COMPUTE_SUBMISSION_INTENT_INVALID')
  const item = value as Record<string, unknown>
  if (typeof item.accountId !== 'string' || !OPAQUE_ID.test(item.accountId)
    || typeof item.taskId !== 'string' || !OPAQUE_ID.test(item.taskId)
    || typeof item.attempt !== 'number' || !Number.isSafeInteger(item.attempt) || item.attempt < 1 || item.attempt > 1_000_000
    || item.request === undefined) throw new ComputeError('COMPUTE_SUBMISSION_INTENT_INVALID')
  return { accountId: item.accountId, taskId: item.taskId, attempt: item.attempt, request: item.request }
}

function parseReconciliation(value: unknown): SubmissionReconciliation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ComputeError('COMPUTE_SUBMISSION_INTENT_INVALID')
  const item = value as Record<string, unknown>
  if (typeof item.observed !== 'string' || !observations.has(item.observed as SubmissionReconciliation['observed'])
    || typeof item.evidence !== 'string' || !OPAQUE_ID.test(item.evidence)) {
    throw new ComputeError('COMPUTE_SUBMISSION_INTENT_INVALID')
  }
  return { observed: item.observed as SubmissionReconciliation['observed'], evidence: item.evidence }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ComputeError('COMPUTE_TASK_CANONICAL_INVALID')
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  throw new ComputeError('COMPUTE_TASK_CANONICAL_INVALID')
}

function timestamp(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) throw new ComputeError('COMPUTE_TASK_TIMESTAMP_INVALID')
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new ComputeError('COMPUTE_TASK_TIMESTAMP_INVALID')
  return value
}

/** Unreachable by construction: the event union is closed and every variant is handled above. */
function assertNever(): never {
  throw new ComputeError('COMPUTE_TASK_TRANSITION_INVALID', 409)
}
