/** Three layers, three blocks: what is listed, how many workers answer, what the server estimates. */
import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { CapabilityCatalogEntry, CapabilityFailureCode, CapabilityPoolCounts } from '@deepseek-ai/dsh-api-remotes/client'
import type { CapabilityController } from './controller.ts'
import type { CapabilityKey } from './locales.ts'
import css from './CapabilityPanel.module.css'

/** Action and store face the settings section receives. */
export interface CapabilityInjected {
  controller: CapabilityController
  hooks: { capability: CapabilityController['store'] }
}

export type CapabilityPanelProps = InjectFace<CapabilityInjected> & PropsLocale<'qianshou.capability'>

/** `busy` names the reading indicator in this dictionary, so the failure of that name has its own key. */
function failureKey(failure: CapabilityFailureCode): CapabilityKey {
  return failure === 'busy' ? 'busyFailure' : failure
}

/** Render the scheduler's per-implementation split, which is empty far more often than it is not. */
function Implementations({ counts, t }: { counts: CapabilityPoolCounts } & PropsLocale<'qianshou.capability'>) {
  const rows = Object.entries(counts.byImpl)
  if (rows.length === 0) return null
  return <div className={css.impl}>
    <span className={css.implLabel}>{t('byImpl')}</span>
    {rows.map(([impl, count]) => <span key={impl} className={css.tag}>{impl} {count}</span>)}
  </div>
}

/** Render one capability row; selection is the only thing a click changes. */
function CatalogRow({ entry, selected, onSelect, t }: {
  entry: CapabilityCatalogEntry
  selected: boolean
  onSelect: () => void
} & PropsLocale<'qianshou.capability'>) {
  return <li>
    <button type="button" className={css.row} aria-pressed={selected} onClick={onSelect}>
      <span className={css.rowName}>{entry.title ?? entry.id}</span>
      {entry.title !== null && <span className={css.rowId}>{entry.id}</span>}
      <span className={css.tag}>{entry.taskType === null ? t('noTaskType') : t('taskTypeLabel', { taskType: entry.taskType })}</span>
    </button>
  </li>
}

/** Read-only capability facts for the signed-in account, each layer labelled as itself. */
export function CapabilityPanel({ controller, useCapability, t }: CapabilityPanelProps) {
  const { catalog, selected, availability, estimate, busy, failed } = useCapability(state => state)
  const [goal, setGoal] = useState('')
  const [budget, setBudget] = useState('')
  const [currency, setCurrency] = useState('CNY')
  useEffect(() => { void controller.loadCatalog() }, [controller])

  const entries = catalog?.state === 'catalog-only' ? catalog.entries : []
  const entry = entries.find(candidate => candidate.id === selected)
  const estimable = entry !== undefined && entry.taskType !== null

  return <section className={css.panel} data-qianshou-capability>
    <h2>{t('title')}</h2>
    <p className={css.hint}>{t('hint')}</p>

    <div className={css.actions}>
      <button type="button" disabled={busy} onClick={() => { void controller.loadCatalog() }}>
        {busy ? t('busy') : t('refresh')}
      </button>
    </div>
    {catalog === null && (failed
      ? <div className={css.statusCard} role="alert"><strong>{t('network')}</strong></div>
      : <div className={css.statusCard} role="status">{t('loading')}</div>)}
    {failed && catalog?.state === 'catalog-only' && <p role="alert">{t('network')}</p>}
    {catalog?.state === 'signed-out' && <p role="status">{t('signedOut')}</p>}
    {catalog?.state === 'unavailable' && <p role="alert">
      {t(failureKey(catalog.failure))}
      {catalog.httpStatus !== null && <> {t('httpStatus', { status: String(catalog.httpStatus) })}</>}
    </p>}
    {catalog?.state === 'catalog-only' && <div className={css.layer}>
      <p className={css.hint}>
        {t('catalogOnly')} {catalog.registryVersion === null ? t('noRegistry') : t('registryVersion', { version: catalog.registryVersion })}
      </p>
      {entries.length === 0
        ? <p role="status">{t('empty')}</p>
        : <ul className={css.rows}>{entries.map(candidate => <CatalogRow key={candidate.id} entry={candidate}
          selected={candidate.id === selected} onSelect={() => { void controller.select(candidate.id) }} t={t} />)}</ul>}
    </div>}

    {availability?.state === 'catalog-only' && <div className={css.layer}>
      <h3>{availability.capabilityId}</h3>
      <div className={css.counts}>
        <span className={css.tag}>{t('declared', { count: String(availability.declared.count) })}</span>
        <span className={css.tag}>{t('availableNow', { count: String(availability.availableNow.count) })}</span>
        <span className={css.tag}>{t('onlineTtl', { seconds: String(availability.availableNow.onlineTtlSeconds) })}</span>
      </div>
      <Implementations counts={availability.availableNow} t={t} />
      <p className={css.hint}>{t('countsHint')}</p>
    </div>}
    {availability?.state === 'unavailable' && <p role="alert">{t(failureKey(availability.failure))}</p>}
    {availability?.state === 'signed-out' && <p role="status">{t('signedOut')}</p>}

    {selected !== null && <form className={css.layer} onSubmit={(event) => {
      event.preventDefault()
      void controller.runEstimate({
        goal,
        budget: budget === '' ? null : { amount_minor: Number(budget), currency },
      })
    }}>
      <label>{t('goal')}
        <textarea aria-label={t('goal')} value={goal} required disabled={busy} placeholder={t('goalPlaceholder')}
          onChange={(event) => { setGoal(event.target.value) }} />
      </label>
      <div className={css.budgetRow}>
        <label>{t('budget')}
          <input aria-label={t('budget')} value={budget} inputMode="numeric" min={0} type="number" disabled={busy}
            onChange={(event) => { setBudget(event.target.value) }} />
        </label>
        <label>{t('currency')}
          <input aria-label={t('currency')} value={currency} disabled={busy}
            onChange={(event) => { setCurrency(event.target.value) }} />
        </label>
      </div>
      <p className={css.hint}>{t('budgetLocal')}</p>
      {!estimable && <p role="status">{t('noTaskType')}</p>}
      <div className={css.actions}>
        <button type="submit" disabled={busy || !estimable}>{busy ? t('busy') : t('estimate')}</button>
      </div>
    </form>}

    {estimate?.state === 'estimate-only' && <div className={css.layer}>
      <h3>{t('estimateTitle')}</h3>
      <p className={css.hint}>{t('notAQuote')}</p>
      <dl className={css.amounts}>
        <dt>{t('estimatedTotal')}</dt><dd>{estimate.estimatedTotal} {estimate.currency}</dd>
        <dt>{t('recommendedBudget')}</dt><dd>{estimate.recommendedBudget} {estimate.currency}</dd>
        <dt>{t('billingMode')}</dt><dd>{estimate.billingMode}</dd>
      </dl>
      <div className={css.counts}>
        <span className={css.tag}>{t(estimate.balanceEnough ? 'balanceEnough' : 'balanceShort')}</span>
        <span className={css.tag}>{t('taskTypeLabel', { taskType: estimate.taskType })}</span>
      </div>
      <details className={css.fields}>
        <summary>{t('fieldsTitle')}</summary>
        <ul>{Object.entries(estimate.fields).map(([projected, server]) =>
          <li key={projected}>{projected} · {server}</li>)}</ul>
      </details>
      <p className={css.hint}>{t('source', { source: estimate.source })}</p>
    </div>}
    {estimate?.state === 'unavailable' && <p role="alert">{t(failureKey(estimate.failure))}</p>}
  </section>
}
