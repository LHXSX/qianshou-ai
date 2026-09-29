/** Shared ordinary skill viewing state; user gestures alone authorize a package submission. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createOrdinarySkillTransport, type OrdinarySkillChoice, type OrdinarySkillDraft,
  type OrdinarySkillReceipt, type OrdinarySkillSubmission, type OrdinarySkillsRemote } from './ordinary-skill-transport.ts'

export interface OrdinarySkillsView {
  accountId: string | null
  skills: OrdinarySkillChoice[]
  draft: OrdinarySkillDraft
  submitState: 'idle' | 'submitting' | 'unknown' | 'submitted' | 'error'
  submissions: OrdinarySkillSubmission[]
  catalog: OrdinarySkillReceipt[]
  catalogState: 'idle' | 'loading' | 'ready' | 'error'
  error: boolean
}
const draft = (): OrdinarySkillDraft => ({ source: '', name: '', title: '', summary: '', priceYuan: '' })
const empty = (): OrdinarySkillsView => ({ accountId: null, skills: [], draft: draft(), submitState: 'idle',
  submissions: [], catalog: [], catalogState: 'idle', error: false })

/** Own the plain observable used by the framework hook; no component receives a service object. */
export class OrdinarySkillsController {
  readonly store = createSnapshotStore<OrdinarySkillsView>(empty())
  private readonly transport
  private generation = 0
  private readEpoch = 0
  private disposed = false
  private requestId: string | null = null
  private submitting: Promise<void> | null = null
  constructor(remote: OrdinarySkillsRemote, private readonly readOwner: () => Promise<number | null>) {
    this.transport = createOrdinarySkillTransport(remote)
  }
  /** Read local choices, original submissions and real reviewed catalog without submitting. */
  async reload(): Promise<void> {
    if (!this.active()) return
    const readEpoch = ++this.readEpoch
    this.store.update((s) => { s.catalogState = 'loading'; s.error = false })
    const owner = await this.readOwner().catch(() => null)
    if (!this.active() || readEpoch !== this.readEpoch) return
    const accountId = owner === null ? null : String(owner)
    if (accountId !== this.store.getSnapshot().accountId) {
      this.generation++
      this.requestId = null
      this.store.set({ ...empty(), accountId, catalogState: 'loading' })
    }
    const [choices, catalog, mine] = await Promise.allSettled([this.transport.choices(), this.transport.catalog(),
      accountId === null ? Promise.resolve(null) : this.transport.mine()])
    if (!this.active() || readEpoch !== this.readEpoch || (await this.readOwner().catch(() => null)) !== owner) return
    const prior = this.store.getSnapshot()
    const submissions = mine.status === 'fulfilled' && mine.value !== null && mine.value.accountId === accountId
      ? mine.value.submissions : prior.submissions
    const original = this.requestId === null ? undefined : submissions.find(s => s.intent.requestId === this.requestId)
    this.store.set({ ...prior, accountId, skills: choices.status === 'fulfilled' ? choices.value : prior.skills,
      catalog: catalog.status === 'fulfilled' ? catalog.value : [], catalogState: catalog.status === 'fulfilled' ? 'ready' : 'error',
      submissions, submitState: original?.state === 'submitted' ? 'submitted' : prior.submitState,
      error: choices.status === 'rejected' || mine.status === 'rejected' })
  }
  /** Change explicit author terms; an uncertain original request stays locked for reconciliation.
   * @param change - User-selected local identity or name, summary and price input.
   */
  edit(change: Partial<OrdinarySkillDraft>): void {
    const current = this.store.getSnapshot()
    if (!this.active() || current.submitState === 'unknown' || current.submitState === 'submitting') return
    this.requestId = null
    this.store.update((s) => { Object.assign(s.draft, change); s.submitState = 'idle'; s.error = false })
  }
  /** Submit the current explicit terms once; uncertain responses only expose recovery. */
  submit(): Promise<void> {
    if (this.submitting !== null) return this.submitting
    const view = this.store.getSnapshot()
    if (!this.active() || view.submitState === 'unknown' || view.submitState === 'submitted' || view.draft.source === '') return Promise.resolve()
    const validText = (s: string, limit: number) => s.length > 0 && s.length <= limit && s.trim() === s
      && s.isWellFormed() && !/[\u0000-\u001f\u007f]/u.test(s)
    if (view.accountId === null || !view.skills.some(s => s.source === view.draft.source && s.name === view.draft.name)
      || !validText(view.draft.title, 80) || !validText(view.draft.summary, 400)
      || !/^(?:0|[1-9][0-9]{0,7})(?:\.[0-9]{1,2})?$/u.test(view.draft.priceYuan)) {
      this.store.update((s) => { s.submitState = 'error'; s.error = true })
      return Promise.resolve()
    }
    const requestId = this.requestId ?? randomUUID(); this.requestId = requestId
    const generation = this.generation
    const input = { ...view.draft, requestId }
    this.store.update((s) => { s.submitState = 'submitting'; s.error = false })
    const done = Promise.resolve().then(async () => {
      const owner = await this.readOwner()
      if (owner === null || String(owner) !== view.accountId) throw new Error('ordinary-skill-owner-changed')
      const result = await this.transport.submit(input)
      if (!this.current(generation) || (await this.readOwner()) !== owner) return
      this.store.update((s) => {
        s.submitState = result.state === 'submitted' ? 'submitted' : 'unknown'
        s.submissions = [...s.submissions.filter(r => r.intent.requestId !== requestId), result]
      })
    }).catch(() => {
      if (this.current(generation)) this.store.update((s) => { s.submitState = 'unknown'; s.error = true })
    }).finally(() => { if (this.submitting === done) this.submitting = null })
    this.submitting = done
    return done
  }
  /** Query the original saved UUIDs; this method never calls submit. */
  refresh(): Promise<void> { return this.reload() }
  /** Discard late results after plugin disposal without resubmitting a package. */
  dispose(): void { this.disposed = true; this.generation++ }
  private active() { return !this.disposed }
  private current(generation: number) { return !this.disposed && generation === this.generation }
}
