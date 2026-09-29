/**
 * Settings shell root: the sidebar-foot trigger row plus the centered modal
 * panel with the section nav rail. The shell is
 * a pure composition face — slot-owned text (trigger label, panel title,
 * close label, sections) arrives from registrants through slots; accessible
 * names resolve from localized content (trigger: shell locale; dialog:
 * aria-labelledby the title node; close: visually-hidden slot text). Modal
 * open state and the active section id are component-local viewing state;
 * the onboarding coordinator mounts exactly one ordered registrant while the
 * sessions-derived empty-Hero fact is active. Visible dialog chrome belongs
 * to the step, so a mounted-but-deciding step paints nothing here.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  ConnectionIndicator,
  IconAgentPresetOutline16, IconArchiveOutline20, IconCloseOutline16, IconDataOutline16,
  IconGaugeOutline16, IconPluginPinwheelOutline16, IconSettingsOutline16, IconUserOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConnectionIndicatorState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsRootComponentProps, SettingsSectionRow } from './shell-contract.ts'
import css from './SettingsRoot.module.css'
import { DesktopUpdateIndicator } from './DesktopUpdateIndicator.tsx'
import type { SettingsKey } from './locales.ts'

const RECOVERY_CONFIRMATION_MS = 2_000

/** Minimum visible time for the connecting pill; shorter attempts read as flicker. */
const CONNECTING_MIN_VISIBLE_MS = 800

/** Nav glyph by section id; unknown ids fall back to the settings gear. */
function navIcon(id: string) {
  if (id === 'models') return <IconDataOutline16 className={css.navIcon} size={16} />
  if (id === 'agent-presets') return <IconAgentPresetOutline16 className={css.navIcon} size={16} />
  if (id === 'qianshou-account') return <IconUserOutline16 className={css.navIcon} size={16} />
  if (id === 'qianshou-capability') return <IconGaugeOutline16 className={css.navIcon} size={16} />
  if (id === 'plugins') return <IconPluginPinwheelOutline16 className={css.navIcon} size={16} />
  // 20-native glyph in the rail's 16px icon slot, as on the Session row menu.
  if (id === 'archived-sessions') return <IconArchiveOutline20 className={css.navIcon} size={16} />
  return <IconSettingsOutline16 className={css.navIcon} size={16} />
}

type PanelProps = {
  rows: readonly SettingsSectionRow[]
  renderSlot: SettingsRootComponentProps['renderSlot']
  t: SettingsRootComponentProps['t']
  activeId: string | undefined
  onSelect: (id: string) => void
  onClose: () => void
  qianshou: boolean
}

type NavGroup = 'everyday' | 'agent' | 'advanced'

/** Keep the product's routine settings ahead of component diagnostics. */
const NAV_GROUPS: readonly { id: NavGroup; rows: readonly string[] }[] = [
  { id: 'everyday', rows: ['qianshou-account', 'general', 'models'] },
  { id: 'agent', rows: ['agent-presets'] },
  { id: 'advanced', rows: ['plugins', 'qianshou-capability', 'archived-sessions'] },
]

/** Unknown contributions remain reachable in Advanced without changing the slot ledger. */
function groupedRows(rows: readonly SettingsSectionRow[]): readonly { id: NavGroup; rows: readonly SettingsSectionRow[] }[] {
  const known = new Set(NAV_GROUPS.flatMap(group => group.rows))
  return NAV_GROUPS.map(group => ({
    id: group.id,
    rows: [
      ...group.rows.flatMap(id => rows.filter(row => row.id === id)),
      ...(group.id === 'advanced' ? rows.filter(row => !known.has(row.id)) : []),
    ],
  })).filter(group => group.rows.length > 0)
}

/** Compact explanation in the shell header; detailed help remains in each section. */
function sectionHintKey(id: string | undefined): SettingsKey {
  switch (id) {
    case 'general': return 'sectionHint.general'
    case 'models': return 'sectionHint.models'
    case 'qianshou-account': return 'sectionHint.account'
    case 'agent-presets': return 'sectionHint.agent'
    case 'plugins': return 'sectionHint.plugins'
    case 'qianshou-capability': return 'sectionHint.capability'
    case 'archived-sessions': return 'sectionHint.archive'
    default: return 'sectionHint.other'
  }
}

/**
 * The modal layer: full-viewport mask + centered panel. Close paths: the
 * header button, a mask click, and document-level Escape (mounted only while
 * open, so the listener lifetime is the panel's).
 */
function SettingsPanel({ rows, renderSlot, t, activeId, onSelect, onClose, qianshou }: PanelProps) {
  // The installed legacy technical market is separate from Qianshou's Skills
  // center. Its registration remains intact for the upstream profile.
  const shownRows = qianshou ? rows.filter(row => row.id !== 'market') : rows
  // Entries can unmount underneath the requested id, so the render-time
  // projection falls back to the first row when the id is gone.
  const active = shownRows.find(r => r.id === activeId)?.id ?? shownRows[0]?.id
  const activeRow = shownRows.find(row => row.id === active)
  const titleId = useId()

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])

  // Entering the dialog focuses the close button; the root restores its trigger on close.
  const closeButton = useRef<HTMLButtonElement | null>(null)
  useEffect(() => { closeButton.current?.focus() }, [])

  return (
    <div className={css.overlay} role="presentation">
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div className={css.panel} role="dialog" aria-modal="true" aria-labelledby={titleId}
        data-settings-product={qianshou ? 'qianshou' : undefined}>
        <nav className={css.nav} aria-labelledby={titleId}>
          <div className={css.navTitle} id={titleId}>{renderSlot('settings.header', {})}</div>
          <div className={css.navList}>
            {groupedRows(shownRows).map(group => (
              <div className={css.navGroup} key={group.id}>
                <div className={css.navGroupTitle}>{t(`navGroup.${group.id}`)}</div>
                <div className={css.navGroupRows}>
                  {group.rows.map(row => (
                    <button
                      key={row.id}
                      type="button"
                      className={clsx(css.navCell, row.id === active && css.active)}
                      aria-current={row.id === active ? 'true' : undefined}
                      onClick={() => { onSelect(row.id) }}
                    >
                      {navIcon(row.id)}
                      <span className={css.navLabel}>{row.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </nav>
        <div className={css.content}>
          <div className={css.header}>
            <div className={css.pageContext}>
              {qianshou ? <h2 className={css.pageHeading}>{activeRow?.label ?? t('title')}</h2> : <div className={css.pagePath}>
                {active === 'qianshou-account' ? <strong>{activeRow?.label}</strong> : <>
                  <span>{t('title')}</span>
                  {activeRow !== undefined && <><span aria-hidden="true">/</span><strong>{activeRow.label}</strong></>}
                </>}
              </div>}
              <p>{t(sectionHintKey(active))}</p>
            </div>
            <div className={css.actions}>{renderSlot('settings.action', {})}</div>
            <button ref={closeButton} type="button" className={css.close} onClick={onClose}>
              <IconCloseOutline16 size={14} />
              <span className={css.hiddenLabel}>{renderSlot('settings.close', {})}</span>
            </button>
          </div>
          <div className={css.options}>
            {active !== undefined && renderSlot('settings.section', { close: onClose }, { only: active })}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Render the settings trigger and panel.
 * @param props - composed slot props (contract/slots.ts).
 * @returns the settings shell element tree.
 */
export function SettingsRoot(props: SettingsRootComponentProps) {
  const {
    wide, reconnect, useConnectionState, useSections, useOnboardingSteps, useSessions, renderSlot, t,
    useDesktopUpdate, openDesktopUpdate,
  } = props
  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  const [completedOnboarding, setCompletedOnboarding] = useState<ReadonlySet<string>>(() => new Set())
  const [showRecovery, setShowRecovery] = useState(false)
  const [holdConnecting, setHoldConnecting] = useState(false)
  const connectingShownAt = useRef<number | undefined>(undefined)
  const triggerButton = useRef<HTMLButtonElement | null>(null)
  const qianshouAccountFooter = process.env.DSH_CLIENT_BUILD_PROFILE === 'qianshou'
  const wasOpen = useRef(open)
  const close = useCallback(() => {
    setOpen(false)
    setActiveId(undefined)
  }, [])
  // Restore after the close commit, when the dialog can no longer own focus.
  useEffect(() => {
    if (wasOpen.current && !open) {
      if (qianshouAccountFooter) document.querySelector<HTMLButtonElement>('[data-qianshou-account-entry]')?.focus()
      else triggerButton.current?.focus()
    }
    wasOpen.current = open
  }, [open, qianshouAccountFooter])
  const openSection = useCallback((id: string) => {
    setActiveId(id)
    setOpen(true)
  }, [])

  // The ledger tick keeps the nav rows fresh: registrants re-register with
  // freshly localized text on locale change, and the trigger/header/close
  // seats re-render through their own outlets' subscriptions.
  const rows = useSections(s => s)
  useEffect(() => {
    const onOpenSettings = (event: Event) => {
      if (!(event instanceof CustomEvent)) return
      const detail: unknown = event.detail
      if (typeof detail !== 'object' || detail === null || !('sectionId' in detail)) return
      const sectionId = detail.sectionId
      if (sectionId !== 'general' && sectionId !== 'qianshou-account') return
      if (!rows.some(row => row.id === sectionId)) return
      openSection(sectionId)
    }
    window.addEventListener('qianshou:open-settings', onOpenSettings)
    return () => { window.removeEventListener('qianshou:open-settings', onOpenSettings) }
  }, [openSection, rows])
  useEffect(() => {
    const onOpenUpdate = () => { openDesktopUpdate() }
    window.addEventListener('qianshou:open-update', onOpenUpdate)
    return () => { window.removeEventListener('qianshou:open-update', onOpenUpdate) }
  }, [openDesktopUpdate])
  useEffect(() => {
    window.addEventListener('qianshou:open-intake', close)
    return () => { window.removeEventListener('qianshou:open-intake', close) }
  }, [close])
  const desktopUpdate = useDesktopUpdate(state => state)
  const connectionState = useConnectionState(state => state)
  const previousConnectionState = useRef(connectionState)
  const onboardingSteps = useOnboardingSteps(s => s)
  const onboardingActive = useSessions((state) => {
    const main = Object.values(state.byId)
      .find(session => (session.retainedBy.mainView ?? 0) > 0)
    return state.phase === 'ready' && (main === undefined || main.blank)
  })
  const onboardingStep = onboardingActive
    ? onboardingSteps.find(step => !completedOnboarding.has(step.id))
    : undefined

  useEffect(() => {
    if (onboardingActive) return
    setCompletedOnboarding(new Set())
  }, [onboardingActive])

  useLayoutEffect(() => {
    const previous = previousConnectionState.current
    previousConnectionState.current = connectionState
    if (connectionState !== 'connected') {
      setShowRecovery(false)
      return
    }
    if (previous !== 'disconnected' && previous !== 'connecting') return
    setShowRecovery(true)
  }, [connectionState])

  // The confirmation window starts when the recovered pill becomes visible,
  // which the connecting minimum-visible hold can delay past the transition.
  useLayoutEffect(() => {
    if (!showRecovery || holdConnecting) return
    const timeout = window.setTimeout(() => { setShowRecovery(false) }, RECOVERY_CONFIRMATION_MS)
    return () => { window.clearTimeout(timeout) }
  }, [showRecovery, holdConnecting])

  useLayoutEffect(() => {
    if (connectionState === 'connecting') {
      connectingShownAt.current = Date.now()
      return
    }
    const shownAt = connectingShownAt.current
    if (shownAt === undefined) return
    connectingShownAt.current = undefined
    const remaining = CONNECTING_MIN_VISIBLE_MS - (Date.now() - shownAt)
    if (remaining <= 0) return
    setHoldConnecting(true)
    const timeout = window.setTimeout(() => { setHoldConnecting(false) }, remaining)
    return () => {
      window.clearTimeout(timeout)
      setHoldConnecting(false)
    }
  }, [connectionState])

  const completeOnboardingStep = useCallback((id: string) => {
    setCompletedOnboarding((previous) => {
      if (previous.has(id)) return previous
      return new Set([...previous, id])
    })
  }, [])

  let connectionIndicator: ConnectionIndicatorState | undefined
  if (connectionState === 'connecting' || holdConnecting) {
    connectionIndicator = 'connecting'
  } else if (connectionState === 'disconnected') {
    connectionIndicator = 'disconnected'
  } else if (showRecovery) {
    connectionIndicator = 'recovered'
  }

  return (
    <>
      <div className={clsx(css.triggerRow, !wide && css.railRow, qianshouAccountFooter && css.accountUpdateRow)}
        data-qianshou-update-row={qianshouAccountFooter || undefined}>
        {!qianshouAccountFooter && <button
          ref={triggerButton}
          type="button"
          className={clsx(css.trigger, !wide && css.rail)}
          aria-label={t('trigger')}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => { setOpen(true) }}
        >
          {renderSlot('settings.trigger', { wide })}
        </button>}
        {!qianshouAccountFooter && <ConnectionIndicator
          state={wide && desktopUpdate.presentation?.phase !== 'installing' ? connectionIndicator : undefined}
          disconnectedLabel={t('connection.error')}
          connectingLabel={t('connection.connecting')}
          recoveredLabel={t('connection.connected')}
          reconnectActionLabel={t('connection.reconnect')}
          restartActionLabel={t('connection.restart')}
          onReconnect={reconnect}
        />}
        <DesktopUpdateIndicator wide={wide} hidden={!qianshouAccountFooter && connectionIndicator !== undefined && desktopUpdate.presentation?.phase !== 'installing'}
          t={t} view={desktopUpdate} onOpen={openDesktopUpdate} />
      </div>
      {open && (
        <SettingsPanel
          rows={rows}
          renderSlot={renderSlot}
          t={t}
          activeId={activeId}
          onSelect={setActiveId}
          onClose={close}
          qianshou={qianshouAccountFooter}
        />
      )}
      {/* Dialog chrome and `#root` inert ownership live inside each step's
          visible branch. A step still deciding (private facts loading)
          renders null, so nothing paints or blocks while it decides. */}
      {onboardingStep !== undefined && renderSlot('settings.onboarding', {
        stepId: onboardingStep.id,
        complete: () => { completeOnboardingStep(onboardingStep.id) },
        openSection,
      }, { only: onboardingStep.id })}
    </>
  )
}
