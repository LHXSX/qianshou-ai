/** Independent main-column page; it never overlays or resizes the conversation task panel. */
import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MemoryController } from './controller.ts'
import { MemoryEditor } from './MemoryEditor.tsx'
import { downloadExport, importText } from './files.ts'
import css from './MemoryPage.module.css'

/** Controller and bare store are wired only by the plugin owner. */
export interface MemoryInjected { controller: MemoryController; hooks: { memory: MemoryController['store'] } }
/** Derived renderer hook and localized page copy. */
export type MemoryPageProps = InjectFace<MemoryInjected> & PropsLocale<'qianshou.memory'>
/**
 * Render owner scope, keyword search and explicit edit/review/export actions.
 * @param props - Injected presentation face.
 * @returns Memory page.
 */
export function MemoryPage({ controller, useMemory, t }: MemoryPageProps) {
  const view = useMemory(value => value)
  const [keywords, setKeywords] = useState('')
  const [deletion, setDeletion] = useState<'delete' | 'reject' | null>(null)
  const [importFailed, setImportFailed] = useState(false)
  const importGeneration = useRef(0)
  const attached = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { attached.current = true
    const detach = controller.attach()
    void controller.load()
    return () => { attached.current = false
      importGeneration.current++
      detach() } }, [controller])
  const query = view.query
  const activeScope = query.workspaceId ?? query.scope ?? 'all'
  return <main className={css.page} data-qianshou-memory>
    <header className={css.header}><div><h1>{t('title')}</h1><p>{t('ownership')}</p></div><div className={css.actions}>
      <Button variant="outline" disabled={view.loading} onClick={() => { void controller.load() }}>{t('refresh')}</Button>
      <Button variant="outline" disabled={view.exporting} onClick={() => { void controller.export().then((content) => { if (attached.current && content !== null) downloadExport(content) }) }}>{t(view.exporting ? 'exporting' : 'export')}</Button>
      <Button variant="primary" onClick={() => { importGeneration.current++; controller.create() }}>{t('create')}</Button>
    </div></header>
    <p className={css.hint}>{t('ownershipHint')}</p><p className={css.hint}>{t('modelHint')}</p>
    <form className={css.toolbar} onSubmit={(event) => { event.preventDefault()
      controller.filter({ ...query, query: keywords, offset: 0 }) }}>
      <label>{t('scope')}<select value={activeScope} onChange={(event) => {
        importGeneration.current++
        const value = event.target.value; const { workspaceId: _, scope: __, ...rest } = query
        controller.filter({ ...rest, offset: 0, ...(value === 'all' ? {} : value === 'device' ? { scope: 'device' } : { scope: 'workspace', workspaceId: value as NonNullable<typeof query.workspaceId> }) })
      }}><option value="all">{t('all')}</option><option value="device">{t('device')}</option>{view.metadata?.workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.title}</option>)}</select></label>
      <label>{t('status')}<select value={query.status ?? 'all'} onChange={(event) => {
        const { status: _, ...rest } = query; const status = event.target.value
        controller.filter({ ...rest, offset: 0, ...(status === 'all' ? {} : { status: status as 'active' | 'candidate' }) })
      }}><option value="all">{t('allStatus')}</option><option value="active">{t('active')}</option><option value="candidate">{t('candidate')}</option></select></label>
      <Input aria-label={t('search')} placeholder={t('search')} value={keywords} maxLength={500} onChange={(event) => { setKeywords(event.target.value) }} />
      <Button type="submit">{t('searchAction')}</Button>
      <Button onClick={() => { input.current?.click() }}>{t('import')}</Button>
      <input hidden ref={input} type="file" accept=".txt,.md,.markdown,.json,.csv,.ts,.tsx,.js,.jsx,.py,.rs,.go,.java,.c,.cpp,.h,.css,.html,.yml,.yaml" aria-label={t('import')} onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = ''; if (!file) return
        const generation = ++importGeneration.current; const draftGeneration = controller.draftGeneration; setImportFailed(false)
        void importText(file).then((value) => {
          if (generation !== importGeneration.current || draftGeneration !== controller.draftGeneration) return
          controller.create(); const draft = controller.store.getSnapshot().draft
          if (draft) controller.edit({ ...draft, ...value })
        }).catch(() => { if (generation === importGeneration.current) setImportFailed(true) })
      }} />
    </form>
    {view.error && <p role="alert" className={css.notice}>{t(view.error)}</p>}
    {importFailed && <p role="alert">{t('importFailed')}</p>}
    <div className={css.columns}><aside className={css.list}>
      <p role="status">{view.loading ? t('loading') : t('count', { count: String(view.page?.total ?? 0) })}</p>
      {!view.loading && view.page?.items.length === 0 && <p className={css.hint}>{t('empty')}</p>}
      {view.page?.items.map(item => <button type="button" key={item.id} className={css.row} aria-pressed={view.detail?.entry.id === item.id} onClick={() => { importGeneration.current++; void controller.select(item.id) }}>
        <strong>{item.title}</strong><span>{t(item.kind)} · {t(item.status)}</span><span>{item.workspacePath ?? t('device')}</span><p>{item.snippet}</p>
      </button>)}
      <div className={css.actions}><Button size="sm" disabled={(query.offset ?? 0) === 0 || view.loading} onClick={() => { controller.filter({ ...query, offset: Math.max(0, (query.offset ?? 0) - 50) }) }}>{t('previous')}</Button>
        <Button size="sm" disabled={(query.offset ?? 0) + 50 >= (view.page?.total ?? 0) || view.loading} onClick={() => { controller.filter({ ...query, offset: (query.offset ?? 0) + 50 }) }}>{t('next')}</Button></div>
    </aside><MemoryEditor view={view} controller={controller} requestDelete={setDeletion} t={t} /></div>
    <Modal open={deletion !== null} title={t(deletion === 'reject' ? 'reject' : 'delete')} closeLabel={t('cancel')} onClose={() => { setDeletion(null) }}>
      <p>{t('deleteHint')}</p><div className={css.actions}><Button onClick={() => { setDeletion(null) }}>{t('cancel')}</Button><Button variant="primary" onClick={() => {
        if (deletion === 'reject') void controller.review('reject'); else void controller.delete(); setDeletion(null)
      }}>{t('confirmDelete')}</Button></div>
    </Modal>
  </main>
}
/**
 * Sidebar owns the label, selection and button.
 * @param props - Sidebar icon dimensions.
 * @returns Neutral local knowledge glyph.
 */
export function MemoryIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true"><path d="M4 4h6a3 3 0 0 1 2 1 3 3 0 0 1 2-1h6v15h-6a3 3 0 0 0-2 1 3 3 0 0 0-2-1H4Z M12 5v15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>
}
