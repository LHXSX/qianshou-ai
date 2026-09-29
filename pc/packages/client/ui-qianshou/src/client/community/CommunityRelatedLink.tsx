/** Resolve old and new topic links to their reviewed market display name. */
import { useEffect, useState } from 'react'
import type { CommunityRelated } from './transport.ts'
import type { CommunityMarketResolve } from './related-market.ts'
import type { CommunityTranslate } from './locales.ts'
import css from './CommunityPage.module.css'

export function CommunityRelatedLink({ related, resolve, open, t }: {
  readonly related: CommunityRelated
  readonly resolve: CommunityMarketResolve | undefined
  readonly open: ((related: CommunityRelated) => void) | undefined
  readonly t: CommunityTranslate
}) {
  const [name, setName] = useState<string | null | undefined>()
  useEffect(() => {
    const abort = new AbortController()
    setName(undefined)
    if (resolve === undefined) setName(null)
    else void resolve(related, abort.signal).then((item) => {
      if (!abort.signal.aborted) setName(item?.name || null)
    }).catch(() => { if (!abort.signal.aborted) setName(null) })
    return () => { abort.abort() }
  }, [related, resolve])
  return <div className={css.related}>
    <span>{t('relatedLabel', { kind: t(related.kind === 'skill' ? 'relatedSkill' : 'relatedProduct'),
      name: name === undefined ? t('relatedNameLoading') : name ?? t('relatedNameUnavailable') })}</span>
    {open && <button type="button" className={css.ghost} onClick={() => { open(related) }}>{t('relatedView')} →</button>}
  </div>
}
