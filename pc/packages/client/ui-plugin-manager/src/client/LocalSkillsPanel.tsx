/** Owner's local skill files with separate evidence for current-conversation availability. */
import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LocalSkillArchiveRequest, LocalSkillRestoreRequest } from '@deepseek-ai/dsh-api-remotes/client'
import type { LocalSkillsView } from './local-skills-controller.ts'
import type { SessionSkillsView } from './session-skills-controller.ts'
import type { LocalSkillKey } from './local-skill-locales.ts'
import type { OrderPublicationView, OrderSkillPricePreview,
  PublicationLifecycleRequest, SkillOrderReviewInput } from './order-publication-controller.ts'
import { CATEGORIES, categoryLabelKey, categoryOfLocalSkill, localSkillCopy, type LocalSkillCategory } from './local-skill-presentation.ts'
import { LocalSkillTrial, type LoadLocalSkillTrial, type RunLocalSkillTrial } from './LocalSkillTrial.tsx'
import { usePublicationReviewRefresh } from './use-publication-review-refresh.ts'
import { publicationArchiveErrorLabel } from './publication-archive-error.ts'
import { canEnableAuthorPublication } from './author-activation-receipt.ts'
import css from './LocalSkillsPanel.module.css'

function sampleStatusLabel(status: string | undefined, evidence: string | undefined): LocalSkillKey {
  if (evidence === 'invalid') return 'publishSampleInvalid'
  if (status === 'independent_sample_required') return 'publishIndependentSampleRequired'
  if (status === 'evidence_deposited') return 'publishSampleDeposited'
  if (status === 'verified') return 'publishSampleVerified'
  if (status === 'running') return 'publishSampleRunning'
  if (status === 'pending') return 'publishSamplePending'
  if (status === 'blocked') return 'publishSampleBlocked'
  return 'publishSampleUnknown'
}

export interface LocalSkillsPanelProps {
  view: LocalSkillsView
  session?: SessionSkillsView | undefined
  t: (key: LocalSkillKey) => string
  ensure: () => Promise<void>
  refreshPublications?: () => Promise<void>
  managePublicationLifecycle?: ((request: PublicationLifecycleRequest) => Promise<boolean>) | undefined
  reload: () => Promise<void>
  archiveLocalSkill?: (request: LocalSkillArchiveRequest) => Promise<boolean>
  refreshLocalArchives?: (() => Promise<void>) | undefined
  restoreLocalSkill?: ((request: LocalSkillRestoreRequest) => Promise<boolean>) | undefined
  runLocalTrial?: RunLocalSkillTrial | undefined
  loadLocalTrial?: LoadLocalSkillTrial | undefined
  useSkill?: ((name: string) => boolean) | undefined
  publication?: OrderPublicationView
  publishOrderSkill?: (source: 'user-dsh' | 'user-agents', name: string, review: SkillOrderReviewInput) => Promise<void>
  previewOrderPrice?: (source: 'user-dsh' | 'user-agents', name: string) => Promise<OrderSkillPricePreview>
  submitSkillProduct?: (source: 'user-dsh' | 'user-agents', name: string,
    salePriceYuan: string) => Promise<boolean>
  retryOrderSkillArchive?: (source: 'user-dsh' | 'user-agents', name: string) => Promise<void>
  retryReviewSamples?: (source: 'user-dsh' | 'user-agents', name: string) => Promise<void>
  planOrderAdapter?: (source: 'user-dsh' | 'user-agents', name: string) => Promise<boolean>
  openIntake?: () => void
  enableOrderSkill?: (source: 'user-dsh' | 'user-agents', name: string) => Promise<void>
  consumptionOnly?: boolean | undefined
  compact?: boolean | undefined
  focusSource?: 'user-dsh' | 'user-agents' | undefined
  focusName?: string | undefined
}

/** A file receipt is distinct from the winning skill in a selected conversation. */
export function LocalSkillsPanel({ view, session, t, ensure, refreshPublications, reload, useSkill,
  runLocalTrial, loadLocalTrial, archiveLocalSkill,
  refreshLocalArchives, restoreLocalSkill,
  publication, publishOrderSkill, previewOrderPrice,
  retryOrderSkillArchive, retryReviewSamples,
  planOrderAdapter, openIntake, enableOrderSkill, compact = false, consumptionOnly = false,
  focusName, focusSource }: LocalSkillsPanelProps) {
  const [category, setCategory] = useState<LocalSkillCategory | 'all'>('all')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [useError, setUseError] = useState(false)
  const [planningSkill, setPlanningSkill] = useState<string | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const [pricingSkill, setPricingSkill] = useState<string | null>(null)
  const [priceError, setPriceError] = useState<string | null>(null)
  const [orderReview, setOrderReview] = useState<({
    source: 'user-dsh' | 'user-agents'
    name: string
    path: string
    skillUpdatedAt: number
    skillSha256: string | undefined
    adapterDigest: string
    platformPriced: boolean
    settingsVersion?: number
    taskDefinitionSha256?: string }
    & SkillOrderReviewInput) | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [detailsError, setDetailsError] = useState(false)
  const [saleError, setSaleError] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [recycleOpen, setRecycleOpen] = useState(false)
  const [dismissedRemovalSignature, setDismissedRemovalSignature] = useState('')
  const [restoredNotice, setRestoredNotice] = useState(false)
  const removalSignature = Object.entries(view.removals ?? {}).filter(([, action]) => action.phase === 'archived')
    .map(([path, action]) => `${path}:${action.receipt?.receiptPath ?? ''}`).sort().join('\n')
  useEffect(() => { void ensure() }, [ensure])
  useEffect(() => {
    if (!consumptionOnly && refreshPublications !== undefined) void refreshPublications()
  }, [refreshPublications, consumptionOnly])
  useEffect(() => { if (focusName !== undefined) { setQuery(focusName); setCategory('all') } }, [focusName])
  const pendingReview = !consumptionOnly && Object.values(publication?.items ?? {}).some(row => row.lifecycle?.archived !== true
    && (['archive-pending', 'submitted'].includes(row.phase) || row.marketProductStatus === 'review'))
  usePublicationReviewRefresh(pendingReview, refreshPublications,
    publication?.refreshing === true || publication?.busyKey != null || view.status === 'loading')

  const categories = CATEGORIES.filter(value => view.skills.some(skill => categoryOfLocalSkill(skill) === value))
  const normalized = query.trim().toLocaleLowerCase()
  const filtered = [...view.skills].sort((a, b) => b.updatedAt - a.updatedAt).filter((skill) => {
    if (focusSource !== undefined && skill.source !== focusSource) return false
    if (category !== 'all' && categoryOfLocalSkill(skill) !== category) return false
    if (normalized === '') return true
    const copy = localSkillCopy(skill, t)
    return [skill.name, copy.title, copy.about, skill.description]
      .some(value => value.toLocaleLowerCase().includes(normalized))
  })
  const shown = compact && !expanded ? filtered.slice(0, 6) : filtered
  const reviewSourcePresent = orderReview !== null && view.skills.some(skill => skill.source === orderReview.source
    && skill.name === orderReview.name && skill.path === orderReview.path
    && skill.updatedAt === orderReview.skillUpdatedAt && skill.sha256 === orderReview.skillSha256)
  const reviewEligible = reviewSourcePresent && view.status === 'ready'
    && view.eligibilityStatus === 'ready'
    && view.orderEligible?.some(item => item.source === orderReview.source && item.name === orderReview.name
      && item.path === orderReview.path && (orderReview.platformPriced
        || item.artifactDigest === orderReview.adapterDigest)) === true
  const reviewVisible = reviewSourcePresent && (view.eligibilityStatus !== 'ready' || reviewEligible)
  useEffect(() => {
    if (orderReview !== null && (!reviewSourcePresent
      || view.status === 'ready' && view.eligibilityStatus === 'ready' && !reviewEligible)) setOrderReview(null)
  }, [orderReview, reviewSourcePresent, reviewEligible, view.status, view.eligibilityStatus])
  const preparePublication = (source: 'user-dsh' | 'user-agents', name: string, key: string): void => {
    if (planOrderAdapter === undefined) return
    setPlanningSkill(key)
    setPlanError(null)
    void planOrderAdapter(source, name).then((opened) => {
      if (!opened) setPlanError(key)
    }).catch(() => { setPlanError(key) }).finally(() => { setPlanningSkill(null) })
  }

  return <section className={css.panel} data-local-skills>
    <header className={css.header}>
      <div><h2>{t('title')}</h2><p>{t('scope')}</p></div>
      <div className={css.headerActions}>
        {refreshLocalArchives !== undefined && <Button variant="outline" size="sm" aria-expanded={recycleOpen}
          onClick={() => { setRecycleOpen(!recycleOpen); if (!recycleOpen) void refreshLocalArchives() }}>{t('localRecycle')}</Button>}
        <Button variant="outline" size="sm" disabled={view.status === 'loading' || publication?.refreshing === true}
          onClick={() => { void reload() }}>{t(publication?.refreshing === true ? 'publishRefreshingReview' : 'refresh')}</Button>
      </div>
    </header>
    {view.status === 'loading' && <p className={css.notice} role="status">{t('loading')}</p>}
    {view.status === 'error' && <p className={css.notice} role="alert">{t('unavailable')}</p>}
    {!consumptionOnly && view.status === 'ready' && view.eligibilityStatus === 'loading'
      && <p className={css.notice} role="status">{t('orderEligibilityLoading')}</p>}
    {!consumptionOnly && view.status === 'ready' && view.eligibilityStatus === 'unavailable'
      && <p className={css.notice} role="alert">{t('orderEligibilityUnavailable')}</p>}
    {useError && <p className={css.notice} role="alert">{t('notInSession')}</p>}
    {removalSignature !== '' && removalSignature !== dismissedRemovalSignature && <div className={css.notice} role="status">
      <span>{t('localRemoveDone')}</span> <button type="button"
        onClick={() => { setDismissedRemovalSignature(removalSignature) }}>{t('localNoticeDismiss')}</button>
    </div>}
    {restoredNotice && <p className={css.notice} role="status">{t('localRestoreDone')}</p>}
    {recycleOpen && <section className={css.recycle} aria-label={t('localRecycle')}>
      <header className={css.header}><h3>{t('localRecycle')}</h3>
        <Button variant="outline" size="sm" disabled={view.archiveStatus === 'loading'}
          onClick={() => { void refreshLocalArchives?.() }}>{t('refresh')}</Button></header>
      <p>{t('localRestoreExplain')}</p>
      {view.archiveStatus === 'loading' && <p role="status">{t('localRecycleLoading')}</p>}
      {view.archiveStatus === 'error' && <p role="alert">{t('localRecycleFailed')}</p>}
      {view.archiveStatus === 'ready' && view.archives?.length === 0 && <p>{t('localRecycleEmpty')}</p>}
      <ul className={css.recycleList}>{(view.archives ?? []).map((entry) => {
        const action = view.restorations?.[entry.archiveId]
        return <li key={entry.archiveId}>
          <div className={css.header}><div><strong>{localSkillCopy({ name: entry.name,
            displayName: entry.displayName ?? entry.name, description: entry.description ?? '' }, t).title}</strong> <time dateTime={entry.archivedAt}>
            {new Date(entry.archivedAt).toLocaleDateString(navigator.language)}</time></div>
          <Button variant="outline" size="sm" disabled={view.archiveStatus !== 'ready' || action?.phase === 'restoring'
            || restoreLocalSkill === undefined} onClick={() => {
            setRestoredNotice(false)
            void restoreLocalSkill?.({ source: entry.source, archiveId: entry.archiveId, sha256: entry.sha256 })
              .then((restored) => { if (restored) { setRestoredNotice(true); setDismissedRemovalSignature(removalSignature) } })
          }}>{t(action?.phase === 'restoring' ? 'localRestoring' : 'localRestore')}</Button></div>
          {action?.phase === 'failed' && <p role="alert">{t(action.reason === 'skill-import/conflict'
            ? 'localRestoreConflict' : action.reason === 'skill-import/in-use' ? 'localRemoveInUse' : 'localRestoreFailed')}</p>}
          <details className={css.details}><summary>{t('skillCardDetails')}</summary>
            <p>{t('localRecycleOriginal')} <code>{entry.originalPath}</code></p>
            <p>{t('localRecycleBackup')} <code>{entry.archivePath}</code></p></details>
        </li>
      })}</ul>
    </section>}
    {(view.status === 'ready' || view.skills.length > 0) && (view.skills.length === 0
      ? <p className={css.empty} role="status">{t('empty')}</p>
      : <>
        {(!compact || expanded) && <label className={css.search}><span>{t('searchLabel')}</span>
          <input type="search" value={query} placeholder={t('searchPlaceholder')}
            onChange={(event) => { setQuery(event.currentTarget.value) }} /></label>}
        <div className={css.categories} role="group" aria-label={t('title')}>
          <button type="button" className={category === 'all' ? css.active : ''} aria-pressed={category === 'all'} onClick={() => { setCategory('all') }}>{t('all')}</button>
          {categories.map(value => <button type="button" key={value} className={category === value ? css.active : ''}
            aria-pressed={category === value} onClick={() => { setCategory(value) }}>{t(categoryLabelKey(value))}</button>)}
        </div>
        <p className={css.count}>{t('count').replace('{count}', String(filtered.length))}</p>
        {filtered.length === 0 && <p className={css.notice} role="status">{t('noMatches')}</p>}
        <ul className={css.grid}>{shown.map((skill) => {
          const copy = localSkillCopy(skill, t)
          const categoryLabel = t(categoryLabelKey(categoryOfLocalSkill(skill)))
          const winner = session?.status === 'ready' && session.skills.find(entry => entry.name === skill.name)
          const available = winner !== false && winner !== undefined && winner.path === skill.path
          const status = session?.sessionId === null || session === undefined ? t('noSession')
            : available ? skill.userInvocable ? t('inSession') : t('modelOnly') : t('notInSession')
          const publicationKey = `skill:${skill.source}:${encodeURIComponent(skill.name)}`
          const removal = view.removals?.[skill.path]
          const progress = publication?.items[publicationKey]
          const sellerProduct = progress?.publicationId === undefined ? undefined
            : publication?.sellerProducts?.[progress.publicationId]
          const productStatus = sellerProduct?.status ?? progress?.marketProductStatus
          const salePriceYuan = sellerProduct?.salePriceYuan ?? progress?.salePriceYuan
          const eligible = view.eligibilityStatus === 'ready'
            ? view.orderEligible?.find(item => item.source === skill.source && item.name === skill.name
              && item.path === skill.path) : undefined
          const needsPreparation = eligible === undefined || (progress?.phase === 'blocked'
            && ['adapter-missing', 'file-input-unsupported', 'platform-task-unmapped',
              'local-verification-failed', 'sample-insufficient']
              .includes(progress.reason ?? ''))
          const busy = view.status !== 'ready' || removal?.phase === 'archiving'
            || !consumptionOnly && (publication?.busyKey !== null && publication?.busyKey !== undefined)
            || pricingSkill !== null
          const publicationMessage = progress?.phase === 'archive-pending' ? 'publishArchivePending'
            : progress?.phase === 'submitted' ? 'publishSubmitted'
              : progress?.phase === 'approved' ? 'publishApproved'
                : progress?.phase === 'rejected' ? 'publishRejected'
                  : progress?.phase === 'ready' ? 'publishReady'
                    : progress?.phase === 'blocked' ? progress.reason === 'file-input-unsupported' ? 'publishBlockedFile'
                      : progress.reason === 'adapter-missing' ? 'publishBlockedAdapter'
                        : progress.reason === 'platform-task-unmapped' ? 'publishBlockedContract'
                          : progress.reason === 'runtime-unavailable' ? 'publishBlockedRuntime'
                            : progress.reason === 'skill-import-unavailable' ? 'publishBlockedSkillImport'
                              : progress.reason === 'node-contributor-unavailable' ? 'publishBlockedContributor'
                                : progress.reason === 'local-verification-failed' ? 'publishBlockedSelfTest'
                                  : progress.reason === 'sample-insufficient' ? 'publishBlockedSamples'
                                    : progress.reason === 'platform-route-unavailable' ? 'publishBlockedPlatformRoute'
                                      : progress.reason === 'platform-unavailable' ? 'publishBlockedPlatform'
                                        : progress.reason === 'publication-conflict' ? 'publishBlockedConflict'
                                          : progress.reason === 'skill-not-found' ? 'publishBlockedSkillMissing'
                                            : progress.reason === 'order-auth-required' ? 'publishBlockedAuth'
                                              : progress.reason === 'already-authorized' ? 'publishBlockedAuthorized' : 'publishBlockedOther'
                      : 'publishChecking'
          const publicationTitle = progress?.reviewSyncStale ? 'publishStatusStale'
            : progress?.phase === 'archive-pending' ? 'publishStatusArchivePending'
              : progress?.phase === 'submitted' ? 'publishStatusSubmitted'
                : progress?.phase === 'approved' ? 'publishStatusApproved'
                  : progress?.phase === 'rejected' ? 'publishStatusRejected'
                    : progress?.phase === 'ready' ? 'publishStatusReady'
                      : progress?.phase === 'blocked' ? 'publishStatusBlocked' : 'publishStatusChecking'
          return <li className={css.card} key={skill.path}>
            <div className={css.cardTop}><span className={css.category}>{categoryLabel}</span>
              <span className={css.status}>{status}</span></div>
            <h3>{copy.title}</h3>
            <p>{copy.about}</p>
            <div className={css.cardFoot}>
              {available && skill.userInvocable && useSkill !== undefined && <Button variant="outline" size="sm" disabled={view.status !== 'ready'} onClick={() => {
                setUseError(!useSkill(skill.name))
              }}>{t('useSkill')}</Button>}
              {!consumptionOnly && runLocalTrial !== undefined && eligible?.platformPriced === true && <LocalSkillTrial
                source={skill.source} name={skill.name} run={runLocalTrial} load={loadLocalTrial}
                prepare={planOrderAdapter === undefined ? undefined : () => { void planOrderAdapter(skill.source, skill.name) }} t={t} />}
              {(archiveLocalSkill !== undefined && skill.canArchive === true && skill.sha256 !== undefined
                || !consumptionOnly && ((publishOrderSkill !== undefined && eligible !== undefined) || planOrderAdapter !== undefined)
                  && !['archive-pending', 'submitted', 'approved'].includes(progress?.phase ?? '')) &&
                <details className={css.management}><summary>{t('skillCardManage')}</summary>
                  <div className={css.managementActions}>
                    {archiveLocalSkill !== undefined && skill.canArchive === true && skill.sha256 !== undefined &&
                      <Button variant="outline" size="sm" disabled={busy || view.activations?.[`${skill.source}:${skill.name}`]?.phase === 'enabling'}
                        onClick={() => { setRestoredNotice(false); setRemoving(skill.path) }}>{t('localRemove')}</Button>}
                    {!consumptionOnly && ((publishOrderSkill !== undefined && eligible !== undefined) || planOrderAdapter !== undefined)
                      && progress?.phase !== 'archive-pending' && progress?.phase !== 'submitted' && progress?.phase !== 'approved'
                      && <Button variant="outline" size="sm" disabled={busy || planningSkill !== null}
                        onClick={() => {
                          if (needsPreparation || eligible === undefined || publishOrderSkill === undefined) {
                            preparePublication(skill.source, skill.name, publicationKey)
                            return
                          }
                          setAdvancedOpen(!eligible.serviceTitle?.trim() || !eligible.serviceDescription?.trim())
                          setDetailsError(false)
                          setSaleError(false)
                          setPriceError(null)
                          if (eligible.platformPriced === true) {
                            if (previewOrderPrice === undefined) { setPriceError(publicationKey); return }
                            setPricingSkill(publicationKey)
                            void previewOrderPrice(skill.source, skill.name).then((preview) => {
                              if (preview.taskType !== eligible.taskType) throw new Error('task contract changed')
                              setOrderReview({ source: skill.source, name: skill.name,
                                path: skill.path, skillUpdatedAt: skill.updatedAt, skillSha256: skill.sha256,
                                adapterDigest: preview.artifactDigest, platformPriced: true,
                                settingsVersion: preview.settingsVersion,
                                taskDefinitionSha256: preview.taskDefinitionSha256,
                                displayName: eligible.serviceTitle?.trim() ?? '',
                                purpose: eligible.serviceDescription?.trim() ?? '',
                                configuration: '', priceYuan: preview.priceYuan, salePriceYuan: '' })
                            }).catch(() => { setPriceError(publicationKey) })
                              .finally(() => { setPricingSkill(null) })
                            return
                          }
                          setOrderReview({ source: skill.source, name: skill.name,
                            path: skill.path, skillUpdatedAt: skill.updatedAt, skillSha256: skill.sha256,
                            adapterDigest: eligible.artifactDigest, platformPriced: false,
                            displayName: eligible.serviceTitle?.trim() ?? '',
                            purpose: eligible.serviceDescription?.trim() ?? '',
                            configuration: '', priceYuan: '0.00', salePriceYuan: '' })
                        }}>{t(pricingSkill === publicationKey ? 'publishPricing'
                          : planningSkill === publicationKey ? 'planningAdapter' : 'publishOrder')}</Button>}
                  </div>
                </details>}
              {priceError === publicationKey && <p role="alert">{t('publishPriceUnavailable')}</p>}
              {planError === publicationKey && <p role="alert">{t('planUnavailable')}</p>}
            </div>
            {removing === skill.path && archiveLocalSkill !== undefined && skill.sha256 !== undefined &&
              <div className={css.publicationStatus} role="group" aria-label={t('localRemoveTitle')}>
                <strong>{t('localRemoveTitle')}：{copy.title}</strong>
                <p>{t('localRemoveExplain')}</p>
                <p>{t('localRemoveCloud')}</p>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => { setRemoving(null) }}>
                  {t('localRemoveCancel')}</Button>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => {
                  const sha256 = skill.sha256
                  if (sha256 === undefined) return
                  void archiveLocalSkill({ source: skill.source, name: skill.name, path: skill.path,
                    sha256 }).then((removed) => { if (removed) setRemoving(null) })
                }}>{t(removal?.phase === 'archiving' ? 'localRemoving' : 'localRemoveConfirm')}</Button>
                {removal?.phase === 'failed' && <p role="alert">{t(removal.reason === 'skill-import/changed'
                  ? 'localRemoveChanged' : removal.reason === 'skill-import/in-use'
                    ? 'localRemoveInUse' : 'localRemoveFailed')}</p>}
              </div>}
            {!consumptionOnly && progress !== undefined && <div className={css.publicationStatus}
              role={progress.phase === 'blocked' ? 'alert' : 'status'} data-order-publication-phase={progress.phase}>
              <strong>{t(!progress.reviewSyncStale && progress.phase === 'approved'
                ? productStatus === 'published' ? 'sellerProductPublished'
                  : productStatus === 'suspended' ? 'publicationLifecycleDelisted'
                    : productStatus === 'review' ? 'sellerProductPending'
                      : productStatus === 'rejected' ? 'sellerProductRejected' : publicationTitle
                : publicationTitle)}</strong>
              {progress.phase === 'blocked' && <p>{t(publicationMessage)}</p>}
              {progress.packageMigrationRequired && <p role="alert">{t('publishPackageMigration')}</p>}
              {progress.mediaEvidenceStatus === 'invalid' && <p role="alert">{t('publishSampleInvalid')}</p>}
              {progress.reviewSyncStale && <p role="status">{t('publishReviewSyncStale')}</p>}
              <details className={css.details} open={progress.phase === 'rejected' || progress.phase === 'blocked'}>
                <summary>{t('skillCardDetails')}</summary>
                <div className={css.detailsBody}>
                  <p>{t('skillCardCommand')} <code>/{skill.name}</code></p>
                  {progress.phase !== 'blocked' && <p>{t(publicationMessage)}</p>}
                  {view.activations?.[`${skill.source}:${skill.name}`]?.phase === 'ready' && <p>{t(
                    view.activations[`${skill.source}:${skill.name}`]?.runtimeKind === 'native-h3' ? 'authorNativeEnabled' : 'authorEnabled')}</p>}
                  {progress.publicationId && <p>{t('publishReceipt')} <code>{progress.publicationId}</code></p>}
                  {progress.priceYuan !== undefined && <p>{t('publishReceiptPrice').replace('{price}', progress.priceYuan)}</p>}
                  {salePriceYuan != null && <p>{t('sellerProductPrice').replace('{price}', salePriceYuan)}</p>}
                  {progress.phase === 'archive-pending' && retryOrderSkillArchive !== undefined &&
                    <Button variant="outline" size="sm" disabled={busy}
                      onClick={() => { void retryOrderSkillArchive(skill.source, skill.name) }}>
                      {t('publishRetryArchive')}
                    </Button>}
                  {progress.phase === 'archive-pending' && progress.archiveError &&
                    <p role="alert">{t(publicationArchiveErrorLabel(progress.archiveError))}</p>}
                  {progress.phase === 'submitted' && <>
                    {progress.mediaEvidenceStatus !== 'invalid' && <p data-order-review-sample-status={progress.reviewSampleStatus ?? 'unknown'}
                      role="status">
                      {t(sampleStatusLabel(progress.reviewSampleStatus, progress.mediaEvidenceStatus))}
                    </p>}
                    {progress.reviewSampleError && <p role="alert">{t('publishSampleStartFailed')}</p>}
                    {retryReviewSamples !== undefined && progress.reviewSampleStatus !== 'independent_sample_required'
                      && (progress.reviewSampleError !== undefined
                      || progress.reviewSampleStatus === undefined || progress.reviewSampleStatus === 'blocked'
                      || progress.mediaEvidenceStatus === 'invalid') &&
                      <Button variant="outline" size="sm" disabled={busy}
                        onClick={() => { void retryReviewSamples(skill.source, skill.name) }}>
                        {t('publishSampleRetry')}
                      </Button>}
                  </>}
                  {['archive-pending', 'submitted', 'approved', 'rejected'].includes(progress.phase) && progress.reviewReasons?.length
                    ? <details className={css.reviewReasons} open={progress.phase === 'rejected'}>
                      <summary>{t('publishReviewReasons').replace('{count}', String(progress.reviewReasons.length))}</summary>
                      <ul>{progress.reviewReasons.map((reason, index) => <li key={`${index}:${reason}`}>{reason}</li>)}</ul>
                    </details> : null}
                  {['archive-pending', 'submitted', 'approved', 'rejected'].includes(progress.phase) && refreshPublications !== undefined
                    && <Button variant="outline" size="sm" disabled={busy || publication?.refreshing === true}
                      onClick={() => { void refreshPublications() }}>
                      {t(publication?.refreshing === true ? 'publishRefreshingReview' : 'publishRefreshReview')}
                    </Button>}
                  {!progress.reviewSyncStale && publication?.reviewSyncedAt !== undefined && <p role="status">
                    {t('publishReviewSynced').replace('{time}', new Date(publication.reviewSyncedAt).toLocaleTimeString())}
                  </p>}
                  {progress.phase === 'approved' && !progress.reviewSyncStale && <div data-seller-product-status={sellerProduct?.status ?? progress.marketProductStatus ?? 'none'}>
                    {sellerProduct !== undefined ? sellerProduct.reviewReasons.length > 0 && <details>
                      <summary>{t('sellerProductReasons')}</summary>
                      <ul>{sellerProduct.reviewReasons.map((reason, index) => <li key={`${index}:${reason}`}>{reason}</li>)}</ul>
                    </details> : progress.marketProductStatus !== 'published' || !progress.marketProductId
                      ? publication?.sellerProductsUnavailable !== false
                        ? <p role="alert">{t('sellerProductLedgerUnavailable')}</p>
                        : <p>{t(progress.salePriceYuan == null ? 'publishLegacyNoListing' : 'publishListingPending')}</p>
                      : null}
                  </div>}
                  {progress.reason === 'file-input-unsupported' && <p>{t('publishBlockedFileNext')}</p>}
                </div>
              </details>
            </div>}
            {(consumptionOnly || progress === undefined) && <details className={css.details}><summary>{t('skillCardDetails')}</summary>
              <p>{t('skillCardCommand')} <code>/{skill.name}</code></p>
            </details>}
            {!consumptionOnly && canEnableAuthorPublication(progress, eligible, productStatus)
              && enableOrderSkill !== undefined && <>
              <Button variant="outline" size="sm" disabled={view.status !== 'ready' || view.eligibilityStatus !== 'ready'
                || view.activations?.[`${skill.source}:${skill.name}`]?.phase === 'enabling'}
              onClick={() => { if (skill.source === 'user-dsh' || skill.source === 'user-agents') void enableOrderSkill(skill.source, skill.name) }}>
                {t(view.activations?.[`${skill.source}:${skill.name}`]?.phase === 'enabling' ? 'authorEnabling' : 'authorEnable')}</Button>
              {view.activations?.[`${skill.source}:${skill.name}`]?.phase === 'ready' ? <p role="status">{t('authorIntakeSaved')}</p> : null}
              {view.activations?.[`${skill.source}:${skill.name}`]?.phase === 'failed' ? <p role="alert">{t(authorActivationError(view.activations?.[`${skill.source}:${skill.name}`]?.reason))}</p> : null}
            </>}
            {!consumptionOnly && progress?.phase === 'ready' && !progress.reviewSyncStale
              && openIntake !== undefined && <Button variant="outline" size="sm"
              onClick={openIntake}>{t('openIntake')}</Button>}
          </li>
        })}</ul>
        {orderReview !== null && reviewVisible && publishOrderSkill !== undefined && <div className={css.reviewBackdrop}
          onMouseDown={(event) => { if (event.target === event.currentTarget && !submitting) setOrderReview(null) }}>
          <form className={css.reviewSheet} role="dialog" aria-modal="true" aria-label={t('publishReviewTitle')}
            onSubmit={(event) => { event.preventDefault(); if (submitting || !reviewEligible) return
              if (orderReview.displayName.trim() === '' || orderReview.purpose.trim() === '') {
                setAdvancedOpen(true); setDetailsError(true); return
              }
              const sale = orderReview.salePriceYuan ?? ''
              if (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/u.test(sale) || Number(sale) > 100000) {
                setSaleError(true); return
              }
              setSubmitting(true)
              void publishOrderSkill(orderReview.source, orderReview.name, {
                displayName: orderReview.displayName, purpose: orderReview.purpose,
                configuration: orderReview.configuration, priceYuan: orderReview.priceYuan,
                salePriceYuan: Number(sale).toFixed(2),
                expectedArtifactDigest: orderReview.adapterDigest,
                ...(orderReview.taskDefinitionSha256 === undefined ? {}
                  : { expectedTaskDefinitionSha256: orderReview.taskDefinitionSha256 }),
              }).finally(() => { setSubmitting(false); setOrderReview(null) })
            }}>
            <header><h3>{t('publishReviewTitle')}</h3><button type="button" aria-label={t('publishReviewClose')}
              disabled={submitting} onClick={() => { setOrderReview(null) }}>×</button></header>
            <p>{t('publishReviewIntro')}</p>
            <p className={css.reviewName}>{orderReview.displayName}</p>
            <p>{orderReview.purpose}</p>
            <label>{t('publishSalePrice')}<input type="text" inputMode="decimal" required
              pattern="(?:0|[1-9][0-9]{0,5})(?:\.[0-9]{1,2})?" value={orderReview.salePriceYuan ?? ''}
              onChange={(event) => {
                setSaleError(false); setOrderReview({ ...orderReview, salePriceYuan: event.currentTarget.value })
              }} /></label>
            <p>{t('publishSaleHint')}</p>
            {saleError && <p role="alert">{t('publishSaleInvalid')}</p>}
            {orderReview.platformPriced ? <>
              <p className={css.reviewName}>{t('publishReviewPlatformPrice').replace('{price}', orderReview.priceYuan)}</p>
              <p>{t('publishReviewPlatformPriceHint').replace('{version}', String(orderReview.settingsVersion))}</p>
            </> : <>
              <label>{t('publishReviewPrice')}<input type="text" inputMode="decimal" required pattern="(?:0|[1-9][0-9]{0,5})(?:\.[0-9]{1,2})?"
                value={orderReview.priceYuan}
                onChange={(event) => { setOrderReview({ ...orderReview, priceYuan: event.currentTarget.value }) }} /></label>
              <p>{t('publishReviewPriceHint')}</p>
            </>}
            <button type="button" className={css.advancedToggle} aria-expanded={advancedOpen}
              onClick={() => { setAdvancedOpen(value => !value) }}>{t('publishReviewAdvanced')}</button>
            {advancedOpen && <div className={css.advancedFields}>
              {detailsError && <p role="alert">{t('publishReviewNeedDetails')}</p>}
              <label>{t('publishReviewName')}<input maxLength={80} value={orderReview.displayName}
                onChange={(event) => {
                  setDetailsError(false); setOrderReview({ ...orderReview, displayName: event.currentTarget.value })
                }} /></label>
              <label>{t('publishReviewPurpose')}<textarea maxLength={500} rows={3} value={orderReview.purpose}
                onChange={(event) => {
                  setDetailsError(false); setOrderReview({ ...orderReview, purpose: event.currentTarget.value })
                }} /></label>
            </div>}
            <footer><Button variant="outline" size="sm" type="button" disabled={submitting} onClick={() => { setOrderReview(null) }}>
              {t('publishReviewCancel')}</Button><Button variant="primary" size="sm" type="submit" disabled={submitting || !reviewEligible}>
              {t(submitting ? 'publishReviewSubmitting' : 'publishReviewSubmit')}</Button></footer>
          </form>
        </div>}
        {compact && filtered.length > 6 && <button type="button" className={css.expand} onClick={() => { setExpanded(value => !value) }}>
          {t(expanded ? 'showLess' : 'showMore')}
        </button>}
      </>)}
  </section>
}

/** Keep the actual failure class visible without exposing tokens or raw server data. */
export function authorActivationError(reason: string | undefined): LocalSkillKey {
  if (reason?.endsWith('order-auth-required')) return 'authorEnableLogin'
  if (reason?.endsWith('order-author-not-published') || reason?.endsWith('order-author-source-changed')) return 'authorEnableSourceChanged'
  if (reason?.endsWith('order-node-contributor-unavailable')) return 'authorEnableNodeUnavailable'
  if (reason?.endsWith('order-author-entitlement-refunded')) return 'authorEnableEntitlementClosed'
  if (reason?.includes('untrusted') || reason?.includes('invalid') || reason?.includes('digest')) return 'authorEnableVerificationFailed'
  if (reason?.endsWith('service-unavailable') || reason?.endsWith('supply-unavailable')) return 'authorEnableGrantFailed'
  return 'authorEnableUnknown'
}
