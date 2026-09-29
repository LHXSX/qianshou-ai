/** A compact, authenticated discussion board in the desktop main column. */
import { useEffect, useState, type FormEvent } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { createCommunityTransport, CommunityFailure, type CommunityCategory, type CommunityRelated,
  type CommunityReply, type CommunityTopic, type CommunityTransport } from './transport.ts'
import type { CommunityTranslate } from './locales.ts'
import { CommunityRelatedPicker } from './CommunityRelatedPicker.tsx'
import { CommunityRelatedLink } from './CommunityRelatedLink.tsx'
import type { CommunityMarketChoice, CommunityMarketSearch, CommunityMarketResolve } from './related-market.ts'
import css from './CommunityPage.module.css'

const defaultTransport = createCommunityTransport()

export interface CommunityPageProps {
  readonly t: CommunityTranslate
  readonly transport?: CommunityTransport
  readonly accountId?: () => Promise<string | null>
  readonly openAccount?: () => void
  readonly openRelated?: (related: CommunityRelated) => void
  readonly searchRelated?: CommunityMarketSearch
  readonly resolveRelated?: CommunityMarketResolve
}

function failureText(error: unknown, t: CommunityTranslate): string {
  const code = error instanceof CommunityFailure ? error.code : ''
  if (['FORUM_ACCOUNT_REQUIRED', 'UNAUTHORIZED', 'AUTH_REQUIRED', 'unauthorized', 'unauthenticated'].includes(code)) return t('accountRequired')
  if (['FORBIDDEN', 'forbidden'].includes(code)) return t('forbidden')
  if (['NOT_FOUND', 'not_found'].includes(code)) return t('notFound')
  if (code === 'bad_request') return t('badRequest')
  if (code === 'rate_limited') return t('rateLimited')
  if (code === 'already_reported') return t('alreadyReported')
  if (code === 'invalid_state') return t('invalidState')
  if (code === 'FORUM_NOT_LIVE') return t('notLive')
  return t('unavailable')
}

function date(value: string): string {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return ''
  return new Intl.DateTimeFormat(typeof navigator === 'undefined' ? 'zh-CN' : navigator.language, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(time)
}

/** The sidebar owns the row and accessible label. */
export function CommunityIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 11.4a7.5 7.5 0 0 1-7.5 7.5H8l-4 2v-5.1A7.5 7.5 0 1 1 20 11.4Z" />
    <path d="M8 10.8h9M8 14h6" />
  </svg>
}

function TopicBadges({ item, t }: { readonly item: CommunityTopic; readonly t: CommunityTranslate }) {
  return <span className={css.badges}>
    {item.pinned && <span className={css.badge}>{t('pinned')}</span>}
    {item.official && <span className={css.badge}>{t('official')}</span>}
    {item.status === 'solved' && <span className={css.solved}>{t('solved')}</span>}
  </span>
}

/** Actual server rows only; empty and unavailable states never manufacture discussions. */
export function CommunityPage({ t, transport = defaultTransport, accountId, openAccount, openRelated, searchRelated, resolveRelated }: CommunityPageProps) {
  const [categories, setCategories] = useState<readonly CommunityCategory[]>([])
  const [category, setCategory] = useState<string | undefined>()
  const [searchDraft, setSearchDraft] = useState('')
  const [query, setQuery] = useState('')
  const [topics, setTopics] = useState<readonly CommunityTopic[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [view, setView] = useState<'list' | 'detail' | 'compose'>('list')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ readonly topic: CommunityTopic; readonly replies: readonly CommunityReply[] } | null>(null)
  const [nextReplyCursor, setNextReplyCursor] = useState<string | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailRevision, setDetailRevision] = useState(0)
  const [viewerId, setViewerId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [draftCategory, setDraftCategory] = useState('')
  const [relatedKind, setRelatedKind] = useState<'none' | 'skill' | 'product'>('none')
  const [relatedSelection, setRelatedSelection] = useState<CommunityMarketChoice | null>(null)
  const [replyDraft, setReplyDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [report, setReport] = useState<{ kind: 'topic' | 'reply'; id: string } | null>(null)
  const [reportReason, setReportReason] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    if (accountId === undefined) return
    let active = true
    void accountId().then(id => { if (active) setViewerId(id) }).catch(() => { if (active) setViewerId(null) })
    return () => { active = false }
  }, [accountId, revision])

  useEffect(() => {
    const abort = new AbortController()
    setPhase('loading')
    setError('')
    void Promise.all([transport.categories(abort.signal), transport.topics({ ...(category === undefined ? {} : { category }), query }, abort.signal)])
      .then(([foundCategories, foundTopics]) => {
        if (abort.signal.aborted) return
        setCategories(foundCategories)
        setTopics(foundTopics.items)
        setNextCursor(foundTopics.nextCursor)
        setDraftCategory(current => current && current !== 'activities' ? current
          : foundCategories.find(item => item.id !== 'activities')?.id ?? '')
        setPhase('ready')
      })
      .catch(cause => {
        if (abort.signal.aborted) return
        setPhase('error')
        setError(failureText(cause, t))
      })
    return () => { abort.abort() }
  }, [transport, category, query, revision, t])

  useEffect(() => {
    if (selectedId === null) return
    const abort = new AbortController()
    setDetailLoading(true)
    setActionError('')
    void transport.topic(selectedId, {}, abort.signal).then(found => {
      if (abort.signal.aborted) return
      setDetail(found)
      setNextReplyCursor(found.nextReplyCursor)
      setDetailLoading(false)
    }).catch(cause => {
      if (abort.signal.aborted) return
      setDetail(null)
      setDetailLoading(false)
      setActionError(failureText(cause, t))
    })
    return () => { abort.abort() }
  }, [selectedId, detailRevision, transport, t])

  const openTopic = (id: string): void => {
    setSelectedId(id)
    setDetail(null)
    setView('detail')
    setActionError('')
    setNotice('')
  }
  const refresh = (): void => { setRevision(value => value + 1) }
  const publish = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const cleanTitle = title.trim()
    const cleanContent = content.trim()
    if (cleanTitle.length < 4 || cleanTitle.length > 100) { setActionError(t('invalidTitle')); return }
    if (cleanContent.length < 10 || cleanContent.length > 10_000) { setActionError(t('invalidContent')); return }
    if (relatedKind !== 'none' && (relatedSelection === null || relatedSelection.kind !== relatedKind)) {
      setActionError(t('invalidRelated')); return
    }
    setBusy(true)
    setActionError('')
    try {
      const created = await transport.createTopic({ category: draftCategory, title: cleanTitle, content: cleanContent,
        ...(relatedKind === 'none' || relatedSelection === null ? {}
          : { related: { kind: relatedSelection.kind, id: relatedSelection.id } }),
      })
      setTitle(''); setContent(''); setRelatedKind('none'); setRelatedSelection(null)
      refresh()
      openTopic(created.id)
    } catch (cause) { setActionError(failureText(cause, t)) }
    finally { setBusy(false) }
  }
  const sendReply = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (selectedId === null) return
    const body = replyDraft.trim()
    if (body.length < 1 || body.length > 5000) { setActionError(t('invalidReply')); return }
    setBusy(true); setActionError('')
    try {
      await transport.createReply(selectedId, body)
      setReplyDraft('')
      setDetailRevision(value => value + 1)
      refresh()
    } catch (cause) { setActionError(failureText(cause, t)) }
    finally { setBusy(false) }
  }
  const solve = async (): Promise<void> => {
    if (selectedId === null) return
    setBusy(true); setActionError('')
    try {
      await transport.solve(selectedId)
      setDetailRevision(value => value + 1)
      refresh()
    } catch (cause) { setActionError(failureText(cause, t)) }
    finally { setBusy(false) }
  }
  const submitReport = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (report === null) return
    const reason = reportReason.trim()
    if (reason.length < 4) { setActionError(t('invalidReport')); return }
    setBusy(true); setActionError('')
    try {
      await transport.report(report.kind, report.id, reason)
      setReport(null); setReportReason(''); setNotice(t('reportSent'))
    } catch (cause) { setActionError(failureText(cause, t)) }
    finally { setBusy(false) }
  }
  const loadMore = async (): Promise<void> => {
    if (nextCursor === null || busy) return
    setBusy(true); setActionError('')
    try {
      const page = await transport.topics({ ...(category === undefined ? {} : { category }), query, cursor: nextCursor })
      setTopics(current => {
        const seen = new Set(current.map(item => item.id))
        return [...current, ...page.items.filter(item => !seen.has(item.id))]
      })
      setNextCursor(page.nextCursor)
    } catch (cause) { setActionError(failureText(cause, t)) }
    finally { setBusy(false) }
  }
  const loadMoreReplies = async (): Promise<void> => {
    if (selectedId === null || nextReplyCursor === null || busy) return
    setBusy(true); setActionError('')
    try {
      const page = await transport.topic(selectedId, { replyCursor: nextReplyCursor })
      setDetail(current => {
        if (current === null) return current
        const seen = new Set(current.replies.map(item => item.id))
        return { topic: page.topic, replies: [...current.replies, ...page.replies.filter(item => !seen.has(item.id))] }
      })
      setNextReplyCursor(page.nextReplyCursor)
    } catch (cause) { setActionError(failureText(cause, t)) }
    finally { setBusy(false) }
  }

  const selectedCategory = categories.find(item => item.id === detail?.topic.category)?.title ?? detail?.topic.category
  const linked = detail?.topic.related

  return <main className={css.page} data-qianshou-community>
    <header className={css.header}>
      <div><span className={css.eyebrow}>{t('nav')}</span><h1>{t('title')}</h1><p>{t('subtitle')}</p></div>
      <div className={css.headerActions}>
        <button type="button" className={css.ghost} onClick={refresh}>{t('refresh')}</button>
        <button type="button" className={css.primary} disabled={phase !== 'ready'}
          onClick={() => { setView('compose'); setActionError(''); setNotice('') }}>{t('newTopic')}</button>
      </div>
    </header>

    {view === 'list' && <>
      <form className={css.search} onSubmit={event => { event.preventDefault(); setQuery(searchDraft.trim()) }}>
        <input aria-label={t('search')} placeholder={t('search')} value={searchDraft}
          onChange={event => { setSearchDraft(event.target.value) }} />
        <button type="submit" className={css.ghost}>{t('searchButton')}</button>
      </form>
      <nav className={css.categories} aria-label={t('category')}>
        <button type="button" className={category === undefined ? css.activeCategory : css.category}
          onClick={() => { setCategory(undefined) }}>{t('all')}</button>
        {categories.map(item => <button type="button" key={item.id} title={item.description}
          className={category === item.id ? css.activeCategory : css.category}
          onClick={() => { setCategory(item.id) }}>{item.title}</button>)}
      </nav>
      {phase === 'loading' && <p className={css.message} role="status">{t('loading')}</p>}
      {phase === 'error' && <div className={css.message} role="alert"><p>{error}</p>
        {error === t('accountRequired') && openAccount && <button type="button" className={css.ghost} onClick={openAccount}>{t('openAccount')}</button>}
        <button type="button" className={css.ghost} onClick={refresh}>{t('retry')}</button></div>}
      {phase === 'ready' && topics.length === 0 && <p className={css.message}>{t('empty')}</p>}
      {phase === 'ready' && <div className={css.topics}>{topics.map(item => <button type="button" className={css.topicCard}
        key={item.id} onClick={() => { openTopic(item.id) }}>
        <span className={css.topicTop}><span>{categories.find(row => row.id === item.category)?.title ?? item.category}</span><TopicBadges item={item} t={t} /></span>
        <strong>{item.title}</strong><span className={css.excerpt}>{item.content}</span>
        <span className={css.meta}><span>{t('author', { name: item.authorName })} · {date(item.createdAt)}</span><span>{t('replies', { count: item.replyCount })}</span></span>
      </button>)}</div>}
      {nextCursor !== null && phase === 'ready' && <button type="button" className={css.more} disabled={busy} onClick={() => { void loadMore() }}>{t('more')}</button>}
    </>}

    {view === 'compose' && <section className={css.editor}>
      <button type="button" className={css.back} onClick={() => { setView('list') }}>{t('back')}</button>
      <h2>{t('newTopic')}</h2>
      <form onSubmit={event => { void publish(event) }}>
        <label>{t('category')}<select value={draftCategory} onChange={event => { setDraftCategory(event.target.value) }} required>
          {categories.filter(item => item.id !== 'activities').map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select></label>
        <label>{t('topicTitle')}<input value={title} maxLength={100} placeholder={t('titlePlaceholder')}
          onChange={event => { setTitle(event.target.value) }} required /></label>
        <label>{t('topicContent')}<textarea value={content} maxLength={10_000} rows={9}
          placeholder={t('contentPlaceholder')} onChange={event => { setContent(event.target.value) }} required /></label>
        <div className={css.relatedForm}><label>{t('relatedKind')}<select value={relatedKind}
          onChange={event => { setRelatedKind(event.target.value as typeof relatedKind); setRelatedSelection(null); setActionError('') }}>
          <option value="none">{t('relatedNone')}</option><option value="skill">{t('relatedSkill')}</option>
          <option value="product">{t('relatedProduct')}</option></select></label>
          {relatedKind !== 'none' && <CommunityRelatedPicker key={relatedKind} kind={relatedKind}
            selected={relatedSelection} search={searchRelated} onSelect={item => {
              setRelatedSelection(item); setActionError('')
            }} t={t} />}</div>
        <p className={css.hint}>{t('relatedHint')}</p>
        <div className={css.editorActions}><button type="button" className={css.ghost} onClick={() => { setView('list') }}>{t('cancel')}</button>
          <button type="submit" className={css.primary} disabled={busy || !draftCategory}>{busy ? t('publishing') : t('publish')}</button></div>
      </form>
    </section>}

    {view === 'detail' && <section className={css.detail}>
      <button type="button" className={css.back} onClick={() => { setView('list'); setSelectedId(null); setDetail(null) }}>{t('back')}</button>
      {detailLoading && <p className={css.message} role="status">{t('loading')}</p>}
      {detail && <>
        <article className={css.post}>
          <div className={css.topicTop}><span>{selectedCategory}</span><TopicBadges item={detail.topic} t={t} /></div>
          <h2>{detail.topic.title}</h2>
          <div className={css.meta}>{t('author', { name: detail.topic.authorName })} · {date(detail.topic.createdAt)}</div>
          <p className={css.body}>{detail.topic.content}</p>
          {linked && <CommunityRelatedLink key={`${linked.kind}:${linked.id}`} related={linked}
            resolve={resolveRelated} open={openRelated} t={t} />}
          <div className={css.postActions}>
            {viewerId !== null && viewerId === detail.topic.authorId && detail.topic.category === 'help' && detail.topic.status === 'open'
              && <button type="button" className={css.ghost} disabled={busy} onClick={() => { void solve() }}>{busy ? t('markingSolved') : t('markSolved')}</button>}
            <button type="button" className={css.textButton} onClick={() => { setReport({ kind: 'topic', id: detail.topic.id }); setNotice('') }}>{t('report')}</button>
          </div>
        </article>
        <h3 className={css.replyHeading}>{t('replies', { count: detail.topic.replyCount })}</h3>
        <div className={css.replyList}>{detail.replies.map(item => <article className={css.replyCard} key={item.id}>
          <div className={css.meta}>{t('replyBy', { name: item.authorName })} · {date(item.createdAt)} {item.accepted && <span className={css.solved}>{t('accepted')}</span>}</div>
          <p className={css.body}>{item.content}</p>
          <button type="button" className={css.textButton} onClick={() => { setReport({ kind: 'reply', id: item.id }); setNotice('') }}>{t('report')}</button>
        </article>)}</div>
        {nextReplyCursor !== null && <button type="button" className={css.more} disabled={busy}
          onClick={() => { void loadMoreReplies() }}>{t('more')}</button>}
        <form className={css.replyEditor} onSubmit={event => { void sendReply(event) }}>
          <label htmlFor="qianshou-community-reply">{t('reply')}</label>
          <textarea id="qianshou-community-reply" rows={4} maxLength={5000} value={replyDraft}
            placeholder={t('replyPlaceholder')} onChange={event => { setReplyDraft(event.target.value) }} />
          <button type="submit" className={css.primary} disabled={busy}>{busy ? t('sending') : t('sendReply')}</button>
        </form>
      </>}
    </section>}

    {report && <form className={css.reportForm} onSubmit={event => { void submitReport(event) }}>
      <label>{t('reportReason')}<textarea value={reportReason} maxLength={500} rows={3}
        placeholder={t('reportPlaceholder')} onChange={event => { setReportReason(event.target.value) }} /></label>
      <div><button type="button" className={css.ghost} onClick={() => { setReport(null) }}>{t('cancel')}</button>
        <button type="submit" className={css.primary} disabled={busy}>{t('reportSubmit')}</button></div>
    </form>}
    {actionError && <p className={css.error} role="alert">{actionError}</p>}
    {notice && <p className={css.notice} role="status">{notice}</p>}
  </main>
}
