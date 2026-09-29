/** Private, byte-verified plugin candidates; the existing installer owns the write. */
import { useEffect } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LocalPluginCandidatesView, LocalPluginCandidateView } from './local-plugin-candidates-controller.ts'
import type { OrderPublicationReason, OrderPublicationReview, OrderPublicationView } from './order-publication-controller.ts'
import { OrderPublicationReviewSheet } from './OrderPublicationReviewSheet.tsx'
import type { LocalPluginCandidateKey } from './local-plugin-candidate-locales.ts'
import css from './LocalPluginCandidatesPanel.module.css'

export interface LocalPluginCandidatesPanelProps {
  view: LocalPluginCandidatesView
  installed: readonly { name: string; enabled: boolean; installed: boolean }[]
  t: (key: LocalPluginCandidateKey) => string
  reload: () => Promise<void>
  reviewInstall: (candidate: LocalPluginCandidateView) => void
  checkInstalled?: (candidate: LocalPluginCandidateView) => Promise<void>
  publication?: OrderPublicationView
  publishOrderCandidate?: (candidate: LocalPluginCandidateView) => Promise<void>
  openOrderReview?: (candidate: LocalPluginCandidateView) => void
  editOrderReview?: (change: Partial<Pick<OrderPublicationReview,
    'name' | 'purpose' | 'category' | 'configuration' | 'saleMode' | 'salePriceYuan'>>) => void
  saveOrderReview?: () => Promise<void>
  closeOrderReview?: () => void
  openIntake?: () => void
}

const BLOCKED_KEYS: Record<OrderPublicationReason, LocalPluginCandidateKey> = {
  'candidate-changed': 'publishBlockedcandidateChanged', 'adapter-missing': 'publishBlockedadapterMissing',
  'installed-changed': 'publishBlockedinstalledChanged', 'review-required': 'publishBlockedreviewRequired',
  'install-failed': 'publishBlockedinstallFailed', 'restart-required': 'publishBlockedrestartRequired',
  'activation-failed': 'publishBlockedactivationFailed', 'sample-failed': 'publishBlockedsampleFailed',
  'sample-insufficient': 'publishBlockedsampleFailed',
  'already-authorized': 'publishBlockedalreadyAuthorized', 'inventory-incomplete': 'publishBlockedinventoryIncomplete',
  'skill-not-found': 'publishBlockedskillNotFound', 'file-input-unsupported': 'publishBlockedfileInputUnsupported',
  'platform-task-unmapped': 'publishBlockedplatformTaskUnmapped', 'remote-unavailable': 'publishBlockedremoteUnavailable',
  'runtime-unavailable': 'publishBlockedremoteUnavailable', 'local-verification-failed': 'publishBlockedremoteUnavailable',
  'skill-import-unavailable': 'publishBlockedremoteUnavailable', 'node-contributor-unavailable': 'publishBlockedremoteUnavailable',
  'platform-route-unavailable': 'publishBlockedremoteUnavailable', 'platform-unavailable': 'publishBlockedremoteUnavailable',
  'publication-conflict': 'publishBlockedremoteUnavailable',
  'order-auth-required': 'publishBlockedremoteUnavailable',
}

export function LocalPluginCandidatesPanel({ view, installed, t, reload, reviewInstall, checkInstalled,
  publication, publishOrderCandidate, openOrderReview, editOrderReview, saveOrderReview,
  closeOrderReview, openIntake }: LocalPluginCandidatesPanelProps) {
  useEffect(() => { void reload() }, [reload])
  return <section className={css.panel} data-local-plugin-candidates>
    <header className={css.header}>
      <div><h3>{t('title')}</h3><p>{t('intro')}</p></div>
      <Button variant="outline" size="sm" onClick={() => { void reload() }}>{t('refresh')}</Button>
    </header>
    {view.status === 'loading' ? <p className={css.note} role="status">{t('loading')}</p> : null}
    {view.status === 'error' ? <p className={css.note} role="alert">{t('error')}</p> : null}
    {view.status === 'ready' && view.candidates.length === 0 ? <p className={css.note}>{t('empty')}</p> : null}
    {view.status === 'ready' && view.candidates.length > 0 && <div className={css.grid}>
      {view.candidates.map(candidate => {
        const current = installed.find(item => item.name === candidate.packageName && item.installed)
        const installedCheck = view.installedChecks?.[`${candidate.draftId}:${candidate.packageDigest}`]
        const progress = publication?.items[`candidate:${candidate.draftId}`]
        const busy = publication?.busyKey !== null && publication?.busyKey !== undefined
        return <article className={css.card} key={candidate.packagePath} data-local-plugin-candidate={candidate.packageName}>
          <div className={css.titleLine}>
            <h4>{candidate.displayName}</h4>
            <span data-local-plugin-state={current === undefined ? 'candidate' : current.enabled ? 'enabled' : 'installed'}>
              {t(current === undefined ? 'candidate' : current.enabled ? 'installedOn' : 'installedOff')}
            </span>
          </div>
          <p className={css.description}>{candidate.description}</p>
          <p className={css.scope}>{t('scope')}</p>
          {current !== undefined && <p className={css.note} role={installedCheck === 'changed' ? 'alert' : 'status'}>
            {t(installedCheck === 'matched' ? 'installedMatched'
              : installedCheck === 'changed' ? 'installedChanged'
                : installedCheck === 'unavailable' ? 'installedUnavailable'
                  : installedCheck === 'checking' ? 'installedChecking' : 'installedNote')}</p>}
          <details className={css.details}>
            <summary>{t('details')}</summary>
            <dl>
              <dt>{t('operation')}</dt><dd>{candidate.operationTitle}</dd>
              <dt>{t('command')}</dt><dd><code>{candidate.toolName}</code></dd>
              <dt>{t('package')}</dt><dd><code>{candidate.packageName}</code></dd>
              <dt>{t('location')}</dt><dd><code>{candidate.packagePath}</code></dd>
              <dt>{t('digest')}</dt><dd><code>{candidate.packageDigest}</code></dd>
            </dl>
          </details>
          <div className={css.footer}>
            <span>{t('boundary')}</span>
            {current === undefined && <Button variant="primary" size="sm" onClick={() => { reviewInstall(candidate) }}>{t('reviewInstall')}</Button>}
            {current !== undefined && checkInstalled !== undefined && <Button variant="outline" size="sm"
              disabled={installedCheck === 'checking'} onClick={() => { void checkInstalled(candidate) }}>
              {t('checkInstalled')}
            </Button>}
            {candidate.orderAdapter !== undefined && (openOrderReview !== undefined || publishOrderCandidate !== undefined)
              && <Button variant="outline" size="sm" disabled={busy}
              onClick={() => { if (openOrderReview !== undefined) openOrderReview(candidate)
                else if (publishOrderCandidate !== undefined) void publishOrderCandidate(candidate) }}>{t('publishOrder')}</Button>}
          </div>
          {progress !== undefined && <p className={css.note} role={progress.phase === 'blocked' ? 'alert' : 'status'}
            data-order-publication-phase={progress.phase}>{t(progress.phase === 'blocked'
              ? BLOCKED_KEYS[progress.reason ?? 'remote-unavailable']
              : progress.phase === 'ready' ? 'publishReady' : `publish${progress.phase}` as LocalPluginCandidateKey)}</p>}
          {progress?.phase === 'ready' && openIntake !== undefined && <Button variant="outline" size="sm"
            onClick={openIntake}>{t('openIntake')}</Button>}
        </article>
      })}
    </div>}
    {publication?.review !== undefined && publication.review !== null && editOrderReview !== undefined
      && saveOrderReview !== undefined && closeOrderReview !== undefined && <OrderPublicationReviewSheet
        review={publication.review} local={publication.items[`candidate:${publication.review.candidate.draftId}`]}
        t={t} edit={editOrderReview} save={saveOrderReview} close={closeOrderReview} openIntake={openIntake} />}
  </section>
}
