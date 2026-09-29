/** Read-only navigation to actual child-turn file evidence retained by this Host. */
import { useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ChildFileChanges.module.css'

interface ChildChange {
  sessionId: string
  turn: number
  cwd: string
  state: 'pending' | 'available' | 'unavailable'
  reason?: string
  shared: boolean
  seq?: number
  total?: number
  reviewAddress?: string
}
interface ChildIndex { available: boolean; entries: ChildChange[] }
interface Props extends PropsLocale<'qianshou.brand'> {
  parent: string
  entries: readonly ({ kind: 'diagnostic' } | { kind: 'child'; id: string; label?: string; activity: string })[]
  open: (address: string) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decode(value: unknown): ChildIndex {
  if (typeof value !== 'object' || value === null || !('available' in value) || typeof value.available !== 'boolean'
    || !('entries' in value) || !Array.isArray(value.entries)) throw new Error('Invalid child changes response')
  const entries: unknown[] = value.entries
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.sessionId !== 'string' || typeof entry.cwd !== 'string'
      || typeof entry.turn !== 'number' || !Number.isSafeInteger(entry.turn) || entry.turn < 1 || typeof entry.shared !== 'boolean'
      || typeof entry.state !== 'string' || !['pending', 'available', 'unavailable'].includes(entry.state)
      || (entry.state === 'available' && (!Number.isSafeInteger(entry.seq) || !Number.isSafeInteger(entry.total)
        || typeof entry.reviewAddress !== 'string' || !entry.reviewAddress.startsWith('dsh-resource://changes-review/session/')))) {
      throw new Error('Invalid child changes entry')
    }
  }
  return value as ChildIndex
}

/** Poll while mounted, abort on navigation, and open only an available source record.
 * @param props - actual parent, child catalog, and existing dock navigation.
 * @returns bounded child evidence with honest missing and partial-observation states.
 */
export function ChildFileChanges({ parent, entries, open, t }: Props) {
  const [state, setState] = useState<{ parent: string; value: ChildIndex | 'error' }>()
  const [refresh, setRefresh] = useState(0)
  // The poll repeats every two seconds for as long as the section is mounted; an
  // identical Host answer must not republish a new state object, or the section
  // re-renders forever with nothing to show for it.
  const published = useRef<{ parent: string; body: string }>()
  useEffect(() => {
    const lifetime = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const publish = (value: ChildIndex | 'error', body: string): void => {
      const previous = published.current
      if (previous?.parent === parent && previous.body === body) return
      published.current = { parent, body }
      setState({ parent, value })
    }
    const read = async () => {
      try {
        const response = await fetch(`/api/changes.children?${new URLSearchParams({ parentSessionId: parent })}`, { signal: lifetime.signal })
        if (!response.ok) throw new Error('Child changes unavailable')
        const body = await response.text()
        if (!lifetime.signal.aborted) publish(decode(JSON.parse(body)), body)
      } catch {
        if (!lifetime.signal.aborted) publish('error', 'error')
      } finally {
        if (!lifetime.signal.aborted) timer = setTimeout(() => { void read() }, 2000)
      }
    }
    void read()
    return () => { lifetime.abort(); if (timer !== undefined) clearTimeout(timer) }
  }, [parent, refresh])
  const value = state?.parent === parent ? state.value : undefined
  const label = (id: string) => entries.find(entry => entry.kind === 'child' && entry.id === id)
  return <section className={css.root} aria-label={t('childChanges')} data-child-file-changes>
    <div className={css.toolbar}><strong>{t('childChanges')}</strong><button type="button" onClick={() => { setRefresh(count => count + 1) }}>{t('changesRefresh')}</button></div>
    <p>{t('changesScope')}</p>
    {value === undefined && <p role="status">{t('changesLoading')}</p>}
    {value === 'error' && <p role="alert">{t('changesError')}</p>}
    {value !== undefined && value !== 'error' && (value.entries.length === 0
      ? <p>{t('changesUntracked')}</p>
      : value.entries.map((entry) => {
        const child = label(entry.sessionId)
        const title = child?.kind === 'child' ? child.label ?? t('unnamedTask') : t('unnamedTask')
        const reason = entry.reason === 'no-change' ? 'changesNoChange' : entry.reason === 'retention-limit' ? 'changesExpired'
          : entry.reason === 'execution-unavailable' ? 'changesRemote' : entry.reason === 'untracked' ? 'changesUntracked' : 'changesPartial'
        return <article key={`${entry.sessionId}/${entry.turn}/${entry.seq ?? 'pending'}`}>
          <strong>{title} · {t('changesTurn', { turn: String(entry.turn) })}</strong>
          <span className={css.path} title={entry.cwd}>{entry.cwd}</span>
          {entry.shared && <p role="status">{t('changesShared')}</p>}
          {entry.state === 'available' && entry.reviewAddress !== undefined
            ? <><button type="button" onClick={() => { if (entry.reviewAddress !== undefined) open(entry.reviewAddress) }}>{t('changesOpen', { count: String(entry.total) })}</button>
              {entry.reason !== undefined && <p>{t(reason)}</p>}</>
            : <p>{t(entry.state === 'pending' ? 'changesPending' : reason)}</p>}
        </article>
      }))}
  </section>
}
