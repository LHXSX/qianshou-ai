/** Account-checked publication and seller receipts, with existing owner actions. */
import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { authorActivationError, type LocalSkillsPanelProps } from './LocalSkillsPanel.tsx'
import type { MarketplaceKey } from './marketplace-locales.ts'
import type { LocalSkillKey } from './local-skill-locales.ts'
import type { OrderPublicationItem, PublicationLifecycleRequest } from './order-publication-controller.ts'
import { PublicationLifecycleConfirmation } from './PublicationLifecycleConfirmation.tsx'
import { publicationActionLabel } from './publication-lifecycle.ts'
import type { MarketplacePublicationFocus } from './marketplace-navigation-contract.ts'
import { localSkillCopy } from './local-skill-presentation.ts'
import { usePublicationReviewRefresh } from './use-publication-review-refresh.ts'
import { publicationArchiveErrorLabel } from './publication-archive-error.ts'
import { canEnableAuthorPublication } from './author-activation-receipt.ts'
import css from './MarketplaceWorkspace.module.css'

function skillReference(key: string): { source: 'user-dsh' | 'user-agents'; name: string } | null {
  const matched = /^skill:(user-dsh|user-agents):(.+)$/u.exec(key)
  if (matched === null) return null
  try {
    const name = decodeURIComponent(matched[2]!)
    return name.length <= 256 ? { source: matched[1] as 'user-dsh' | 'user-agents', name } : null
  } catch { return null }
}

function statusKey(row: OrderPublicationItem): LocalSkillKey {
  if (row.reviewSyncStale) return 'publishStatusStale'
  switch (row.phase) {
    case 'archive-pending': return 'publishStatusArchivePending'
    case 'submitted': return 'publishStatusSubmitted'
    case 'approved': return 'publishStatusApproved'
    case 'rejected': return 'publishStatusRejected'
    case 'withdrawn': return 'publicationLifecycleWithdrawn'
    case 'delisted': return 'publicationLifecycleDelisted'
    case 'archived': return 'publicationLifecycleArchived'
    case 'ready': return 'publishStatusReady'
    case 'blocked': return 'publishStatusBlocked'
    default: return 'publishStatusChecking'
  }
}

const evidenceKeys: Record<string, LocalSkillKey> = {
  package: 'publishEvidencePackage', sample: 'publishEvidenceSample', media: 'publishEvidenceMedia',
  pricing: 'publishEvidencePricing', review: 'publishEvidenceReview',
}

/** Empty input never implies a free listing; only an explicit numeric zero does. */
function salePrice(input: string): string | null {
  const value = input.trim()
  if (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/u.test(value) || Number(value) > 100000) return null
  return Number(value).toFixed(2)
}

function ProductSubmission({ row, skill, localSkills, disabled }: {
  row: OrderPublicationItem
  skill: { source: 'user-dsh' | 'user-agents'; name: string }
  localSkills: LocalSkillsPanelProps
  disabled: boolean
}) {
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const locked = row.salePriceYuan != null
  const price = locked ? salePrice(row.salePriceYuan) : salePrice(input)
  const submit = (): void => {
    if (disabled || pending || price === null || localSkills.submitSkillProduct === undefined) return
    setPending(true); setFailed(false)
    void localSkills.submitSkillProduct(skill.source, skill.name, price)
      .then((ok) => { setFailed(!ok) }, () => { setFailed(true) })
      .finally(() => { setPending(false) })
  }
  return <div>
    <p>{localSkills.t('sellerProductExplain')}</p>
    {locked ? <p>{localSkills.t('sellerProductPriceLocked')}</p> : <label>
      {localSkills.t('sellerProductPriceLabel')}
      <input type="text" inputMode="decimal" value={input} disabled={disabled || pending}
        onChange={(event) => { setInput(event.target.value); setFailed(false) }} />
    </label>}
    {!locked && <p>{localSkills.t('publishSaleHint')}</p>}
    <Button variant="outline" size="sm" disabled={disabled || pending || price === null} onClick={submit}>
      {localSkills.t(pending ? 'sellerProductSubmitting' : 'sellerProductSubmit')}
    </Button>
    {failed && <p role="alert">{localSkills.t('sellerProductSubmitFailed')}</p>}
  </div>
}

export function OrderPublicationsPanel({ localSkills, t, manage, focus = null }: {
  localSkills: LocalSkillsPanelProps
  t: (key: MarketplaceKey) => string
  manage: (name: string) => void
  focus?: MarketplacePublicationFocus | null
}) {
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [confirmation, setConfirmation] = useState<(PublicationLifecycleRequest & { name: string }) | null>(null)
  const [lifecycleFailed, setLifecycleFailed] = useState(false)
  const publication = localSkills.publication
  const busy = pending !== null || publication?.busyKey !== null && publication?.busyKey !== undefined
  const ownedEntries = Object.entries(publication?.items ?? {}).filter(([key]) => focus === null
    || key === `skill:${focus.source}:${encodeURIComponent(focus.name)}`)
  const entries = ownedEntries.filter(([, row]) => (row.lifecycle?.archived === true) === showArchived)
  usePublicationReviewRefresh(ownedEntries.some(([, row]) => row.lifecycle?.archived !== true
    && (['archive-pending', 'submitted'].includes(row.phase) || row.marketProductStatus === 'review')),
    localSkills.refreshPublications, busy || publication?.refreshing === true)
  const selected = confirmation === null ? undefined : publication?.items[confirmation.recordKey]
  const confirmationValid = confirmation !== null && !busy && publication?.refreshing !== true
    && selected?.publicationId === confirmation.publicationId && selected.reviewSyncStale !== true
    && selected.lifecycle?.revision === confirmation.expectedRevision
    && selected.lifecycle.allowedActions.includes(confirmation.action)
    && localSkills.managePublicationLifecycle !== undefined
  const confirmLifecycle = (): void => {
    if (!confirmationValid || localSkills.managePublicationLifecycle === undefined) return
    const request = confirmation
    setPending(request.recordKey); setLifecycleFailed(false)
    void localSkills.managePublicationLifecycle({ recordKey: request.recordKey, publicationId: request.publicationId,
      action: request.action, expectedRevision: request.expectedRevision })
      .then((ok) => { if (ok) setConfirmation(null); else setLifecycleFailed(true) }, () => { setLifecycleFailed(true) })
      .finally(() => { setPending(null) })
  }
  const action = (key: string, run: () => Promise<void>): void => {
    setPending(key); setError(null)
    void run().catch(() => { setError(key) }).finally(() => { setPending(null) })
  }
  return <section className={css.records} aria-label={t('workspacePublications')}>
    <div className={css.header}><div className={css.publicationHeading}>
      <p className={css.intro}>{t('publicationsIntro')}</p>
      {publication?.reviewSyncedAt !== undefined && !ownedEntries.some(([, row]) => row.reviewSyncStale)
        && <span role="status" className={css.synced}>{localSkills.t('publishReviewSynced')
          .replace('{time}', new Date(publication.reviewSyncedAt).toLocaleTimeString())}</span>}
    </div><Button variant="outline" size="sm" disabled={busy || publication?.refreshing === true}
      onClick={() => { action('refresh', localSkills.refreshPublications ?? localSkills.reload) }}>
      {publication?.refreshing === true ? localSkills.t('publishRefreshingReview') : t('publicationsRefresh')}</Button>
    </div>
    <p>{localSkills.t('publicationLifecycleOwnerOnly')}</p>
    <div className={css.actions}>
      <Button variant="outline" size="sm" aria-pressed={!showArchived} onClick={() => { setShowArchived(false) }}>
        {localSkills.t('publicationLifecycleActiveRecords')}</Button>
      <Button variant="outline" size="sm" aria-pressed={showArchived} onClick={() => { setShowArchived(true) }}>
        {localSkills.t('publicationLifecycleArchivedRecords')}</Button>
    </div>
    {entries.some(([, row]) => ['archive-pending', 'submitted'].includes(row.phase))
      && <p role="status">{localSkills.t('publishAutoReviewProgress')}</p>}
    {publication?.sellerProductsUnavailable && <p role="alert">{localSkills.t('sellerProductLedgerUnavailable')}</p>}
    {entries.length === 0 && <p>{showArchived ? localSkills.t('publicationLifecycleArchivedEmpty') : t('publicationsEmpty')}</p>}
    {entries.map(([key, row]) => {
      const skill = skillReference(key)
      const installed = skill === null ? undefined : localSkills.view.skills.find(item => item.source === skill.source && item.name === skill.name)
      const title = row.displayName ?? (installed === undefined ? skill?.name ?? t('publicationDraft')
        : localSkillCopy(installed, localSkills.t).title)
      const publicationId = row.publicationId
      const lifecycle = row.lifecycle
      const product = row.publicationId === undefined ? undefined : publication?.sellerProducts[row.publicationId]
      const productStatus = product?.status ?? row.marketProductStatus
      const eligible = installed === undefined || localSkills.view.eligibilityStatus !== 'ready' ? undefined
        : localSkills.view.orderEligible?.find(item => item.source === installed.source && item.name === installed.name
          && item.path === installed.path)
      const salePriceYuan = product?.salePriceYuan ?? row.salePriceYuan
      const canRetrySamples = row.phase === 'submitted' && row.reviewSampleStatus !== 'independent_sample_required'
        && (row.reviewSampleError !== undefined || row.reviewSampleStatus === undefined
          || row.reviewSampleStatus === 'blocked' || row.mediaEvidenceStatus === 'invalid')
      return <article className={css.record} key={key} data-order-publication-phase={row.phase}>
        <header className={css.recordHeading}><h3>{title}</h3>
          <strong data-publication-primary-status>{localSkills.t(row.phase === 'approved' && !row.reviewSyncStale
            ? productStatus === 'suspended' || row.lifecycle?.state === 'delisted' ? 'publicationLifecycleDelisted'
              : productStatus === 'published' ? 'sellerProductPublished'
                : productStatus === 'review' ? 'sellerProductPending'
                  : productStatus === 'rejected' ? 'sellerProductRejected' : statusKey(row)
            : statusKey(row))}</strong></header>
        {row.priceYuan !== undefined && <p>{t('publicationExecutionPrice').replace('{price}', row.priceYuan)}</p>}
        {salePriceYuan != null && <p>{localSkills.t('sellerProductPrice').replace('{price}', salePriceYuan)}</p>}
        {row.reviewSyncStale && <p role="status">{localSkills.t('publishReviewSyncStale')}</p>}
        {row.lifecycle?.blockingReasons.map(reason => reason === 'active-orders'
          ? <p role="status" key={reason}>{localSkills.t('publicationLifecycleActiveOrders')}</p>
          : reason === 'pending-install' ? <p role="status" key={reason}>{localSkills.t('publicationLifecyclePendingInstall')}</p> : null)}
        {row.phase === 'approved' && row.archiveStatus !== 'confirmed'
          && <p role="status">{localSkills.t('sellerProductArchiveRequired')}</p>}
        {row.packageMigrationRequired && <p role="alert">{localSkills.t('publishPackageMigration')}</p>}
        {row.mediaEvidenceStatus === 'invalid' && <p role="alert">{localSkills.t('publishSampleInvalid')}</p>}
        <details className={css.recordDetails} open={row.phase === 'rejected' || row.phase === 'blocked'}><summary>{localSkills.t('skillCardDetails')}</summary>
          <div className={css.recordDetailsBody}>
            {row.publicationId !== undefined && <p><small>{t('publicationReference')}：<code>{row.publicationId}</code></small></p>}
            {row.phase === 'approved' && <p>{localSkills.t(statusKey(row))}</p>}
            {row.phase === 'archive-pending' && <p>{localSkills.t('publishArchivePending')}</p>}
            {row.phase === 'archive-pending' && row.archiveError !== undefined
              && <p role="alert">{localSkills.t(publicationArchiveErrorLabel(row.archiveError))}</p>}
            {row.phase === 'submitted' && row.mediaEvidenceStatus !== 'invalid' && <p>{localSkills.t(row.reviewSampleStatus === 'independent_sample_required' ? 'publishIndependentSampleRequired'
              : row.reviewSampleStatus === 'evidence_deposited' ? 'publishSampleDeposited'
                : row.reviewSampleStatus === 'verified' ? 'publishSampleVerified'
                  : row.reviewSampleStatus === 'running' ? 'publishSampleRunning'
                    : row.reviewSampleStatus === 'pending' ? 'publishSamplePending'
                      : row.reviewSampleStatus === 'blocked' ? 'publishSampleBlocked' : 'publishSampleUnknown')}</p>}
            <span data-seller-product-status={product?.status ?? row.marketProductStatus ?? 'none'} />
            {skill !== null && localSkills.view.activations?.[`${skill.source}:${skill.name}`]?.phase === 'ready'
              && <p>{localSkills.t(localSkills.view.activations[`${skill.source}:${skill.name}`]?.runtimeKind === 'native-h3'
                ? 'authorNativeEnabled' : 'authorEnabled')}</p>}
            {(row.reviewReasons?.length || product?.reviewReasons.length) ? <details open={row.phase === 'rejected' || row.phase === 'blocked'}>
              <summary>{t('publicationConditions')}</summary><ul>
                {[...(row.reviewReasons ?? []), ...(product?.reviewReasons ?? [])].map((reason, index) => {
                  const kind = /^(package|sample|media|pricing|review):\s/u.exec(reason)?.[1]
                  const evidenceState = kind === undefined ? undefined : row.evidenceStatus?.[kind]
                  const label = kind === undefined ? '' : localSkills.t(evidenceKeys[kind]!)
                  return <li key={index}>{evidenceState === 'missing'
                    ? localSkills.t('publishEvidencePending').replace('{kind}', label)
                    : evidenceState === 'invalid' ? localSkills.t('publishEvidenceInvalid').replace('{kind}', label)
                      : reason}</li>
                })}
              </ul></details> : null}
          </div>
        </details>
        {skill !== null && row.phase === 'approved' && row.archiveStatus === 'confirmed'
          && row.publicationId !== undefined && product === undefined
          && row.marketProductId == null && row.marketProductStatus == null
          && localSkills.submitSkillProduct !== undefined && <ProductSubmission
          key={row.publicationId} row={row} skill={skill} localSkills={localSkills}
          disabled={busy || publication?.refreshing === true || publication?.sellerProductsUnavailable === true
              || row.reviewSyncStale === true || localSkills.view.status !== 'ready'} />}
        <details className={css.recordManagement}><summary>{localSkills.t('skillCardManage')}</summary>
          <div className={css.actions}>
            {publicationId !== undefined && localSkills.managePublicationLifecycle !== undefined && lifecycle !== undefined
              && lifecycle.allowedActions.map(lifecycleAction => <Button key={lifecycleAction} variant="outline" size="sm"
                disabled={busy || publication?.refreshing === true || row.reviewSyncStale === true}
                onClick={() => {
                  setLifecycleFailed(false)
                  setConfirmation({ recordKey: key, publicationId, expectedRevision: lifecycle.revision,
                    action: lifecycleAction, name: title })
                }}>{localSkills.t(publicationActionLabel[lifecycleAction])}</Button>)}
            {skill !== null && <Button variant="outline" size="sm" onClick={() => { manage(skill.name) }}>{t('publicationManage')}</Button>}
            {skill !== null && row.phase === 'archive-pending' && localSkills.retryOrderSkillArchive !== undefined
              && <Button variant="outline" size="sm" disabled={busy} onClick={() => {
                action(key, () => localSkills.retryOrderSkillArchive!(skill.source, skill.name))
              }}>{localSkills.t('publishRetryArchive')}</Button>}
            {skill !== null && canRetrySamples && localSkills.retryReviewSamples !== undefined
              && <Button variant="outline" size="sm" disabled={busy} onClick={() => {
                action(key, () => localSkills.retryReviewSamples!(skill.source, skill.name))
              }}>{localSkills.t('publishSampleRetry')}</Button>}
            {skill !== null && installed !== undefined && canEnableAuthorPublication(row, eligible, productStatus)
              && localSkills.enableOrderSkill !== undefined && <Button variant="outline" size="sm"
              disabled={busy || localSkills.view.activations?.[`${skill.source}:${skill.name}`]?.phase === 'enabling'}
              onClick={() => { action(key, () => localSkills.enableOrderSkill!(skill.source, skill.name)) }}>
              {localSkills.t(localSkills.view.activations?.[`${skill.source}:${skill.name}`]?.phase === 'enabling' ? 'authorEnabling' : 'authorEnable')}</Button>}
          </div>
        </details>
        {skill !== null && localSkills.view.activations?.[`${skill.source}:${skill.name}`]?.phase === 'ready'
          && <p role="status">{localSkills.t('authorIntakeSaved')}</p>}
        {skill !== null && localSkills.view.activations?.[`${skill.source}:${skill.name}`]?.phase === 'failed'
          && <p role="alert">{localSkills.t(authorActivationError(localSkills.view.activations?.[`${skill.source}:${skill.name}`]?.reason))}</p>}
        {error === key && <p role="alert" className={css.notice}>{t('publicationActionFailed')}</p>}
      </article>
    })}
    {error === 'refresh' && <p role="alert" className={css.notice}>{t('publicationActionFailed')}</p>}
    {confirmation !== null && <PublicationLifecycleConfirmation action={confirmation.action} name={confirmation.name}
      pending={pending === confirmation.recordKey} valid={confirmationValid} failed={lifecycleFailed}
      t={localSkills.t} onCancel={() => { setConfirmation(null); setLifecycleFailed(false) }} onConfirm={confirmLifecycle} />}
  </section>
}
