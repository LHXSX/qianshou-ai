import { useEffect, useRef, useState } from 'react'
import { Button, Input, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SupplyPolicy } from '@deepseek-ai/dsh-compute-core/supply'
import type { SupplyState } from './controller.ts'
import {
  draftMemoryBytes, memoryFacts, memoryPlaceholder, policyForm, policyRequest, serviceRows,
  type PolicyForm, type PolicyProblem, type ServiceRow,
} from './form.ts'
import type { SupplyKey } from './locales.ts'
import { ADMISSION_REASON_KEYS, codeKey, PROBE_ERROR_KEYS, SERVICE_REASON_KEYS } from './reasons.ts'
import {
  advertisingKey, durationBucket, errorKey, problemKey, serviceKindKey, stateHintKey, stateKey, verificationKey,
} from './view.ts'
import css from './SupplyPage.module.css'

/** Framework-bound projection and the two finite actions this page owns. */
export interface SupplyFace {
  hooks: { supply: ObservableSnapshot<SupplyState> }
  refresh: () => Promise<void>
  savePolicy: (policy: SupplyPolicy) => Promise<boolean>
}

/** Main slot props and typed copy for local supply management. */
export type SupplyPageProps = PropsRuntime<'main'> & PropsLocale<'qianshou.supply'> & InjectFace<SupplyFace>

/** The namespace-bound translate seat this page renders with. */
type SupplyTranslate = SupplyPageProps['t']

/** Show what the Host observed about this machine and let the owner edit the policy.
 * @param props - Slot props: runtime seat, dictionary and the injected supply face.
 * @returns The supply workspace.
 */
export function SupplyPage(props: SupplyPageProps) {
  const { t } = props
  const state = props.useSupply(snapshot => snapshot)
  const snapshot = state.snapshot
  const [form, setForm] = useState<PolicyForm | null>(null)
  const [problem, setProblem] = useState<PolicyProblem | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)
  const submitting = useRef(false)
  useEffect(() => { void props.refresh() }, [props.refresh])
  // The draft mirrors the Host's policy until the owner edits something. An
  // unsaved edit is never overwritten by a background observation.
  useEffect(() => {
    if (!snapshot || dirty) return
    setForm(policyForm(snapshot))
    setProblem(null)
  }, [snapshot, dirty])
  // The editor only exists once a draft is seeded, so a caller always hands
  // back the complete next draft; no branch here can invent one.
  function edit(next: PolicyForm): void {
    setForm(next)
    setProblem(null)
    setSaved(false)
    setDirty(true)
  }
  async function save(): Promise<void> {
    if (submitting.current || state.saving || state.loading || !snapshot || form === null) return
    const request = policyRequest(form, snapshot)
    if (!request.ok) { setProblem(request.problem); return }
    submitting.current = true
    try {
      const accepted = await props.savePolicy(request.policy)
      setSaved(accepted)
      if (accepted) setDirty(false)
    } finally { submitting.current = false }
  }
  const eligibility = snapshot?.eligibility.state ?? null
  const rows = serviceRows(snapshot, form)
  const savedBytes = snapshot?.ownerPolicy.minFreeMemoryBytes ?? 0
  const effectiveBytes = form === null ? null : draftMemoryBytes(form, savedBytes)
  const idle = snapshot?.activity.idleSeconds ?? null
  const rejected = problem === null ? null : problemKey(problem)
  return <main className={css.page}>
    <header className={css.header}>
      <div>
        <span className={css.eyebrow}>{t('eyebrow')}</span>
        <h1>{t('heading')}</h1>
        <p>{t('description')}</p>
      </div>
      <Button onClick={() => { void props.refresh() }} disabled={state.loading || state.saving}>{t('refresh')}</Button>
    </header>

    {state.error && <div className={css.error} role="alert">
      <strong>{t('error')}</strong>
      <p>{t(errorKey(state.error.code))}</p>
      <p className={css.code}>{state.error.code}</p>
    </div>}

    <section className={css.observation} aria-label={t('observedAt')}
      data-observation={snapshot === null ? 'none' : state.stale ? 'stale' : 'fresh'}>
      <dl className={css.inlineFacts}>
        <div data-fact="observedAt">
          <dt>{t('observedAt')}</dt>
          <dd>{snapshot === null ? t('observedAtUnknown')
            : <time dateTime={snapshot.observedAt}>{new Date(snapshot.observedAt).toLocaleString()}</time>}</dd>
        </div>
      </dl>
      <p className={css.hint}>{snapshot === null ? t('noObservationHint') : t('observationHint')}</p>
      {state.stale && <p className={css.stale}>{t('staleObservation')}</p>}
    </section>

    <div className={css.columns}>
      <section className={css.card} aria-label={t('eligibility')}>
        <h2>{t('eligibility')}</h2>
        <p className={css.stateRow}>
          <StateDot state={eligibility === 'ready' ? 'done' : eligibility === 'blocked' ? 'warning' : 'idle'} />
          <strong>{t(stateKey(eligibility))}</strong>
        </p>
        <p className={css.hint}>{t(stateHintKey(eligibility))}</p>
        <h3>{t('reasons')}</h3>
        {snapshot === null ? <p className={css.hint}>{t('noObservation')}</p>
          : snapshot.eligibility.reasons.length === 0 ? <p className={css.hint}>{t('noReasons')}</p>
            : <ul className={css.reasons}>{snapshot.eligibility.reasons.map((code, index) => {
              const key = codeKey(ADMISSION_REASON_KEYS, code)
              return <li key={`${index}-${code}`} data-reason={code}>
                <span>{key === null ? t('reasonUnknownCode') : t(key)}</span>
                <code>{code}</code>
              </li>
            })}</ul>}
      </section>

      <section className={css.card} aria-label={t('advertising')}>
        <h2>{t('advertising')}</h2>
        <p className={css.stateRow}>
          <StateDot state={snapshot?.advertisingState === 'advertising' ? 'done'
            : snapshot?.advertisingState === 'withdrawn' ? 'warning' : 'idle'} />
          <strong>{t(advertisingKey(snapshot?.advertisingState ?? null))}</strong>
        </p>
        <p className={css.hint}>{t('advertisingHint')}</p>
        <h3>{t('advertisedCapabilities')}</h3>
        {(snapshot?.advertisedCapabilityIds.length ?? 0) === 0
          ? <p className={css.hint}>{snapshot?.advertisingState === 'advertising' ? t('advertisedEmpty') : t('noAdvertisedCapabilities')}</p>
          : <ul className={css.ids}>{snapshot?.advertisedCapabilityIds.map((id, index) => (
            <li key={`${index}-${id}`}><code>{id}</code></li>))}</ul>}
        <p className={css.boundary}>{t('dispatchBoundary')}</p>
      </section>

      <section className={css.card} aria-label={t('facts')}>
        <h2>{t('facts')}</h2>
        <p className={css.hint}>{t('factsHint')}</p>
        <dl className={css.facts}>
          <div data-fact="idle"><dt>{t('idle')}</dt>
            <dd>{idle === null ? t('unknown')
              : t(durationBucket(idle).key, { count: String(durationBucket(idle).count) })}</dd></div>
          <div data-fact="foregroundTask"><dt>{t('foregroundTask')}</dt>
            <dd>{booleanText(snapshot?.activity.foregroundTaskActive ?? null, t)}</dd></div>
          <div data-fact="voice"><dt>{t('voice')}</dt>
            <dd>{booleanText(snapshot?.activity.voiceActive ?? null, t)}</dd></div>
          <div data-fact="platform"><dt>{t('platform')}</dt><dd>{snapshot?.hardware.platform ?? t('unknown')}</dd></div>
          <div data-fact="architecture"><dt>{t('architecture')}</dt><dd>{snapshot?.hardware.arch ?? t('unknown')}</dd></div>
          <div data-fact="cpuModel"><dt>{t('cpuModel')}</dt><dd>{snapshot?.hardware.cpuModel ?? t('unknown')}</dd></div>
          <div data-fact="logicalCores"><dt>{t('logicalCores')}</dt>
            <dd>{snapshot === null ? t('unknown') : t('coreCount', { count: String(snapshot.hardware.logicalCores) })}</dd></div>
          <div data-fact="totalMemory"><dt>{t('totalMemory')}</dt>
            <dd>{snapshot === null ? t('unknown')
              : `${memoryFacts(snapshot.hardware.totalMemoryBytes).size}（${snapshot.hardware.totalMemoryBytes} B）`}</dd></div>
          <div data-fact="freeMemory"><dt>{t('freeMemory')}</dt>
            <dd>{snapshot === null ? t('unknown')
              : `${memoryFacts(snapshot.hardware.freeMemoryBytes).size}（${snapshot.hardware.freeMemoryBytes} B）`}</dd></div>
        </dl>
        <h3>{t('gpu')}</h3>
        {(snapshot?.hardware.gpus.length ?? 0) === 0 ? <p className={css.hint}>{t('gpuNone')}</p>
          : <ul className={css.tight}>{snapshot?.hardware.gpus.map((gpu, index) => (
            <li key={`${index}-${gpu.name}`}>{gpu.name}
              {gpu.vendor === null ? '' : ` · ${gpu.vendor}`}
              {` · ${gpu.memoryBytes === null ? t('gpuMemoryUnknown') : memoryFacts(gpu.memoryBytes).size}`}</li>))}</ul>}
        <h3>{t('probeErrors')}</h3>
        {(snapshot?.hardware.probeErrors.length ?? 0) === 0 ? <p className={css.hint}>{t('noProbeErrors')}</p>
          : <ul className={css.reasons}>{snapshot?.hardware.probeErrors.map((code, index) => {
            const key = codeKey(PROBE_ERROR_KEYS, code)
            return <li key={`${index}-${code}`} data-probe-error={code}>
              <span>{key === null ? t('unknownCode') : t(key)}</span><code>{code}</code>
            </li>
          })}</ul>}
      </section>

      <section className={css.card} aria-label={t('policy')}>
        <h2>{t('policy')}</h2>
        <p className={css.hint}>{t('policyHint')}</p>
        {form === null || snapshot === null ? <p className={css.hint}>{t('noObservationHint')}</p>
          : <form onSubmit={(event) => { event.preventDefault(); void save() }}>
            <fieldset className={css.form} disabled={state.loading || state.saving}>
              <label>{t('mode')}<select value={form.mode} onChange={(event) => { edit({ ...form, mode: event.target.value as SupplyPolicy['mode'] }) }}>
                <option value="off">{t('modeOff')}</option>
                <option value="idle">{t('modeIdle')}</option>
                <option value="allowed">{t('modeAllowed')}</option>
              </select></label>
              <p className={css.hint}>{form.mode === 'off' ? t('modeOffHint') : form.mode === 'idle' ? t('modeIdleHint') : t('modeAllowedHint')}</p>
              <label>{t('maxConcurrency')}<Input inputMode="numeric" value={form.maxConcurrency}
                onChange={(event) => { edit({ ...form, maxConcurrency: event.target.value }) }} /></label>
              <p className={css.hint}>{t('maxConcurrencyHint')}</p>
              <label>{t('minFreeMemoryMiB')}<Input inputMode="numeric" value={form.minFreeMemoryMiB}
                placeholder={memoryPlaceholder(savedBytes)} onChange={(event) => { edit({ ...form, minFreeMemoryMiB: event.target.value }) }} /></label>
              <p className={css.hint}>{t('minFreeMemoryHint')}</p>
              <p className={css.hint} data-fact="memoryCurrent">{t('minFreeMemoryCurrent', memoryFacts(savedBytes))}</p>
              {effectiveBytes !== null && <p className={css.hint} data-fact="memoryEffective">
                {t('minFreeMemoryEffective', memoryFacts(effectiveBytes))}</p>}
              <label>{t('minIdleSeconds')}<Input inputMode="numeric" value={form.minIdleSeconds}
                onChange={(event) => { edit({ ...form, minIdleSeconds: event.target.value }) }} /></label>
              <p className={css.hint}>{t('minIdleSecondsHint')}</p>
              <h3>{t('enabledServices')}</h3>
              <p className={css.hint}>{t('enabledServicesHint')}</p>
              {rows.length === 0
                ? <div className={css.empty}><h3>{t('noServices')}</h3><p className={css.hint}>{t('noServicesHint')}</p></div>
                : <ul className={css.services}>{rows.map(row => <li key={row.id} data-service={row.id}>
                  <label className={css.service}>
                    <input type="checkbox" checked={row.enabled} disabled={row.verification !== 'verified' && !row.enabled}
                      onChange={() => { edit({ ...form, ...toggle(form, row) }) }} />
                    <span><strong>{row.name ?? row.id}</strong>
                      <span className={css.hint}>{serviceMeta(row, t)}</span></span>
                  </label>
                  {row.reason !== null && <p className={css.hint} data-service-reason={row.reason}>
                    {reasonText(SERVICE_REASON_KEYS, row.reason, t)}</p>}
                  {!row.acceptable && <p className={css.warn}>{t('invalidServiceId', { id: row.id })}</p>}
                </li>)}</ul>}
              <p className={css.hint}>{t(snapshot.ownerPolicy.nodeRates.length === 0 ? 'ratesNone' : 'ratesCount',
                { count: String(snapshot.ownerPolicy.nodeRates.length) })}</p>
              {rejected !== null && <p className={css.error} role="alert" data-problem={problem?.kind}>
                {t(rejected.key, rejected.id === undefined ? undefined : { id: rejected.id })}</p>}
              <Button type="submit" variant="primary" disabled={state.loading || state.saving}>
                {t(state.saving ? 'saving' : 'save')}</Button>
              {dirty && <p className={css.hint}>{t('unsaved')}</p>}
              {saved && !dirty && <p className={css.saved} role="status">{t('saved')}</p>}
            </fieldset>
          </form>}
      </section>

      <section className={css.card} aria-label={t('earnings')}>
        <h2>{t('earnings')}</h2>
        <p className={css.notConnected}><strong>{t('earningsNotConnected')}</strong></p>
        <p className={css.hint}>{t('earningsHint')}</p>
      </section>
    </div>
    <p className={css.boundary}>{t('boundary')}</p>
  </main>
}

/** Decorative machine-with-signal glyph for the sidebar seat of this workspace. */
export function SupplyIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" />
    <path d="M7 10.5h2.5M7 7.5h5" /><path d="M16.5 7.5v6" strokeLinecap="round" />
  </svg>
}

/** A boolean activity fact as one of its three honest states, never a defaulted value. */
function booleanText(value: boolean | null, t: SupplyTranslate): string {
  if (value === null) return t('unknown')
  return value ? t('yes') : t('no')
}

/** The enabled-identifier list one capability checkbox toggles. */
function toggle(form: PolicyForm, row: ServiceRow): Pick<PolicyForm, 'enabledServiceIds'> {
  return {
    enabledServiceIds: row.enabled
      ? form.enabledServiceIds.filter(id => id !== row.id)
      : [...form.enabledServiceIds, row.id],
  }
}

/** Kind, version and self-check facts of one capability row. */
function serviceMeta(row: ServiceRow, t: SupplyTranslate): string {
  if (row.kind === null || row.verification === null) return t('serviceNotDiscovered')
  const base = `${t(serviceKindKey(row.kind))} · ${row.version ?? t('versionUnknown')} · ${t(verificationKey(row.verification))}`
  return row.verification === 'verified' ? base : `${base} · ${t('serviceNotVerified')}`
}

/** Localized text for one probe reason code, falling back to the code itself. */
function reasonText(table: Readonly<Record<string, SupplyKey>>, code: string, t: SupplyTranslate): string {
  const key = codeKey(table, code)
  return key === null ? `${t('unknownCode')}${code}` : t(key)
}
