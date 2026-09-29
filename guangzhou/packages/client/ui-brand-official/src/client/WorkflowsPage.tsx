/**
 * 工作流 — orchestration shapes plus the background processes this client can
 * actually see.
 *
 * The two workflow engines (`workflow` and the Ralph loop) run as tools inside a
 * conversation, and `ctx.jobs` mirrors each long-running process into the session
 * list. That mirror is what this page reads, so the panel shows real progress
 * instead of a mocked pipeline diagram. No standalone editor exists yet, and the
 * boundary note says so.
 */
import {
  ActionButton, BoundaryNote, SectionCard, StepList, type DestinationPageProps, type JobFact,
} from './page-chrome.tsx'
import type { ForgeBrandKey } from './locales.ts'
import css from './DestinationPage.module.css'

/** Job states the host reports, in the order the page lists them. */
const STATUS_KEYS: Record<JobFact['status'], ForgeBrandKey> = {
  running: 'dest.workflows.jobRunning',
  stopping: 'dest.workflows.jobStopping',
  completed: 'dest.workflows.jobCompleted',
  killed: 'dest.workflows.jobKilled',
  failed: 'dest.workflows.jobFailed',
}

/** Background processes, orchestration shapes, and launch guidance. */
export function WorkflowsPage({ state, t, body, openPanel }: DestinationPageProps & {
  openPanel?: ((panel: string | null) => () => void) | undefined
}) {
  const { jobs } = state
  return <>
    <SectionCard
      heading="dest.workflows.jobs.title"
      count={jobs.length === 0 ? undefined : t('dest.workflows.jobs.count', { count: String(jobs.length) })}
      t={t}
    >
      {jobs.length === 0
        ? <p className={css.empty}>{t('dest.workflows.jobs.empty')}</p>
        : <ul className={css.jobs}>
          {jobs.map(job => (
            <li key={job.id} className={css.jobRow} data-status={job.status}>
              <span className={css.jobDot} data-status={job.status} aria-hidden="true" />
              <span className={css.jobCopy}>
                <strong>{job.label}</strong>
                <span className={css.jobMeta}>
                  <code>{job.kind}</code>
                  {' · '}
                  <span>{t(STATUS_KEYS[job.status])}</span>
                  {' · '}
                  <time dateTime={new Date(job.startedAt).toISOString()}>
                    {new Date(job.startedAt).toLocaleTimeString()}
                  </time>
                </span>
              </span>
            </li>
          ))}
        </ul>}
      {openPanel !== undefined && <div className={css.cardFoot}>
        <ActionButton glyph="back" panel={null} onClick={openPanel(null)}>{t('shell.back')}</ActionButton>
      </div>}
    </SectionCard>

    <SectionCard heading="dest.workflows.forms.title" t={t}>
      <StepList t={t} steps={{ source: 'dest.workflows.forms.items' }} />
    </SectionCard>

    <SectionCard heading="dest.workflows.run.title" t={t}>
      <StepList t={t} steps={{ source: 'dest.workflows.run.items' }} />
    </SectionCard>
    <BoundaryNote lead={t(body)} note={t('dest.workflows.notice')} />
  </>
}
