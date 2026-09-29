/**
 * U1 显示面：主人打开面板就能看到"节点在不在、在跑什么、跑到哪、结算了几单、为什么被拒"。
 * 五态标签（运行中/在线待命/重连中/节点未运行/从未启动）各自不同；收益**照实显示缺报价**，绝不编数字。
 */
import type { ReactNode } from 'react'
import type { NodeAlertKind, NodeStatusController } from './controller.ts'
import { RunningCat } from './RunningCat.tsx'
import { useNodeState } from './use-node-state.ts'
import {
  earningsNumber, formatClock, formatDuration, verificationKey,
  type NodeOutcomeKind, type NodePhase, type NodeStatusSnapshot, type NodeUnreachableCode, type NodeVerificationKey,
} from './types.ts'
import type { NodeCopyKey } from './locales.ts'
import { h3VideoStatusKey } from './h3-status-copy.ts'
import { h3TrialBlocksIntake } from './h3-status.ts'
import css from './node-status.module.css'

/** 文案取值口（框架给的 `t` 就是它；键受本命名空间约束）。 */
export type NodeTranslate = (key: NodeCopyKey) => string

/** 显示面 props。 */
export interface NodeStatusPanelProps {
  /** 状态控制器（由注册点注入，两个挂载点共用同一个实例）。 */
  readonly controller: NodeStatusController
  /** 文案。 */
  readonly t: NodeTranslate
  /** 减少动效开关；不传就自己侦测。 */
  readonly reducedMotion?: boolean
  /** Intake home already shows live tasks; keep process diagnostics below its fold. */
  readonly diagnosticsOnly?: boolean
}

const PHASE_COPY: Record<NodePhase, NodeCopyKey> = {
  'never-started': 'phaseNeverStarted',
  'offline': 'phaseOffline',
  'not-wired': 'phaseNotWired',
  'running': 'phaseRunning',
  'standby': 'phaseStandby',
  'connecting': 'phaseConnecting',
  'link-failed': 'phaseLinkFailed',
}

const PROGRESS_PHASE_COPY = {
  started: 'progressStarted',
  working: 'progressWorking',
  done: 'progressDone',
} as const satisfies Record<'started' | 'working' | 'done', NodeCopyKey>

function progressPhaseKey(phase: 'started' | 'working' | 'done'): NodeCopyKey {
  return PROGRESS_PHASE_COPY[phase]
}

const PHASE_HINT: Record<NodePhase, NodeCopyKey> = {
  'never-started': 'phaseNeverStartedHint',
  'offline': 'phaseOfflineHint',
  'not-wired': 'phaseNotWiredHint',
  'running': 'phaseOfflineHint',
  'standby': 'phaseOfflineHint',
  'connecting': 'phaseOfflineHint',
  'link-failed': 'phaseOfflineHint',
}

const CONNECTION_COPY: Record<string, NodeCopyKey> = {
  online: 'connectionOnline', connecting: 'connectionConnecting', offline: 'connectionOffline',
}

const OUTCOME_COPY: Record<NodeOutcomeKind, NodeCopyKey> = {
  succeeded: 'outcomeSucceeded', refused: 'outcomeRefused', failed: 'outcomeFailed', 'canceled-by-owner': 'outcomeCanceled',
}

const VERIFICATION_COPY: Record<NodeVerificationKey, NodeCopyKey> = {
  settleable: 'verificationSettleable', retryable: 'verificationRetryable',
  retained: 'verificationRetained', indeterminate: 'verificationIndeterminate', unpolled: 'verificationUnpolled',
}

/** 四类事件 + 三个必须分开说的分支 → 文案。 */
const ALERT_COPY: Record<NodeAlertKind, NodeCopyKey> = {
  offer: 'alertOffer', started: 'alertStarted', finished: 'alertFinished',
  'finished-unverified': 'alertFinishedUnverified', failed: 'alertFailed', refused: 'alertRefused', canceled: 'alertCanceled',
}

function powerNote(power: { readonly running: boolean, readonly code?: string } | null): NodeCopyKey | null {
  if (power === null || power.running || power.code === undefined) return null
  if (power.code === 'NODE_SWITCH_NO_SESSION') return 'powerNeedLogin'
  if (power.code === 'NODE_SWITCH_NO_REPO') return 'powerNoProgram'
  if (power.code === 'NODE_SWITCH_SPAWN_FAILED' || power.code === 'NODE_SWITCH_TOKEN_IN_ARGV') return 'powerFailed'
  if (power.code === 'NODE_AGENT_UNAVAILABLE') return 'powerNoAgent'
  return null
}

/** 读不到的原因 → 文案：中继没接线与节点没跑**分开说**。 */
const UNREACHABLE_COPY: Record<NodeUnreachableCode, NodeCopyKey> = {
  NODE_UNREACHABLE: 'phaseOffline', RELAY_MISSING: 'phaseNotWired', RELAY_REFUSED: 'phaseNotWired', BAD_PAYLOAD: 'phaseNotWired',
}

/**
 * 节点状态面板（主区 panelId 占据者）。
 * @param props - 控制器、文案与减少动效开关。
 * @returns 面板。
 */
export function NodeStatusPanel({ controller, t, reducedMotion, diagnosticsOnly = false }: NodeStatusPanelProps) {
  const state = useNodeState(controller)
  const snapshot = state.readout?.kind === 'snapshot' ? state.readout.snapshot : null
  const unreachable = state.readout?.kind === 'unreachable' ? state.readout : null
  const note = powerNote(state.power)
  return (
    <section className={css.panel} data-node-status data-node-diagnostics={diagnosticsOnly ? 'true' : undefined}>
      <header className={css.header}>
        <h2 className={css.title}>{t('title')}</h2>
        <span className={css.intakeDiagnostic} data-node-power={state.power?.running === true ? 'on' : 'off'}>
          {state.power?.running === true ? t('intakeLocalAdmitted') : t('intakeLocalPaused')}
        </span>
        <span className={css.phase} data-node-phase={state.phase}>{t(PHASE_COPY[state.phase])}</span>
        {state.alertsEnabled
          ? null
          : <button type="button" className={css.linkButton} onClick={() => { controller.enableAlerts() }}>{t('enableAlerts')}</button>}
      </header>
      {state.alert === null
        ? null
        : (
          <div className={css.alert} data-node-alert={state.alert.kind} role="status">
            <span className={css.alertBadge}>{t(ALERT_COPY[state.alert.kind])}</span>
            {state.alert.shardId === null ? null : <code className={css.mono}>{state.alert.shardId}</code>}
            {state.alert.detail === null ? null : <span className={css.alertDetail}>{state.alert.detail}</span>}
            <button type="button" className={css.dismissButton} onClick={() => { controller.dismissAlerts() }}>{t('dismissAlert')}</button>
          </div>
        )}
      {state.alertsEnabled ? null : <p className={css.hint} data-node-alerts-off>{t('alertsOff')} · {t('alertsOffNote')}</p>}
      {note === null ? null : <p className={css.hint} data-node-power-note>{t(note)}</p>}
      {snapshot === null
        ? (
          <p className={css.empty} data-node-empty>
            {t(unreachable === null ? PHASE_HINT[state.phase] : UNREACHABLE_COPY[unreachable.code])}
            {unreachable?.message === undefined ? null : <span className={css.detail}>{unreachable.message}</span>}
          </p>
        )
        : (
          <>
            <ConnectionBlock snapshot={snapshot} t={t} />
            {snapshot.h3Video !== undefined && (snapshot.h3Video.configured || h3TrialBlocksIntake(snapshot.h3Video)) && (
              <section className={css.block} data-node-h3-preflight={snapshot.h3Video.ready ? 'passed' : 'not-ready'}>
                <h3 className={css.blockTitle}>{t('h3PreflightTitle')}</h3>
                <p role="status">{t(h3VideoStatusKey(snapshot.h3Video))}</p>
                <p className={css.hint}>{t('h3PreflightScope')}</p>
              </section>
            )}
            {diagnosticsOnly ? null : <CurrentBlock snapshot={snapshot} t={t} controller={controller} {...(reducedMotion === undefined ? {} : { reducedMotion })} />}
            {diagnosticsOnly ? null : <CountersBlock snapshot={snapshot} t={t} />}
            <RefusalBlock snapshot={snapshot} t={t} />
            {diagnosticsOnly ? null : <RecentBlock snapshot={snapshot} t={t} />}
            {diagnosticsOnly ? null : <EarningsBlock snapshot={snapshot} t={t} />}
            {state.lastCommand === null
              ? null
              : (
                <p className={css.hint} data-node-command={state.lastCommand.code}>
                  {state.lastCommand.ok ? t('commandSent') : t('commandFailed')} · <code className={css.mono}>{state.lastCommand.code}</code>
                </p>
              )}
          </>
        )}
    </section>
  )
}

function Row({ label, value }: { label: string, value: ReactNode }) {
  return (
    <li className={css.row}>
      <span className={css.rowLabel}>{label}</span>
      <span className={css.rowValue}>{value}</span>
    </li>
  )
}

function Stat({ label, value, tone }: { label: string, value: number, tone?: 'ok' | 'bad' }) {
  return (
    <li className={css.stat} {...(tone === undefined || value === 0 ? {} : { 'data-tone': tone })}>
      <span className={css.statValue}>{String(value)}</span>
      <span className={css.statLabel}>{label}</span>
    </li>
  )
}

function ConnectionBlock({ snapshot, t }: { snapshot: NodeStatusSnapshot, t: NodeTranslate }) {
  const { connection, uptimeSeconds } = snapshot
  return (
    <section className={css.block} data-node-connection={connection.state}>
      <h3 className={css.blockTitle}>{t('connectionTitle')}</h3>
      <ul className={css.rows}>
        <Row label={t('connectionTitle')} value={t(CONNECTION_COPY[connection.state] ?? 'connectionOffline')} />
        <Row label={t('onlineFor')} value={formatDuration(connection.onlineSeconds ?? 0)} />
        <Row label={t('processUptime')} value={formatDuration(uptimeSeconds)} />
        <Row label={t('core')} value={connection.core} />
        <Row label={t('workerId')} value={connection.workerId === null ? '—' : <code className={css.mono}>{connection.workerId}</code>} />
        <Row label={t('ownerId')} value={connection.ownerId === null ? '—' : String(connection.ownerId)} />
        <Row label={t('mode')} value={t(connection.mode === 'paused' ? 'modePaused' : 'modeRunning')} />
        {connection.reason === null ? null : <Row label={t('refusalReason')} value={connection.reason} />}
      </ul>
    </section>
  )
}

function CurrentBlock({ snapshot, t, controller, reducedMotion }: {
  snapshot: NodeStatusSnapshot, t: NodeTranslate, controller: NodeStatusController, reducedMotion?: boolean
}) {
  const current = snapshot.current
  // 跑完不留痕会让人以为节点死了 —— 空时退回展示「最近一次执行」（本轮 A 项修复）。
  const lastRun = snapshot.recent[0] ?? null
  return (
    <section className={css.block} data-node-current={current === null ? 'none' : current.shardId} data-attempt={current?.attempt ?? 0}>
      <h3 className={css.blockTitle}>{t('currentTitle')}</h3>
      {current === null
        ? (lastRun === null
            ? <p className={css.emptySmall}>{t('currentNone')}</p>
            : (
              <>
                <p className={css.runningLine}>
                  <strong>{lastRun.taskType}</strong>
                  <span className={css.pct} data-node-last-outcome={lastRun.outcome}>{lastRun.outcome}</span>
                </p>
                <ul className={css.rows}>
                  <Row label={t('shard')} value={<code className={css.mono}>{lastRun.shardId}</code>} />
                  <Row label={t('elapsed')} value={formatDuration((lastRun.durationMs ?? 0) / 1000)} />
                  <Row label={t('startedAt')} value={formatClock(lastRun.at)} />
                  <Row label={t('verification')} value={lastRun.verification ?? '-'} />
                </ul>
                <p className={css.hint}>{t('lastRunHint')}</p>
              </>
            ))
        : (
          <>
            <p className={css.runningLine}>
              <RunningCat {...(reducedMotion === undefined ? {} : { reducedMotion })} />
              <strong>{current.taskType}</strong>
              {current.phase === undefined ? null : <span className={css.pct}>{t(progressPhaseKey(current.phase))}</span>}
              <span className={css.pct}>{`${String(current.progressPct)}%`}</span>
            </p>
            <div className={css.bar}><span className={css.barFill} style={{ width: `${String(Math.max(0, Math.min(100, current.progressPct)))}%` }} /></div>
            <ul className={css.rows}>
              <Row label={t('shard')} value={<code className={css.mono}>{current.shardId}</code>} />
              <Row label={t('attempt')} value={String(current.attempt)} />
              <Row label={t('startedAt')} value={formatClock(current.startedAt)} />
              <Row label={t('elapsed')} value={formatDuration(current.elapsedMs / 1000)} />
              <Row label={t('progressEvents')} value={String(current.progressEvents)} />
            </ul>
            <div className={css.actions}>
              <button type="button" className={css.danger} onClick={() => { void controller.abort(current.shardId) }}>{t('abortShard')}</button>
              <button type="button" className={css.danger} onClick={() => { void controller.abort('all') }}>{t('abortAll')}</button>
            </div>
            <p className={css.hint}>{t('abortHint')}</p>
          </>
        )}
    </section>
  )
}

function CountersBlock({ snapshot, t }: { snapshot: NodeStatusSnapshot, t: NodeTranslate }) {
  const counters = snapshot.counters
  return (
    <section className={css.block} data-node-counters>
      <h3 className={css.blockTitle}>{t('countersTitle')}</h3>
      <ul className={css.stats}>
        <Stat label={t('counterOffers')} value={counters.offersReceived} />
        <Stat label={t('counterAccepted')} value={counters.accepted} />
        <Stat label={t('counterSucceeded')} value={counters.succeeded} tone="ok" />
        <Stat label={t('counterFailed')} value={counters.failed} tone="bad" />
        <Stat label={t('counterRejected')} value={counters.rejected} tone="bad" />
        <Stat label={t('counterCanceled')} value={counters.canceledByOwner} />
      </ul>
    </section>
  )
}

function RefusalBlock({ snapshot, t }: { snapshot: NodeStatusSnapshot, t: NodeTranslate }) {
  const refusal = snapshot.lastRefusal
  return (
    <section className={css.block} data-node-refusal={refusal?.kind ?? 'none'}>
      <h3 className={css.blockTitle}>{t('lastRefusalTitle')}</h3>
      {refusal === null
        ? <p className={css.emptySmall}>{t('lastRefusalNone')}</p>
        : (
          <ul className={css.rows}>
            <Row label={t('shard')} value={<code className={css.mono}>{refusal.shardId}</code>} />
            <Row label={t('refusalCode')} value={<code className={css.mono}>{refusal.code}</code>} />
            <Row label={t('refusalReason')} value={refusal.reason} />
            <Row label={t('startedAt')} value={formatClock(refusal.at)} />
          </ul>
        )}
    </section>
  )
}

function RecentBlock({ snapshot, t }: { snapshot: NodeStatusSnapshot, t: NodeTranslate }) {
  return (
    <section className={css.block} data-node-recent>
      <h3 className={css.blockTitle}>{t('recentTitle')}</h3>
      {snapshot.recent.length === 0
        ? <p className={css.emptySmall}>{t('recentNone')}</p>
        : (
          <ul className={css.recent}>
            {snapshot.recent.map(record => (
              <li key={`${record.shardId}-${record.at}`} className={css.recentRow} data-outcome={record.outcome}>
                <span className={css.recentTop}>
                  <span className={css.recentOutcome} data-outcome-kind={record.outcome}>{t(OUTCOME_COPY[record.outcome])}</span>
                  <span className={css.recentType}>{record.taskType}</span>
                </span>
                <code className={css.mono}>{record.shardId}</code>
                <span className={css.recentMeta}>
                  <span className={css.recentTime}>{formatClock(record.at)}</span>
                  <span className={css.recentTime}>{formatDuration(record.durationMs / 1000)}</span>
                  <span className={css.verification} data-verification={record.verification ?? 'unpolled'}>
                    {t('verification')} {t(VERIFICATION_COPY[verificationKey(record.verification)])}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
    </section>
  )
}

function EarningsBlock({ snapshot, t }: { snapshot: NodeStatusSnapshot, t: NodeTranslate }) {
  // 这一格永远没有数字：派单帧不带报价，编一个收益就是缺陷（反向回归闸见测试）。
  const amount = earningsNumber(snapshot)
  return (
    <section
      className={css.block}
      data-node-earnings={amount === null ? 'null' : 'value'}
      data-node-earnings-note={snapshot.earnings.note}
      title={snapshot.earnings.note}
    >
      <h3 className={css.blockTitle}>{t('earningsTitle')}</h3>
      <p className={css.earnings}>{t('earningsMissing')}</p>
      <p className={css.emptySmall}>{t('earningsExplain')}</p>
      <p className={css.hint}>{t('earningsBasis')} <code className={css.mono}>{snapshot.earnings.basis}</code></p>
    </section>
  )
}
