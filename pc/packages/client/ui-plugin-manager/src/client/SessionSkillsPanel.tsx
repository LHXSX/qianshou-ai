/** Read-only display of skills callable in the current Session. */
import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionSkillsView } from './session-skills-controller.ts'
import type { LocalSkillKey } from './local-skill-locales.ts'
import { categoryLabelKey, categoryOfLocalSkill, localSkillCopy } from './local-skill-presentation.ts'
import css from './SessionSkillsPanel.module.css'

/** Fully localized copy supplied by the owning market registration. */
export interface SessionSkillsLabels {
  readonly title: string
  readonly scope: string
  readonly searchLabel: string
  readonly searchPlaceholder: string
  readonly refresh: string
  readonly loading: string
  readonly unavailable: string
  readonly noSession: string
  readonly empty: string
  readonly noMatches: string
  readonly count: string
  readonly userOnly: string
  readonly useSkill: string
  readonly useUnavailable: string
  readonly details: string
}

/** Data and actions supplied by the Session skill catalog owner. */
export interface SessionSkillsPanelProps {
  readonly view: SessionSkillsView
  readonly labels: SessionSkillsLabels
  readonly reload: () => void
  readonly useSkill?: (name: string) => boolean
  readonly localT?: ((key: LocalSkillKey) => string) | undefined
}

/**
 * Show only skills the Host currently reports as human-invocable for one Session.
 * @param props - Session catalog state, localized copy, and refresh action.
 * @returns A searchable catalog with explicit read and no-Session states.
 */
export function SessionSkillsPanel({ view, labels, reload, useSkill, localT }: SessionSkillsPanelProps) {
  const [query, setQuery] = useState('')
  const [useError, setUseError] = useState(false)
  useEffect(() => { setQuery(''); setUseError(false) }, [view.sessionId])
  const normalized = query.trim().toLocaleLowerCase()
  const shown = normalized === '' ? view.skills : view.skills.filter(skill => {
    const copy = localT === undefined ? null : localSkillCopy({ ...skill, displayName: skill.displayName ?? skill.name }, localT)
    return [skill.name, skill.description, skill.whenToUse ?? '', copy?.title ?? '', copy?.about ?? '']
      .some(value => value.toLocaleLowerCase().includes(normalized))
  })

  return <section className={css.panel} data-session-skills>
    <header className={css.header}>
      <div>
        <h2>{labels.title}</h2>
        <p>{labels.scope}</p>
      </div>
      <Button variant="outline" size="sm" disabled={view.sessionId === null || view.status === 'loading'}
        onClick={reload}>{labels.refresh}</Button>
    </header>
    {view.status === 'no-session' && <p className={css.notice} role="status">{labels.noSession}</p>}
    {view.status === 'loading' && <p className={css.notice} role="status">{labels.loading}</p>}
    {view.status === 'error' && <p className={css.notice} role="alert">{labels.unavailable}</p>}
    {useError && <p className={css.notice} role="alert">{labels.useUnavailable}</p>}
    {view.status === 'ready' && <>
      {view.skills.length === 0 ? <p className={css.notice} role="status">{labels.empty}</p> : <>
        <label className={css.search}>
          <span>{labels.searchLabel}</span>
          <input type="search" value={query} placeholder={labels.searchPlaceholder}
            onChange={event => { setQuery(event.currentTarget.value) }} />
        </label>
        <p className={css.count}>{labels.count.replace('{count}', String(shown.length))}</p>
        {shown.length === 0 && <p className={css.notice} role="status">{labels.noMatches}</p>}
        <ul className={css.grid}>{shown.map(skill => {
          const copy = localT === undefined ? null : localSkillCopy({ ...skill, displayName: skill.displayName ?? skill.name }, localT)
          return <li className={css.card} key={skill.name}>
          <div className={css.cardTop}>
            <h3>{copy?.title ?? skill.name}</h3>
            {localT !== undefined && <span className={css.badge}>{localT(categoryLabelKey(categoryOfLocalSkill({ ...skill, displayName: skill.displayName ?? skill.name })))}</span>}
            {!skill.modelInvocable && <span className={css.badge}>{labels.userOnly}</span>}
          </div>
          {copy !== null && <code className={css.command}>/{skill.name}</code>}
          <p>{copy?.about ?? skill.description}</p>
          {skill.whenToUse !== undefined && (localT === undefined || /[\u3400-\u9fff]/u.test(skill.whenToUse)) && <p className={css.whenToUse}>{skill.whenToUse}</p>}
          <div className={css.cardFoot}>
            <details className={css.details}>
              <summary>{labels.details}</summary>
              <p>{skill.description}</p>
              {skill.whenToUse !== undefined && <p>{skill.whenToUse}</p>}
            </details>
            {useSkill !== undefined && <Button variant="outline" size="sm" onClick={() => {
              setUseError(!useSkill(skill.name))
            }}>{labels.useSkill}</Button>}
          </div>
        </li>
        })}</ul>
      </>}
    </>}
  </section>
}
