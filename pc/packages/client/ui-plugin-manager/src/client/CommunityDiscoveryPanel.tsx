/** Public registry entries, clearly separate from the Qianshou capability catalog. */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CommunityView } from './community-controller.ts'
import type { CommunityKey } from './community-locales.ts'
import css from './CommunityDiscoveryPanel.module.css'

export interface CommunityDiscoveryPanelProps {
  view: CommunityView
  query: string
  t: (key: CommunityKey) => string
  search: (query: string) => void
  loadMore: () => void
  /** Opens the Host inspector with an exact package name and version. */
  reviewPackage: (spec: string) => void
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '')
}

export function CommunityDiscoveryPanel({ view, query, t, search, loadMore, reviewPackage }: CommunityDiscoveryPanelProps) {
  const tooLong = query.length > 120
  const termChanged = view.status !== 'idle' && query.trim() !== view.query
  const omitted = view.excluded + view.unavailable
  return <section className={css.section} data-community-discovery>
    <div className={css.head}>
      <div><h2>{t('title')}</h2><p>{t('description')}</p></div>
      <Button variant="outline" size="sm" disabled={view.status === 'loading' || tooLong}
        onClick={() => { search(query) }}>{t(view.status === 'loading' ? 'searching' : 'search')}</Button>
    </div>
    {tooLong && <p className={css.note} role="status">{t('queryTooLong')}</p>}
    {view.status === 'loading' && <p className={css.note} role="status">{t('searching')}</p>}
    {view.status === 'error' && <p className={css.note} role="alert">{t('error')}</p>}
    {view.status === 'ready' && <>
      <div className={css.meta}>
        <strong>{view.query === '' ? t('allQuery') : fill(t('lastQuery'), { query: view.query })}</strong>
        <span>{fill(t('source'), { source: view.source })}</span>
      </div>
      {termChanged && <p className={css.note} role="status">{t('changedQuery')}</p>}
      {view.entries.length === 0 && <p className={css.note}>{t('empty')}</p>}
      <ul className={css.grid}>{view.entries.map(entry => <li className={css.card} key={`${entry.name}@${entry.version}`}>
        <div className={css.cardTitle}><h3>{entry.name}</h3><span>{fill(t('version'), { version: entry.version })}</span></div>
        <p>{entry.description}</p>
        <div className={css.cardFoot}>
          <span>{fill(t('publisher'), { publisher: entry.publisher ?? t('unknownPublisher') })}</span>
          <Button variant="outline" size="sm" onClick={() => { reviewPackage(entry.installSpec) }}>{t('inspect')}</Button>
        </div>
      </li>)}</ul>
      {omitted > 0 && <p className={css.note}>{fill(t('omitted'), { count: String(omitted) })}</p>}
      {view.pageError && <p className={css.note} role="alert">{t('moreError')}</p>}
      {view.nextOffset !== null && <Button variant="outline" size="sm" disabled={view.loadingMore || termChanged}
        onClick={loadMore}>{view.loadingMore ? t('searching') : t('loadMore')}</Button>}
      <p className={css.note}>{t('inspectHint')}</p>
    </>}
  </section>
}
