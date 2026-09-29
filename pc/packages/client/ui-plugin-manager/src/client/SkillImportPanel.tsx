/** Review one locally selected SKILL.md before asking the Host to write it. */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SkillImportView } from './skill-import-controller.ts'
import type { SessionSkillsView } from './session-skills-controller.ts'
import type { MarketplaceKey } from './marketplace-locales.ts'
import css from './SkillImportPanel.module.css'

export interface SkillImportPanelProps {
  view: SkillImportView
  t: (key: MarketplaceKey) => string
  install: () => void
  checkWrite: () => void
  dismiss: () => void
  refreshSkills?: (() => void) | undefined
  sessionSkillsView?: SessionSkillsView | undefined
}

function sessionVerification(view: SkillImportView, session: SessionSkillsView, t: SkillImportPanelProps['t']): string {
  const inspection = view.inspection
  if (inspection === null || view.writtenPath === null) return ''
  if (!inspection.userInvocable) return t('skillImportModelCheckUnavailable')
  if (session.sessionId === null) return t('skillImportNoSession')
  if (session.status !== 'ready') return t('skillImportSessionUnavailable')
  const winner = session.skills.find(skill => skill.name === inspection.name)
  if (winner === undefined) return t('skillImportNotDiscovered')
  if (winner.path === view.writtenPath) return t('skillImportDiscovered')
  if (winner.path !== undefined) return t('skillImportShadowed')
  return t('skillImportSourceUnknown')
}

export function SkillImportPanel({ view, t, install, checkWrite, dismiss, refreshSkills, sessionSkillsView }: SkillImportPanelProps) {
  if (view.status === 'idle') return null
  const busy = view.status === 'reading' || view.status === 'inspecting'
    || view.status === 'installing' || view.status === 'verifying'
  const inspection = view.inspection
  const errorKey = view.error === null ? null : ({
    invalidFile: 'skillImportInvalidFile', tooLarge: 'skillImportTooLarge', readFailed: 'skillImportReadFailed',
    invalid: 'skillImportInvalid', conflict: 'skillImportConflict', different: 'skillImportDifferent', expired: 'skillImportExpired',
    unsafePath: 'skillImportUnsafePath', unavailable: 'skillImportUnavailable',
  } as const)[view.error]
  return <section className={css.panel} aria-label={t('skillImportTitle')} data-skill-import>
    <div className={css.heading}>
      <div><h3>{t('skillImportTitle')}</h3><p>{t('skillImportSource')}: {view.fileName}</p></div>
      <Button variant="outline" size="sm" disabled={view.status === 'installing' || view.status === 'verifying'} onClick={dismiss}>{t('skillImportClose')}</Button>
    </div>
    {busy && <p role="status">{t(view.status === 'installing' ? 'skillImportInstalling'
      : view.status === 'verifying' ? 'skillImportVerifying' : 'skillImportChecking')}</p>}
    {view.status === 'unconfirmed' && <div className={css.uncertain} role="status">
      <p>{t('skillImportUnconfirmed')}</p>
      <Button variant="outline" size="sm" onClick={checkWrite}>{t('skillImportCheckAgain')}</Button>
    </div>}
    {errorKey !== null && <p className={css.error} role="alert">{t(errorKey)}</p>}
    {inspection !== null && <>
      <dl className={css.facts}>
        <dt>{t('skillImportName')}</dt><dd><strong>{inspection.name}</strong></dd>
        <dt>{t('skillImportDescription')}</dt><dd>{inspection.description}</dd>
        <dt>{t('skillImportDestination')}</dt><dd><code>{inspection.targetPath}</code></dd>
        <dt>{t('skillImportDigest')}</dt><dd><code>{inspection.sha256}</code></dd>
        <dt>{t('skillImportSize')}</dt><dd>{inspection.bytes.toLocaleString()} B</dd>
        <dt>{t('skillImportInvocation')}</dt><dd>{inspection.userInvocable
          ? inspection.modelInvocable ? t('skillImportBothInvocable') : t('skillImportUserInvocable')
          : inspection.modelInvocable ? t('skillImportModelOnly') : t('skillImportNotInvocable')}</dd>
      </dl>
      {view.content !== null && <details className={css.preview}>
        <summary>{t('skillImportPreview')}</summary>
        <pre>{view.content}</pre>
      </details>}
      <p className={css.note}>{t('skillImportScope')}</p>
      {view.status === 'ready' && <div className={css.actions}>
        <Button variant="primary" size="sm" onClick={install}>{t('skillImportConfirm')}</Button>
      </div>}
      {view.status === 'written' && <div className={css.result} role="status">
        <p>{t('skillImportWritten')}</p>
        {view.writtenPath !== null && <code>{view.writtenPath}</code>}
        {refreshSkills !== undefined && <Button variant="outline" size="sm" onClick={refreshSkills}>{t('skillImportRefresh')}</Button>}
        {sessionSkillsView !== undefined && <p className={css.verification}>{sessionVerification(view, sessionSkillsView, t)}</p>}
      </div>}
    </>}
  </section>
}
