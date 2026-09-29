/**
 * Forge product destinations: the four sidebar pages that used to render one
 * empty-state sentence each.
 *
 * Every page now has a real information hierarchy — a positioning line, grouped
 * fact cards, an actionable "where to use this" list, and one honest boundary
 * note. Live facts arrive through the injected face (see destination-state.ts),
 * and the only buttons rendered are ones that perform a verified navigation.
 */
import { useMemo } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ForgeBrandKey } from './locales.ts'
import { AgentsPage } from './AgentsPage.tsx'
import { FilesPage } from './FilesPage.tsx'
import { ModelsPage } from './ModelsPage.tsx'
import { WorkflowsPage } from './WorkflowsPage.tsx'
import { ActionButton, DestinationFrame, type DestinationPageProps } from './page-chrome.tsx'
import {
  derivePageState, listIsReady,
  type DestinationActions, type DestinationLiveSnapshot, type DestinationsInjected,
} from './destination-state.ts'

/** Which product destination a shell registration renders. */
export type DestinationId = 'qianshou-agents' | 'qianshou-workflows' | 'qianshou-files' | 'qianshou-models-api'

/**
 * Props the slot framework hands one destination occupant: the standard render
 * seat plus this registration's injected face. The per-destination identity
 * (`id`/`title`/`body`) is NOT part of this share — the slot renderer passes the
 * class-level key, so each registration overlays its own identity keys.
 */
export type DestinationOccupantProps = PropsRuntime<'main'> & PropsLocale<'forge.brand'> & DestinationsInjected

/** Props of the static destination page itself: the framework share plus identity. */
export type DestinationsPageProps = DestinationOccupantProps & {
  /** Which product destination this occupant renders. */
  id: DestinationId
  /** Dictionary key of the page heading. */
  title: ForgeBrandKey
  /** Dictionary key of the page's honest boundary note. */
  body: ForgeBrandKey
}

/** Sources a page reads before the client has emitted anything. */
const COLD_SNAPSHOT: DestinationLiveSnapshot = { list: undefined, directory: undefined, directoryMounted: false }

/** Whether a partially-constructed slot supplied the live hook at all. */
function coldHook(): DestinationLiveSnapshot {
  return COLD_SNAPSHOT
}

/** Inert session continuation for a bare mount that supplied no session service. */
function noSession(): void {}

/**
 * Render one forge product destination.
 * @param props - destination identity, locale seat, and the injected live face.
 * @returns the product page for that destination.
 */
export function DestinationPage({
  id, title, body, t, useLiveState, openChat, openPanel, openFiles, openSession,
}: DestinationsPageProps) {
  const live = (useLiveState ?? coldHook)((snapshot: DestinationLiveSnapshot) => snapshot)
  const state = useMemo(() => derivePageState(live), [live])
  const rosterPending = useMemo(() => !listIsReady(live.list), [live.list])
  // The framework always injects the whole face; a bare mount (a unit test or a
  // preview) gets inert stand-ins so the frame still renders its copy.
  const actions: Omit<DestinationActions, 'openPanel' | 'openSession'> = {
    openChat: openChat ?? (() => {}),
    openFiles: openFiles ?? (() => undefined),
  }
  const shared: DestinationPageProps = {
    title,
    body,
    state,
    t,
    rosterPending,
    openFilesPanel: () => { void actions.openFiles() },
  }
  const navActions = <>
    {openChat !== undefined
      && <ActionButton glyph="back" panel={null} onClick={openChat}>{t('shell.back')}</ActionButton>}
    {openPanel !== undefined && <>
      <ActionButton glyph="agents" panel="qianshou-agents" onClick={openPanel('qianshou-agents')}>
        {t('shell.openAgents')}
      </ActionButton>
      <ActionButton glyph="workflows" panel="qianshou-workflows" onClick={openPanel('qianshou-workflows')}>
        {t('shell.openWorkflows')}
      </ActionButton>
      <ActionButton glyph="files" panel="qianshou-files" onClick={openPanel('qianshou-files')}>
        {t('shell.openFiles')}
      </ActionButton>
      <ActionButton glyph="models" panel="qianshou-models-api" onClick={openPanel('qianshou-models-api')}>
        {t('shell.openModels')}
      </ActionButton>
    </>}
  </>
  return (
    <DestinationFrame title={t(title)} position={positionOf(id)} eyebrow="shell.scopeGlobal"
      t={t} actions={navActions}>
      {id === 'qianshou-agents' && <AgentsPage {...shared}
        openChat={actions.openChat}
        openSession={openSession ?? noSession} />}
      {id === 'qianshou-workflows' && <WorkflowsPage {...shared} openPanel={openPanel} />}
      {id === 'qianshou-files' && <FilesPage {...shared} />}
      {id === 'qianshou-models-api' && <ModelsPage {...shared} openPanel={openPanel} />}
    </DestinationFrame>
  )
}

/** One-line positioning copy per destination. */
function positionOf(id: DestinationId): ForgeBrandKey {
  if (id === 'qianshou-agents') return 'dest.agents.position'
  if (id === 'qianshou-workflows') return 'dest.workflows.position'
  if (id === 'qianshou-files') return 'dest.files.position'
  return 'dest.models.position'
}

/**
 * Decorative glyph paths. The four destination titles are the only keys any
 * caller passes (the product nav registers one per destination), so the lookup
 * is total over that set and needs no empty branch.
 */
const DESTINATION_GLYPHS: Record<
  'dest.agents.title' | 'dest.workflows.title' | 'dest.files.title' | 'dest.models.title',
  string
> = {
  'dest.agents.title':
    'M8 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'
    + 'M4 19c.6-2.8 2.6-4 4-4s3.4 1.2 4 4M12 19c.6-2.8 2.6-4 4-4s3.4 1.2 4 4',
  'dest.workflows.title': 'M5 7h6l2 3h6M5 17h4l2-3h8M9 7v10',
  'dest.files.title': 'M7 4h7l5 5v11H7V4Zm7 0v5h5',
  'dest.models.title': 'M12 4 5 8v8l7 4 7-4V8l-7-4Zm0 4v12M5 8l7 4 7-4',
}

/** Decorative glyph shared by a product-nav row. */
export function DestinationIcon({ kind }: { kind: keyof typeof DESTINATION_GLYPHS }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d={DESTINATION_GLYPHS[kind]} />
    </svg>
  )
}
