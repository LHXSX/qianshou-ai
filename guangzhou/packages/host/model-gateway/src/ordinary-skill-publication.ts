/** Ordinary SKILL.md publication reuses Guangzhou's account and staff-review carrier, with no funds ledger. */
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto'
import { constants, closeSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Principal } from './admin-routes.ts'
import { verifyOrdinarySkillPackage } from './ordinary-skill-package.ts'

export const ORDINARY_SKILL_PATH = '/qianshou-market/skills'
export const ORDINARY_SKILL_ADMIN_PATH = '/api/qianshou/ai/skills/submissions'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA = /^[0-9a-f]{64}$/u
const REVIEW_FIELDS = ['schema', 'purpose', 'submissionId', 'accountId', 'skillId', 'version', 'title', 'summary', 'price_yuan', 'currency',
  'packageSha256', 'packageBytes', 'unpackedTreeSha256', 'skillMdSha256', 'skillMdPath', 'manual_test', 'decision', 'note', 'reviewId',
  'operatorId', 'operatorAccountId', 'reviewedAt'] as const

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SKILL_METADATA_INVALID')
  return value as Record<string, unknown>
}
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const r = row(value)
  if (Object.keys(r).length !== fields.length || Object.keys(r).some(k => !fields.includes(k))) throw new Error('SKILL_METADATA_INVALID')
  return r
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('SKILL_METADATA_INVALID')
  return value
}
function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const r = row(value)
  return `{${Object.keys(r).sort().map(k => `${JSON.stringify(k)}:${canonical(r[k])}`).join(',')}}`
}
export function ordinarySkillReviewBytes(payload: Record<string, unknown>): Buffer {
  return Buffer.from(canonical(exact(payload, REVIEW_FIELDS)))
}
const json = (data: unknown, status = 200): Response => Response.json(data, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
type Stored = { submission_id: string; account_id: string; request_id: string; request_sha: string; metadata: string; archive: Uint8Array }

export interface OrdinarySkillOptions {
  readonly storePath?: string
  readonly authenticate: (request: Request) => Promise<Principal | null>
  readonly operatorKeys?: Readonly<Record<string, string>>
  readonly operatorAccounts?: Readonly<Record<string, string>>
  readonly officialAccounts?: readonly string[]
  readonly now?: () => number
}

/** No package is run or approved by this service. A mapped independent staff account signs the tested bytes and price. */
export function createOrdinarySkillPublication(options: OrdinarySkillOptions): {
  handler: (request: Request) => Promise<Response>; catalog: (cursor?: string) => Promise<Response>; close: () => void
} {
  const now = options.now ?? Date.now
  let db: DatabaseSync | undefined
  if (options.storePath !== undefined) {
    if (!isAbsolute(options.storePath)) throw new Error('SKILL_STORE_PATH_INVALID')
    const dir = dirname(options.storePath); mkdirSync(dir, { recursive: true, mode: 0o700 })
    const parent = lstatSync(dir); const uid = process.getuid?.()
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0 || uid !== undefined && parent.uid !== uid) throw new Error('SKILL_STORE_DIRECTORY_INVALID')
    const fd = openSync(options.storePath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); closeSync(fd)
    const file = lstatSync(options.storePath)
    if (!file.isFile() || (file.mode & 0o077) !== 0 || uid !== undefined && file.uid !== uid) throw new Error('SKILL_STORE_FILE_INVALID')
    db = new DatabaseSync(options.storePath)
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS ordinary_skill_submissions(submission_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, request_id TEXT NOT NULL, request_sha TEXT NOT NULL, metadata TEXT NOT NULL, archive BLOB NOT NULL, UNIQUE(account_id,request_id)); CREATE TABLE IF NOT EXISTS ordinary_skill_reviews(submission_id TEXT PRIMARY KEY, decision TEXT NOT NULL, skill_id TEXT NOT NULL, version TEXT NOT NULL, receipt TEXT NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS ordinary_skill_published_version ON ordinary_skill_reviews(skill_id,version) WHERE decision='publish';`)
  }
  const lookup = (id: unknown): Stored => {
    if (typeof id !== 'string' || !UUID.test(id)) throw new Error('SKILL_METADATA_INVALID')
    const r = db!.prepare('SELECT * FROM ordinary_skill_submissions WHERE submission_id=?').get(id) as Stored | undefined
    if (!r) throw new Error('SKILL_SUBMISSION_NOT_FOUND')
    return r
  }
  const checkReview = (value: unknown, stored: Stored): Record<string, unknown> => {
    const envelope = exact(value, ['key_id', 'payload', 'signature']); const p = exact(envelope['payload'], REVIEW_FIELDS)
    const meta = JSON.parse(stored.metadata) as Record<string, unknown>
    if (p['accountId'] !== stored.account_id) throw new Error('SKILL_REVIEW_BINDING_INVALID')
    for (const key of ['submissionId', 'accountId', 'skillId', 'version', 'title', 'summary', 'price_yuan', 'currency', 'packageSha256', 'packageBytes', 'unpackedTreeSha256', 'skillMdSha256', 'skillMdPath']) {
      if (p[key] !== meta[key]) throw new Error('SKILL_REVIEW_BINDING_INVALID')
    }
    const manual = exact(p['manual_test'], ['tested', 'test_receipt_sha256'])
    if (p['schema'] !== 'qianshou.ordinary-skill-review.v1' || p['purpose'] !== 'qianshou:ordinary-skill-review'
      || !['publish', 'reject'].includes(String(p['decision'])) || p['operatorId'] !== envelope['key_id'] || p['operatorAccountId'] === stored.account_id
      || typeof p['reviewId'] !== 'string' || !UUID.test(p['reviewId']) || !Number.isSafeInteger(p['reviewedAt']) || Number(p['reviewedAt']) < 1
      || typeof manual['tested'] !== 'boolean' || manual['test_receipt_sha256'] !== null && (typeof manual['test_receipt_sha256'] !== 'string' || !SHA.test(manual['test_receipt_sha256']))
      || p['decision'] === 'publish' && (manual['tested'] !== true || manual['test_receipt_sha256'] === null)) throw new Error('SKILL_REVIEW_INVALID')
    text(p['note'], 500); const keyId = text(envelope['key_id'], 100); text(p['operatorAccountId'], 128)
    const pem = Object.hasOwn(options.operatorKeys ?? {}, keyId) ? options.operatorKeys?.[keyId] : undefined
    if (!pem || typeof envelope['signature'] !== 'string') throw new Error('SKILL_REVIEW_INVALID')
    const signature = Buffer.from(envelope['signature'], 'base64')
    if (signature.length !== 64 || signature.toString('base64') !== envelope['signature']) throw new Error('SKILL_REVIEW_INVALID')
    const key = createPublicKey({ key: Buffer.from(pem, 'base64'), format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== 'ed25519' || !verify(null, ordinarySkillReviewBytes(p), key, signature)) throw new Error('SKILL_REVIEW_INVALID')
    return p
  }
  const projected = (stored: Stored): Record<string, unknown> => {
    const meta = { ...JSON.parse(stored.metadata) as Record<string, unknown>, requestId: stored.request_id,
      publisher_kind: (options.officialAccounts ?? []).includes(stored.account_id) ? 'official' : 'user' }
    const saved = db!.prepare('SELECT receipt FROM ordinary_skill_reviews WHERE submission_id=?').get(stored.submission_id) as { receipt: string } | undefined
    if (!saved) return { ...meta, review: { status: 'pending' }, purchase_available: false, installable: false }
    const receipt: unknown = JSON.parse(saved.receipt); const p = checkReview(receipt, stored)
    return { ...meta, review: { status: p['decision'] === 'publish' ? 'published' : 'rejected', receipt }, purchase_available: false, installable: false }
  }
  const cursorOf = (value: unknown): string => {
    if (value === undefined) return ''
    if (typeof value !== 'string' || !UUID.test(value)) throw new Error('SKILL_METADATA_INVALID')
    return value
  }
  const page = (rows: Stored[]): { submissions: Record<string, unknown>[]; nextCursor: string | null } => ({
    submissions: rows.slice(0, 20).map(projected), nextCursor: rows.length > 20 ? rows[19]!.submission_id : null,
  })
  const catalog = async (cursor?: string): Promise<Response> => {
    if (!db) return json({ ok: false, code: 'ORDINARY_SKILL_UNAVAILABLE' }, 503)
    try {
      const rows = db.prepare("SELECT s.* FROM ordinary_skill_submissions s JOIN ordinary_skill_reviews r ON r.submission_id=s.submission_id WHERE r.decision='publish' AND s.submission_id>? ORDER BY s.submission_id LIMIT 21").all(cursorOf(cursor)) as unknown as Stored[]
      const p = page(rows)
      return json({ ok: true, kind: 'ordinary_skill', purchase_available: false, listings: p.submissions, nextCursor: p.nextCursor })
    } catch { return json({ ok: false, code: 'ORDINARY_SKILL_UNAVAILABLE' }, 503) }
  }
  const handler = async (request: Request): Promise<Response> => {
    if (!db) return json({ ok: false, code: 'ORDINARY_SKILL_UNAVAILABLE' }, 503)
    if (request.method !== 'POST') return json({ ok: false, code: 'METHOD_NOT_ALLOWED' }, 405)
    let principal: Principal | null
    try { principal = await options.authenticate(request) } catch { return json({ ok: false, code: 'ACCOUNT_VERIFICATION_UNAVAILABLE' }, 503) }
    if (!principal) return json({ ok: false, code: 'LOGIN_REQUIRED' }, 401)
    let input: Record<string, unknown>
    try {
      const raw = await request.arrayBuffer(); if (raw.byteLength > 3 * 1024 * 1024) return json({ ok: false, code: 'PAYLOAD_TOO_LARGE' }, 413)
      input = row(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)))
    } catch { return json({ ok: false, code: 'BAD_REQUEST' }, 400) }
    try {
      if (input['action'] === 'submit') {
        exact(input, ['action', 'requestId', 'skillId', 'version', 'title', 'summary', 'price_yuan', 'archiveBase64'])
        const requestId = text(input['requestId'], 36); if (!UUID.test(requestId)) throw new Error('SKILL_METADATA_INVALID')
        const skillId = text(input['skillId'], 100); const version = text(input['version'], 80)
        if (!/^[a-z][a-z0-9_.-]{2,99}$/u.test(skillId) || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u.test(version)
          || typeof input['price_yuan'] !== 'string' || !/^(?:0|[1-9][0-9]{0,7})(?:\.[0-9]{1,2})?$/u.test(input['price_yuan'])) throw new Error('SKILL_METADATA_INVALID')
        const archiveText = text(input['archiveBase64'], Math.ceil(2 * 1024 * 1024 / 3) * 4)
        const archive = Buffer.from(archiveText, 'base64'); if (archive.toString('base64') !== archiveText) throw new Error('SKILL_METADATA_INVALID')
        const verified = verifyOrdinarySkillPackage(archive)
        const terms = { kind: 'ordinary_skill', accountId: principal.accountId, skillId, version, title: text(input['title'], 80), summary: text(input['summary'], 400),
          price_yuan: input['price_yuan'], currency: 'CNY', ...verified }
        const digest = createHash('sha256').update(canonical(terms)).digest('hex')
        const prior = db.prepare('SELECT * FROM ordinary_skill_submissions WHERE account_id=? AND request_id=?').get(principal.accountId, requestId) as Stored | undefined
        if (prior) {
          if (prior.request_sha !== digest) return json({ ok: false, code: 'SKILL_SUBMISSION_IDEMPOTENCY_CONFLICT' }, 409)
          return json({ ok: true, duplicate: true, submission: projected(prior) })
        }
        const count = db.prepare('SELECT COUNT(*) AS count FROM ordinary_skill_submissions WHERE account_id=?').get(principal.accountId) as { count: number }
        const total = db.prepare('SELECT COALESCE(SUM(LENGTH(archive)),0) AS bytes FROM ordinary_skill_submissions').get() as { bytes: number }
        if (count.count >= 1000 || total.bytes + archive.length > 16 * 1024 ** 3) return json({ ok: false, code: 'SKILL_SUBMISSION_LIMIT' }, 429)
        const submissionId = randomUUID(); const meta = { submissionId, ...terms, submittedAt: now() }
        db.prepare('INSERT INTO ordinary_skill_submissions VALUES(?,?,?,?,?,?)').run(submissionId, principal.accountId, requestId, digest, JSON.stringify(meta), archive)
        return json({ ok: true, duplicate: false, submission: projected(lookup(submissionId)) })
      }
      if (input['action'] === 'mine') {
        if (input['requestId'] !== undefined) {
          exact(input, ['action', 'requestId']); const requestId = cursorOf(input['requestId'])
          const stored = db.prepare('SELECT * FROM ordinary_skill_submissions WHERE account_id=? AND request_id=?').get(principal.accountId, requestId) as Stored | undefined
          return json({ ok: true, submissions: stored ? [projected(stored)] : [], nextCursor: null })
        }
        exact(input, input['cursor'] === undefined ? ['action'] : ['action', 'cursor'])
        const rows = db.prepare('SELECT * FROM ordinary_skill_submissions WHERE account_id=? AND submission_id>? ORDER BY submission_id LIMIT 21').all(principal.accountId, cursorOf(input['cursor'])) as unknown as Stored[]
        return json({ ok: true, ...page(rows) })
      }
      if (input['action'] === 'catalog') { exact(input, input['cursor'] === undefined ? ['action'] : ['action', 'cursor']); return await catalog(cursorOf(input['cursor']) || undefined) }
      // Staff operations are independent of package authors and never exposed
      // through the public Bearer action allowlist.
      if (!principal.isAdmin || !Object.values(options.operatorAccounts ?? {}).includes(principal.accountId)) return json({ ok: false, code: 'STAFF_REVIEW_REQUIRED' }, 403)
      if (input['action'] === 'pending') {
        exact(input, input['cursor'] === undefined ? ['action'] : ['action', 'cursor']); const rows = db.prepare('SELECT s.* FROM ordinary_skill_submissions s LEFT JOIN ordinary_skill_reviews r ON r.submission_id=s.submission_id WHERE r.submission_id IS NULL AND s.submission_id>? ORDER BY s.submission_id LIMIT 21').all(cursorOf(input['cursor'])) as unknown as Stored[]
        return json({ ok: true, ...page(rows) })
      }
      if (input['action'] === 'pull') {
        exact(input, ['action', 'submissionId']); const stored = lookup(input['submissionId']); const checked = verifyOrdinarySkillPackage(Buffer.from(stored.archive)); const meta = JSON.parse(stored.metadata) as Record<string, unknown>
        if (checked.packageSha256 !== meta['packageSha256'] || checked.unpackedTreeSha256 !== meta['unpackedTreeSha256']) throw new Error('SKILL_SUBMISSION_CHANGED')
        return json({ ok: true, submission: projected(stored), archiveBase64: Buffer.from(stored.archive).toString('base64'), packageSha256: checked.packageSha256 })
      }
      if (input['action'] === 'review') {
        exact(input, ['action', 'submissionId', 'review']); const stored = lookup(input['submissionId']); const p = checkReview(input['review'], stored)
        if (p['operatorAccountId'] !== principal.accountId || options.operatorAccounts?.[String(p['operatorId'])] !== principal.accountId || stored.account_id === principal.accountId) return json({ ok: false, code: 'INDEPENDENT_REVIEW_REQUIRED' }, 403)
        const checked = verifyOrdinarySkillPackage(Buffer.from(stored.archive)); const meta = JSON.parse(stored.metadata) as Record<string, unknown>
        if (checked.packageSha256 !== meta['packageSha256'] || checked.unpackedTreeSha256 !== meta['unpackedTreeSha256']) throw new Error('SKILL_SUBMISSION_CHANGED')
        const receipt = canonical(input['review']); const old = db.prepare('SELECT receipt FROM ordinary_skill_reviews WHERE submission_id=?').get(stored.submission_id) as { receipt: string } | undefined
        if (old) {
          if (old.receipt !== receipt) return json({ ok: false, code: 'SKILL_REVIEW_CONFLICT' }, 409)
          return json({ ok: true, duplicate: true, submission: projected(stored) })
        }
        if (Math.abs(now() - Number(p['reviewedAt'])) > 5 * 60 * 1000) throw new Error('SKILL_REVIEW_INVALID')
        if (p['decision'] === 'publish' && db.prepare("SELECT submission_id FROM ordinary_skill_reviews WHERE skill_id=? AND version=? AND decision='publish'").get(p['skillId'] as string, p['version'] as string)) return json({ ok: false, code: 'SKILL_VERSION_EXISTS' }, 409)
        db.prepare('INSERT INTO ordinary_skill_reviews VALUES(?,?,?,?,?)').run(stored.submission_id, p['decision'] as string, p['skillId'] as string, p['version'] as string, receipt)
        return json({ ok: true, duplicate: false, submission: projected(stored) })
      }
      return json({ ok: false, code: 'BAD_REQUEST' }, 400)
    } catch (error) {
      const code = error instanceof Error ? error.message : 'ORDINARY_SKILL_UNAVAILABLE'
      const expected = new Set(['SKILL_METADATA_INVALID', 'PLUGIN_SEED_PACKAGE_INVALID', 'SKILL_REVIEW_INVALID', 'SKILL_REVIEW_BINDING_INVALID'])
      return json({ ok: false, code: expected.has(code) || code === 'SKILL_SUBMISSION_NOT_FOUND' ? code : 'ORDINARY_SKILL_UNAVAILABLE' }, code === 'SKILL_SUBMISSION_NOT_FOUND' ? 404 : expected.has(code) ? 400 : 503)
    }
  }
  return { handler, catalog, close: () => db?.close() }
}
