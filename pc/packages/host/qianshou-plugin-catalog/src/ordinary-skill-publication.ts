/** Ordinary skill snapshots use one actor-owned submission UUID and independent manual review. */
import { createHash, createPublicKey, verify } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { captureOrdinarySkill } from './ordinary-skill-archive.ts'
import { canonicalOrderJson } from './order-json-canonical.ts'
import { marketApiUrl } from './market.ts'
import type { OrdinarySkillChoice, OrdinarySkillSubmit, OrdinarySkillReceipt, OrdinarySkillIntent,
  OrdinarySkillPublicationResult, OrdinarySkillChoicesResult, OrdinarySkillCatalogResult, OrdinarySkillMineResult } from './types.ts'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const HASH = /^[a-f0-9]{64}$/u
const PRICE = /^(?:0|[1-9][0-9]{0,7})(?:\.[0-9]{1,2})?$/u
const REVIEW_FIELDS = ['schema', 'purpose', 'submissionId', 'accountId', 'skillId', 'version', 'title', 'summary', 'price_yuan', 'currency',
  'packageSha256', 'packageBytes', 'unpackedTreeSha256', 'skillMdSha256', 'skillMdPath', 'manual_test', 'decision', 'note', 'reviewId',
  'operatorId', 'operatorAccountId', 'reviewedAt']
function fail(code = 'ORDINARY_SKILL_RESPONSE_INVALID'): never { throw new Error(code) }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail()
  return value as Record<string, unknown>
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.trim() !== value
    || !value.isWellFormed() || /[\u0000-\u001f\u007f]/u.test(value)) fail()
  return value
}
function hash(value: unknown): string { const s = text(value, 64); if (!HASH.test(s)) fail(); return s }
function id(value: unknown): string { const s = text(value, 36); if (!UUID.test(s)) fail(); return s }
function exact(row: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(row).sort().join(',') !== [...keys].sort().join(',')) fail()
}

interface Account { snapshot(): Promise<{ phase: string; account: { id: string } | null }>; ensureAccessToken(): Promise<string | null> }
interface Inventory {
  skills: { name: string
    source: string
    path: string
    displayName?: string
    description?: string }[]
}

/** Parse bytes and verify the staff signature before calling a row published.
 * @param value - Guangzhou wire submission.
 * @param keys - Operator-owned Ed25519 SPKI keys, independent of package authors.
 * @returns Public receipt without archive, local paths or account tokens.
 */
export function parseOrdinarySkillReceipt(value: unknown, keys: Readonly<Record<string, string>>): OrdinarySkillReceipt {
  const r = object(value)
  const accountId = text(r.accountId, 128); const packageSha256 = hash(r.packageSha256)
  const skillMdSha256 = hash(r.skillMdSha256); const unpackedTreeSha256 = hash(r.unpackedTreeSha256)
  const priceYuan = text(r.price_yuan, 32); if (!PRICE.test(priceYuan)) fail()
  const skillId = text(r.skillId, 100); const version = text(r.version, 80)
  if (r.kind !== 'ordinary_skill' || !/^[a-z][a-z0-9_.-]{2,99}$/u.test(skillId)
    || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(version) || r.currency !== 'CNY'
    || !Number.isSafeInteger(r.packageBytes) || Number(r.packageBytes) < 22 || Number(r.packageBytes) > 2 * 1024 * 1024
    || !Number.isSafeInteger(r.submittedAt) || Number(r.submittedAt) < 1 || r.purchase_available !== false || r.installable !== false
    || !['official', 'user'].includes(String(r.publisher_kind)) || !Array.isArray(r.files) || r.files.length < 1 || r.files.length > 128) fail()
  const files = r.files.map((value) => {
    const f = object(value); const path = text(f.path, 240)
    if (path.startsWith('/') || /[\\:]/u.test(path) || path.split('/').some(p => p === '.' || p === '..' || p === '')
      || !Number.isSafeInteger(f.sizeBytes) || Number(f.sizeBytes) < 0 || Number(f.sizeBytes) > 512 * 1024) fail()
    return { path, sha256: hash(f.sha256) }
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  if (new Set(files.map(f => f.path.toLowerCase())).size !== files.length
    || createHash('sha256').update(JSON.stringify(files.map(f => [f.path, f.sha256]))).digest('hex') !== unpackedTreeSha256
    || !files.some(f => f.path === r.skillMdPath && f.sha256 === skillMdSha256)) fail()
  const review = object(r.review); const status = review.status
  let reviewed: OrdinarySkillReceipt['review'] = { status: 'pending', reviewId: null, operatorId: null,
    reviewedAt: null, note: null, testReceiptSha256: null }
  if (status === 'pending') exact(review, ['status'])
  else {
    if (status !== 'published' && status !== 'rejected') fail()
    exact(review, ['status', 'receipt'])
    const envelope = object(review.receipt); exact(envelope, ['key_id', 'payload', 'signature'])
    const p = object(envelope.payload); exact(p, REVIEW_FIELDS)
    for (const name of ['submissionId', 'accountId', 'skillId', 'version', 'title', 'summary', 'price_yuan', 'currency',
      'packageSha256', 'packageBytes', 'unpackedTreeSha256', 'skillMdSha256', 'skillMdPath']) if (p[name] !== r[name]) fail()
    const manual = object(p.manual_test); exact(manual, ['tested', 'test_receipt_sha256'])
    const keyId = text(envelope.key_id, 100); const publicKey = Object.hasOwn(keys, keyId) ? keys[keyId] : undefined
    if (p.schema !== 'qianshou.ordinary-skill-review.v1' || p.purpose !== 'qianshou:ordinary-skill-review'
      || p.operatorId !== keyId || p.operatorAccountId === accountId || typeof manual.tested !== 'boolean'
      || p.decision !== (status === 'published' ? 'publish' : 'reject') || !Number.isSafeInteger(p.reviewedAt)
      || Number(p.reviewedAt) < 1 || publicKey === undefined
      || status === 'published' && (!manual.tested || manual.test_receipt_sha256 === null)) fail()
    text(p.operatorAccountId, 128)
    const signature = Buffer.from(text(envelope.signature, 128), 'base64')
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' })
    if (signature.length !== 64 || signature.toString('base64') !== envelope.signature || key.asymmetricKeyType !== 'ed25519'
      || !verify(null, Buffer.from(canonicalOrderJson(p)), key, signature)) fail()
    reviewed = { status, reviewId: id(p.reviewId), operatorId: keyId, reviewedAt: Number(p.reviewedAt),
      note: text(p.note, 500), testReceiptSha256: manual.test_receipt_sha256 === null ? null : hash(manual.test_receipt_sha256) }
  }
  return { requestId: id(r.requestId), submissionId: id(r.submissionId), accountId, skillId, version,
    title: text(r.title, 80), summary: text(r.summary, 400), priceYuan, currency: 'CNY', packageSha256,
    packageBytes: Number(r.packageBytes), unpackedTreeSha256, skillMdSha256, submittedAt: Number(r.submittedAt),
    publisherKind: r.publisher_kind as 'official' | 'user', review: reviewed, purchaseAvailable: false, installable: false }
}

/** Own immutable intents, bounded network requests and explicit submission/recovery operations. */
export class OrdinarySkillPublications {
  private readonly lifetime = new AbortController()
  private readonly pending = new Map<string, { input: string; done: Promise<OrdinarySkillPublicationResult> }>()
  private readonly origin: URL | null
  constructor(private readonly home: string, origin: string | null, private readonly timeoutMs: number,
    private readonly keys: Readonly<Record<string, string>>, private readonly account: () => Account | null,
    private readonly inventory: () => Promise<Inventory>) { this.origin = origin === null ? null : marketApiUrl(origin) }
  private path() { return join(this.home, 'qianshou', 'ordinary-skill-publications.json') }
  private assertOpen(): void { if (this.lifetime.signal.aborted) fail('ORDINARY_SKILL_UNAVAILABLE') }
  private async owner(token = false) {
    this.assertOpen()
    const account = this.account(); if (account === null) fail('ORDINARY_SKILL_SIGN_IN_REQUIRED')
    const current = await account.snapshot()
    if (current.phase !== 'authenticated' || current.account === null) fail('ORDINARY_SKILL_SIGN_IN_REQUIRED')
    const accountId = text(current.account.id, 128)
    const bearer = token ? await account.ensureAccessToken() : null
    if (token && (bearer === null || !/^[\x21-\x7e]{16,4096}$/u.test(bearer))) fail('ORDINARY_SKILL_SIGN_IN_REQUIRED')
    const after = await account.snapshot()
    this.assertOpen()
    if (after.phase !== 'authenticated' || after.account?.id !== accountId) fail('ORDINARY_SKILL_ACCOUNT_CHANGED')
    return { accountId, bearer }
  }
  private async assertOwner(accountId: string) {
    if ((await this.owner()).accountId !== accountId) fail('ORDINARY_SKILL_ACCOUNT_CHANGED')
  }
  private async rows(): Promise<OrdinarySkillIntent[]> {
    let handle
    try { handle = await open(this.path(), constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e }
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) fail('ORDINARY_SKILL_STATE_INVALID')
      const value = object(JSON.parse(await handle.readFile('utf8')))
      if (value.version !== 1 || !Array.isArray(value.intents) || value.intents.length > 1000) fail('ORDINARY_SKILL_STATE_INVALID')
      const intents = value.intents.map((v) => {
        const r = object(v); this.input(r)
        text(r.accountId, 128); text(r.skillId, 100); text(r.version, 80)
        hash(r.packageSha256); hash(r.unpackedTreeSha256); hash(r.skillMdSha256)
        if (!Number.isSafeInteger(r.packageBytes) || Number(r.packageBytes) < 22 || Number(r.packageBytes) > 2 * 1024 * 1024) fail()
        exact(r, ['requestId', 'source', 'name', 'title', 'summary', 'priceYuan', 'accountId', 'skillId', 'version',
          'packageSha256', 'packageBytes', 'unpackedTreeSha256', 'skillMdSha256'])
        return r as unknown as OrdinarySkillIntent
      })
      if (new Set(intents.map(r => `${r.accountId}:${r.requestId}`)).size !== intents.length) fail('ORDINARY_SKILL_STATE_INVALID')
      return intents
    } finally { await handle.close() }
  }
  private input(value: unknown): OrdinarySkillSubmit {
    const r = object(value); const requestId = id(r.requestId)
    if (!['user-dsh', 'user-agents'].includes(String(r.source)) || typeof r.priceYuan !== 'string' || !PRICE.test(r.priceYuan)) fail('ORDINARY_SKILL_TERMS_INVALID')
    return { requestId, source: r.source as OrdinarySkillChoice['source'], name: text(r.name, 128),
      title: text(r.title, 80), summary: text(r.summary, 400), priceYuan: r.priceYuan }
  }
  private async reserve(intent: OrdinarySkillIntent): Promise<void> {
    await mkdir(dirname(this.path()), { recursive: true, mode: 0o700 })
    const parent = await lstat(dirname(this.path())); if (!parent.isDirectory() || parent.isSymbolicLink()) fail()
    await withFileLock(this.path(), async () => {
      const rows = await this.rows()
      if (rows.some(r => r.accountId === intent.accountId && r.requestId === intent.requestId)) fail('ORDINARY_SKILL_REQUEST_CONFLICT')
      if (rows.length >= 1000) fail('ORDINARY_SKILL_STATE_FULL')
      const raw = JSON.stringify({ version: 1, intents: [...rows, intent] })
      if (Buffer.byteLength(raw) > 4 * 1024 * 1024) fail('ORDINARY_SKILL_STATE_FULL')
      await writeFileAtomic(this.path(), raw, { mode: 0o600, dirMode: 0o700 })
    })
  }
  private async request(body?: Record<string, unknown>, bearer?: string | null): Promise<Record<string, unknown>> {
    if (this.origin === null || this.lifetime.signal.aborted) fail('ORDINARY_SKILL_UNAVAILABLE')
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.timeoutMs)])
    const response = await fetch(new URL('/qianshou-market/skills', this.origin), { method: body === undefined ? 'GET' : 'POST',
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(bearer == null ? {} : { authorization: `Bearer ${bearer}` }) }, redirect: 'error', credentials: 'omit', signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    if (!response.ok || response.body === null) fail('ORDINARY_SKILL_UNAVAILABLE')
    const reader = response.body.getReader(); const parts: Uint8Array[] = []; let size = 0
    try { for (;;) { const part = await reader.read(); if (part.done) break
      size += part.value.length; if (size > 4 * 1024 * 1024) fail(); parts.push(part.value) } }
    finally { await reader.cancel().catch(() => undefined) }
    const r = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))))
    if (r.ok !== true) fail('ORDINARY_SKILL_UNAVAILABLE')
    return r
  }
  /** Read user-root skill names without capturing or executing their files. */
  async choices(): Promise<OrdinarySkillChoicesResult> {
    this.assertOpen()
    const inventory = await this.inventory()
    this.assertOpen()
    return { skills: inventory.skills.filter(s => s.source === 'user-dsh' || s.source === 'user-agents')
      .map(s => ({ source: s.source as OrdinarySkillChoice['source'], name: s.name,
        displayName: s.displayName ?? s.name, description: s.description ?? '' })) }
  }
  /** Read reviewed ordinary listings; metadata cannot enable purchase or installation. */
  async catalog(): Promise<OrdinarySkillCatalogResult> {
    const listings: OrdinarySkillReceipt[] = []; let cursor: string | null = null
    const seen = new Set<string>()
    do {
      const owner = cursor === null ? null : await this.owner(true)
      const r: Record<string, unknown> = cursor === null ? await this.request() : await this.request({ action: 'catalog', cursor }, owner?.bearer)
      if (owner !== null) await this.assertOwner(owner.accountId)
      if (r.kind !== 'ordinary_skill' || r.purchase_available !== false || !Array.isArray(r.listings) || r.listings.length > 20) fail()
      for (const row of r.listings) {
        const receipt = parseOrdinarySkillReceipt(row, this.keys)
        if (receipt.review.status !== 'published' || seen.has(receipt.submissionId)) fail()
        seen.add(receipt.submissionId); listings.push(receipt)
      }
      if (listings.length > 1000 || r.nextCursor !== null && (typeof r.nextCursor !== 'string' || !UUID.test(r.nextCursor)
        || seen.has(`cursor:${r.nextCursor}`))) fail()
      cursor = r.nextCursor; if (cursor !== null) seen.add(`cursor:${cursor}`)
    } while (cursor !== null)
    return { listings }
  }
  private bind(receipt: OrdinarySkillReceipt, intent: OrdinarySkillIntent): void {
    for (const key of ['requestId', 'accountId', 'skillId', 'version', 'title', 'summary', 'priceYuan',
      'packageSha256', 'packageBytes', 'unpackedTreeSha256', 'skillMdSha256'] as const) if (receipt[key] !== intent[key]) fail()
  }
  private async reconcile(intent: OrdinarySkillIntent): Promise<OrdinarySkillPublicationResult> {
    const owner = await this.owner(true); if (owner.accountId !== intent.accountId) fail('ORDINARY_SKILL_ACCOUNT_CHANGED')
    const r = await this.request({ action: 'mine', requestId: intent.requestId }, owner.bearer)
    await this.assertOwner(intent.accountId)
    if (!Array.isArray(r.submissions) || r.submissions.length > 1 || r.nextCursor !== null) fail()
    if (r.submissions.length === 0) return { intent, submission: null, state: 'unknown' }
    const submission = parseOrdinarySkillReceipt(r.submissions[0], this.keys); this.bind(submission, intent)
    return { intent, submission, state: 'submitted' }
  }
  /** Query original saved requests only; a missing server row never causes another submit. */
  async mine(): Promise<OrdinarySkillMineResult> {
    const { accountId } = await this.owner()
    const intents = (await this.rows()).filter(r => r.accountId === accountId)
    const submissions: OrdinarySkillPublicationResult[] = []
    for (const intent of intents) {
      try { submissions.push(await this.reconcile(intent)) }
      catch { await this.assertOwner(accountId); submissions.push({ intent, submission: null, state: 'unknown' }) }
    }
    await this.assertOwner(accountId)
    return { accountId, submissions }
  }
  /** Capture and submit once after the user approves the exact title, summary and price.
   * @param value - Local inventory identity, explicit terms and stable request UUID.
   * @returns Original request with its receipt, or an uncertain state requiring a read.
   */
  async submit(value: OrdinarySkillSubmit): Promise<OrdinarySkillPublicationResult> {
    const input = this.input(value); exact(object(value), ['requestId', 'source', 'name', 'title', 'summary', 'priceYuan'])
    if (this.origin === null) fail('ORDINARY_SKILL_UNAVAILABLE')
    const owner = await this.owner(true); const key = `${owner.accountId}:${input.requestId}`
    const signature = canonicalOrderJson(input); const pending = this.pending.get(key)
    if (pending !== undefined) { if (pending.input !== signature) fail('ORDINARY_SKILL_REQUEST_CONFLICT'); return pending.done }
    const done = Promise.resolve().then(async () => {
      const existing = (await this.rows()).find(r => r.accountId === owner.accountId && r.requestId === input.requestId)
      if (existing !== undefined) {
        if (canonicalOrderJson(this.input(existing)) !== signature) fail('ORDINARY_SKILL_REQUEST_CONFLICT')
        return this.reconcile(existing)
      }
      const skill = (await this.inventory()).skills.find(s => s.source === input.source && s.name === input.name)
      if (skill === undefined) fail('ORDINARY_SKILL_LOCAL_UNAVAILABLE')
      const archive = await captureOrdinarySkill(skill.path)
      const intent: OrdinarySkillIntent = { ...input, accountId: owner.accountId,
        skillId: `local.${createHash('sha256').update(`${input.source}:${input.name}`).digest('hex').slice(0, 24)}`,
        version: `0.0.0-snapshot.${archive.unpackedTreeSha256.slice(0, 24)}`, packageSha256: archive.packageSha256,
        packageBytes: archive.packageBytes, unpackedTreeSha256: archive.unpackedTreeSha256, skillMdSha256: archive.skillMdSha256 }
      await this.assertOwner(owner.accountId); await this.reserve(intent); await this.assertOwner(owner.accountId)
      try {
        const r = await this.request({ action: 'submit', requestId: intent.requestId, skillId: intent.skillId,
          version: intent.version, title: intent.title, summary: intent.summary, price_yuan: intent.priceYuan,
          archiveBase64: archive.bytes.toString('base64') }, owner.bearer)
        await this.assertOwner(owner.accountId)
        const submission = parseOrdinarySkillReceipt(r.submission, this.keys); this.bind(submission, intent)
        return { intent, submission, state: 'submitted' as const }
      } catch { await this.assertOwner(owner.accountId); return { intent, submission: null, state: 'unknown' as const } }
    })
    this.pending.set(key, { input: signature, done })
    void done.finally(() => { this.pending.delete(key) }).catch(() => undefined)
    return done
  }
  /** Abort owned operations; durable requests remain read-only on the next Host start. */
  async close(): Promise<void> { this.lifetime.abort(); await Promise.allSettled([...this.pending.values()].map(p => p.done)) }
}
