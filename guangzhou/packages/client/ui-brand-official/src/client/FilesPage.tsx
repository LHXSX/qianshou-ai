/**
 * 文件与数据 — how a session reads the real workspace.
 *
 * The only files this client can enumerate are inside a session: the `@`
 * reference provider and the right sidebar's Files tab. This page therefore
 * documents the three real reading paths and opens that tab for the current
 * session. It shows no file count, no size total, and no library index, because
 * none of those exists anywhere in this deployment.
 */
import {
  ActionButton, BoundaryNote, SectionCard, StepList, type DestinationPageProps,
} from './page-chrome.tsx'
import css from './DestinationPage.module.css'

/** Reading paths, the file-panel action, and the honest scope boundary. */
export function FilesPage({ state, t, body, openFilesPanel }: DestinationPageProps) {
  // The right sidebar's tab store is session-scoped, so the panel only has a
  // workspace to show once a session is open; without one the page says which
  // session it would follow instead of offering a button that cannot work.
  const hasSession = state.sessions.currentId !== null
  return <>
    <SectionCard heading="dest.files.read.title" t={t}>
      <StepList t={t} steps={{ source: 'dest.files.read.items' }} />
      <div className={css.cardFoot}>
        {hasSession
          ? <ActionButton glyph="files" onClick={openFilesPanel}>{t('dest.files.panel')}</ActionButton>
          : <p className={css.empty}>{t('dest.files.panelNoSession')}</p>}
      </div>
    </SectionCard>

    <SectionCard heading="dest.files.scope.title" t={t}>
      <StepList t={t} steps={{ source: 'dest.files.scope.items' }} />
    </SectionCard>
    <BoundaryNote lead={t(body)} note={t('dest.files.notice')} />
  </>
}
