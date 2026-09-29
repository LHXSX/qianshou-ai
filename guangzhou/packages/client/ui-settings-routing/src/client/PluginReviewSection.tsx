/** Administrator view of Shanghai's pending marketplace submissions. */
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RoutingKey } from './locales.ts'
import css from './PluginReviewSection.module.css'

const PATH = '/api/qianshou/ai/admin/marketplace'

interface ReviewItem {
  readonly id: number
  readonly name: string
  readonly author_name: string | null
  readonly launch_kind: string
  readonly price: number
  readonly min_memory_mb: number
  readonly gpu_required: boolean
  readonly tiers: readonly string[]
  readonly review_issues: readonly string[]
  readonly can_approve: boolean
}

interface Props {
  readonly t?: (key: RoutingKey) => string
}

const fallbackText = (key: RoutingKey): string => key

function parseItems(payload: unknown): readonly ReviewItem[] {
  if (payload === null || typeof payload !== 'object') throw new Error('INVALID_REVIEW_RESPONSE')
  const result = (payload as Record<string, unknown>)['result']
  if (result === null || typeof result !== 'object') throw new Error('INVALID_REVIEW_RESPONSE')
  const items = (result as Record<string, unknown>)['items']
  if (!Array.isArray(items)) throw new Error('INVALID_REVIEW_RESPONSE')
  for (const item of items) {
    if (item === null || typeof item !== 'object' || typeof item.id !== 'number'
      || !Number.isSafeInteger(item.id) || typeof item.name !== 'string'
      || !(typeof item.author_name === 'string' || item.author_name === null)
      || typeof item.launch_kind !== 'string' || typeof item.price !== 'number'
      || typeof item.min_memory_mb !== 'number' || typeof item.gpu_required !== 'boolean'
      || !Array.isArray(item.tiers) || item.tiers.some((tier: unknown) => typeof tier !== 'string')
      || !Array.isArray(item.review_issues) || item.review_issues.some((issue: unknown) => typeof issue !== 'string')
      || typeof item.can_approve !== 'boolean') throw new Error('INVALID_REVIEW_RESPONSE')
  }
  return items as ReviewItem[]
}

async function post(body: unknown): Promise<unknown> {
  const response = await fetch(PATH, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const payload: unknown = await response.json()
  if (!response.ok) {
    const message = payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>)['message'] : null
    throw new Error(typeof message === 'string' ? message : `HTTP ${response.status}`)
  }
  return payload
}

/** Review queue with explicit reasons and no price or executable activation shortcut. */
export function PluginReviewSection(props: Props) {
  const t = props.t ?? fallbackText
  const [items, setItems] = useState<readonly ReviewItem[] | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState<number | null>(null)
  const [notes, setNotes] = useState<Record<number, string>>({})

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try { setItems(parseItems(await post({ action: 'list' }))) }
    catch (cause) { setItems(null); setError(cause instanceof Error ? cause.message : t('pluginReviewUnavailable')) }
    finally { setLoading(false) }
  }, [t])

  useEffect(() => { void refresh() }, [refresh])

  async function decide(item: ReviewItem, action: 'approve' | 'reject'): Promise<void> {
    const note = (notes[item.id] ?? '').trim()
    if (!note) { setError(t('pluginReviewNoteRequired')); return }
    setPending(item.id)
    setError('')
    try { await post({ action, appId: item.id, note }); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('pluginReviewUnavailable')) }
    finally { setPending(null) }
  }

  return <section className={css.page} aria-label={t('pluginReviewNav')}>
    <header className={css.header}>
      <div><span className={css.eyebrow}>{t('pluginReviewEyebrow')}</span>
        <h1>{t('pluginReviewTitle')}</h1><p>{t('pluginReviewIntro')}</p></div>
      <Button onClick={() => { void refresh() }} disabled={loading || pending !== null}>{t('pluginReviewRefresh')}</Button>
    </header>
    <div className={css.notice}>{t('pluginReviewLimit')}</div>
    {error && <p className={css.error} role="alert">{error}</p>}
    {loading && <p className={css.muted}>{t('pluginReviewLoading')}</p>}
    {items?.length === 0 && <div className={css.empty}>{t('pluginReviewEmpty')}</div>}
    <div className={css.grid}>{items?.map(item => <article key={item.id} className={css.card}>
      <div className={css.cardTop}><div><span className={css.kicker}>{t('pluginReviewSubmission')}</span>
        <h2>{item.name}</h2><p className={css.muted}>{item.author_name || t('pluginReviewUnknownAuthor')}</p></div>
        <span className={item.can_approve ? css.ready : css.blocked}>
          {item.can_approve ? t('pluginReviewReady') : t('pluginReviewBlocked')}
        </span></div>
      <dl className={css.facts}>
        <div><dt>{t('pluginReviewType')}</dt><dd>{item.launch_kind === 'webview' ? t('pluginReviewWeb') : t('pluginReviewExecutable')}</dd></div>
        <div><dt>{t('pluginReviewPrice')}</dt><dd>{item.price === 0 ? t('pluginReviewFree') : String(item.price)}</dd></div>
        <div><dt>{t('pluginReviewMemory')}</dt><dd>{item.min_memory_mb} MB</dd></div>
        <div><dt>{t('pluginReviewGpu')}</dt><dd>{item.gpu_required ? t('pluginReviewYes') : t('pluginReviewNo')}</dd></div>
      </dl>
      {item.tiers?.length > 0 && <p className={css.muted}>{t('pluginReviewTiers')}：{item.tiers.join('、')}</p>}
      {item.review_issues.length > 0 && <div className={css.issues}>
        <strong>{t('pluginReviewIssues')}</strong><ul>{item.review_issues.map(issue => <li key={issue}>{issue}</li>)}</ul>
      </div>}
      <label className={css.note}>{t('pluginReviewNote')}
        <textarea value={notes[item.id] ?? ''} maxLength={500}
          onChange={event => { setNotes(current => ({ ...current, [item.id]: event.target.value })) }}
          placeholder={t('pluginReviewNoteHint')} /></label>
      <div className={css.actions}>
        <Button disabled={!item.can_approve || pending !== null} onClick={() => { void decide(item, 'approve') }}>{t('pluginReviewApprove')}</Button>
        <Button disabled={pending !== null} onClick={() => { void decide(item, 'reject') }}>{t('pluginReviewReject')}</Button>
      </div>
    </article>)}</div>
  </section>
}
