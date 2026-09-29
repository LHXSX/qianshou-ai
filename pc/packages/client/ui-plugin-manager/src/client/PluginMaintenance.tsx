/** Explicit Host loading checks and inspected updates for one local bundle. */
import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PluginUpdateInspection } from '@deepseek-ai/dsh-plugin-manager/types'
import type { PackageView } from './manager-store.ts'
import type { LoadingCheck } from './loading-checks.ts'
import { managementText, type Translate } from './presentation.ts'
import css from './PluginMaintenance.module.css'

const CHECK_LABELS = { active: 'loadingCheckActive', disabled: 'loadingCheckDisabled', incomplete: 'loadingCheckIncomplete', failed: 'loadingCheckFailed', missing: 'loadingCheckMissing' } as const
const ROW_LABELS = { active: 'rowPhaseActive', pending: 'rowPhasePending', loading: 'rowPhaseLoading', failed: 'rowPhaseFailed', unloading: 'rowPhaseUnloading' } as const

/** Loading verification does not invoke a plugin's business API or certify its safety. */
export function PluginMaintenance({ pkg, t, busy, check, onCheck, onUpdate }: {
  readonly pkg: PackageView
  readonly t: Translate
  readonly busy: boolean
  readonly check: LoadingCheck | undefined
  readonly onCheck: () => void
  readonly onUpdate: () => void
}): ReactNode {
  const checking = check?.status === 'checking'
  const result = check?.status === 'checked' ? check.result : undefined
  return <section className={css.section} data-plugin-maintenance>
    <div className={css.actions}>
      <Button variant="outline" size="sm" disabled={busy || checking} aria-busy={checking} onClick={onCheck}>{t(checking ? 'loadingCheckRunning' : 'loadingCheckAction')}</Button>
      {pkg.installed && pkg.canUpdate !== false && pkg.readOnlyReason === undefined ? <Button variant="outline" size="sm" disabled={busy} onClick={onUpdate}>{t('updateAction')}</Button> : null}
    </div>
    <p className={css.note}>{t('loadingCheckScope')}</p>
    {check?.status === 'failed' ? <p role="alert" className={css.error}>{t('loadingCheckError', { reason: check.reason })}</p> : null}
    {result === undefined ? null : <div className={css.result} data-plugin-loading-check={result.state}>
      <p role="status">{t(CHECK_LABELS[result.state])}</p>
      <p className={css.note}>{t('loadingCheckTime', { time: new Date(result.checkedAt).toLocaleString() })}</p>
      {result.errors.map((error, index) => <p key={index} className={css.error}>{managementText(error, t)}</p>)}
      <details><summary>{t('partsCountTotal', { count: String(result.rows.length) })}</summary>
        <ul className={css.rows}>{result.rows.map((row, index) => <li key={`${row.rowId}:${index}`}>
          <code>{row.rowId}</code><span>{t(row.phase === null ? 'rowStateIdle' : ROW_LABELS[row.phase])}</span>
        </li>)}</ul>
      </details>
    </div>}
  </section>
}

/** Confirm a Host-inspected, same-name exact version without changing the saved enablement. */
export function UpdateReviewDialog({ inspection, t, onConfirm, onEdit, onClose }: {
  readonly inspection: Extract<PluginUpdateInspection, { status: 'accepted' }>
  readonly t: Translate
  readonly onConfirm: () => void
  readonly onEdit: () => void
  readonly onClose: () => void
}): ReactNode {
  return <Modal open title={t('updateReviewTitle')} closeLabel={t('close')} onClose={onClose}
    footer={<div className={css.actions}><Button variant="outline" onClick={onEdit}>{t('installEdit')}</Button><Button variant="primary" onClick={onConfirm}>{t('updateConfirm')}</Button></div>}>
    <div className={css.result}>
      <code>{inspection.target.name}</code>
      <p>{t('updateVersionChange', { current: inspection.current.version, target: inspection.target.version })}</p>
      <p>{t('updatePreservesSelection', { state: t(inspection.current.enabled ? 'catalogFilterEnabled' : 'catalogDisabled') })}</p>
      <p className={css.note}>{t('updateRestartScope')}</p>
      <p className={css.note}>{t('installGuideSafety')}</p>
    </div>
  </Modal>
}
