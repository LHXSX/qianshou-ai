/** Owner-only receipts for the intake home. The Host must validate and redact server data. */
import type { NodeTranslate } from './NodeStatusPanel.tsx'
import { orderTaskDescription, orderTaskDuration, orderTaskName } from './order-task-copy.ts'
import { formatClock } from './types.ts'
import css from './node-status.module.css'

export interface IntakeMoney {
  readonly amount: string
  readonly currency: string
}

export interface IntakeHistoryItem {
  readonly shard_id: string
  readonly workload_id: string
  readonly task_type: string
  readonly status: string
  readonly attempts: number
  readonly dispatched_at: string | null
  readonly started_at: string | null
  readonly completed_at: string | null
  readonly elapsed_ms: number | null
  readonly settled_node_compute_cny: string
}

/** Optional until the authenticated Shanghai dashboard route is wired into the Host. */
export interface IntakeDashboardData {
  readonly schema: 'qianshou.node-dashboard.v1'
  readonly worker_id: string
  readonly history_scope: 'current_shard_assignment'
  readonly counts: {
    readonly executions: number
    readonly orders: number
    readonly succeeded: number
    readonly failed: number
    readonly cancelled: number
    readonly pending_resolution: number
    readonly avg_success_elapsed_ms: number | null
  }
  readonly earnings: { readonly currency: 'CNY', readonly settled_node_compute: string }
  readonly plugin_calls: number | null
  readonly plugin_calls_note: string
  readonly total: number
  readonly limit: number
  readonly offset: number
  readonly items: readonly IntakeHistoryItem[]
}

export type IntakeDashboardPhase = 'pending' | 'missing-worker' | 'loading' | 'ready' | 'unavailable'

function phaseCopy(phase: IntakeDashboardPhase, t: NodeTranslate): string {
  if (phase === 'unavailable') return t('intakeDataUnavailable')
  if (phase === 'loading') return t('intakeSyncing')
  if (phase === 'missing-worker') return t('intakeNeedNode')
  return t('intakeAwaitingSync')
}

function money(value: IntakeMoney | null): string | null {
  if (value === null || !/^\d+(?:\.\d{1,4})?$/u.test(value.amount) || !/^[A-Z]{3,10}$/u.test(value.currency)) return null
  return `${value.amount} ${value.currency}`
}

function Metric({ label, value, note }: { label: string, value: string, note: string }) {
  return <div className={css.intakeMetric}>
    <span className={css.intakeMetricLabel}>{label}</span>
    <strong className={css.intakeMetricValue}>{value}</strong>
    <span className={css.intakeMetricNote}>{note}</span>
  </div>
}

/** Historical figures are never inferred from node-process counters or an offer frame. */
export function IntakeOverview({ dashboard, phase, t }: { dashboard: IntakeDashboardData | null | undefined, phase: IntakeDashboardPhase, t: NodeTranslate }) {
  const counts = dashboard?.counts
  const earned = dashboard === null || dashboard === undefined ? null : money({ amount: dashboard.earnings.settled_node_compute, currency: dashboard.earnings.currency })
  const missing = phaseCopy(phase, t)
  return <section className={css.intakeOverview} aria-labelledby="intake-overview-title">
    <div className={css.intakeSectionHead}>
      <div><span className={css.intakeSectionEyebrow}>{t('intakeOverviewEyebrow')}</span><h2 id="intake-overview-title">{t('intakeOverviewTitle')}</h2></div>
      <span className={css.intakeSourceTag}>{dashboard == null ? missing : t('intakePlatformReceipt')}</span>
    </div>
    <div className={css.intakeMetrics}>
      <Metric label={t('intakeOrdersMetric')} value={counts === undefined ? '—' : counts.orders === 0 ? t('intakeNoOrders') : String(counts.orders)} note={counts === undefined ? missing : `${String(counts.executions)} ${t('intakeExecutionsNote')}`} />
      <Metric label={t('intakeOutcomeMetric')} value={counts === undefined ? '—' : counts.executions === 0 ? t('intakeNoOutcome') : `${String(counts.succeeded)} / ${String(counts.failed)}`} note={counts === undefined ? missing : `${t('intakeAverageDuration')} ${orderTaskDuration(counts.avg_success_elapsed_ms, t)}`} />
      <Metric label={t('intakeIncomeMetric')} value={earned ?? '—'} note={earned === null ? dashboard == null ? missing : t('intakeAwaitingLedger') : t('intakeIncomeNote')} />
      <Metric label={t('intakePluginMetric')} value={dashboard?.plugin_calls == null ? '—' : String(dashboard.plugin_calls)} note={dashboard?.plugin_calls == null ? t('intakePluginUnverified') : t('intakePluginNote')} />
    </div>
  </section>
}

export function IntakeHistory({ dashboard, phase, t, onRefresh, onPrevious, onNext }: {
  dashboard: IntakeDashboardData | null | undefined
  phase: IntakeDashboardPhase
  t: NodeTranslate
  onRefresh?: () => void
  onPrevious?: () => void
  onNext?: () => void
}) {
  return <section className={css.intakeCard} aria-labelledby="intake-history-title">
    <div className={css.intakeCardHead}>
      <div><span className={css.intakeSectionEyebrow}>{t('intakePlatformSource')}</span><h2 id="intake-history-title">{t('intakeHistoryTitle')}</h2></div>
      <div className={css.intakeCardActions}>
        {dashboard == null ? null : <span className={css.intakeSourceTag}>{t('intakeHistoryCurrent')}</span>}
        {onRefresh === undefined ? null : <button type="button" className={css.intakeSmallButton} onClick={onRefresh} disabled={phase === 'loading'}>{t('intakeRefresh')}</button>}
      </div>
    </div>
    {dashboard == null
      ? <p className={css.intakeEmpty} role={phase === 'unavailable' ? 'status' : undefined}>{phase === 'unavailable' ? t('intakeHistoryUnavailable') : phase === 'loading' ? t('intakeHistoryLoading') : phase === 'missing-worker' ? t('intakeHistoryNeedNode') : t('intakeHistoryAwaiting')}</p>
      : dashboard.items.length === 0
        ? <p className={css.intakeEmpty}>{t('intakeHistoryEmpty')}</p>
        : <ul className={css.intakeHistoryList}>{dashboard.items.map(item => <li className={css.intakeHistoryItem} key={item.shard_id}>
          <div className={css.intakeHistoryTop}><strong>{orderTaskName(item.task_type, t)}</strong><span data-order-outcome={item.status === 'done' ? 'succeeded' : item.status}>{t(item.status === 'done' ? 'outcomeSucceeded' : item.status === 'failed' ? 'outcomeFailed' : item.status === 'cancelled' ? 'outcomeCanceled' : item.status === 'pending' || item.status === 'dispatched' || item.status === 'running' ? 'intakePending' : 'intakeOutcomeUnknown')}</span></div>
          <p className={css.intakeHistorySummary}>{orderTaskDescription(item.task_type, t)}</p>
          <div className={css.intakeHistoryMeta}>
            <span>{item.completed_at === null && item.started_at === null && item.dispatched_at === null ? t('intakeTimeUnknown') : formatClock(item.completed_at ?? item.started_at ?? item.dispatched_at ?? '')}</span>
            <span>{orderTaskDuration(item.elapsed_ms, t)}</span>
            <strong>{t('orderHistoryEarning')} · {item.settled_node_compute_cny === '0.0000' ? t('intakeNotSettled') : money({ amount: item.settled_node_compute_cny, currency: 'CNY' }) ?? t('intakeEarningUnknown')}</strong>
          </div>
          <details className={css.intakeHistoryDetail}>
            <summary>{t('orderHistoryOpen')}</summary>
            <dl>
              <div><dt>{t('orderBoxTask')}</dt><dd><code>{item.workload_id}</code></dd></div>
              <div><dt>{t('orderBoxType')}</dt><dd><code>{item.task_type}</code></dd></div>
              <div><dt>{t('orderBoxStarted')}</dt><dd>{item.started_at === null ? t('intakeTimeUnknown') : formatClock(item.started_at)}</dd></div>
              <div><dt>{t('orderHistoryFinished')}</dt><dd>{item.completed_at === null ? t('intakeTimeUnknown') : formatClock(item.completed_at)}</dd></div>
              <div><dt>{t('orderBoxAttempt')}</dt><dd>{item.attempts}</dd></div>
            </dl>
          </details>
        </li>)}</ul>}
    {dashboard === null || dashboard === undefined || dashboard.total <= dashboard.limit ? null : <div className={css.intakePagination}>
      <span>{`${String(dashboard.offset + (dashboard.items.length === 0 ? 0 : 1))}–${String(dashboard.offset + dashboard.items.length)} / ${String(dashboard.total)}`}</span>
      <div>
        <button type="button" className={css.intakeSmallButton} onClick={onPrevious} disabled={onPrevious === undefined || dashboard.offset === 0}>{t('intakePrevious')}</button>
        <button type="button" className={css.intakeSmallButton} onClick={onNext} disabled={onNext === undefined || dashboard.offset + dashboard.items.length >= dashboard.total}>{t('intakeNext')}</button>
      </div>
    </div>}
  </section>
}
