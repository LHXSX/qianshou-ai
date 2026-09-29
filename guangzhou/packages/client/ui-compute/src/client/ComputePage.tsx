import { useEffect, useRef, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComputePlanId, ComputePlanRequest } from '@deepseek-ai/dsh-compute-core/protocol'
import type { ComputeState } from './controller.ts'
import { planRequest, type PlanForm } from './form.ts'
import css from './ComputePage.module.css'

/** Framework-bound projection and finite user actions. */
export interface ComputeFace {
  hooks: { compute: ObservableSnapshot<ComputeState> }
  refresh: () => Promise<void>
  ensureLoaded: () => Promise<void>
  saveDraft: (request: ComputePlanRequest) => Promise<boolean>
  confirmDraft: (id: ComputePlanId, decision: 'approved' | 'declined') => Promise<boolean>
  publishDraft: (id: ComputePlanId) => Promise<boolean>
}
/** Main slot props and typed copy for shared compute. */
export type ComputePageProps = PropsRuntime<'main'> & PropsLocale<'qianshou.compute'> & InjectFace<ComputeFace>
/** Show verified capability facts and unpriced local plans without an execution affordance. */
export function ComputePage(props: ComputePageProps) {
  const { t } = props
  const state = props.useCompute(snapshot => snapshot)
  const [form, setForm] = useState<PlanForm>({ capabilityId: '', goal: '', budget: '', nodeMode: 'auto', nodes: '' })
  const submitting = useRef(false)
  const [invalid, setInvalid] = useState(false)
  useEffect(() => { void props.refresh() }, [props.refresh])
  const selected = state.capabilities.find(item => item.id === form.capabilityId)
  const request = planRequest(form, state.capabilities)
  const errorKey = state.error?.code === 'INVALID_COMPUTE_RESPONSE' ? 'invalidResponse'
    : state.error && /AUTH|UNAUTHORIZED|FORBIDDEN/.test(state.error.code) ? 'authRequired' : 'requestFailed'
  function edit<K extends keyof PlanForm>(key: K, value: PlanForm[K]): void {
    setForm(current => ({ ...current, [key]: value })); setInvalid(false)
  }
  async function save(): Promise<void> {
    if (submitting.current || state.saving || state.loading) return
    if (!request) { setInvalid(true); return }
    submitting.current = true
    try { await props.saveDraft(request) }
    finally { submitting.current = false }
  }
  return <main className={css.page}>
    <header className={css.header}>
      <div><span className={css.eyebrow}>{t('eyebrow')}</span><h1>{t('heading')}</h1><p>{t('description')}</p></div>
      <Button onClick={() => { void props.refresh() }} disabled={state.loading || state.saving}>{t('refresh')}</Button>
    </header>
    <section className={css.connection} aria-label={t('connection')}>
      <div className={css.connectionHeading}><ComputeIcon /><strong>{state.loading ? t('loading')
        : state.connection ? t(state.connection.configured ? 'configured' : 'disconnected') : t('unknown')}</strong></div>
      {state.connection && <p>{state.connection.message}</p>}
      {state.connection?.configured && <p className={css.hint}>{t('connectionHint')}</p>}
      {state.connection && <dl className={css.readiness}>
        {(['workloadRead', 'quoting', 'submission'] as const).map(key => <div key={key}>
          <dt>{t(key)}</dt><dd>{t(state.connection?.capabilities[key] ? 'enabled' : 'unavailable')}</dd>
        </div>)}
      </dl>}
      <p className={css.boundary}>{t('draftOnly')}</p>
    </section>
    {state.error && <div className={css.error} role="alert"><strong>{t('error')}</strong><p>{t(errorKey)}</p><p>{state.error.message}</p></div>}
    <div className={css.columns}>
      <section className={css.catalog}>
        <h2>{t('catalog')}</h2><p className={css.hint}>{t('catalogHint')}</p>
        {state.capabilities.length === 0 && !state.loading && <div className={css.empty}><ComputeIcon /><h3>{t('noCapabilities')}</h3><p>{t('noCapabilitiesHint')}</p></div>}
        <div className={css.capabilities}>
          {state.capabilities.map(capability => <button type="button" key={capability.id} className={css.capability}
            aria-pressed={form.capabilityId === capability.id} disabled={!capability.available || state.loading || state.saving}
            onClick={() => { edit('capabilityId', capability.id) }}>
            <span className={css.capabilityHeading}><strong>{capability.name}</strong><span>{t(capability.delivery)}</span></span>
            <span className={css.capabilityDescription}>{capability.description}</span>
            <span className={css.hint}>{capability.available ? t('available') : capability.unavailableReason || t('capabilityUnavailable')}</span>
          </button>)}
        </div>
      </section>
      <section className={css.planning}>
        <h2>{t('request')}</h2>
        <form onSubmit={(event) => { event.preventDefault(); void save() }}>
          <fieldset className={css.form} disabled={state.loading || state.saving || !state.capabilities.some(item => item.available)}>
            <label>{t('selectedCapability')}<select value={form.capabilityId} onChange={(event) => { edit('capabilityId', event.target.value) }}>
              <option value="">{t('selectCapability')}</option>
              {state.capabilities.map(capability => (
                <option key={capability.id} value={capability.id} disabled={!capability.available}>{capability.name}</option>
              ))}
            </select></label>
            <label>{t('goal')}<textarea value={form.goal} rows={4} maxLength={8000} placeholder={t('goalPlaceholder')}
              onChange={(event) => { edit('goal', event.target.value) }} /></label>
            <label>{t('budget')}<Input value={form.budget} inputMode="decimal" onChange={(event) => { edit('budget', event.target.value) }} /></label>
            <p className={css.hint}>{t('budgetHint')}</p>
            <details className={css.options}><summary>{t('nodes')}</summary>
              <label>{t('nodes')}<select value={form.nodeMode} onChange={(event) => { edit('nodeMode', event.target.value === 'manual' ? 'manual' : 'auto') }}>
                <option value="auto">{t('auto')}</option><option value="manual">{t('manual')}</option>
              </select></label>
              {form.nodeMode === 'manual' && <label>{t('nodeLimit')}<Input type="number" min={1} max={64} step={1} value={form.nodes}
                onChange={(event) => { edit('nodes', event.target.value) }} /></label>}
              <p className={css.hint}>{t('nodesHint')}</p>
            </details>
            {invalid && <p role="alert" className={css.error}>{t('invalid')}</p>}
            <Button type="submit" variant="primary" disabled={!request || !selected?.available}>{t(state.saving ? 'saving' : 'saveDraft')}</Button>
          </fieldset>
        </form>
      </section>
    </div>
    <section className={css.drafts} aria-label={t('drafts')}>
      <h2>{t('drafts')}</h2>
      {!state.loading && state.drafts.length === 0 && <p className={css.hint}>{t('noDrafts')}</p>}
      <div className={css.draftGrid}>{state.drafts.map(draft => <article key={draft.id} className={css.draft}>
        <div className={css.draftHeading}><strong>{state.capabilities.find(item => item.id === draft.request.capabilityId)?.name ?? draft.request.capabilityId}</strong><span>{t(draft.workloadId ? 'draftStatusPublished' : draft.authorization === 'approved' ? 'draftStatusApproved' : draft.authorization === 'declined' ? 'draftStatusDeclined' : 'draftStatus')}</span></div>
        <p className={css.goal}>{draft.request.goal}</p>
        <div className={css.quote}><strong>{t('noQuote')}</strong><p>{t('noQuoteHint')}</p></div>
        <dl className={css.requirements}>
          <div><dt>{t('savedBudget')}</dt><dd>{t('amount', { amount: (draft.request.budgetMinor / 100).toFixed(2) })}</dd></div>
          <div><dt>{t('requestedNodes')}</dt><dd>{draft.request.maxNodes === null ? t('auto') : t('nodeCount', { count: String(draft.request.maxNodes) })}</dd></div>
          <div><dt>{t('createdAt')}</dt><dd><time dateTime={draft.createdAt}>{new Date(draft.createdAt).toLocaleString()}</time></dd></div>
        </dl>
        <p className={css.hint}>{draft.reason}</p>
        {draft.authorization === 'approved' && draft.workloadId === null && <Button variant="primary" size="sm"
          disabled={state.loading || state.saving}
          onClick={() => { void props.publishDraft(draft.id) }}>{t('cardPublish')}</Button>}
        {draft.workloadId !== null && <p className={css.hint}>{t('cardWorkload')}: {draft.workloadId}</p>}
      </article>)}</div>
    </section>
  </main>
}
/** Decorative network glyph for the sidebar and compute status surface. */
export function ComputeIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <rect x="9" y="2" width="6" height="6" rx="1.5" /><rect x="2" y="16" width="6" height="6" rx="1.5" /><rect x="16" y="16" width="6" height="6" rx="1.5" />
    <path d="M12 8v4M5 16v-4h14v4" />
  </svg>
}
