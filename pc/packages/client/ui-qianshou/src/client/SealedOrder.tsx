/** Read-only order activity: live attempts plus durable, owner-scoped platform receipts. */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { NodeStatusController } from './node-status/controller.ts'
import { createIntakeDashboardTransport, type IntakeDashboardTransport } from './node-status/dashboard-transport.ts'
import type { IntakeDashboardData, IntakeHistoryItem } from './node-status/IntakeDashboard.tsx'
import { orderTaskDescription, orderTaskDuration, orderTaskName } from './node-status/order-task-copy.ts'
import { useNodeState } from './node-status/use-node-state.ts'
import { formatClock, formatDuration, type NodeRunningTask } from './node-status/types.ts'
import css from './SealedOrder.module.css'

export interface OrderAddress {
  readonly shardId: string
  readonly attempt: number
}

/** Navigation state only; never grants the selected task any execution capability. */
export class OrderSelection {
  private current: OrderAddress | null = null
  private readonly listeners = new Set<() => void>()

  select(order: OrderAddress): void {
    this.current = order
    for (const listener of this.listeners) listener()
  }

  readonly snapshot = (): OrderAddress | null => this.current
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

export type OrderSidebarProps = SidebarSectionOwnerProps & PropsLocale<'qianshou.node'> & {
  readonly controller: NodeStatusController
  readonly openOrder: (order: OrderAddress) => void
}

const defaultDashboardTransport = createIntakeDashboardTransport()

/** Short jobs can finish between two live polls, so recent work comes from the platform ledger. */
function useRecentDashboard(workerId: string | null, supplied: IntakeDashboardData | null | undefined,
  transport: IntakeDashboardTransport): IntakeDashboardData | null {
  const [latest, setLatest] = useState<{ readonly workerId: string, readonly data: IntakeDashboardData | null } | null>(null)
  useEffect(() => {
    if (supplied !== undefined || workerId === null) return
    const abort = new AbortController()
    let pending = false
    const read = async (): Promise<void> => {
      if (pending) return
      pending = true
      try {
        const data = await transport.read(workerId, 0, abort.signal)
        if (!abort.signal.aborted) setLatest({ workerId, data })
      } catch {
        if (!abort.signal.aborted) setLatest({ workerId, data: null })
      } finally { pending = false }
    }
    void read()
    const timer = setInterval(() => { void read() }, 10_000)
    return () => { abort.abort(); clearInterval(timer) }
  }, [workerId, supplied, transport])
  return supplied !== undefined ? supplied : latest?.workerId === workerId ? latest.data : null
}

function orderOutcome(item: IntakeHistoryItem, t: OrderSidebarProps['t']): string {
  if (item.status === 'done') return t('outcomeSucceeded')
  if (item.status === 'failed') return t('outcomeFailed')
  if (item.status === 'cancelled') return t('outcomeCanceled')
  return t('intakePending')
}

function orderEarning(item: IntakeHistoryItem, t: OrderSidebarProps['t']): string {
  return item.settled_node_compute_cny === '0.0000'
    ? t('intakeNotSettled') : `${item.settled_node_compute_cny} CNY`
}

/** Reserve sidebar space only while the node reports a genuinely running task. */
export function OrderSidebar({ wide, controller, openOrder, t }: OrderSidebarProps) {
  const state = useNodeState(controller)
  const tasks = state.readout?.kind === 'snapshot' ? state.readout.snapshot.tasks : []
  const task = tasks[0]
  if (!wide || task === undefined) return null
  return <section className={css.sidebar} aria-label={t('ordersTitle')} data-order-sidebar>
    <button type="button" className={css.orderRow}
      aria-label={`${t('orderOpen')} ${task.taskType}`}
      onClick={() => { openOrder({ shardId: task.shardId, attempt: task.attempt }) }}>
      <span className={css.pulse} aria-hidden="true" />
      <span className={css.orderText}><strong>{orderTaskName(task.taskType, t)}</strong>
        <small>{t('ordersActive')} · {task.progressPct}%</small></span>
      {tasks.length > 1 && <span className={css.count} aria-label={`${tasks.length} ${t('ordersUnit')}`}>{tasks.length}</span>}
      <span className={css.chevron} aria-hidden="true">›</span>
    </button>
  </section>
}

type SealedOrderPanelProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'qianshou.node'> & {
  readonly controller: NodeStatusController
  readonly dashboard?: IntakeDashboardData | null
  readonly dashboardTransport?: IntakeDashboardTransport
}

export type SealedOrderMainProps = PropsLocale<'qianshou.node'> & {
  readonly controller: NodeStatusController
  readonly selection: OrderSelection
  readonly dashboard?: IntakeDashboardData | null
  readonly dashboardTransport?: IntakeDashboardTransport
}

function selectedOrder(value: unknown): OrderAddress | null {
  if (typeof value !== 'object' || value === null || !('order' in value)) return null
  const order = value.order
  if (typeof order !== 'object' || order === null || !('shardId' in order) || !('attempt' in order)) return null
  return typeof order.shardId === 'string' && typeof order.attempt === 'number' && Number.isSafeInteger(order.attempt) && order.attempt >= 0
    ? { shardId: order.shardId, attempt: order.attempt }
    : null
}

function Detail({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return <div className={css.detail}><dt>{label}</dt><dd>{children}</dd></div>
}

function observedTask(tasks: readonly NodeRunningTask[], address: OrderAddress | null): NodeRunningTask | null {
  return address === null ? null : tasks.find(task => task.shardId === address.shardId && task.attempt === address.attempt) ?? null
}

function SealedOrderView({ controller, address, t, dashboard: supplied,
  dashboardTransport = defaultDashboardTransport }: {
  readonly controller: NodeStatusController
  readonly address: OrderAddress | null
  readonly t: SealedOrderMainProps['t']
  readonly dashboard?: IntakeDashboardData | null
  readonly dashboardTransport?: IntakeDashboardTransport
}) {
  const state = useNodeState(controller)
  const snapshot = state.readout?.kind === 'snapshot' ? state.readout.snapshot : null
  const task = observedTask(snapshot?.tasks ?? [], address)
  const dashboard = useRecentDashboard(snapshot?.connection.workerId ?? null, supplied, dashboardTransport)
  const receipt = address === null ? null : dashboard?.items.find(item => item.shard_id === address.shardId) ?? null
  return <section className={css.panel} aria-label={t('orderBoxTitle')} data-sealed-order>
    <header className={css.panelHeader}>
      <span className={css.eyebrow}>{t('ordersTitle')}</span>
      <h2>{t('orderBoxTitle')}</h2>
      <span className={css.readOnly}>{task === null && receipt !== null ? t('orderHistoryReadOnly') : t('orderBoxReadOnly')}</span>
      <p>{task === null && receipt !== null ? t('orderHistoryDescription') : t('orderBoxDescription')}</p>
    </header>
    {address === null
      ? <p className={css.notice}>{t('orderBoxNoSelection')}</p>
      : task === null
        ? receipt === null
          ? <p className={css.notice} role="status">{t('orderBoxMissing')}</p>
          : <div className={css.panelBody} data-order-receipt>
            <div className={css.liveHeading}><span className={css.receiptDot} aria-hidden="true" />
              <strong>{orderTaskName(receipt.task_type, t)}</strong><span>{orderOutcome(receipt, t)}</span></div>
            <p className={css.receiptDescription}>{orderTaskDescription(receipt.task_type, t)}</p>
            <dl className={css.details}>
              <Detail label={t('orderBoxTask')}><code>{receipt.workload_id}</code></Detail>
              <Detail label={t('orderBoxType')}><code>{receipt.task_type}</code></Detail>
              <Detail label={t('orderHistoryEarning')}>{orderEarning(receipt, t)}</Detail>
              <Detail label={t('orderBoxStarted')}>{receipt.started_at === null ? t('intakeTimeUnknown') : formatClock(receipt.started_at)}</Detail>
              <Detail label={t('orderHistoryFinished')}>{receipt.completed_at === null ? t('intakeTimeUnknown') : formatClock(receipt.completed_at)}</Detail>
              <Detail label={t('orderBoxElapsed')}>{orderTaskDuration(receipt.elapsed_ms, t)}</Detail>
              <Detail label={t('orderBoxAttempt')}>{receipt.attempts}</Detail>
              <Detail label={t('orderBoxNode')}>{dashboard?.worker_id ?? t('orderBoxNoNode')}</Detail>
            </dl>
            <p className={css.evidence}>{t('orderHistoryEvidence')}</p>
          </div>
        : <div className={css.panelBody}>
          <div className={css.liveHeading}><span className={css.liveDot} aria-hidden="true" /><strong>{task.taskType}</strong><span>{task.progressPct}%</span></div>
          <div className={css.progressTrack} role="progressbar" aria-valuenow={task.progressPct} aria-valuemin={0} aria-valuemax={100} aria-label={t('orderBoxProgress')}>
            <span style={{ width: `${Math.max(0, Math.min(100, task.progressPct))}%` }} />
          </div>
          <dl className={css.details}>
            <Detail label={t('orderBoxTask')}><code>{task.workloadId}.{task.shardId}</code></Detail>
            <Detail label={t('orderBoxType')}>{task.taskType}</Detail>
            <Detail label={t('orderBoxPlugin')}>{t('orderBoxPluginUnknown')}</Detail>
            <Detail label={t('orderBoxPrice')}>{t('orderBoxUnknown')}</Detail>
            <Detail label={t('orderBoxEta')}>{t('orderBoxUnknown')}</Detail>
            <Detail label={t('orderBoxStarted')}>{formatClock(task.startedAt)}</Detail>
            <Detail label={t('orderBoxElapsed')}>{formatDuration(task.elapsedMs / 1000)}</Detail>
            <Detail label={t('orderBoxAttempt')}>{task.attempt}</Detail>
            <Detail label={t('orderBoxNode')}>{snapshot?.connection.workerId ?? t('orderBoxNoNode')}</Detail>
          </dl>
          <p className={css.evidence}>{t('orderBoxEvidence')}</p>
        </div>}
  </section>
}

/** Dedicated dock tab with no input, command, power or abort control. */
export function SealedOrderPanel({ controller, useTabInfo, t, dashboard, dashboardTransport }: SealedOrderPanelProps) {
  const tab = useTabInfo().tab
  return <SealedOrderView controller={controller} address={selectedOrder(tab.navigation.params)} t={t}
    {...(dashboard === undefined ? {} : { dashboard })}
    {...(dashboardTransport === undefined ? {} : { dashboardTransport })} />
}

/** When no conversation Session is mounted, the same sealed view opens in the main column. */
export function SealedOrderMain({ controller, selection, t, dashboard, dashboardTransport }: SealedOrderMainProps) {
  const address = useSyncExternalStore(selection.subscribe, selection.snapshot, selection.snapshot)
  return <SealedOrderView controller={controller} address={address} t={t}
    {...(dashboard === undefined ? {} : { dashboard })}
    {...(dashboardTransport === undefined ? {} : { dashboardTransport })} />
}
