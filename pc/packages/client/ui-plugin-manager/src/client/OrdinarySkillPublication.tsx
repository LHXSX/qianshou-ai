/** Plain-props ordinary skill publishing; no adapters, scripts or payment operations. */
import { useEffect } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OrdinarySkillsView } from './ordinary-skill-controller.ts'
import type { OrdinarySkillDraft } from './ordinary-skill-transport.ts'
import type { OrdinarySkillKey } from './ordinary-skill-locales.ts'
import css from './MarketplaceWorkspace.module.css'

export interface OrdinarySkillPublicationProps {
  view: OrdinarySkillsView
  edit: (change: Partial<OrdinarySkillDraft>) => void
  reload: () => Promise<void>
  submit: () => Promise<void>
  refresh: () => Promise<void>
  t: (key: OrdinarySkillKey) => string
}
/** Let a person select existing skill bytes and explicitly submit name, description and price. */
export function OrdinarySkillPublication({ view, edit, reload, submit, refresh, t }: OrdinarySkillPublicationProps) {
  useEffect(() => { void reload() }, [reload])
  const locked = view.submitState === 'submitting' || view.submitState === 'unknown'
  const validText = (s: string, limit: number) => s.length > 0 && s.length <= limit && s.trim() === s
    && s.isWellFormed() && !/[\u0000-\u001f\u007f]/u.test(s)
  const valid = view.accountId !== null && view.draft.source !== '' && view.draft.title.trim().length > 0
    && validText(view.draft.title, 80) && validText(view.draft.summary, 400)
    && /^(?:0|[1-9][0-9]{0,7})(?:\.[0-9]{1,2})?$/u.test(view.draft.priceYuan)
  return <section className={css.ordinarySkillPanel}>
    <h3>{t('title')}</h3><p>{t('instructions')}</p>
    <label>{t('local')}<select disabled={locked} value={JSON.stringify([view.draft.source, view.draft.name])}
      onChange={(e) => { const selected = view.skills.find(s => JSON.stringify([s.source, s.name]) === e.target.value)
        if (selected !== undefined) edit({ source: selected.source, name: selected.name, title: selected.displayName.slice(0, 80),
          summary: selected.description.slice(0, 400) }) }}>
      <option value={JSON.stringify(['', ''])}>{t('choose')}</option>
      {view.skills.map(s => <option key={`${s.source}:${s.name}`} value={JSON.stringify([s.source, s.name])}>{s.displayName}</option>)}
    </select></label>
    <label>{t('name')}<input disabled={locked} value={view.draft.title} maxLength={80} onChange={(e) => { edit({ title: e.target.value }) }} /></label>
    <label>{t('summary')}<textarea disabled={locked} value={view.draft.summary} maxLength={400} onChange={(e) => { edit({ summary: e.target.value }) }} /></label>
    <label>{t('price')}<input disabled={locked} inputMode="decimal" value={view.draft.priceYuan}
      onChange={(e) => { edit({ priceYuan: e.target.value }) }} /></label>
    <div className={css.actions}>
      <Button disabled={locked || !valid || view.submitState === 'submitted'} onClick={() => { void submit() }}>{t('submit')}</Button>
      <Button variant="outline" disabled={view.submitState === 'submitting'} onClick={() => { void refresh() }}>{t('refresh')}</Button>
    </div>
    {view.accountId === null && <p>{t('signIn')}</p>}
    {view.skills.length === 0 && <p>{t('noLocal')}</p>}
    {view.submitState === 'submitting' && <p role="status">{t('submitting')}</p>}
    {view.submitState === 'unknown' && <p role="alert">{t('unknown')}</p>}
    {view.error && <p role="alert">{t('failed')}</p>}
    <h4>{t('requests')}</h4>
    {view.submissions.map(item => <article key={item.intent.requestId} className={css.record}>
      <strong>{item.intent.title}</strong><p>{item.intent.summary}</p><p>¥{item.intent.priceYuan} · CNY</p>
      <p role="status">{t(item.submission?.review.status ?? 'unknown')}</p>
      <details><summary>{t('package')}</summary><code>{item.intent.packageSha256}</code></details>
      {item.submission?.review.reviewId != null && <details><summary>{t('receipt')}</summary>
        <p>{item.submission.review.note}</p><code>{item.submission.review.reviewId}</code><p>{item.submission.review.operatorId}</p>
        <code>{item.submission.review.testReceiptSha256}</code></details>}
    </article>)}
  </section>
}

export interface OrdinarySkillCatalogProps {
  view: OrdinarySkillsView
  reload: () => Promise<void>
  t: (key: OrdinarySkillKey) => string
  officialOnly?: boolean | undefined
}
/** Show real reviewed ordinary prices and author kinds while purchase and installation remain closed. */
export function OrdinarySkillCatalog({ view, reload, t, officialOnly = false }: OrdinarySkillCatalogProps) {
  useEffect(() => { void reload() }, [reload])
  const catalog = view.catalog.filter(skill => !officialOnly || skill.publisherKind === 'official')
  return <section className={css.ordinarySkillPanel}><header className={css.header}><h3>{t('market')}</h3>
    <Button variant="outline" size="sm" onClick={() => { void reload() }}>{t('reload')}</Button></header>
  {view.catalogState === 'loading' && <p role="status">{t('loading')}</p>}
  {view.catalogState === 'error' && <p role="alert">{t('failed')}</p>}
  {view.catalogState === 'ready' && catalog.length === 0 && <p>{t('empty')}</p>}
  {catalog.map(skill => <article key={skill.submissionId} className={css.record}>
    <strong>{skill.title}</strong><small>{t(skill.publisherKind)}</small><p>{skill.summary}</p><p>¥{skill.priceYuan} · CNY</p>
    <p>{t('published')}</p><p>{t('unavailable')}</p>
    <details><summary>{t('receipt')}</summary><p>{skill.review.note}</p><p>{skill.review.operatorId}</p>
      <code>{skill.review.reviewId}</code><code>{skill.review.testReceiptSha256}</code><code>{skill.packageSha256}</code></details>
  </article>)}
  </section>
}
