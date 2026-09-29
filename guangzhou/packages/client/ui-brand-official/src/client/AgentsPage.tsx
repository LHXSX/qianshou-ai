/**
 * 智能体广场 — the honest team page.
 *
 * The roster it shows is the client's own session/subagent projection: the rows
 * are the child sessions this browser can actually address, and each row's title
 * is the label the delegation itself wrote (an employee name plus its brief).
 * When nothing is delegated there is no roster to show, and the page says so
 * instead of listing a marketplace inventory.
 */
import {
  ActionButton, BoundaryNote, SectionCard, StepList, type DestinationPageProps,
} from './page-chrome.tsx'
import css from './DestinationPage.module.css'

/** Roster rows, dispatch instructions, and team configuration for the agents page. */
export function AgentsPage({ state, t, body, rosterPending, openChat, openSession }: DestinationPageProps & {
  openChat: () => void
  openSession: (id: string) => void
}) {
  const { subagents } = state.sessions
  return <>
    <SectionCard
      heading="dest.agents.status.title"
      count={subagents.length === 0 ? undefined : t('dest.agents.count', { count: String(subagents.length) })}
      t={t}
    >
      {subagents.length === 0
        ? <p className={css.empty}>{rosterPending ? t('shell.reading') : t('dest.agents.status.empty')}</p>
        : <ul className={css.roster}>
          {subagents.map(entry => (
            <li key={entry.id} className={css.rosterRow} data-running={entry.running || undefined}>
              <span className={css.avatar} aria-hidden="true">{(entry.label ?? entry.id).slice(0, 1)}</span>
              <span className={css.rosterCopy}>
                <strong>{entry.label ?? entry.id}</strong>
                <span className={css.rosterMeta}>
                  {t(entry.kind === 'subagent' ? 'dest.agents.categorySubagent' : 'dest.agents.categoryOneShot')}
                  {' · '}
                  <span data-state={entry.running ? 'running' : 'inactive'}>
                    {t(entry.running ? 'dest.agents.stateRunning' : 'dest.agents.stateInactive')}
                  </span>
                </span>
              </span>
              <button type="button" className={css.rosterOpen} onClick={() => { openSession(entry.id) }}>
                {t('dest.agents.detail')}
              </button>
            </li>
          ))}
        </ul>}
      {openChat !== undefined && <div className={css.cardFoot}>
        <ActionButton glyph="back" panel={null} onClick={openChat}>{t('shell.back')}</ActionButton>
      </div>}
    </SectionCard>

    <SectionCard heading="dest.agents.where" t={t}>
      <StepList t={t} steps={{ source: 'dest.agents.where.items' }} />
    </SectionCard>

    <SectionCard heading="dest.agents.members" count={t('dest.agents.members.count', { count: '24' })} t={t}>
      <StepList t={t} steps={{ source: 'dest.agents.members.items' }} />
    </SectionCard>

    <SectionCard heading="dest.agents.now.title" t={t}>
      <StepList t={t} steps={{ source: 'dest.agents.now.items' }} />
    </SectionCard>
    <BoundaryNote lead={t(body)} note={t('dest.agents.notice')} />
  </>
}
