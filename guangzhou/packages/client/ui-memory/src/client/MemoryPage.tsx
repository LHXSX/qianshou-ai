import { useEffect, useRef, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MemoryState } from './controller.ts'
import type { MemoryDraft, MemoryEntry, MemoryFilters, MemoryKind } from './contracts.ts'
import { importMemoryText, MEMORY_IMPORT_LIMIT, TEXT_IMPORT_ACCEPT } from './import-text.ts'
import css from './MemoryPage.module.css'

/** Plain controller actions and one observable bound by the main renderer. */
export interface MemoryFace {
  hooks: { memory: ObservableSnapshot<MemoryState> }
  refresh: () => Promise<void>
  filter: (change: Partial<MemoryFilters>) => void
  select: (id: string | null) => Promise<void>
  mutate: (action: 'save' | 'review' | 'delete', body: MemoryDraft | {
    id: string
    expectedRevision: number
    action?: 'accept' | 'reject'
  }) => Promise<boolean>
  exportData: () => Promise<string | null>
}
/** Main-slot props and the memory feature's locale. */
export type MemoryPageProps = PropsRuntime<'main'> & PropsLocale<'qianshou.memory'> & InjectFace<MemoryFace>
const kinds: readonly MemoryKind[] = ['temporary', 'permanent', 'knowledge', 'experience']
function draftOf(entry?: MemoryEntry): MemoryDraft {
  return entry ? {
    id: entry.id, expectedRevision: entry.revision, title: entry.title, content: entry.content,
    kind: entry.kind, scope: entry.scope, ...(entry.workspace ? { workspace: entry.workspace } : {}),
    source: entry.source, evidence: entry.evidence,
    expiresInDays: entry.expiresAt ? Math.min(90, Math.max(1, Math.ceil((entry.expiresAt - Date.now()) / 86400000))) : 7,
  } : { title: '', content: '', kind: 'knowledge', scope: 'personal', source: '', evidence: '', expiresInDays: 7 }
}
/** Render source-first records with explicit save, review, deletion, and file import. */
export function MemoryPage(props: MemoryPageProps) {
  const { t } = props
  const state = props.useMemory(snapshot => snapshot)
  const [draft, setDraft] = useState<MemoryDraft | null>(null)
  const [original, setOriginal] = useState('')
  const [query, setQuery] = useState('')
  const [workspaceFilter, setWorkspaceFilter] = useState('')
  const [localError, setLocalError] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  useEffect(() => { void props.refresh() }, [props.refresh])
  useEffect(() => {
    if (state.selected) {
      const next = draftOf(state.selected)
      setDraft(next); setOriginal(JSON.stringify(next)); setLocalError('')
    }
  }, [state.selected])
  const dirty = draft !== null && JSON.stringify(draft) !== original
  const candidate = state.selected?.status === 'candidate' && draft?.id === state.selected.id
  const byteLength = draft ? new TextEncoder().encode(draft.content).length : 0
  const invalid = draft !== null && (!draft.title.trim() || !draft.content.trim()
    || (draft.scope === 'workspace' && !draft.workspace?.trim())
    || (draft.kind === 'temporary' && (!Number.isInteger(draft.expiresInDays)
      || (draft.expiresInDays ?? 0) < 1 || (draft.expiresInDays ?? 0) > 90)))
  function confirmDiscard(): boolean { return !dirty || window.confirm(t('discardConfirm')) }
  function edit<K extends keyof MemoryDraft>(key: K, value: MemoryDraft[K]): void {
    setDraft(current => current === null ? null : { ...current, [key]: value })
  }
  async function create(imported?: { title: string; content: string; source: string }): Promise<void> {
    if (!confirmDiscard()) return
    await props.select(null)
    const next = { ...draftOf(), ...imported, ...(imported ? { title: imported.title.slice(0, 160) } : {}) }
    setDraft(next); setOriginal(JSON.stringify(draftOf())); setLocalError('')
  }
  async function importFile(file: File): Promise<void> {
    try { await create(await importMemoryText(file)) }
    catch (error) {
      const code = error instanceof Error ? error.message : ''
      setLocalError(t(code === 'IMPORT_TOO_LARGE' ? 'importTooLarge' : code === 'IMPORT_UNSUPPORTED' ? 'importUnsupported' : 'importInvalid'))
    }
  }
  async function exportFile(): Promise<void> {
    const data = await props.exportData()
    if (data === null) return
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url; anchor.download = 'qianshou-memory.json'; anchor.click()
    setTimeout(() => { URL.revokeObjectURL(url) }, 1000)
  }
  async function save(): Promise<void> {
    if (!draft || invalid || candidate || byteLength > MEMORY_IMPORT_LIMIT) return
    const { workspace, expiresInDays, ...fields } = draft
    const body = { ...fields, ...(draft.scope === 'workspace' ? { workspace: workspace ?? '' } : {}),
      ...(draft.kind === 'temporary' ? { expiresInDays: expiresInDays ?? 7 } : {}) }
    if (await props.mutate('save', body) && !draft.id) { setDraft(null); setOriginal('') }
  }
  async function finish(action: 'review' | 'delete', review?: 'accept' | 'reject'): Promise<void> {
    if (!draft?.id || draft.expectedRevision === undefined) return
    if (await props.mutate(action, {
      id: draft.id, expectedRevision: draft.expectedRevision, ...(review ? { action: review } : {}),
    })) { setDraft(null); setOriginal('') }
  }
  function pageCount(): string {
    return t('pageCount').replace('{start}', String(state.total ? state.filters.offset + 1 : 0))
      .replace('{end}', String(Math.min(state.total, state.filters.offset + state.items.length))).replace('{total}', String(state.total))
  }
  return (
    <main className={css.page}>
      <header className={css.header}>
        <div><span className={css.eyebrow}>{t('title')}</span><h1>{t('heading')}</h1><p>{t('description')}</p></div>
        <div className={css.actions}>
          <Button onClick={() => { void exportFile() }} disabled={state.busy}>{t('export')}</Button>
          <Button onClick={() => { fileInput.current?.click() }} disabled={state.busy}>{t('import')}</Button>
          <Button variant="primary" onClick={() => { void create() }} disabled={state.busy}>{t('create')}</Button>
          <input ref={fileInput} className={css.file} type="file" accept={TEXT_IMPORT_ACCEPT} aria-label={t('import')}
            onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = '' }} />
        </div>
      </header>
      <div className={css.layers}>
        {kinds.map(kind => <button key={kind} type="button" className={css.layer} aria-pressed={state.filters.kind === kind}
          onClick={() => { props.filter({ kind: state.filters.kind === kind ? '' : kind }) }}>
          <span>{t(kind)}</span><strong>{state.loading ? '…' : state.stats[kind]}</strong>
        </button>)}
      </div>
      {(localError || state.error) && <p className={css.error} role="alert">{localError || `${t('error')} · ${state.error}`}</p>}
      <div className={css.columns}>
        <section className={css.catalog}>
          <form className={css.search} onSubmit={(event) => {
            event.preventDefault(); props.filter({ query, workspace: workspaceFilter })
          }}>
            <Input aria-label={t('search')} placeholder={t('search')} value={query} maxLength={500}
              onChange={(event) => { setQuery(event.target.value) }} />
            <Button type="submit" variant="outline">{t('searchAction')}</Button>
            <Input className={css.workspaceFilter ?? ''} aria-label={t('workspaceFilter')} placeholder={t('workspaceFilter')}
              value={workspaceFilter} maxLength={4096} onChange={(event) => { setWorkspaceFilter(event.target.value) }} />
          </form>
          <div className={css.statusFilters}>
            <Button variant={state.filters.status === 'active' ? 'primary' : 'ghost'}
              onClick={() => { props.filter({ status: 'active' }) }}>{t('active')}</Button>
            <Button variant={state.filters.status === 'candidate' ? 'primary' : 'ghost'}
              onClick={() => { props.filter({ status: 'candidate' }) }}>
              {t('candidate')} · {state.loading ? '…' : state.stats.candidates}
            </Button>
            <Button onClick={() => { void props.refresh() }} disabled={state.loading}>{t('refresh')}</Button>
          </div>
          {state.loading ? <p role="status" className={css.hint}>{t('loading')}</p> : null}
          {!state.loading && state.items.length === 0 ? <div className={css.empty}><h2>{t('empty')}</h2><p>{t('emptyHint')}</p></div> : null}
          <div className={css.list}>
            {state.items.map(item => <button key={item.id} className={css.item} data-selected={state.selected?.id === item.id}
              onClick={() => { if (confirmDiscard()) { setDraft(null); setOriginal(''); void props.select(item.id) } }} disabled={state.busy}>
              <span className={css.itemHead}><strong>{item.title}</strong><span>{t(item.kind)}</span></span>
              <span className={css.snippet}>{item.snippet}</span>
              <span className={css.itemMeta}>{t(item.status)} · {item.workspace || t('personal')} · {t('revision')} {item.revision}</span>
            </button>)}
          </div>
          <div className={css.pagination}>
            <Button disabled={state.loading || state.filters.offset === 0}
              onClick={() => { props.filter({ offset: Math.max(0, state.filters.offset - 50) }) }}>{t('previous')}</Button>
            <span>{pageCount()}</span>
            <Button disabled={state.loading || state.filters.offset + state.items.length >= state.total}
              onClick={() => { props.filter({ offset: state.filters.offset + 50 }) }}>{t('next')}</Button>
          </div>
        </section>
        <section className={css.editor}>
          <h2>{t('detail')}</h2>
          {state.detailLoading ? <p role="status">{t('loading')}</p> : null}
          {!draft && !state.detailLoading ? <p className={css.hint}>{t('choose')}</p> : null}
          {draft && <>
            {candidate && <div className={css.candidate}>
              <p>{t('candidateHint')}</p><div className={css.actions}>
                <Button variant="primary" disabled={state.busy} onClick={() => {
                  void finish('review', 'accept')
                }}>{t('accept')}</Button>
                <Button disabled={state.busy} onClick={() => {
                  if (window.confirm(t('rejectConfirm'))) void finish('review', 'reject')
                }}>{t('reject')}</Button>
              </div>
            </div>}
            <fieldset className={css.form} disabled={state.busy}>
              <label>{t('entryTitle')}<Input value={draft.title} maxLength={160} readOnly={candidate}
                onChange={(event) => { edit('title', event.target.value) }} /></label>
              <div className={css.formPair}>
                <label>{t('kind')}<select value={draft.kind} disabled={candidate}
                  onChange={(event) => { edit('kind', event.target.value as MemoryKind) }}>
                  {kinds.map(kind => <option key={kind} value={kind}>{t(kind)}</option>)}
                </select></label>
                <label>{t('scope')}<select value={draft.scope} disabled={candidate}
                  onChange={(event) => { edit('scope', event.target.value as MemoryDraft['scope']) }}>
                  <option value="personal">{t('personal')}</option><option value="workspace">{t('workspace')}</option>
                </select></label>
              </div>
              {draft.scope === 'workspace' && <label>{t('workspacePath')}<Input value={draft.workspace ?? ''} maxLength={4096} readOnly={candidate}
                onChange={(event) => { edit('workspace', event.target.value) }} /></label>}
              <p className={css.hint}>{t('scopeHint')}</p>
              {draft.kind === 'temporary' && <label>{t('days')}<Input type="number" min={1} max={90} readOnly={candidate}
                value={draft.expiresInDays ?? 7}
                onChange={(event) => { edit('expiresInDays', Number(event.target.value)) }} /></label>}
              <label>{t('content')}<textarea className={css.sourceText} value={draft.content} rows={13} spellCheck={false} readOnly={candidate}
                onChange={(event) => { edit('content', event.target.value) }} /></label>
              <span className={css.hint}>{t('bytes')} · {byteLength}</span>
              <label>{t('source')}<Input value={draft.source ?? ''} maxLength={2000} placeholder={t('sourceHint')} readOnly={candidate}
                onChange={(event) => { edit('source', event.target.value) }} /></label>
              <label>{t('evidence')}<textarea value={draft.evidence ?? ''} maxLength={4000} rows={3}
                placeholder={t('evidenceHint')} readOnly={candidate}
                onChange={(event) => { edit('evidence', event.target.value) }} /></label>
            </fieldset>
            {invalid && !candidate && <p className={css.hint}>{t('invalid')}</p>}
            {byteLength > MEMORY_IMPORT_LIMIT && <p className={css.error}>{t('tooLarge')}</p>}
            <div className={css.actions}>
              {!candidate && <Button variant="primary" disabled={state.busy || invalid || !dirty || byteLength > MEMORY_IMPORT_LIMIT}
                onClick={() => { void save() }}>{t('save')}</Button>}
              <Button disabled={state.busy} onClick={() => {
                const next = state.selected ? draftOf(state.selected) : null; setDraft(next); setOriginal(JSON.stringify(next))
              }}>{t('discard')}</Button>
              {draft.id && <Button disabled={state.busy} onClick={() => {
                if (window.confirm(t('deleteConfirm'))) void finish('delete')
              }}>{t('remove')}</Button>}
            </div>
          </>}
          {state.selected && <div className={css.metadata}>
            <span>{t('revision')} · {state.selected.revision}</span>
            <span>{t('created')} · {new Date(state.selected.createdAt).toLocaleString()}</span>
            <span>{t('updated')} · {new Date(state.selected.updatedAt).toLocaleString()}</span>
            <span>{t('expires')} · {state.selected.expiresAt ? new Date(state.selected.expiresAt).toLocaleString() : t('noExpiry')}</span>
          </div>}
          {state.selected && <section className={css.history}><h3>{t('versions')}</h3>
            {state.revisions.length === 0 ? <p className={css.hint}>{t('noVersions')}</p> : null}
            {state.revisions.map(version => <details key={version.revision}>
              <summary>{t('revision')} {version.revision} · {version.title} · {new Date(version.updatedAt).toLocaleString()}</summary>
              <p>{t('savedSource')} · {version.source}</p><pre>{version.content}</pre><p>{version.evidence}</p>
            </details>)}
          </section>}
          <p className={css.importHint}>{t('importHint')}</p>
        </section>
      </div>
    </main>
  )
}
/** Decorative book glyph shared by the sidebar contribution. */
export function MemoryIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <path d="M12 5c-3-2-7-2-10-1v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1Zm0 0v15M5 8h4M5 12h4M15 8h4M15 12h4" />
  </svg>
}
