/** A name-based selection over reviewed catalog facts, contained in the topic composer. */
import { useEffect, useRef, useState } from 'react'
import type { CommunityRelated } from './transport.ts'
import type { CommunityMarketChoice, CommunityMarketSearch } from './related-market.ts'
import type { CommunityTranslate } from './locales.ts'
import css from './CommunityPage.module.css'

export function CommunityRelatedPicker({ kind, selected, search, onSelect, t }: {
  readonly kind: CommunityRelated['kind']
  readonly selected: CommunityMarketChoice | null
  readonly search: CommunityMarketSearch | undefined
  readonly onSelect: (item: CommunityMarketChoice | null) => void
  readonly t: CommunityTranslate
}) {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<readonly CommunityMarketChoice[]>([])
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => { request.current?.abort() }, [])
  const find = async (): Promise<void> => {
    request.current?.abort()
    const abort = new AbortController()
    request.current = abort
    setItems([])
    setPhase('loading')
    try {
      if (search === undefined) throw new Error('Market search unavailable')
      const found = await search(kind, query, abort.signal)
      if (abort.signal.aborted) return
      setItems(found.filter(item => item.kind === kind))
      setPhase('ready')
    } catch {
      if (!abort.signal.aborted) setPhase('error')
    }
  }
  return <section className={css.relatedPicker} aria-label={t('relatedSearchSection')}>
    <div className={css.relatedSearchBar}>
      <label>{t('relatedSearch')}<input type="search" value={query} maxLength={100}
        placeholder={t('relatedSearchPlaceholder')} onChange={event => {
          request.current?.abort(); setQuery(event.currentTarget.value); setItems([]); setPhase('idle')
        }} onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); void find() }
        }} /></label>
      <button type="button" className={css.ghost} disabled={phase === 'loading'}
        onClick={() => { void find() }}>{t('relatedSearchButton')}</button>
    </div>
    {selected !== null && <div className={css.relatedSelected} role="status">
      <span>{t('relatedSelected', { name: selected.name })}</span>
      <button type="button" className={css.textButton} onClick={() => { onSelect(null) }}>{t('relatedClear')}</button>
    </div>}
    {phase === 'loading' && <p role="status">{t('relatedSearching')}</p>}
    {phase === 'error' && <p role="alert">{t('relatedSearchUnavailable')}</p>}
    {phase === 'ready' && items.length === 0 && <p role="status">{t('relatedSearchEmpty')}</p>}
    {items.length > 0 && <ul className={css.relatedResults}>{items.map(item => <li key={`${item.kind}:${item.id}`}>
      <article className={css.relatedCard}>
        <strong>{item.name}</strong><p>{item.description}</p>
        {item.salePriceYuan !== undefined && <span>{t('relatedSalePrice', { price: item.salePriceYuan })}</span>}
        {item.version !== undefined && <span>{t('relatedVersion', { version: item.version })}</span>}
        <button type="button" className={css.ghost} onClick={() => { onSelect(item) }}
          aria-label={t('relatedSelectName', { name: item.name })}>{t('relatedSelect')}</button>
      </article>
    </li>)}</ul>}
  </section>
}
