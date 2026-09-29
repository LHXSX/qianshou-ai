/** A stable, session-independent home for the owner's existing intake controls. */
import { useEffect, useState } from 'react'
import { beginRetainedRead, failRetainedRead } from '../retained-read.ts'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { NodeStatusController } from './controller.ts'
import { NodeStatusPanel, type NodeTranslate } from './NodeStatusPanel.tsx'
import { OrderSourcesPanel } from './OrderSourcesPanel.tsx'
import { H3OwnerWizard } from './H3OwnerWizard.tsx'
import { H3CanonicalOwnerWizard } from './H3CanonicalOwnerWizard.tsx'
import type { H3CanonicalSetupTransport } from './h3-canonical-setup-transport.ts'
import { h3TrialBlocksIntake } from './h3-status.ts'
import { h3VideoStatusKey } from './h3-status-copy.ts'
import type { H3OwnerSetupTransport } from './h3-owner-setup-transport.ts'
import { IntakeHistory, IntakeOverview, type IntakeDashboardData, type IntakeDashboardPhase } from './IntakeDashboard.tsx'
import { createIntakeDashboardTransport, type IntakeDashboardTransport } from './dashboard-transport.ts'
import type { IntakeOrderSources, IntakeSupplyOrder, IntakeSupplyTransport } from './supply-transport.ts'
import { useNodeState } from './use-node-state.ts'
import { formatDuration, type NodePhase, type NodeStatusSnapshot } from './types.ts'
import css from './node-status.module.css'

export interface NodeIntakePageProps {
  readonly controller: NodeStatusController
  readonly t: NodeTranslate
  /** Authenticated platform data; absence means not yet synced, not zero orders. */
  readonly dashboard?: IntakeDashboardData | null
  /** Saved owner policy and local admission are deliberately read from their real Host services. */
  readonly supplyTransport?: IntakeSupplyTransport
  /** Same-origin Host reader, injectable for focused tests. */
  readonly dashboardTransport?: IntakeDashboardTransport
  /** Opens the existing skill assistant with an editable plan for this installed ability. */
  readonly planOrderAdapter?: (prompt: string) => Promise<boolean>
  /** Opens owner publication management without submitting or enabling anything. */
  readonly onManagePublication?: (sourceId: string) => boolean
  readonly onOpenSharing?: () => void
  /** Explicit local H3 setup; reading this transport never generates or publishes. */
  readonly h3SetupTransport?: H3OwnerSetupTransport
  /** Canonical setup has separate trials and never selects a legacy provider. */
  readonly h3CanonicalTransport?: H3CanonicalSetupTransport
}

interface DashboardLoad {
  readonly transport: IntakeDashboardTransport
  readonly workerId: string
  readonly ownerId: number | null
  readonly offset: number
  readonly revision: number
  readonly phase: 'loading' | 'ready' | 'unavailable'
  readonly data: IntakeDashboardData | null
}

interface SupplyLoad {
  readonly transport: IntakeSupplyTransport | undefined
  readonly workerId: string | null
  readonly ownerId: number | null
  readonly phase: 'loading' | 'ready' | 'unavailable'
  readonly order: IntakeSupplyOrder | null
}

interface SourceLoad {
  readonly transport: IntakeSupplyTransport | undefined
  readonly workerId: string | null
  readonly ownerId: number | null
  readonly phase: 'loading' | 'ready' | 'unavailable'
  readonly data: IntakeOrderSources | null
}

const defaultDashboardTransport = createIntakeDashboardTransport()

const PHASE_COPY: Record<NodePhase, Parameters<NodeTranslate>[0]> = {
  'never-started': 'phaseNeverStarted', offline: 'phaseOffline', 'not-wired': 'phaseNotWired',
  running: 'phaseRunning', standby: 'phaseStandby', connecting: 'phaseConnecting', 'link-failed': 'phaseLinkFailed',
}

/** Owner admission reasons come from the live local node, never from the saved grant. */
function localPauseReason(snapshot: NodeStatusSnapshot | null): Parameters<NodeTranslate>[0] | null {
  if (snapshot === null || snapshot.connection.mode === 'running') return null
  const reasons = snapshot.intakeReasons ?? []
  if (reasons.includes('USER_ACTIVE')) return 'intakeUserActiveReason'
  if (reasons.includes('FOREGROUND_PRIORITY')) return 'intakeForegroundReason'
  if (reasons.includes('VOICE_ACTIVE')) return 'intakeVoiceActiveReason'
  if (snapshot.h3Video !== undefined && h3TrialBlocksIntake(snapshot.h3Video)) return h3VideoStatusKey(snapshot.h3Video)
  if (reasons.includes('LOCAL_ORDER_PLUGIN_UNAVAILABLE')) return 'intakeRunnerUnavailableReason'
  if (reasons.includes('IDLE_STATE_UNKNOWN') || reasons.includes('HOST_ACTIVITY_UNKNOWN')
    || reasons.includes('VOICE_ACTIVITY_UNKNOWN') || reasons.includes('MEMORY_STATE_UNKNOWN')) return 'intakeMeasurementUnknownReason'
  if (reasons.includes('MEMORY_LIMIT')) return 'intakeMemoryLimitReason'
  if (reasons.includes('CONCURRENCY_LIMIT')) return 'intakeConcurrencyReason'
  if (reasons.includes('DEPLOYMENT_DISABLED')) return 'intakeDeploymentDisabledReason'
  if (reasons.includes('OWNER_POLICY_UNAVAILABLE')) return 'intakePolicyUnavailableReason'
  return null
}

/** The sidebar provides the row, label, tooltip and selection state. */
export function NodeIntakeIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 10.5V5.8A1.8 1.8 0 0 1 5.8 4h12.4A1.8 1.8 0 0 1 20 5.8v4.7M4 10.5h4.4l1.6 2.2h4l1.6-2.2H20V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
    <path d="m10.3 7.4 1.3 1.3 2.5-2.5" />
  </svg>
}

/** Shows local live work and platform history as distinct sources. */
export function NodeIntakePage({ controller, t, dashboard, dashboardTransport, supplyTransport,
  planOrderAdapter, onManagePublication, onOpenSharing, h3SetupTransport, h3CanonicalTransport }: NodeIntakePageProps) {
  const state = useNodeState(controller)
  const snapshot = state.readout?.kind === 'snapshot' ? state.readout.snapshot : null
  const tasks = snapshot?.tasks ?? []
  const workerId = snapshot?.connection.workerId ?? null
  const ownerId = snapshot?.connection.ownerId ?? null
  const [page, setPage] = useState<{ readonly workerId: string; readonly ownerId: number | null; readonly offset: number } | null>(null)
  const [revision, setRevision] = useState(0)
  const [load, setLoad] = useState<DashboardLoad | null>(null)
  const [supplyLoad, setSupplyLoad] = useState<SupplyLoad>({ transport: supplyTransport, workerId, ownerId,
    phase: supplyTransport === undefined ? 'unavailable' : 'loading', order: null })
  const supply = supplyLoad.transport === supplyTransport && supplyLoad.workerId === workerId && supplyLoad.ownerId === ownerId ? supplyLoad
    : { phase: supplyTransport === undefined ? 'unavailable' as const : 'loading' as const, order: null }
  const setSupply = (value: Pick<SupplyLoad, 'phase' | 'order'>): void => {
    setSupplyLoad({ transport: supplyTransport, workerId, ownerId, ...value })
  }
  const [supplyBusy, setSupplyBusy] = useState(false)
  const [supplyError, setSupplyError] = useState(false)
  const [textServiceBusy, setTextServiceBusy] = useState(false)
  const [textServiceError, setTextServiceError] = useState<Parameters<NodeTranslate>[0] | null>(null)
  const [selectionBusy, setSelectionBusy] = useState(false)
  const [selectionError, setSelectionError] = useState<Parameters<NodeTranslate>[0] | null>(null)
  const [sourceRevision, setSourceRevision] = useState(0)
  const [authorBusy, setAuthorBusy] = useState(false)
  const [affectedSourceId, setAffectedSourceId] = useState<string | null>(null)
  const [sourceLoad, setSources] = useState<SourceLoad>({ transport: supplyTransport, workerId, ownerId, phase: 'loading', data: null })
  const sources = sourceLoad.transport === supplyTransport && sourceLoad.workerId === workerId && sourceLoad.ownerId === ownerId
    ? sourceLoad : { phase: 'loading' as const, data: null }
  const offset = page?.workerId === workerId && page.ownerId === ownerId ? page.offset : 0
  const transport = dashboardTransport ?? defaultDashboardTransport
  useEffect(() => {
    if (dashboard !== undefined || workerId === null) return
    const timer = setInterval(() => { setRevision(value => value + 1) }, 10_000)
    return () => { clearInterval(timer) }
  }, [dashboard, workerId])
  useEffect(() => {
    if (dashboard !== undefined || workerId === null) return
    const abort = new AbortController()
    setLoad(previous => ({ transport, workerId, ownerId, offset, revision, ...beginRetainedRead(
      previous?.transport === transport && previous.workerId === workerId && previous.ownerId === ownerId
        && previous.offset === offset ? previous : null) }))
    void transport.read(workerId, offset, abort.signal).then((data) => {
      if (!abort.signal.aborted) setLoad({ transport, workerId, ownerId, offset, revision, phase: 'ready', data })
    }).catch(() => {
      if (!abort.signal.aborted) setLoad(previous => ({ transport, workerId, ownerId, offset, revision, ...failRetainedRead(
        previous?.transport === transport && previous.workerId === workerId && previous.ownerId === ownerId
          && previous.offset === offset ? previous : null) }))
    })
    return () => { abort.abort() }
  }, [dashboard, workerId, ownerId, offset, revision, transport])
  useEffect(() => {
    if (supplyTransport === undefined) return
    let current = true
    void supplyTransport.read().then((order) => {
      if (current) setSupply({ phase: 'ready', order })
    }).catch(() => {
      if (current) setSupply({ phase: 'unavailable', order: null })
    })
    return () => { current = false }
  }, [supplyTransport, workerId, ownerId])
  useEffect(() => {
    if (supplyTransport?.listSources === undefined) return
    let current = true
    setSources(previous => ({ transport: supplyTransport, workerId, ownerId,
      ...beginRetainedRead(previous.transport === supplyTransport && previous.workerId === workerId
        && previous.ownerId === ownerId ? previous : null) }))
    void supplyTransport.listSources().then((data) => {
      if (current) {
        setSources({ transport: supplyTransport, workerId, ownerId, phase: 'ready', data })
        setAffectedSourceId(null)
      }
    }).catch(() => {
      if (current) {
        setSources(previous => ({ transport: supplyTransport, workerId, ownerId,
          ...failRetainedRead(previous.transport === supplyTransport && previous.workerId === workerId
            && previous.ownerId === ownerId ? previous : null) }))
        setAffectedSourceId(null)
      }
    })
    return () => { current = false }
  }, [supplyTransport, workerId, ownerId, sourceRevision])
  const liveLoad = load?.transport === transport && load.workerId === workerId && load.ownerId === ownerId
    && load.offset === offset ? load : null
  const shownDashboard = dashboard !== undefined ? dashboard : liveLoad?.data ?? null
  const dashboardPhase: IntakeDashboardPhase = dashboard !== undefined ? dashboard === null ? 'pending' : 'ready'
    : workerId === null ? 'missing-worker' : liveLoad?.phase ?? 'loading'
  const ownerOn = supply.phase === 'ready' && supply.order !== null && supply.order.mode !== 'off'
  const authorizedServiceCount = supply.order?.enabledServiceCount ?? null
  const textServiceEnabled = supply.order === null ? null
    : supply.order.enabledServiceIds === null ? authorizedServiceCount === 0 ? false : null
      : supply.order.enabledServiceIds.includes('node')
  // A damaged or temporarily unreadable executor must not strand an existing owner grant.
  // Keep the revocation switch available even when no selected row can be projected.
  const orphanGrant = supplyTransport?.listSources !== undefined && textServiceEnabled === true
    && sources.data?.sources.every(item => item.serviceId !== 'node') !== false
  const sourcesCurrent = sources.phase === 'ready' && sources.data?.complete === true
  const executorVerified = supplyTransport?.listSources === undefined || sourcesCurrent
    && sources.data?.sources.some(item => item.serviceId === 'node' && item.eligible && item.enabled) === true
  const loginRequired = state.power?.code === 'NODE_SWITCH_NO_SESSION'
  const ready = ownerOn && textServiceEnabled === true && executorVerified
    && state.power?.running === true && snapshot?.connection.state === 'online' && snapshot.connection.mode === 'running'
  const intakeStatus = supplyBusy || textServiceBusy || selectionBusy || authorBusy ? 'changing' : supply.phase !== 'ready' || supply.order === null
    || (textServiceEnabled === true && supplyTransport?.listSources !== undefined && !sourcesCurrent) ? 'unknown'
    : !ownerOn ? 'off' : ready ? 'accepting' : 'paused'
  const waitingForIdle = intakeStatus === 'paused' && ownerOn && textServiceEnabled === true && executorVerified
    && !loginRequired && snapshot?.intakeReasons?.includes('USER_ACTIVE') === true
    && snapshot.connection.state === 'online'
  const statusKey = intakeStatus === 'changing' ? 'intakeChanging' : intakeStatus === 'accepting' ? 'intakeAccepting'
    : waitingForIdle ? 'intakeWaitingIdle'
      : intakeStatus === 'paused' && textServiceEnabled === false && !loginRequired ? 'intakeNoServices'
        : intakeStatus === 'paused' ? 'intakePaused' : intakeStatus === 'off' ? 'intakeOff' : 'intakeUnknown'
  const reasonKey = supply.phase !== 'ready' || supply.order === null ? 'intakeUnknownReason'
    : !ownerOn ? 'intakeOffReason'
      : loginRequired ? 'intakeNeedLoginReason'
        : textServiceEnabled === false ? 'intakeNoServicesReason'
          : textServiceEnabled === null ? 'intakeServicesUnknownReason'
            : supplyTransport?.listSources !== undefined && !sourcesCurrent ? 'intakeSourcesUnverifiedReason'
              : !executorVerified ? 'intakeExecutorUnverifiedReason'
                : snapshot?.connection.state !== 'online' ? 'intakeOfflineReason'
                  : state.power?.running !== true || snapshot.connection.mode !== 'running'
                    ? localPauseReason(snapshot) ?? 'intakeNotReadyReason'
                    : 'intakeReadyReason'
  const invalidateSources = (sourceId: string | null): void => {
    setAffectedSourceId(sourceId)
    setSources(previous => ({ transport: supplyTransport, workerId, ownerId,
      ...beginRetainedRead(previous.transport === supplyTransport && previous.workerId === workerId
        && previous.ownerId === ownerId ? previous : null) }))
  }
  const toggleSupply = async (): Promise<void> => {
    if (supplyTransport === undefined || supplyBusy || textServiceBusy || selectionBusy || authorBusy || supply.phase !== 'ready' || supply.order === null
      || !ownerOn && supplyTransport.listSources !== undefined && !sourcesCurrent) return
    setSupplyBusy(true)
    setSupplyError(false)
    try {
      await supplyTransport.set(!ownerOn)
    } catch {
      setSupplyError(true)
    }
    // A write may have committed before its acknowledgement failed. Only the fresh read is shown.
    try {
      setSupply({ phase: 'ready', order: await supplyTransport.read() })
    } catch {
      setSupply({ phase: 'unavailable', order: null })
      setSupplyError(true)
    }
    try { await controller.poll() } catch { /* The local status will retry on its regular poll. */ }
    setSupplyBusy(false)
  }
  const toggleTextService = async (): Promise<void> => {
    if (supplyTransport === undefined || supplyBusy || textServiceBusy || selectionBusy || authorBusy || supply.phase !== 'ready'
      || supply.order === null || textServiceEnabled === null
      || (supplyTransport.listSources !== undefined && !sourcesCurrent && !textServiceEnabled)) return
    setTextServiceBusy(true)
    if (supplyTransport.listSources !== undefined) invalidateSources(sources.data?.sources.find(item => item.serviceId === 'node')?.id ?? null)
    setTextServiceError(null)
    setSelectionError(null)
    let failure: Parameters<NodeTranslate>[0] | null = null
    try { await supplyTransport.setTextService(!textServiceEnabled) }
    catch (error) {
      const code = error instanceof Error ? error.message : ''
      failure = code.endsWith('service-unavailable') ? 'intakeTextServiceUnavailable'
        : code.endsWith('supply-unavailable') ? 'intakeTextServiceSaveFailed'
          : code.endsWith('closed') ? 'intakeTextServiceClosed' : 'intakeTextServiceFailed'
    }
    try {
      const order = await supplyTransport.read()
      setSupply({ phase: 'ready', order })
      setTextServiceError(failure ?? (order === null ? 'intakeTextServiceReadFailed' : null))
    } catch {
      setSupply({ phase: 'unavailable', order: null })
      setTextServiceError('intakeTextServiceReadFailed')
    }
    try { await controller.poll() } catch { /* The local status will retry on its regular poll. */ }
    if (supplyTransport.listSources !== undefined) setSourceRevision(value => value + 1)
    setTextServiceBusy(false)
  }
  const selectOrderSource = async (sourceId: string): Promise<void> => {
    if (supplyTransport?.selectSource === undefined || supplyBusy || textServiceBusy || selectionBusy || authorBusy
      || supply.phase !== 'ready' || textServiceEnabled !== false || !sourcesCurrent
      || !sources.data?.sources.some(item => item.id === sourceId && item.selectable && item.serviceId === null)) return
    setSelectionBusy(true)
    invalidateSources(sourceId)
    setSelectionError(null)
    setTextServiceError(null)
    let failure: Parameters<NodeTranslate>[0] | null = null
    try { await supplyTransport.selectSource(sourceId) }
    catch (error) {
      const code = error instanceof Error ? error.message : ''
      failure = code.endsWith('order-service-enabled') ? 'orderSourceSelectionGrantEnabled'
        : code.endsWith('order-source-busy') ? 'orderSourceSelectionBusy'
          : code.endsWith('order-source-unavailable') ? 'orderSourceSelectionUnavailable'
            : code.endsWith('invalid-order-source') ? 'orderSourceSelectionInvalid'
              : 'orderSourceSelectionFailed'
    }
    try { setSupply({ phase: 'ready', order: await supplyTransport.read() }) }
    catch { setSupply({ phase: 'unavailable', order: null }); failure = 'orderSourceSelectionReadFailed' }
    setSourceRevision(value => value + 1)
    try { await controller.poll() } catch { /* The local status will retry on its regular poll. */ }
    setSelectionError(failure)
    setSelectionBusy(false)
  }
  const activateAuthorSource = async (sourceId: string): Promise<void> => {
    if (!supplyTransport?.activateAuthorSource || authorBusy || supplyBusy || textServiceBusy || selectionBusy
      || !sourcesCurrent || supply.phase !== 'ready'
      || !sources.data?.sources.some(item => item.id === sourceId && item.kind === 'skill'
        && item.authorProductId && (item.reason === 'publication-approved'
          || item.reason === 'ready' && item.eligible))) return
    setAuthorBusy(true)
    invalidateSources(sourceId)
    setSelectionError(null)
    let failure: Parameters<NodeTranslate>[0] | null = null
    try { await supplyTransport.activateAuthorSource(sourceId) }
    catch (error) {
      const code = error instanceof Error ? error.message : ''
      failure = code.endsWith('order-auth-required') ? 'orderAuthorLogin'
        : code.endsWith('order-node-contributor-unavailable') ? 'orderAuthorNodeUnavailable'
          : code.endsWith('order-author-source-changed') || code.endsWith('order-author-not-published') ? 'orderAuthorSourceChanged'
            : code.endsWith('order-author-entitlement-refunded') ? 'orderAuthorEntitlementClosed'
              : 'orderAuthorEnableFailed'
    }
    // Even a lost response may follow a committed receipt. Re-read, never purchase or submit again.
    try { setSupply({ phase: 'ready', order: await supplyTransport.read() }) }
    catch { setSupply({ phase: 'unavailable', order: null }) }
    setSourceRevision(value => value + 1)
    try { await controller.poll() } catch { /* Regular status polling can recover independently. */ }
    setSelectionError(failure)
    setAuthorBusy(false)
  }
  return <main className={css.intakePage} data-node-intake-page>
    <header className={css.intakeIntro}>
      <div>
        <h1>{t('intakeTitle')}</h1>
        <p>{t('intakeDescription')}</p>
      </div>
    </header>

    <section className={css.intakeHero} data-intake-status={intakeStatus}>
      <div className={css.intakeHeroMain}>
        <span className={css.intakeEyebrow}>{t('intakeEyebrow')}</span>
        <h2>{t(statusKey)}</h2>
        <p>{t(reasonKey)}</p>
        <div className={css.intakeReadiness}>
          <span className={css.intakeNodePhase} data-node-phase={state.phase}>
            <span className={css.intakeStatusDot} />{t('intakeNodeLabel')} · {t(PHASE_COPY[state.phase])}
          </span>
          {authorizedServiceCount !== null ? <span className={css.intakeServiceCount} data-intake-service-count={authorizedServiceCount}>
            {t('intakeAuthorizedServices')} · {authorizedServiceCount} {t('intakeServiceUnit')}
          </span> : null}
        </div>
      </div>
      <div className={css.intakeHeroActions}>
        <div className={css.intakeSwitchRow}>
          <span>{t('intakeMasterSwitch')}</span>
          <button type="button" role="switch" className={css.power} aria-label={t('intakeMasterSwitch')}
            aria-checked={ownerOn} data-intake-master-switch={ownerOn ? 'on' : 'off'}
            disabled={supplyBusy || textServiceBusy || selectionBusy || authorBusy || supply.phase !== 'ready' || supply.order === null
              || !ownerOn && supplyTransport?.listSources !== undefined && !sourcesCurrent}
            onClick={() => { void toggleSupply() }}><span className={css.powerThumb} /></button>
        </div>
        {supplyError ? <span className={css.intakeSwitchError} role="alert">{t('intakeSwitchFailed')}</span> : null}
        {supplyTransport?.listSources === undefined || orphanGrant ? <div className={css.intakeTextService}>
          <div className={css.intakeTextServiceRow}>
            <span className={css.intakeTextServiceTitle}>{t('intakeTextService')} <code>word_count</code></span>
            <button type="button" role="switch" className={css.power} aria-label={t('intakeTextService')}
              aria-checked={textServiceEnabled === true}
              data-intake-text-service-switch={textServiceEnabled === null ? 'unknown' : textServiceEnabled ? 'on' : 'off'}
              disabled={supplyBusy || textServiceBusy || selectionBusy || authorBusy || supply.phase !== 'ready' || textServiceEnabled === null}
              onClick={() => { void toggleTextService() }}><span className={css.powerThumb} /></button>
          </div>
          <p className={css.intakeTextServiceNote}>{t(orphanGrant ? 'intakeExecutorUnverifiedReason' : 'intakeTextServiceScope')}</p>
          <p className={css.intakeTextServiceNote}>{t(textServiceBusy ? 'intakeTextServiceChecking'
            : textServiceEnabled === null ? 'intakeTextServiceUnknown'
              : textServiceEnabled ? ownerOn ? 'intakeTextServiceOn' : 'intakeTextServiceOnMasterOff'
                : 'intakeTextServiceOff')}</p>
          {textServiceError !== null ? <p className={css.intakeTextServiceError} role="alert">{t(textServiceError)}</p> : null}
        </div> : null}
      </div>
    </section>

    {supplyTransport?.listSources !== undefined ? <OrderSourcesPanel t={t} phase={sources.phase} data={sources.data}
      granted={supply.phase === 'ready' ? textServiceEnabled : null}
      ownerOn={supply.phase === 'ready' ? ownerOn : null}
      busy={supplyBusy || textServiceBusy || selectionBusy || authorBusy} busySourceId={affectedSourceId}
      error={selectionError ?? textServiceError}
      busyMessage={authorBusy ? 'orderAuthorEnabling' : selectionBusy ? 'orderSourceSelecting' : textServiceBusy ? 'intakeTextServiceChecking' : supplyBusy ? 'intakeChanging' : null}
      selectionSupported={supplyTransport.selectSource !== undefined}
      onRefresh={() => {
        setSelectionError(null); setTextServiceError(null); invalidateSources(null); setSourceRevision(value => value + 1)
      }}
      onToggle={() => { void toggleTextService() }}
      onSelect={(sourceId) => { void selectOrderSource(sourceId) }}
      {...(supplyTransport.activateAuthorSource === undefined ? {}
        : { onActivateAuthor: (sourceId: string) => { void activateAuthorSource(sourceId) } })}
      {...(onManagePublication === undefined ? {} : { onManagePublication })}
      {...planOrderAdapter === undefined ? {} : { onPlanAdapter: planOrderAdapter }} /> : null}

    {onOpenSharing !== undefined ? <button type="button" className={css.intakeSmallButton}
      onClick={onOpenSharing}>{t('intakeOpenSharing')}</button> : null}

    {h3CanonicalTransport !== undefined || h3SetupTransport !== undefined ? <details className={css.intakeCapabilitySetup}
      data-intake-setup-list>
      <summary>{t('intakeAddCapability')}</summary>
      <p>{t('intakeAddCapabilityIntro')}</p>
      {h3CanonicalTransport === undefined
        ? <H3OwnerWizard key={state.identityEpoch} t={t} {...(h3SetupTransport === undefined ? {} : { transport: h3SetupTransport })} />
        : <>
          <H3CanonicalOwnerWizard key={state.identityEpoch} t={t} transport={h3CanonicalTransport} />
          <details><summary>{t('h3CanonicalLegacy')}</summary>
            <H3OwnerWizard key={state.identityEpoch} t={t} {...(h3SetupTransport === undefined ? {} : { transport: h3SetupTransport })} />
          </details>
        </>}
    </details> : null}

    {shownDashboard !== null && (dashboardPhase === 'loading' || dashboardPhase === 'unavailable')
      ? <p className={css.orderSourcesCaution} role="status">{t(dashboardPhase === 'loading' ? 'intakeSyncing' : 'intakeDataUnavailable')}</p> : null}
    <IntakeOverview dashboard={shownDashboard} phase={dashboardPhase} t={t} />
    <div className={css.intakeSections}>
      <section className={css.intakeCard} aria-labelledby="intake-running-title">
        <div className={css.intakeCardHead}>
          <div><span className={css.intakeSectionEyebrow}>{t('intakeLiveSource')}</span><h2 id="intake-running-title">{t('intakeRunningTitle')}</h2></div>
          <span className={css.intakeSourceTag}>{snapshot === null ? t('intakeNodeUnavailable') : tasks.length === 0 ? t('intakeIdle') : `${String(tasks.length)} ${t('intakeRunningUnit')}`}</span>
        </div>
        {snapshot === null
          ? <p className={css.intakeEmpty}>{t('intakeRunningUnknown')}</p>
          : tasks.length === 0
            ? <p className={css.intakeEmpty}>{t('intakeRunningEmpty')}</p>
            : <ul className={css.intakeTaskList}>{tasks.map(task => <li className={css.intakeTask} key={`${task.shardId}:${String(task.attempt)}`}>
              <div className={css.intakeTaskTop}><strong>{task.taskType}</strong><span>{`${String(task.progressPct)}%`}</span></div>
              <div className={css.intakeProgress}><span style={{ width: `${String(Math.max(0, Math.min(100, task.progressPct)))}%` }} /></div>
              <div className={css.intakeTaskMeta}><span>{t('elapsed')} {formatDuration(task.elapsedMs / 1000)}</span><span>{t('intakeTaskReadOnly')}</span></div>
            </li>)}</ul>}
      </section>
      <IntakeHistory
        dashboard={shownDashboard} phase={dashboardPhase} t={t}
        {...(dashboard !== undefined || workerId === null ? {} : {
          onRefresh: () => { setRevision(value => value + 1) },
          onPrevious: () => { setPage({ workerId, ownerId, offset: Math.max(0, offset - (shownDashboard?.limit ?? 20)) }) },
          onNext: () => { setPage({ workerId, ownerId, offset: Math.min(100_000, offset + (shownDashboard?.limit ?? 20)) }) },
        })}
      />
    </div>

    <details className={css.intakeDetails}>
      <summary><span>{t('intakeDetailsTitle')}</span><small>{t('intakeDetailsHint')}</small></summary>
      <NodeStatusPanel controller={controller} t={t} diagnosticsOnly />
    </details>
  </main>
}
