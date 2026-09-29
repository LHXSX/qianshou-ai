import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ComputeError } from '../src/errors.ts'
import {
  canResubmit,
  createSubmissionIntent,
  deriveSubmissionIdempotencyKey,
  parseSubmissionIntentRecord,
  SubmissionLedger,
  submissionRequestFingerprint,
  transitionSubmissionIntent,
  type SubmissionIntentAuthority,
  type SubmissionIntentInput,
  type SubmissionIntentRecord,
  type SubmissionIntentStatus,
  type SubmissionReconciliation,
} from '../src/submission-ledger.ts'

const NOW = '2026-09-15T12:00:00.000Z'
const LATER = '2026-09-15T12:00:05.000Z'
const SETTLED = '2026-09-15T12:00:10.000Z'

const ALL_STATUSES: readonly SubmissionIntentStatus[] = ['INTENT_RECORDED', 'SUBMITTING', 'CONFIRMED', 'REJECTED', 'UNKNOWN']
const ALL_AUTHORITIES: readonly SubmissionIntentAuthority[] = ['local', 'reconciled']
const ALL_OBSERVATIONS: readonly SubmissionReconciliation['observed'][] = ['workload-present', 'workload-absent', 'unresolved']

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'qianshou-ledger-'))
  roots.push(root)
  return root
}

async function openLedger(options: { maxRecords?: number; maxBytes?: number } = {}): Promise<{ ledger: SubmissionLedger; path: string; dir: string }> {
  const root = await tempRoot()
  const dir = join(root, 'private')
  const path = join(dir, 'submissions.json')
  const ledger = new SubmissionLedger({ path, maxRecords: options.maxRecords ?? 8, maxBytes: options.maxBytes ?? 65536 })
  return { ledger, path, dir }
}

function intent(overrides: Partial<SubmissionIntentInput> = {}): SubmissionIntentInput {
  return {
    accountId: 'acct-1',
    taskId: 'task-1',
    attempt: 1,
    request: { taskType: 'h3-image', budgetFen: 50, params: { size: '1024x1024' } },
    ...overrides,
  }
}

/** Planted ledger file used to reach the store guard the public derivation cannot produce. */
function ledgerFile(records: SubmissionIntentRecord[]): string {
  return JSON.stringify({ version: 1, records })
}

async function readLedgerFile(path: string): Promise<{ version: number; records: SubmissionIntentRecord[] }> {
  return JSON.parse(await readFile(path, 'utf8')) as { version: number; records: SubmissionIntentRecord[] }
}

describe('submission idempotency key derivation', () => {
  it('is a pure function of content: identical content shares a key, any change yields another', () => {
    const key = deriveSubmissionIdempotencyKey(intent())
    expect(key).toMatch(/^[a-f0-9]{64}$/u)
    expect(deriveSubmissionIdempotencyKey(intent())).toBe(key)

    // Object key order is not content: canonicalization makes it equal.
    expect(deriveSubmissionIdempotencyKey(intent({ request: { params: { size: '1024x1024' }, budgetFen: 50, taskType: 'h3-image' } }))).toBe(key)

    // Every derivation input is load-bearing.
    expect(deriveSubmissionIdempotencyKey(intent({ accountId: 'acct-2' }))).not.toBe(key)
    expect(deriveSubmissionIdempotencyKey(intent({ taskId: 'task-2' }))).not.toBe(key)
    expect(deriveSubmissionIdempotencyKey(intent({ attempt: 2 }))).not.toBe(key)
    expect(deriveSubmissionIdempotencyKey(intent({ request: { taskType: 'h3-image', budgetFen: 51, params: { size: '1024x1024' } } }))).not.toBe(key)
    expect(deriveSubmissionIdempotencyKey(intent({ request: { taskType: 'h3-image', budgetFen: 50, params: { size: '512x512' } } }))).not.toBe(key)
  })

  it('rejects non-JSON content and unsafe identities instead of hashing an unstable shape', () => {
    expect(() => submissionRequestFingerprint(Number.NaN)).toThrow('COMPUTE_TASK_CANONICAL_INVALID')
    expect(() => submissionRequestFingerprint(Number.POSITIVE_INFINITY)).toThrow('COMPUTE_TASK_CANONICAL_INVALID')
    expect(() => submissionRequestFingerprint(() => undefined)).toThrow('COMPUTE_TASK_CANONICAL_INVALID')
    expect(() => deriveSubmissionIdempotencyKey(intent({ attempt: 0 }))).toThrow('COMPUTE_SUBMISSION_INTENT_INVALID')
    expect(() => deriveSubmissionIdempotencyKey(intent({ taskId: '../escape' }))).toThrow('COMPUTE_SUBMISSION_INTENT_INVALID')
    expect(() => deriveSubmissionIdempotencyKey(intent({ accountId: '' }))).toThrow('COMPUTE_SUBMISSION_INTENT_INVALID')
  })
})

describe('submission intent reducer', () => {
  it('walks the mandated lifecycle and refuses every illegal move', () => {
    const recorded = createSubmissionIntent(intent(), NOW)
    expect(recorded).toMatchObject({ status: 'INTENT_RECORDED', authority: 'local' })

    const submitting = transitionSubmissionIntent(recorded, { type: 'submitting' }, NOW)
    expect(submitting).toMatchObject({ status: 'SUBMITTING', authority: 'local' })

    const unknown = transitionSubmissionIntent(submitting, { type: 'unknown' }, LATER)
    expect(unknown).toMatchObject({ status: 'UNKNOWN', authority: 'local' })

    // A recorded intent can go straight to UNKNOWN; a settled one cannot move at all.
    expect(transitionSubmissionIntent(recorded, { type: 'unknown' }, LATER)).toMatchObject({ status: 'UNKNOWN' })
    expect(() => transitionSubmissionIntent(unknown, { type: 'submitting' }, SETTLED)).toThrow('COMPUTE_TASK_TRANSITION_INVALID')
    expect(() => transitionSubmissionIntent(unknown, { type: 'unknown' }, SETTLED)).toThrow('COMPUTE_TASK_TRANSITION_INVALID')

    const confirmed = transitionSubmissionIntent(unknown, { type: 'reconcile', reconciliation: { observed: 'workload-present', evidence: 'probe-1' } }, SETTLED)
    expect(confirmed).toMatchObject({ status: 'CONFIRMED', authority: 'reconciled' })
    expect(() => transitionSubmissionIntent(confirmed, { type: 'reconcile', reconciliation: { observed: 'workload-absent', evidence: 'probe-2' } }, SETTLED)).toThrow('COMPUTE_TASK_TRANSITION_INVALID')
    expect(() => transitionSubmissionIntent(confirmed, { type: 'unknown' }, SETTLED)).toThrow('COMPUTE_TASK_TRANSITION_INVALID')
    expect(() => transitionSubmissionIntent(confirmed, { type: 'submitting' }, SETTLED)).toThrow('COMPUTE_TASK_TRANSITION_INVALID')
  })

  it('never folds an inconclusive reconciliation into success or failure', () => {
    const unknown = transitionSubmissionIntent(createSubmissionIntent(intent(), NOW), { type: 'unknown' }, NOW)
    const again = transitionSubmissionIntent(unknown, { type: 'reconcile', reconciliation: { observed: 'unresolved', evidence: 'timeout-again' } }, LATER)
    expect(again.status).toBe('UNKNOWN')
    expect(again.authority).toBe('local')
    expect(() => transitionSubmissionIntent(again, {
      type: 'reconcile',
      reconciliation: { observed: 'guess', evidence: 'e' },
    } as unknown as { type: 'reconcile'; reconciliation: SubmissionReconciliation }, LATER)).toThrow('COMPUTE_SUBMISSION_INTENT_INVALID')
  })

  it('refuses a record that claims a reconciled outcome for an unresolved result', () => {
    const base: SubmissionIntentRecord = {
      idempotencyKey: 'a'.repeat(64), accountId: 'acct-1', taskId: 'task-1', attempt: 1,
      requestFingerprint: 'b'.repeat(64), status: 'UNKNOWN', authority: 'reconciled', updatedAt: NOW,
    }
    expect(() => parseSubmissionIntentRecord(base)).toThrow('COMPUTE_TASK_STATE_INVALID')
    expect(() => parseSubmissionIntentRecord({ ...base, status: 'SUBMITTING', authority: 'reconciled' })).toThrow('COMPUTE_TASK_STATE_INVALID')
    expect(() => parseSubmissionIntentRecord({ ...base, status: 'CONFIRMED', authority: 'local' })).toThrow('COMPUTE_TASK_STATE_INVALID')
    expect(() => parseSubmissionIntentRecord({ ...base, status: 'REJECTED', authority: 'local' })).toThrow('COMPUTE_TASK_STATE_INVALID')
  })
})

describe('canResubmit gate', () => {
  it('is false for every record whose result is not a positively observed rejection', () => {
    const allowed: string[] = []
    for (const status of ALL_STATUSES) {
      for (const authority of ALL_AUTHORITIES) {
        const record: SubmissionIntentRecord = {
          idempotencyKey: 'a'.repeat(64), accountId: 'acct-1', taskId: 'task-1', attempt: 1,
          requestFingerprint: 'b'.repeat(64), status, authority, updatedAt: NOW,
        }
        const resolvable = status === 'CONFIRMED' || status === 'REJECTED'
        // A record claiming a reconciled outcome for an unresolved result must
        // not even parse, so no caller can invent one to unlock a resend.
        if (authority === 'reconciled' && !resolvable) expect(() => parseSubmissionIntentRecord(record)).toThrow('COMPUTE_TASK_STATE_INVALID')
        if (canResubmit(record)) allowed.push(`${status}/${authority}`)
      }
    }
    expect(allowed).toEqual(['REJECTED/reconciled'])
    expect(canResubmit(null)).toBe(false)
  })

  it('is false for every reconciliation of UNKNOWN except an observed rejection', () => {
    const unknown = transitionSubmissionIntent(
      transitionSubmissionIntent(createSubmissionIntent(intent(), NOW), { type: 'submitting' }, NOW),
      { type: 'unknown' },
      LATER,
    )
    expect(canResubmit(unknown)).toBe(false)
    for (const observed of ALL_OBSERVATIONS) {
      const next = transitionSubmissionIntent(unknown, { type: 'reconcile', reconciliation: { observed, evidence: `probe-${observed}` } }, SETTLED)
      const expected: SubmissionIntentStatus = observed === 'workload-present' ? 'CONFIRMED' : observed === 'workload-absent' ? 'REJECTED' : 'UNKNOWN'
      expect(next.status).toBe(expected)
      expect(canResubmit(next)).toBe(observed === 'workload-absent')
    }
  })
})

describe('submission ledger persistence', () => {
  it('binds a prequoted Shanghai key to the confirmed amount and refuses changed content', async () => {
    const { ledger } = await openLedger()
    const key = 'e'.repeat(64)
    const request = intent({ request: { taskType: 'h3-image', budget: '0.75' } })
    const first = await ledger.recordIntentWithKey(request, key, NOW)
    expect(first.record.idempotencyKey).toBe(key)
    expect((await ledger.recordIntentWithKey(request, key, LATER)).inserted).toBe(false)
    await expect(ledger.recordIntentWithKey(intent({ request: { taskType: 'h3-image', budget: '0.76' } }), key, LATER))
      .rejects.toMatchObject({ code: 'COMPUTE_TASK_REPLAY_CONFLICT' })
    await ledger.close()
  })

  it('admits at most one active quoted key for the same task across Host processes', async () => {
    const { ledger, path } = await openLedger()
    const peer = new SubmissionLedger({ path, maxRecords: 8, maxBytes: 65536 })
    const results = await Promise.allSettled([
      ledger.recordIntentWithKey(intent({ request: { budget: '0.75' } }), 'a'.repeat(64), NOW),
      peer.recordIntentWithKey(intent({ request: { budget: '0.76' } }), 'b'.repeat(64), NOW),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const denied = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect((denied.reason as ComputeError).code).toBe('COMPUTE_SUBMISSION_UNKNOWN')
    expect(await ledger.list()).toHaveLength(1)
    await Promise.all([ledger.close(), peer.close()])
  })

  it('records an intent once and resolves a replay without resetting its status', async () => {
    const { ledger } = await openLedger()
    const first = await ledger.recordIntent(intent(), NOW)
    expect(first.inserted).toBe(true)
    expect(first.record.status).toBe('INTENT_RECORDED')

    await ledger.transition(first.record.idempotencyKey, { type: 'submitting' }, NOW)
    await ledger.transition(first.record.idempotencyKey, { type: 'unknown' }, LATER)

    const replay = await ledger.recordIntent(intent(), SETTLED)
    expect(replay.inserted).toBe(false)
    // The replay must not clear UNKNOWN, revive the intent or move the timestamp.
    expect(replay.record).toMatchObject({ status: 'UNKNOWN', authority: 'local', updatedAt: LATER })
    await expect(ledger.canResubmit(first.record.idempotencyKey)).resolves.toBe(false)
    await ledger.close()
  })

  it('refuses the same key with different content using the established conflict code', async () => {
    const { ledger, path } = await openLedger()
    const recorded = await ledger.recordIntent(intent(), NOW)
    await ledger.transition(recorded.record.idempotencyKey, { type: 'unknown' }, LATER)

    // The public derivation cannot collide for differing content, so the guard
    // is proved on a planted file — the same shape a record written by an older
    // key derivation would have. Identical key, different content.
    await writeFile(path, ledgerFile([{ ...recorded.record, requestFingerprint: 'c'.repeat(64) }]), { mode: 0o600 })
    const conflict = await ledger.recordIntent(intent(), SETTLED).then(() => null, (error: unknown) => error)
    expect(conflict).toBeInstanceOf(ComputeError)
    expect((conflict as ComputeError).code).toBe('COMPUTE_TASK_REPLAY_CONFLICT')
    expect((conflict as ComputeError).status).toBe(409)
    // The refused replay left the stored record untouched.
    const onDisk = await readLedgerFile(path)
    expect(onDisk.records).toHaveLength(1)
    expect(onDisk.records[0]).toMatchObject({
      idempotencyKey: recorded.record.idempotencyKey,
      requestFingerprint: 'c'.repeat(64),
      status: 'INTENT_RECORDED',
      updatedAt: NOW,
    })
    await ledger.close()
  })

  it('gives changed request content a different key so a stale intent is never reused', async () => {
    const { ledger } = await openLedger()
    const original = await ledger.recordIntent(intent(), NOW)
    const changed = await ledger.recordIntent(intent({ request: { taskType: 'h3-image', budgetFen: 999, params: { size: '1024x1024' } } }), NOW)
    expect(changed.inserted).toBe(true)
    expect(changed.record.idempotencyKey).not.toBe(original.record.idempotencyKey)
    expect(changed.record.requestFingerprint).not.toBe(original.record.requestFingerprint)
    await expect(ledger.list()).resolves.toHaveLength(2)
    await ledger.close()
  })

  it('converges a durable UNKNOWN on observed facts and keeps it when nothing was observed', async () => {
    const { ledger } = await openLedger()

    const confirmed = await ledger.recordIntent(intent({ taskId: 'task-confirmed' }), NOW)
    await ledger.transition(confirmed.record.idempotencyKey, { type: 'submitting' }, NOW)
    await ledger.transition(confirmed.record.idempotencyKey, { type: 'unknown' }, LATER)
    await expect(ledger.canResubmit(confirmed.record.idempotencyKey)).resolves.toBe(false)
    await expect(ledger.reconcile(confirmed.record.idempotencyKey, { observed: 'workload-present', evidence: 'core-read-1' }, SETTLED))
      .resolves.toMatchObject({ status: 'CONFIRMED', authority: 'reconciled' })
    await expect(ledger.canResubmit(confirmed.record.idempotencyKey)).resolves.toBe(false)

    const rejected = await ledger.recordIntent(intent({ taskId: 'task-rejected' }), NOW)
    await ledger.transition(rejected.record.idempotencyKey, { type: 'unknown' }, LATER)
    await expect(ledger.reconcile(rejected.record.idempotencyKey, { observed: 'workload-absent', evidence: 'core-read-2' }, SETTLED))
      .resolves.toMatchObject({ status: 'REJECTED', authority: 'reconciled' })
    await expect(ledger.canResubmit(rejected.record.idempotencyKey)).resolves.toBe(true)

    const unresolved = await ledger.recordIntent(intent({ taskId: 'task-unresolved' }), NOW)
    await ledger.transition(unresolved.record.idempotencyKey, { type: 'unknown' }, LATER)
    await expect(ledger.reconcile(unresolved.record.idempotencyKey, { observed: 'unresolved', evidence: 'core-read-3' }, SETTLED))
      .resolves.toMatchObject({ status: 'UNKNOWN', authority: 'local' })
    await expect(ledger.canResubmit(unresolved.record.idempotencyKey)).resolves.toBe(false)
    await expect(ledger.reconcile(unresolved.record.idempotencyKey, { observed: 'workload-present', evidence: 'core-read-3b' }, SETTLED))
      .resolves.toMatchObject({ status: 'CONFIRMED' })

    await expect(ledger.reconcile('d'.repeat(64), { observed: 'workload-absent', evidence: 'core-read-4' }, SETTLED))
      .rejects.toThrow('COMPUTE_TASK_NOT_FOUND')
    await ledger.close()
  })

  it('survives a crash: reopening keeps UNKNOWN unknown and never rewrites it', async () => {
    const { ledger, path } = await openLedger()
    const stuck = await ledger.recordIntent(intent({ taskId: 'task-crash' }), NOW)
    await ledger.transition(stuck.record.idempotencyKey, { type: 'submitting' }, NOW)
    await ledger.transition(stuck.record.idempotencyKey, { type: 'unknown' }, LATER)
    await ledger.close()

    // Simulate a crash by dropping the instance instead of closing it.
    const afterCrash = new SubmissionLedger({ path, maxRecords: 8, maxBytes: 65536 })
    await expect(afterCrash.get(stuck.record.idempotencyKey)).resolves.toMatchObject({ status: 'UNKNOWN', authority: 'local', updatedAt: LATER })
    await expect(afterCrash.canResubmit(stuck.record.idempotencyKey)).resolves.toBe(false)
    // Reading must not have rewritten the record.
    expect(await readLedgerFile(path)).toMatchObject({ version: 1 })
    const onDisk = await readLedgerFile(path)
    expect(onDisk.records).toHaveLength(1)
    expect(onDisk.records[0]).toMatchObject({ status: 'UNKNOWN', authority: 'local', updatedAt: LATER })

    // A replay after the crash still returns the unknown record and stays blocked.
    await expect(afterCrash.recordIntent(intent({ taskId: 'task-crash' }), SETTLED)).resolves.toMatchObject({ inserted: false })
    await afterCrash.close()

    const second = new SubmissionLedger({ path, maxRecords: 8, maxBytes: 65536 })
    await expect(second.get(stuck.record.idempotencyKey)).resolves.toMatchObject({ status: 'UNKNOWN' })
    await second.close()
  })

  it('enforces the record ceiling', async () => {
    const { ledger, path } = await openLedger({ maxRecords: 2 })
    await ledger.recordIntent(intent({ taskId: 'task-a' }), NOW)
    await ledger.recordIntent(intent({ taskId: 'task-b' }), NOW)
    const failure = await ledger.recordIntent(intent({ taskId: 'task-c' }), NOW).then(() => null, (error: unknown) => error)
    expect(failure).toBeInstanceOf(ComputeError)
    expect((failure as ComputeError).code).toBe('COMPUTE_TASK_STORE_CAPACITY')
    // The refused write left the committed file complete and unchanged.
    await expect(ledger.list()).resolves.toHaveLength(2)
    expect((await readLedgerFile(path)).records).toHaveLength(2)
    await ledger.close()
  })

  it('enforces the byte ceiling', async () => {
    const { ledger, path } = await openLedger({ maxRecords: 1000, maxBytes: 4096 })
    let failure: unknown
    let written = 0
    for (let index = 0; index < 100; index += 1) {
      try {
        await ledger.recordIntent(intent({ taskId: `task-${index}` }), NOW)
        written += 1
      } catch (error) { failure = error; break }
    }
    expect(failure).toBeInstanceOf(ComputeError)
    expect((failure as ComputeError).code).toBe('COMPUTE_TASK_STORE_CAPACITY')
    expect(written).toBeGreaterThan(0)
    expect(written).toBeLessThan(100)
    expect((await stat(path)).size).toBeLessThanOrEqual(4096)
    // Every committed byte is still a complete, parseable ledger.
    expect((await readLedgerFile(path)).records).toHaveLength(written)
    await ledger.close()
  })

  it('refuses an oversized or malformed ledger instead of loading it', async () => {
    const overCount = await openLedger({ maxRecords: 2 })
    await mkdir(overCount.dir, { recursive: true, mode: 0o700 })
    const three = Array.from({ length: 3 }, (_, index) => createSubmissionIntent(intent({ taskId: `task-${index}` }), NOW))
    await writeFile(overCount.path, JSON.stringify({ version: 1, records: three }), { mode: 0o600 })
    expect((await stat(overCount.path)).size).toBeLessThan(65536)
    await expect(overCount.ledger.list()).rejects.toThrow('COMPUTE_TASK_STORE_INVALID')
    await overCount.ledger.close()

    const overBytes = await openLedger({ maxBytes: 16 })
    await mkdir(overBytes.dir, { recursive: true, mode: 0o700 })
    await writeFile(overBytes.path, JSON.stringify({ version: 1, records: three }), { mode: 0o600 })
    await expect(overBytes.ledger.list()).rejects.toThrow('COMPUTE_TASK_STORE_INVALID')
    await overBytes.ledger.close()

    const malformed = await openLedger()
    await mkdir(malformed.dir, { recursive: true, mode: 0o700 })
    const record = createSubmissionIntent(intent(), NOW)
    const cases: [string, string][] = [
      ['not json', 'not json'],
      ['wrong version', JSON.stringify({ version: 2, records: [] })],
      ['missing records', JSON.stringify({ version: 1 })],
      ['short record', JSON.stringify({ version: 1, records: [{ idempotencyKey: 'x' }] })],
      ['non-canonical timestamp', JSON.stringify({ version: 1, records: [{ ...record, updatedAt: '2026-09-15 12:00:00' }] })],
      ['duplicate key', JSON.stringify({ version: 1, records: [record, record] })],
    ]
    for (const [label, content] of cases) {
      await writeFile(malformed.path, content, { mode: 0o600 })
      await expect(malformed.ledger.list(), label).rejects.toThrow('COMPUTE_TASK_STORE_INVALID')
    }
    await malformed.ledger.close()
  })

  it('writes 0600 in a 0700 directory, commits atomically and leaves no debris', async () => {
    const { ledger, path, dir } = await openLedger()
    await ledger.recordIntent(intent(), NOW)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    const committed = await readFile(path, 'utf8')

    // A pre-existing wider-permission target: `fs.writeFile` leaves the mode of
    // an existing inode alone, so this file really is 0644 before the next commit.
    await rm(path)
    await writeFile(path, committed, { mode: 0o644 })
    expect((await stat(path)).mode & 0o777).toBe(0o644)
    // ...and the rename-carried replacement inode narrows it back to 0600.
    await ledger.recordIntent(intent({ taskId: 'task-narrow' }), LATER)
    expect((await stat(path)).mode & 0o777).toBe(0o600)

    const entries = await readdir(dir)
    expect(entries.filter(entry => entry.endsWith('.tmp'))).toEqual([])
    expect(entries.filter(entry => entry.endsWith('.lock'))).toEqual([])
    expect(entries).toEqual(['submissions.json'])

    // The committed file is always complete valid JSON with both records.
    const parsed = await readLedgerFile(path)
    expect(parsed.version).toBe(1)
    expect(parsed.records.map(record => record.taskId).sort()).toEqual(['task-1', 'task-narrow'])
    await ledger.close()
  })

  it('serializes interleaved writers without losing a record or leaving a half file', async () => {
    const { ledger, path } = await openLedger({ maxRecords: 8, maxBytes: 65536 })
    const peer = new SubmissionLedger({ path, maxRecords: 8, maxBytes: 65536 })
    await ledger.recordIntent(intent({ taskId: 'task-seed' }), NOW)

    const results = await Promise.allSettled([
      ledger.recordIntent(intent({ taskId: 'task-a' }), LATER),
      peer.recordIntent(intent({ taskId: 'task-b' }), LATER),
      ledger.recordIntent(intent({ taskId: 'task-c' }), LATER),
      peer.recordIntent(intent({ taskId: 'task-d' }), LATER),
      ledger.list(),
      peer.list(),
    ])
    const rejected = results.filter(result => result.status === 'rejected')
    expect(rejected).toEqual([])
    const inserted = results.flatMap(result => result.status === 'fulfilled' && typeof result.value === 'object' && result.value !== null && 'inserted' in result.value
      ? [(result.value as { inserted: boolean }).inserted]
      : [])
    expect(inserted).toEqual([true, true, true, true])

    await expect(ledger.list()).resolves.toHaveLength(5)
    const parsed = await readLedgerFile(path)
    expect(parsed.records).toHaveLength(5)
    expect(new Set(parsed.records.map(record => record.idempotencyKey)).size).toBe(5)
    expect(parsed.records.map(record => record.taskId).sort()).toEqual(['task-a', 'task-b', 'task-c', 'task-d', 'task-seed'])
    await Promise.all([ledger.close(), peer.close()])
  })

  it('holds the record ceiling under concurrent writers without a lost update', async () => {
    const { ledger, path } = await openLedger({ maxRecords: 3, maxBytes: 65536 })
    const peer = new SubmissionLedger({ path, maxRecords: 3, maxBytes: 65536 })
    await ledger.recordIntent(intent({ taskId: 'task-seed' }), NOW)

    // Four writers compete for the two remaining slots. If the lock did not
    // serialize them, two could read the same state and both admit, leaving a
    // 4-record file over the stated ceiling.
    const results = await Promise.allSettled([
      ledger.recordIntent(intent({ taskId: 'task-a' }), LATER),
      peer.recordIntent(intent({ taskId: 'task-b' }), LATER),
      ledger.recordIntent(intent({ taskId: 'task-c' }), LATER),
      peer.recordIntent(intent({ taskId: 'task-d' }), LATER),
    ])
    const fulfilled = results.filter((result): result is PromiseFulfilledResult<{ record: SubmissionIntentRecord; inserted: boolean }> => result.status === 'fulfilled')
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    expect(fulfilled).toHaveLength(2)
    expect(fulfilled.map(result => result.value.inserted)).toEqual([true, true])
    expect(rejected).toHaveLength(2)
    for (const result of rejected) {
      expect((result.reason as ComputeError).code).toBe('COMPUTE_TASK_STORE_CAPACITY')
    }
    const parsed = await readLedgerFile(path)
    expect(parsed.records).toHaveLength(3)
    expect(new Set(parsed.records.map(record => record.idempotencyKey)).size).toBe(3)
    await expect(ledger.list()).resolves.toHaveLength(3)
    await Promise.all([ledger.close(), peer.close()])
  })

  it('rejects operations after close and rejects unusable limits', async () => {
    const { ledger } = await openLedger()
    await ledger.close()
    await expect(ledger.list()).rejects.toThrow('COMPUTE_CLOSED')
    await expect(ledger.recordIntent(intent(), NOW)).rejects.toThrow('COMPUTE_CLOSED')
    expect(() => new SubmissionLedger({ path: '/tmp/x.json', maxRecords: 0, maxBytes: 1024 })).toThrow('COMPUTE_TASK_STORE_CAPACITY')
    expect(() => new SubmissionLedger({ path: '/tmp/x.json', maxRecords: 1, maxBytes: 0 })).toThrow('COMPUTE_TASK_STORE_CAPACITY')
  })
})

describe('no automatic resend path (source audit)', () => {
  const moduleUrl = new URL('../src/submission-ledger.ts', import.meta.url)
  const clientUrl = new URL('../src/core-client.ts', import.meta.url)

  it('contains no network client, no submit call and no retry loop', async () => {
    const source = await readFile(moduleUrl, 'utf8')
    expect(source.length).toBeGreaterThan(1000)
    const forbidden = [
      /\bfetch\s*\(/u, /XMLHttpRequest/u, /node:https?/u, /net\.connect/u,
      /requestJson/u, /method:\s*['"]POST['"]/u, /\baxios\b/u, /undici/u,
      /\bresend\s*\(/u, /\bretry\s*\(/u, /setTimeout/u, /setInterval/u,
    ]
    for (const pattern of forbidden) expect(source).not.toMatch(pattern)

    // Exactly one write path — the atomic replacement — and a read-only open.
    expect(source.match(/writeFileAtomic\(/gu) ?? []).toHaveLength(1)
    expect(source).toContain("open(this.config.path, 'r')")
    expect(source).not.toContain("'w'")
    expect(source).not.toMatch(/writeFile\s*\(/u)
  })

  it('consults the gate on every path that could reach a future submit', async () => {
    const source = await readFile(moduleUrl, 'utf8')
    // The gate is defined once and only in terms of recorded facts.
    expect(source.match(/export function canResubmit/gu) ?? []).toHaveLength(1)
    expect(source).toContain("record.status === 'REJECTED' && record.authority === 'reconciled'")
    // The only export whose name suggests sending returns the *safety verdict*,
    // so a future submit call cannot be written without reading this boolean.
    expect(source).not.toMatch(/export (async )?function (submit|send|post|dispatch)\w*/u)
  })

  it('confirms the core client POSTs only the developer-task create path', async () => {
    const client = await readFile(clientUrl, 'utf8')
    // 动词不再由"有没有 body"隐含决定（DELETE 不带 body），所以审计换成更硬的两条：
    // 1) 默认推断仍只产 GET/POST，显式动词是一个三值白名单；
    // 2) 唯一的 POST 调用点仍是 developer-task 创建路径，没出现裸 POST `/api/v8/workloads`。
    expect(client).toContain("const verb = method ?? (body !== undefined ? 'POST' : 'GET')")
    expect(client).toMatch(/method\?: 'GET' \| 'POST' \| 'DELETE'/u)
    expect(client).toContain('DEVELOPER_TASK_CREATE_PATH')
    expect(client).toContain('request(DEVELOPER_TASK_CREATE_PATH')
    expect(client).not.toContain("'/api/v8/workloads'")
    // 取消走 DELETE，而不是把写动作塞进 POST。
    expect(client).toContain("undefined, 'DELETE'")
  })
})
