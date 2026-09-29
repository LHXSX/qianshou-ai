/** The browser talks only to the existing Host Remote; archives and Bearer credentials stay there. */
export interface OrdinarySkillChoice {
  source: 'user-dsh' | 'user-agents'
  name: string
  displayName: string
  description: string
}
export interface OrdinarySkillDraft {
  source: OrdinarySkillChoice['source'] | ''
  name: string
  title: string
  summary: string
  priceYuan: string
}
export interface OrdinarySkillReceipt {
  requestId: string
  submissionId: string
  accountId: string
  title: string
  summary: string
  priceYuan: string
  currency: 'CNY'
  version: string
  packageSha256: string
  publisherKind: 'official' | 'user'
  review: { status: 'pending' | 'published' | 'rejected'
    reviewId: string | null
    operatorId: string | null
    reviewedAt: number | null
    note: string | null
    testReceiptSha256: string | null }
  purchaseAvailable: false
  installable: false
}
export interface OrdinarySkillSubmission {
  intent: OrdinarySkillDraft & { requestId: string
    accountId: string
    packageSha256: string }
  submission: OrdinarySkillReceipt | null
  state: 'unknown' | 'submitted'
}
type Reply = { ok: true; value: unknown } | { ok: false; error: { code?: string; message: string } }
export interface OrdinarySkillsRemote {
  ordinarySkillChoices(this: void): Promise<Reply>
  ordinarySkillCatalog(this: void): Promise<Reply>
  ordinarySkillMine(this: void): Promise<Reply>
  submitOrdinarySkill(this: void, input: OrdinarySkillDraft & { requestId: string }): Promise<Reply>
}
function invalid(): never { throw new Error('ordinary-skill-unavailable') }
function row(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function string(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || !empty && value.length === 0) invalid()
  return value
}
function digest(value: unknown): string { const v = string(value, 64); if (!/^[a-f0-9]{64}$/u.test(v)) invalid(); return v }
function id(value: unknown): string {
  const v = string(value, 36)
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v)) invalid()
  return v
}
function price(value: unknown): string {
  const v = string(value, 32); if (!/^(?:0|[1-9][0-9]{0,7})(?:\.[0-9]{1,2})?$/u.test(v)) invalid(); return v
}
function unwrap(reply: Reply): Record<string, unknown> { if (!reply.ok) invalid(); return row(reply.value) }
function receipt(value: unknown): OrdinarySkillReceipt {
  const r = row(value); const review = row(r.review)
  if (r.purchaseAvailable !== false || r.installable !== false || r.currency !== 'CNY'
    || !['official', 'user'].includes(String(r.publisherKind)) || !['pending', 'published', 'rejected'].includes(String(review.status))) invalid()
  const status = review.status as OrdinarySkillReceipt['review']['status']
  const reviewed = status === 'pending' ? { status, reviewId: null, operatorId: null, reviewedAt: null, note: null, testReceiptSha256: null }
    : { status, reviewId: id(review.reviewId), operatorId: string(review.operatorId, 100), reviewedAt: Number(review.reviewedAt),
      note: string(review.note, 500), testReceiptSha256: review.testReceiptSha256 === null ? null : digest(review.testReceiptSha256) }
  if (status !== 'pending' && (!Number.isSafeInteger(reviewed.reviewedAt) || Number(reviewed.reviewedAt) < 1
    || status === 'published' && reviewed.testReceiptSha256 === null)) invalid()
  return { requestId: id(r.requestId), submissionId: id(r.submissionId), accountId: string(r.accountId, 128),
    title: string(r.title, 80), summary: string(r.summary, 400), priceYuan: price(r.priceYuan), currency: 'CNY',
    version: string(r.version, 80), packageSha256: digest(r.packageSha256), publisherKind: r.publisherKind as 'official' | 'user',
    review: reviewed, purchaseAvailable: false, installable: false }
}
function submission(value: unknown): OrdinarySkillSubmission {
  const r = row(value); const intent = row(r.intent)
  if (!['unknown', 'submitted'].includes(String(r.state))
    || !['user-dsh', 'user-agents'].includes(String(intent.source))) invalid()
  const requestId = id(intent.requestId); const accountId = string(intent.accountId, 128)
  const packageSha256 = digest(intent.packageSha256)
  const projected = r.submission === null ? null : receipt(r.submission)
  if (projected !== null && (projected.requestId !== requestId || projected.accountId !== accountId
    || projected.packageSha256 !== packageSha256
    || projected.title !== intent.title || projected.summary !== intent.summary || projected.priceYuan !== intent.priceYuan)) invalid()
  if ((r.state === 'submitted') !== (projected !== null)) invalid()
  return { intent: { source: intent.source as OrdinarySkillChoice['source'], name: string(intent.name, 128), requestId, accountId,
    title: string(intent.title, 80), summary: string(intent.summary, 400), priceYuan: price(intent.priceYuan), packageSha256 },
  submission: projected, state: r.state as 'unknown' | 'submitted' }
}
/** Admit Host-safe public projections, with no code execution or funds operation.
 * @param remote - Existing authenticated qianshouPluginCatalog Remote.
 * @returns Read-only catalog/recovery plus one explicitly called submission operation.
 */
export function createOrdinarySkillTransport(remote: OrdinarySkillsRemote) {
  return {
    choices: async (): Promise<OrdinarySkillChoice[]> => {
      const r = unwrap(await remote.ordinarySkillChoices()); if (!Array.isArray(r.skills) || r.skills.length > 1000) invalid()
      return r.skills.map((value) => { const s = row(value); if (!['user-dsh', 'user-agents'].includes(String(s.source))) invalid()
        return { source: s.source as OrdinarySkillChoice['source'], name: string(s.name, 128),
          displayName: string(s.displayName, 200), description: string(s.description, 4000, true) } })
    },
    catalog: async (): Promise<OrdinarySkillReceipt[]> => {
      const r = unwrap(await remote.ordinarySkillCatalog()); if (!Array.isArray(r.listings) || r.listings.length > 1000) invalid()
      return r.listings.map((value) => { const s = receipt(value); if (s.review.status !== 'published') invalid(); return s })
    },
    mine: async () => {
      const r = unwrap(await remote.ordinarySkillMine()); if (!Array.isArray(r.submissions) || r.submissions.length > 1000) invalid()
      const accountId = string(r.accountId, 128); const submissions = r.submissions.map(submission)
      if (submissions.some(s => s.intent.accountId !== accountId)) invalid()
      return { accountId, submissions }
    },
    submit: async (input: OrdinarySkillDraft & { requestId: string }) => submission(unwrap(await remote.submitOrdinarySkill(input))),
  }
}
