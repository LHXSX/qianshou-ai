/** Image/video sharing; every status comes from the local coordinator. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { createSharingInjection } from './sharing-controller.ts'
import type { SharingMode, SharingModeState, SharingPhase } from './sharing-types.ts'
import css from './HelpPage.module.css'

export type HelpPageProps = PropsLocale<'qianshou.brand'> & InjectFace<ReturnType<typeof createSharingInjection>>
type Translate = HelpPageProps['t']
const stages = ['detect', 'download', 'install', 'api', 'connect', 'persist', 'earnings'] as const
const stageKeys = ['sharingDetect', 'sharingDownload', 'sharingInstall', 'sharingApi', 'sharingConnect', 'sharingPersist', 'sharingEarnings'] as const
const phaseKeys = { idle: 'sharingNotEnabled', detecting: 'sharingDetecting', matching: 'sharingMatching',
  downloading: 'sharingDownloading', installing: 'sharingInstalling', starting: 'sharingStarting',
  connecting: 'sharingConnecting', recovering: 'sharingRecovering', sharing: 'sharingActive',
  paused: 'sharingPaused', blocked: 'sharingNeedsAttention', failed: 'sharingNeedsAttention' } as const satisfies Record<SharingPhase, string>
const reasonKeys = { catalog_unavailable: 'sharingCatalogUnavailable', hardware_unsupported: 'sharingHardwareUnsupported',
  disk_space: 'sharingDiskSpace', login_required: 'sharingLoginRequired', verification_pending: 'sharingVerificationPending',
  runtime_unavailable: 'sharingRuntimeUnavailable', connection_unavailable: 'sharingConnectionUnavailable',
  owner_policy_blocked: 'sharingOwnerPolicyBlocked', consent_required: 'sharingConsentRequired', idle_required: 'sharingIdleRequired',
  resource_unavailable: 'sharingResourceUnavailable', execution_disabled: 'sharingExecutionDisabled', download_failed: 'sharingDownloadFailed' } as const

/** The existing sidebar identity stays stable for saved navigation. */
export function HelpIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <rect x="8.5" y="8.5" width="7" height="7" rx="2" /><path d="M12 4v4.5M12 15.5V20M4 12h4.5M15.5 12H20" />
    <circle cx="12" cy="3" r="1.5" /><circle cx="12" cy="21" r="1.5" /><circle cx="3" cy="12" r="1.5" /><circle cx="21" cy="12" r="1.5" />
  </svg>
}
function MediaGlyph({ mode }: { readonly mode: SharingMode }) {
  return <svg viewBox="0 0 88 64" fill="none" aria-hidden="true">
    <rect x="3" y="3" width="66" height="48" rx="10" stroke="currentColor" strokeWidth="2" />
    {mode === 'image' ? <><circle cx="22" cy="18" r="5" fill="currentColor" opacity=".65" />
      <path d="m11 43 16-15 11 10 12-15 13 20" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </> : <path d="m31 17 17 10-17 10z" fill="currentColor" />}
    <rect x="53" y="34" width="30" height="25" rx="8" fill="var(--dsw-alias-bg-layer-1)" stroke="currentColor" strokeWidth="2" />
    <path d="M68 41v11m-5-5.5h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
}
function SharingCard({ mode, state, ready, readFailed, canAuthorize, authenticated, connected, busy, processing, command, refresh, t }: {
  readonly mode: SharingMode
  readonly state: SharingModeState | undefined
  readonly ready: boolean
  readonly readFailed: boolean
  readonly canAuthorize: boolean
  readonly authenticated: boolean
  readonly connected: boolean
  readonly busy: boolean
  readonly processing: boolean
  readonly command: HelpPageProps['command']
  readonly refresh: HelpPageProps['refresh']
  readonly t: Translate
}) {
  const running = state !== undefined && !['idle', 'paused', 'blocked', 'failed'].includes(state.phase)
  const downloaded = state?.downloadedBytes ?? 0
  const total = state?.totalDownloadBytes ?? 0
  const percentage = total > 0 ? Math.min(100, Math.floor(downloaded / total * 100)) : null
  const local = ready ? state?.local : undefined
  const api = ready ? state?.api : undefined
  const granted = state?.authorization?.connection === 'granted'
  const emptyInventoryKey = 'sharingLocalModelsEmpty'
  const inventoryKey = { unknown: 'sharingLocalModelsUnknown', detected: 'sharingLocalModelsDetected',
    empty: emptyInventoryKey, unavailable: 'sharingLocalModelsUnavailable' } as const
  const runtimeKey = { unknown: 'sharingLocalRuntimeUnknown', ready: 'sharingLocalRuntimeReady',
    unavailable: 'sharingLocalRuntimeUnavailable', unsupported: 'sharingLocalRuntimeUnsupported',
    authentication_required: 'sharingLocalRuntimeAuthentication' } as const
  const apiRuntimeKey = { unknown: 'sharingLocalRuntimeUnknown', ready: 'sharingLocalRuntimeReady', unavailable: 'sharingLocalRuntimeUnavailable',
    unsupported: 'sharingLocalRuntimeUnsupported', auth_required: 'sharingLocalRuntimeAuthentication' } as const
  const localApiReady = api?.status === 'ready' || (api === undefined || api.status === 'unknown') && local?.runtime === 'ready'
  const localRuntimeKey = api !== undefined && api.status !== 'unknown' ? apiRuntimeKey[api.status] : runtimeKey[local?.runtime ?? 'unknown']
  const adoptionKey = { unmatched: 'sharingLocalUnmatched', verification_required: 'sharingLocalVerificationRequired',
    reusable: 'sharingLocalReusable', reused: 'sharingLocalReused' } as const
  const active = ready && authenticated && connected && state?.phase === 'sharing' && state.reason === null
    && local?.runtime === 'ready' && local.adoption === 'reused'
    && state.authorization?.connection === 'granted' && state.authorization.execution === 'idle_only'
    && state.authorization.deviceBound
  const trialConnected = ready && authenticated && connected && granted && state.authorization.deviceBound
    && state.authorization.execution === 'idle_only'
    && localApiReady && state.phase !== 'paused'
  const apiConfirmed = trialConnected && api?.registration === 'registered' && api.probeStatus === 'passed'
    && api.lastProbedAt !== null && Date.parse(api.lastProbedAt) > Date.now() - 120000
  const pausable = running || apiConfirmed
  const continueSetup = granted && !pausable && state.phase !== 'paused'
  const preparing = ready && state !== undefined
    && ['detecting', 'matching', 'downloading', 'installing', 'starting', 'connecting', 'recovering'].includes(state.phase)
    && !(trialConnected && state.phase === 'connecting')
  const apiReceiptKey = apiConfirmed ? 'sharingApiConfirmed' : !localApiReady ? 'sharingApiWaitingReady' : api?.probeStatus === 'failed' ? 'sharingApiProbeFailed'
    : api?.registration === 'unavailable' ? 'sharingApiReportUnavailable' : api?.registration === 'pending' ? 'sharingApiReportPending'
      : api?.registration === 'registered' && api.probeStatus === 'pending' ? 'sharingApiProbePending' : 'sharingApiConfirmationUnknown'
  const trialStatusKey = readFailed ? 'sharingDetectionIncomplete' : !ready ? 'sharingStatusPending'
    : preparing ? phaseKeys[state.phase] : state?.phase === 'paused' ? 'sharingPaused'
      : trialConnected ? 'sharingTrialConnected' : localApiReady ? 'sharingTrialApiReady' : localRuntimeKey
  const trialDetailKey = readFailed ? 'sharingDetectionUnavailable' : preparing ? 'sharingSetupWorking'
    : trialConnected ? 'sharingTrialConnectedDetail' : localApiReady
      ? granted ? 'sharingTrialAwaitingConnection' : 'sharingTrialNeedsConsent'
      : api !== undefined && api.status !== 'unknown' || local !== undefined && local.runtime !== 'unknown'
        ? 'sharingTrialServiceMissing' : 'sharingTrialServiceUnknown'
  // An idle gate must not hide an independently observed missing reviewed plan.
  const reasonKey = state?.reason == null ? null
    : state.reason === 'idle_required' && local !== undefined
      && ['unmatched', 'verification_required'].includes(local.adoption)
      ? state.modelName === null ? 'sharingCatalogUnavailable' : 'sharingVerificationPending'
      : reasonKeys[state.reason]
  const authorizationKey = state?.authorization?.connection === 'granted'
    ? state.authorization.execution === 'idle_only' ? 'sharingConsentGranted' : 'sharingConsentPaused'
    : state?.authorization?.connection === 'revoked' ? 'sharingConsentRevoked' : 'sharingConsentRequired'
  return <article className={css.sharingCard} data-sharing-mode={mode}>
    <div className={css.cardTop}><div className={css.mediaGlyph}><MediaGlyph mode={mode} /></div>
      <span className={css.status} data-active={trialConnected}><i />{t(trialStatusKey)}</span>
    </div>
    <h2>{t(mode === 'image' ? 'sharingImage' : 'sharingVideo')}</h2>
    <p className={css.cardSummary}>{t(mode === 'image' ? 'sharingImageSummary' : 'sharingVideoSummary')}</p>
    <dl className={css.localEvidence} aria-label={t('sharingLocalEvidence')}>
      <div><dt>{t('sharingLocalModels')}</dt><dd>{t(inventoryKey[local?.inventory ?? 'unknown'])}
        {local?.inventory === 'detected' && local.modelCount !== null ? <span> ({local.modelCount})</span> : null}</dd></div>
      <div><dt>{t('sharingApiModel')}</dt><dd>{api?.modelName ?? t('sharingApiIdentityUnknown')}</dd></div>
      <div><dt>{t('sharingApiWorkflow')}</dt><dd>{api?.workflowName ?? t('sharingApiIdentityUnknown')}</dd></div>
      <div><dt>{t('sharingLocalRuntime')}</dt><dd>{t(localRuntimeKey)}</dd></div>
      <div><dt>{t('sharingGuangzhouApiReceipt')}</dt><dd>{t(apiReceiptKey)}</dd></div>
      <div><dt>{t('sharingLocalAuthorization')}</dt><dd>{t(authorizationKey)}</dd></div>
    </dl>
    <p className={css.localNote}>{t('sharingLocalInventoryNote')}</p>
    <p className={css.reason} role="status">{t(trialDetailKey)}</p>
    {percentage === null ? null : <div className={css.downloadProgress}>
      <label>{t('sharingDownloading')} <span>{percentage}%</span></label><progress max={100} value={percentage} aria-label={t('sharingDownloading')} />
    </div>}
    <div className={css.cardAction}>
      <button type="button" className={pausable ? css.secondaryButton : css.primaryButton} disabled={readFailed ? busy : !ready || !canAuthorize || !authenticated || busy}
        onClick={() => {
          if (readFailed) refresh()
          else command(mode, pausable ? 'pause' : state?.phase === 'paused' ? 'resume' : 'enable')
        }}>
        {processing ? t('sharingProcessing') : readFailed ? t('sharingDetectAgain')
          : pausable ? t(mode === 'image' ? 'sharingPauseImage' : 'sharingPauseVideo')
            : state?.phase === 'paused' ? t('sharingResume')
              : continueSetup ? t(mode === 'image' ? 'sharingContinueImage' : 'sharingContinueVideo')
                : t(mode === 'image' ? 'sharingEnableImage' : 'sharingEnableVideo')}{!pausable && !busy ? <span aria-hidden="true">↗</span> : null}
      </button><span>{t(readFailed ? 'sharingDetectionHint' : pausable ? 'sharingForegroundFirst'
        : continueSetup ? 'sharingContinueHint' : 'sharingInstallHint')}</span>
      {state?.authorization?.connection === 'granted' ? <button type="button" className={css.textButton} disabled={busy || !ready || !canAuthorize || !authenticated}
        aria-label={`${t('sharingRevoke')} · ${t(mode === 'image' ? 'sharingImage' : 'sharingVideo')}`}
        onClick={() => { command(mode, 'revoke') }}>{t('sharingRevoke')}</button> : null}
    </div>
    <details className={css.details}><summary>{t('sharingFormalDetails')}</summary>
      <p className={css.localNote}>{t('sharingFormalScope')}</p>
      <dl className={css.localEvidence}>
        <div><dt>{t('sharingFormalStatus')}</dt><dd>{readFailed ? t('sharingDetectionIncomplete') : !ready ? t('sharingStatusPending') : state?.phase === 'sharing' && !active
          ? t('sharingActiveUnconfirmed') : t(phaseKeys[state?.phase ?? 'idle'])}</dd></div>
        <div><dt>{t('sharingLocalQualification')}</dt><dd>{local === undefined
          ? t('sharingLocalQualificationUnknown') : t(adoptionKey[local.adoption])}</dd></div>
      </dl>
      <div className={css.modelSummary}><span>{t('sharingMatchedModel')}</span><strong>{state?.modelName ?? t('sharingAutoMatch')}</strong></div>
      {reasonKey === null ? null : <p className={css.reason} role="status">{t(reasonKey)}</p>}
      <p className={css.localNote}>{t('sharingSetupDetails')}</p>
      <ol>{stages.map((step, index) => {
        const complete = ready && state?.completedSteps.includes(step) === true
          && (step !== 'api' || local?.runtime === 'ready')
          && (!['connect', 'persist'].includes(step) || connected)
        return <li key={step} data-complete={complete}>
          <span>{complete ? '✓' : index + 1}</span>{t(stageKeys[index] ?? 'sharingDetect')}
        </li>
      })}</ol>
    </details>
  </article>
}
function settledTotal(rows: readonly SharingModeState[] | undefined): string | null {
  if (rows === undefined || rows.some(row => row.settledYuan === null)) return null
  const sum = rows.reduce((value, row) => {
    const [whole = '0', fraction = ''] = (row.settledYuan ?? '0').split('.')
    return value + BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0'))
  }, 0n)
  return '¥ ' + String(sum / 10000n) + '.' + String(sum % 10000n).padStart(4, '0')
}
/** Two modes, one action per mode; advanced operations stay behind a disclosure. */
export function HelpPage({ t, useSharing, refresh, command, confirmSharing, cancelSharing,
  openSkills, openAccount }: HelpPageProps) {
  const view = useSharing(state => state)
  const ready = view.phase === 'ready'
  const snapshot = view.snapshot
  const completedCalls = snapshot?.modes.every(row => row.completedCalls !== null)
    ? snapshot.modes.reduce((sum, row) => sum + (row.completedCalls ?? 0), 0) : null
  const settled = settledTotal(snapshot?.modes)
  const cancelConfirmation = (): void => { if (view.confirmation !== null) cancelSharing(view.confirmation.requestId) }
  const confirm = (): void => {
    if (view.confirmation !== null) confirmSharing(view.confirmation.requestId, view.confirmation.scopeId)
  }
  const connection = ready ? snapshot?.connection : undefined
  const connected = connection?.deviceAuthorization === 'authorized' && connection.channel === 'connected'
    && connection.heartbeat === 'accepted'
  const gatewayKey = { unknown: 'sharingGatewayUnknown', unconfigured: 'sharingGatewayUnconfigured', checking: 'sharingGatewayChecking',
    reachable: 'sharingGatewayConnected', unavailable: 'sharingGatewayUnavailable' } as const
  const channelKey = { idle: 'sharingChannelIdle', connecting: 'sharingChannelConnecting',
    connected: 'sharingChannelConnected', offline: 'sharingChannelOffline' } as const
  const authorizationKey = { unknown: 'sharingAuthorizationUnknown', authorized: 'sharingAuthorizationGranted',
    unauthorized: 'sharingAuthorizationMissing' } as const
  const readFailureKey = { timeout: 'sharingReadTimeout', host_missing: 'sharingHostMissing',
    host_unavailable: 'sharingHostUnavailable', login: 'sharingReadLogin',
    response_invalid: 'sharingReadInvalid', unknown: 'sharingReadUnavailable' } as const
  return <main className={css.page} data-compute-sharing>
    <header className={css.header}><div><span className={css.eyebrow}>{t('sharingEyebrow')}</span><h1>{t('helpTitle')}</h1>
      <p>{t('sharingIntro')}</p></div><span className={css.hardware}>{snapshot?.hardware?.name ?? t('sharingHardwarePending')}</span></header>
    <section className={css.connection} aria-live="polite" aria-label={t('sharingConnectionTitle')}>
      <div><strong data-connected={connection?.gateway === 'reachable'}><i aria-hidden="true" />
        {t(gatewayKey[connection?.gateway ?? 'unknown'])}</strong>
      <p>{t(channelKey[connection?.channel ?? 'idle'])}<span aria-hidden="true"> · </span>
        {t(authorizationKey[connection?.deviceAuthorization ?? 'unknown'])}</p>
      <p>{t('sharingConnectionScope')}</p></div>
      <button type="button" className={css.textButton} onClick={refresh}>{t('sharingProbeAgain')} <span aria-hidden="true">↻</span></button>
    </section>
    <div className={css.privacy}><span aria-hidden="true">↗</span><span>{t('sharingPrivacy')}</span></div>
    {view.phase === 'unavailable' ? <div className={css.notice} role="status"><span>{t(readFailureKey[view.readFailure ?? 'unknown'])}</span><button type="button" onClick={refresh}>{t('sharingRefresh')}</button></div> : null}
    {ready && !snapshot?.authenticated ? <div className={css.notice}><span>{t('sharingLoginRequired')}</span><button type="button" onClick={openAccount}>{t('sharingLogin')}</button></div> : null}
    {ready && snapshot?.authenticated && snapshot.scopeId == null ? <p className={css.notice} role="status">{t('sharingConsentUnavailable')}</p> : null}
    {view.actionFailed ? <p className={css.notice} role="status">{t(view.pendingOperation === null ? 'sharingActionNotApplied' : 'sharingActionUnknown')}</p> : null}
    <section className={css.cards} aria-label={t('sharingModes')}>
      {(['image', 'video'] as const).map(mode => <SharingCard key={mode} mode={mode} state={snapshot?.modes.find(row => row.mode === mode)}
        ready={ready} readFailed={view.phase === 'unavailable'} canAuthorize={snapshot?.scopeId != null} authenticated={snapshot?.authenticated === true} connected={connected}
        busy={view.busyMode !== null || view.pendingOperation !== null || view.confirmation !== null}
        processing={view.busyMode === mode}
        command={command} refresh={refresh} t={t} />)}
    </section>
    <section className={css.earnings} aria-labelledby="sharing-earnings-title">
      <div className={css.earningsHeading}><div><span className={css.eyebrow}>{t('sharingPlatformReceipts')}</span><h2 id="sharing-earnings-title">{t('sharingEarningsTitle')}</h2></div>
      </div>
      <div className={css.metrics}>
        <div><span>{t('sharingCalls')}</span><strong>{completedCalls === null ? '—' : completedCalls}</strong><small>{t('sharingCallsNote')}</small></div>
        <div><span>{t('sharingSettled')}</span><strong>{settled ?? '—'}</strong><small>{t('sharingSettledNote')}</small></div>
      </div>
    </section>
    <footer className={css.footer}><p>{t('sharingSkillsHint')}</p><button type="button" className={css.textButton} onClick={openSkills}>{t('sharingOpenSkills')} <span aria-hidden="true">→</span></button></footer>
    <Modal open={view.confirmation !== null && ready && snapshot?.authenticated === true
      && snapshot.scopeId === view.confirmation.scopeId}
    onClose={cancelConfirmation} closeLabel={t('sharingConsentClose')}
    title={t(view.confirmation?.mode === 'video' ? 'sharingConsentVideoTitle' : 'sharingConsentImageTitle')}
    footer={<><button type="button" className={css.secondaryButton} onClick={cancelConfirmation} autoFocus>{t('sharingConsentCancel')}</button>
      <button type="button" className={css.primaryButton} disabled={view.busyMode !== null || view.pendingOperation !== null}
        onClick={confirm}>{t('sharingConsentConfirm')}</button></>}>
      <ul className={css.consentTerms}>
        <li>{t('sharingConsentIdle')}</li>
        <li>{t('sharingConsentReuse')}</li>
        <li>{t('sharingConsentOutbound')}</li>
        <li>{t('sharingConsentQualification')}</li>
      </ul>
    </Modal>
  </main>
}
