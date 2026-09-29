/** Original-text editor and human review actions; source documents remain plain text. */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { MemoryView, MemoryController } from './controller.ts'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './MemoryPage.module.css'

/** Owner editor receives only the page snapshot and explicit actions. */
export interface EditorProps extends PropsLocale<'qianshou.memory'> {
  view: MemoryView
  controller: MemoryController
  requestDelete: (action: 'delete' | 'reject') => void
}
/**
 * Present drafts, unchanged candidates and retained history.
 * @param props - Pure presentation input.
 * @returns Editor or selection guidance.
 */
export function MemoryEditor({ view, controller, requestDelete, t }: EditorProps) {
  const draft = view.draft; const entry = view.detail?.entry
  if (view.reading) return <p role="status">{t('loading')}</p>
  if (!draft) return <p className={css.hint}>{t('noSelection')}</p>
  const candidate = entry?.status === 'candidate'
  const change = (patch: Partial<typeof draft>) => { controller.edit({ ...draft, ...patch }) }
  return <section className={css.editor} data-memory-editor>
    {candidate && <p className={css.notice}>{t('candidateHint')}</p>}
    {entry && <div className={css.actions}><span>{t('revision', { revision: String(entry.revision) })}</span>
      <Button size="sm" disabled={view.busy} onClick={() => { void controller.select(entry.id) }}>{t('reload')}</Button></div>}
    <form className={css.form} onSubmit={(event) => { event.preventDefault(); void controller.save() }}>
      <label>{t('entryTitle')}<Input required maxLength={160} value={draft.title} disabled={view.busy || candidate} onChange={(event) => { change({ title: event.target.value }) }} /></label>
      <div className={css.fields}>
        <label>{t('kind')}<select value={draft.kind} disabled={view.busy || candidate} onChange={(event) => { change({ kind: event.target.value as typeof draft.kind }) }}>
          {(['knowledge', 'permanent', 'temporary', 'experience'] as const).map(kind => <option key={kind} value={kind}>{t(kind)}</option>)}
        </select></label>
        <label>{t('destination')}<select value={draft.workspaceId ?? 'device'} disabled={view.busy || candidate} onChange={(event) => {
          const { workspaceId: _, ...rest } = draft
          controller.edit(event.target.value === 'device' ? { ...rest, scope: 'device' } : { ...rest, scope: 'workspace', workspaceId: event.target.value as NonNullable<typeof draft.workspaceId> })
        }}>
          <option value="device">{t('device')}</option>
          {view.metadata?.workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.title}</option>)}
          {draft.workspaceId &&
            !view.metadata?.workspaces.some(workspace => workspace.id === draft.workspaceId) &&
            <option value={draft.workspaceId}>{entry?.workspacePath ?? draft.workspaceId}</option>}
        </select></label>
        {draft.kind === 'temporary' && <label>{t('expires')}<Input type="number" min={1} max={90} required value={draft.expiresInDays ?? 7} disabled={view.busy || candidate} onChange={(event) => { change({ expiresInDays: Number(event.target.value) }) }} /></label>}
      </div>
      <label>{t('content')}<textarea required className={css.content} value={draft.content} disabled={view.busy || candidate} onChange={(event) => { change({ content: event.target.value }) }} /></label>
      <label>{t('source')}<Input value={draft.source ?? ''} maxLength={2000} disabled={view.busy || candidate} onChange={(event) => { change({ source: event.target.value }) }} /></label>
      <label>{t('evidence')}<textarea value={draft.evidence ?? ''} maxLength={4000} required={draft.kind === 'experience'} disabled={view.busy || candidate} onChange={(event) => { change({ evidence: event.target.value }) }} /></label>
      {entry?.origin && <p className={css.hint}>{t('origin')}: {entry.origin.sessionId}</p>}
      <div className={css.actions}>
        {candidate ? <><Button variant="primary" disabled={view.busy} onClick={() => { void controller.review('accept') }}>{t('accept')}</Button><Button disabled={view.busy} onClick={() => { requestDelete('reject') }}>{t('reject')}</Button></>
          : <Button variant="primary" type="submit" disabled={view.busy}>{t(view.busy ? 'saving' : 'save')}</Button>}
        {entry && !candidate && <Button disabled={view.busy} onClick={() => { requestDelete('delete') }}>{t('delete')}</Button>}
      </div>
    </form>
    {view.detail && view.detail.revisions.length > 0 && <details><summary>{t('history')}</summary>{view.detail.revisions.map(version => <details key={version.revision} className={css.version}>
      <summary>{t('revision', { revision: String(version.revision) })}</summary><strong>{version.title}</strong><pre>{version.content}</pre><p>{version.source}</p><p>{version.evidence}</p>
    </details>)}{view.detail.nextRevisionOffset !== null && <Button size="sm" onClick={() => { void controller.moreHistory() }}>{t('moreHistory')}</Button>}</details>}
  </section>
}
