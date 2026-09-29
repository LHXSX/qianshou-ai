import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ConversationContentProps, ConversationViewsProps, InputZone } from '../contract/slots.ts'
import { HeroShell, WorkspaceChip, workspaceLabel } from './EmptyHero.tsx'
import { followContentEntries } from './content-entry-follow.ts'
import css from './ConversationRoot.module.css'

function ConversationSessionView({ renderSlot }: ConversationViewsProps) {
  return renderSlot('conversation.session', {})
}

function NoConversationWidthControls() {
  return null
}

type WorkspaceOpenFailure = {
  workspaceId: WorkspaceId
  message: 'hero.workspaceOpenFailed' | 'hero.agentStartFailed' | 'hero.agentPresetMissing'
}

function workspaceFailureMessage(reason: unknown): WorkspaceOpenFailure['message'] {
  // Session controller is a separate Client plugin. Read its stable error
  // shape without a cross-plugin runtime import into this bundle.
  const rpcCode = reason instanceof Error && reason.name === 'SessionCreateError'
    ? (reason as Error & { rpcError?: { code?: unknown } }).rpcError?.code
    : undefined
  if (rpcCode === 'agent-preset/not-found' && process.env.DSH_CLIENT_BUILD_PROFILE === 'qianshou') {
    return 'hero.agentPresetMissing'
  }
  if (typeof rpcCode === 'string' && rpcCode.startsWith('agent-preset/')) {
    return 'hero.agentStartFailed'
  }
  return 'hero.workspaceOpenFailed'
}

/**
 * Render the shared Conversation body and its occurrence-selected local Components.
 * @param props - Factory input, standard Session sources, and Conversation seats.
 * @returns the Conversation view, Composer, and optional width controls.
 */
export function ConversationContent(props: ConversationContentProps) {
  const {
    sessionId, phase, hero, useSession, useSessions, useSessionStatus,
    useWorkspaces, useInput, useComposerBlock, renderSlot, renderSlotChain,
    selectWorkspace, t, useFactorySlot,
  } = props
  const session = useSession(snapshot => snapshot)
  const Views = useFactorySlot('views', ConversationSessionView)
  const WidthControls = useFactorySlot('widthControls', NoConversationWidthControls)
  const [body, setBody] = useState<HTMLDivElement | null>(null)
  const [scrollport, setScrollport] = useState<HTMLDivElement | null>(null)
  const [entryArea, setEntryArea] = useState<HTMLDivElement | null>(null)
  const [composerElement, setComposerElement] = useState<HTMLDivElement | null>(null)
  const [contentEntries, setContentEntries] = useState<{ sessionId: typeof sessionId; ids: Set<string> }>(
    () => ({ sessionId, ids: new Set() }))
  const currentSession = useRef(sessionId)
  currentSession.current = sessionId
  const reportPresence = useCallback((entryId: string, present: boolean): void => {
    if (currentSession.current !== sessionId) return
    setContentEntries((previous) => {
      const ids = previous.sessionId === sessionId ? previous.ids : new Set<string>()
      if (ids.has(entryId) === present && previous.sessionId === sessionId) return previous
      const next = new Set(ids)
      if (present) next.add(entryId)
      else next.delete(entryId)
      return { sessionId, ids: next }
    })
  }, [sessionId])
  const hasEntryContent = contentEntries.sessionId === sessionId && contentEntries.ids.size > 0
  const showHero = hero && !hasEntryContent
  const contentPhase = phase === 'hero' && hasEntryContent ? 'active' : phase
  const pendingInteraction = useSessionStatus(snapshot =>
    sessionId === undefined ? undefined : snapshot.get(sessionId)?.pendingInteraction)
  const inputState = useInput(s => s)
  const cwd = useSessions(s => sessionId === undefined ? undefined : s.byId[sessionId]?.cwd)
  const workspaces = useWorkspaces(s => s)
  // A plugin this package cannot import (ui-model-selection) says this session cannot
  // send; its reason is already localized by whoever raised it.
  const composerBlock = useComposerBlock(block => block)

  const [pickerOpen, setPickerOpen] = useState(false)
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState<WorkspaceId | undefined>()
  const [workspaceFailure, setWorkspaceFailure] = useState<WorkspaceOpenFailure | null>(null)
  const workspaceAttempt = useRef(0)
  const pickerAnchor = useRef<HTMLButtonElement>(null)

  // Publishes the two live measurements floating View chrome reads off the
  // scroll body: the seat's height as --dsh-composer-height, so controls clear
  // the composer as it grows, and the scrollport's own height as
  // --dsh-conversation-viewport-height, so a control can sit in the band the
  // seat leaves visible. Callback ref, not an effect; stable identity prevents
  // observer churn while the first blank session fills the resident body
  // outlet.
  const seatObserver = useRef<ResizeObserver | null>(null)
  const seatResizeRef = useCallback((seat: HTMLDivElement | null): void => {
    setComposerElement(seat)
    seatObserver.current?.disconnect()
    seatObserver.current = null
    const scroller = seat?.parentElement ?? null
    if (seat === null || scroller === null) return
    seatObserver.current = new ResizeObserver(() => {
      scroller.style.setProperty('--dsh-composer-height', `${seat.offsetHeight}px`)
      scroller.style.setProperty(
        '--dsh-conversation-viewport-height',
        `${scroller.clientHeight}px`,
      )
    })
    seatObserver.current.observe(seat)
    seatObserver.current.observe(scroller)
  }, [])

  useLayoutEffect(() => {
    if (sessionId === undefined || scrollport === null || entryArea === null || composerElement === null) return
    return followContentEntries(scrollport, entryArea, composerElement,
      () => currentSession.current === sessionId)
  }, [sessionId, scrollport, entryArea, composerElement])

  const sessionWorkspace = sessionId === undefined
    ? undefined
    : workspaces.items.find(workspace => workspace.sessionIds.includes(sessionId))
  const pendingWorkspace = workspaces.items.find(
    workspace => workspace.workspaceId === pendingWorkspaceId,
  )

  // Clear the pending pick once the session lands in it, or when the picked
  // workspace disappears from a ready list (deleted from the sidebar).
  useEffect(() => {
    if (pendingWorkspaceId === undefined) return
    if (sessionWorkspace?.workspaceId === pendingWorkspaceId
      || (workspaces.phase === 'ready' && pendingWorkspace === undefined)) {
      setPendingWorkspaceId(undefined)
    }
  }, [pendingWorkspaceId, sessionWorkspace?.workspaceId, workspaces.phase, pendingWorkspace])

  useEffect(() => {
    if (workspaceFailure === null) return
    if (sessionWorkspace?.workspaceId === workspaceFailure.workspaceId
      || (workspaces.phase === 'ready'
        && !workspaces.items.some(item => item.workspaceId === workspaceFailure.workspaceId))) {
      setWorkspaceFailure(null)
    }
  }, [workspaceFailure, sessionWorkspace?.workspaceId, workspaces.phase, workspaces.items])

  const openWorkspace = (workspaceId: WorkspaceId): void => {
    const attempt = ++workspaceAttempt.current
    setPickerOpen(false)
    setWorkspaceFailure(null)
    setPendingWorkspaceId(workspaceId)
    void selectWorkspace(workspaceId).catch((reason: unknown) => {
      // A second choice can supersede this one while the Host is still
      // creating a Session. Only the latest attempt may change the UI.
      if (attempt !== workspaceAttempt.current) return
      setPendingWorkspaceId(current => current === workspaceId ? undefined : current)
      setWorkspaceFailure({ workspaceId, message: workspaceFailureMessage(reason) })
    })
  }

  const zone: InputZone | undefined =
    session === undefined || inputState === undefined ? undefined : { session, input: inputState }

  // The chip is a selector; label resolution walks the flow top-down:
  //   1. a just-picked workspace (pending) → its title;
  //   2. cold start, no session yet → placeholder ("Choose workspace");
  //   3. the blank session's workspace is in the list → its title;
  //   4. list still loading → cwd folder name bridges so the title does not
  //      flash on refresh (empty cwd → placeholder);
  //   5. list ready but no owning workspace (deleted from the sidebar) →
  //      placeholder, never the deleted folder's name via cwd.
  const chipTitle = pendingWorkspace?.title
    ?? (sessionId === undefined
      ? undefined
      : sessionWorkspace?.title
        ?? (workspaces.phase === 'ready' || cwd === undefined || cwd === ''
          ? undefined
          : workspaceLabel(cwd)))

  const heroWorkspaceRow = (
    <div className={css.heroWorkspaceRow}
      data-qianshou-home={process.env.DSH_CLIENT_BUILD_PROFILE === 'qianshou' ? '' : undefined}>
      <WorkspaceChip
        buttonRef={pickerAnchor}
        label={chipTitle}
        menuOpen={pickerOpen}
        onClick={() => { setPickerOpen(open => !open) }}
        t={t}
      />
      {renderSlot('conversation.hero.workspace', {
        open: pickerOpen,
        anchorRef: pickerAnchor,
        selectedId: pendingWorkspaceId ?? sessionWorkspace?.workspaceId,
        onPick: openWorkspace,
        onClose: () => { setPickerOpen(false) },
      })}
      {renderSlot('conversation.hero.agentPreset', {})}
    </div>
  )

  // The placeholder chip ("Choose workspace") and the Workspace-trigger input travel
  // together: no workspace picked yet (cold start, no session at all), or a
  // blank session whose workspace vanished (deleted from the sidebar). The
  // bar is ONE session-maybe slot rendered unconditionally — inert is a prop,
  // not a different tree, so the textarea DOM survives the transition.
  const inert = sessionId === undefined || (hero && chipTitle === undefined)
  // A raised block is the same inert posture with the blocker's own reason:
  // one disabled textarea, never a second tree. The no-workspace state wins
  // when both hold — picking a workspace is the earlier prerequisite.
  const blocked = !inert && composerBlock !== undefined
  const inputBar = renderSlot('conversation.composer.bar', {
    variant: showHero ? 'hero' : 'composer',
    ...(inert
      ? {
        disabled: true,
        placeholder: t('placeholder.workspace'),
        workspacePickerOpen: pickerOpen,
        onRequestWorkspace: () => { setPickerOpen(true) },
      }
      : blocked
        // `blocked`, not `disabled`: the bar refuses input either way, but a
        // block keeps the model seat live because choosing a model is how the
        // user clears it.
        ? { blocked: composerBlock, placeholder: composerBlock.reason }
        : showHero ? { placeholder: t('placeholder.hero') } : {}),
  })

  const composerBar = (
    <div className={clsx(css.composerStack, showHero && css.composerHero)}>
      {showHero && <HeroShell t={t} renderSlot={renderSlot} />}
      {showHero && heroWorkspaceRow}
      {hero && workspaceFailure !== null && (
        <div className={css.workspaceFailure} role="alert">
          <span>{t(workspaceFailure.message)}</span>
          <button type="button" onClick={() => { openWorkspace(workspaceFailure.workspaceId) }}>
            {t('hero.workspaceRetry')}
          </button>
        </div>
      )}
      {zone !== undefined && renderSlot('conversation.input.dock', zone)}
      {inputBar}
    </div>
  )

  const composer = renderSlotChain(
    'conversation.composer',
    { sessionId, session, pendingInteraction },
    { fallback: composerBar, fallbackOnly: sessionId === undefined, overlay: true },
  )

  // Sticky wraps the whole chain output (fallback + elected overlay), not
  // only `.composerStack`: overlay:true renders those as siblings, and sticky
  // on the fallback alone would leave a business-owned takeover at the content
  // end off-screen when the user is not pinned to the floor.
  const composerSeat = (
    <div ref={seatResizeRef} className={css.composerSeat} data-composer-seat="">
      {composer}
    </div>
  )

  return (
    <div
      ref={setBody}
      className={clsx(css.body, props.variant === 'embedded' && css.embeddedBody)}
      data-conversation-content=""
      data-content-phase={contentPhase}
    >
      <div ref={setScrollport} className={css.scrollBody} data-conversation-scroll="">
        {sessionId === undefined ? null : <Views />}
        {zone !== undefined && <div ref={setEntryArea} className={css.contentEntries} hidden={!hasEntryContent} data-conversation-content-entries="">
          {renderSlot('conversation.content.entries', { ...zone, reportPresence })}
        </div>}
        {composerSeat}
      </div>
      <WidthControls container={body} phase={phase} />
    </div>
  )
}
