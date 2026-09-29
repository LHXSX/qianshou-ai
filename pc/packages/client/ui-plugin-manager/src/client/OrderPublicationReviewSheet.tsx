/** Author review for an exact local executable candidate. No platform write is exposed here. */
import { useEffect, useRef } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OrderPublicationItem, OrderPublicationReview } from './order-publication-controller.ts'
import type { LocalPluginCandidateKey } from './local-plugin-candidate-locales.ts'
import css from './OrderPublicationReviewSheet.module.css'

interface Props {
  review: OrderPublicationReview
  local?: OrderPublicationItem | undefined
  t: (key: LocalPluginCandidateKey) => string
  edit: (change: Partial<Pick<OrderPublicationReview,
    'name' | 'purpose' | 'category' | 'configuration' | 'saleMode' | 'salePriceYuan'>>) => void
  save: () => Promise<void>
  close: () => void
  openIntake?: (() => void) | undefined
}

export function OrderPublicationReviewSheet({ review, local, t, edit, save, close, openIntake }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { closeRef.current?.focus() }, [review.candidate.draftId])
  const locked = review.status === 'loading' || review.status === 'saving'
  const contract = review.candidate.orderAdapter
  if (contract === undefined) return null
  const localText = local?.phase === 'ready' ? t('reviewStageLocalReady')
    : local?.phase === 'blocked' ? t('reviewStageLocalBlocked') : t('reviewStageLocalPending')

  return <div className={css.backdrop} onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
    <section className={css.sheet} role="dialog" aria-modal="true" aria-labelledby="order-review-title"
      onKeyDown={event => { if (event.key === 'Escape') close() }} data-order-publication-review>
      <header className={css.header}>
        <div><h2 id="order-review-title">{t('reviewTitle')}</h2><p>{t('reviewIntro')}</p></div>
        <button type="button" ref={closeRef} className={css.close} aria-label={t('reviewClose')} onClick={close}>×</button>
      </header>
      <div className={css.body}>
        <div className={css.form}>
          <label>{t('reviewName')}<input value={review.name} maxLength={80} disabled={locked}
            onChange={event => edit({ name: event.currentTarget.value })} /></label>
          <label>{t('reviewPurpose')}<textarea value={review.purpose} maxLength={500} rows={3} disabled={locked}
            onChange={event => edit({ purpose: event.currentTarget.value })} /></label>
          <label>{t('reviewCategory')}<select value={review.category} disabled={locked}
            onChange={event => edit({ category: event.currentTarget.value as OrderPublicationReview['category'] })}>
            <option value="text">{t('reviewCategoryText')}</option>
            <option value="data">{t('reviewCategoryData')}</option>
            <option value="automation">{t('reviewCategoryAutomation')}</option>
          </select></label>
          <label>{t('reviewConfiguration')}<textarea value={review.configuration} maxLength={1000} rows={3} disabled={locked}
            onChange={event => edit({ configuration: event.currentTarget.value })} />
            <small>{t('reviewConfigurationHint')}</small></label>
          <fieldset className={css.contract}><legend>{t('reviewContract')}</legend>
            <dl><div><dt>{t('reviewTaskType')}</dt><dd><code>{contract.taskType}</code></dd></div>
              <div><dt>{t('reviewCapability')}</dt><dd><code>{contract.capabilityId}</code></dd></div>
              <div><dt>{t('reviewInput')}</dt><dd><code>{contract.inputKind}</code></dd></div>
              <div><dt>{t('reviewOutput')}</dt><dd><code>{contract.outputKind}</code></dd></div>
              <div><dt>{t('reviewVersion')}</dt><dd><code>{contract.contractVersion}</code></dd></div></dl>
          </fieldset>
          <label>{t('reviewSaleMode')}<select value={review.saleMode} disabled={locked}
            onChange={event => edit({ saleMode: event.currentTarget.value as OrderPublicationReview['saleMode'] })}>
            <option value="free">{t('reviewSaleFree')}</option>
            <option value="paid">{t('reviewSalePaid')}</option>
          </select></label>
          {review.saleMode === 'paid' && <label>{t('reviewSalePrice')}<input type="text" inputMode="decimal"
            value={review.salePriceYuan} maxLength={9} placeholder="2.50" disabled={locked}
            onChange={event => edit({ salePriceYuan: event.currentTarget.value })} /></label>}
          <p className={css.hint}>{t('reviewSaleHint')}</p>
        </div>
        <aside className={css.stages} aria-label={t('reviewTitle')}>
          <div><strong>{t('reviewStageLocal')}</strong><span data-stage="local">{localText}</span></div>
          <div><strong>{t('reviewStageSubmit')}</strong><span data-stage="submitted">{t('reviewStageSubmitBlocked')}</span></div>
          <div><strong>{t('reviewStageAccept')}</strong><span data-stage="accepted">{t('reviewStageAcceptNone')}</span></div>
          <div><strong>{t('reviewStageBuyer')}</strong><span data-stage="buyer">{t('reviewStageBuyerNone')}</span></div>
          <div><strong>{t('reviewStageGrant')}</strong><span data-stage="grant">{t('reviewStageGrantUnchanged')}</span></div>
          <p className={css.block}>{t('reviewPlatformBlock')}</p>
        </aside>
      </div>
      {review.status === 'loading' && <p className={css.feedback} role="status">{t('reviewLoading')}</p>}
      {review.status === 'saved' && <p className={css.feedback} role="status">{t('reviewSaved')} {t('reviewNext')}</p>}
      {review.status === 'error' && <p className={css.feedback} role="alert">{t(review.error === 'invalid-fields'
        ? 'reviewErrorInvalid' : 'reviewErrorUnavailable')}</p>}
      <footer className={css.footer}>
        {openIntake !== undefined && <Button variant="outline" size="sm" onClick={openIntake}>{t('openIntake')}</Button>}
        <Button variant="primary" size="sm" disabled={locked} onClick={() => { void save() }}>
          {t(review.status === 'saving' ? 'reviewSaving' : 'reviewSave')}
        </Button>
      </footer>
    </section>
  </div>
}
