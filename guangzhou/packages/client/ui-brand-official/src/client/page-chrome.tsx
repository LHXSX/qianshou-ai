/**
 * Shared chrome for the forge product destinations.
 *
 * Every destination page renders the same three honest layers — a positioning
 * headline, grouped fact cards, and one boundary note about what this page does
 * NOT know — so the shared pieces live here instead of being re-invented per
 * page. Nothing in this module reads product data; the pages pass in resolved
 * copy and, when a fact is genuinely readable, the values they read.
 */
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { ForgeBrandKey } from './locales.ts'
import css from './DestinationPage.module.css'

/** Resolved translate seat shared by every destination page. */
export type PageTranslate = TranslateNS<'forge.brand'>

/** One ordered list of instructions the user can follow right now. */
export interface PageSteps {
  /** Dictionary key whose value is `lead|detail` per line, one step each. */
  source: ForgeBrandKey
}

/** One parsed instruction line: the action, then why it matters. */
export interface StepLine {
  readonly lead: string
  readonly detail: string
}

/**
 * Split one dictionary value into its ordered instruction lines.
 * @param value - the page's raw step copy.
 * @returns one entry per line, each split at its single separating bar.
 */
export function parseSteps(value: string): StepLine[] {
  return value.split('\n').map((line) => {
    const separator = line.indexOf('|')
    if (separator === -1) throw new Error(`destination step line has no separator: ${line}`)
    return { lead: line.slice(0, separator).trim(), detail: line.slice(separator + 1).trim() }
  })
}

/**
 * Props every destination page receives from the slot shell. The identity trio
 * is spelled here rather than imported from the shell module so a page never
 * depends on the registration layer that renders it.
 */
export interface DestinationPageProps {
  /** Locale key owning this page's <h1>. */
  title: ForgeBrandKey
  /** Locale key of the destination's long-standing boundary statement. */
  body: ForgeBrandKey
  /** Resolved page state; the pages never reach for a service themselves. */
  state: PageState
  /** Locale-bound translate seat. */
  t: PageTranslate
  /** Whether the current roster is still arriving (agents page). */
  rosterPending: boolean
  /** Files-panel action; the right sidebar's Files tab is session-scoped. */
  openFilesPanel: () => void
}

/** Live facts derived from the client's own services (see destination-state.ts). */
export interface PageState {
  sessions: SessionFacts
  jobs: readonly JobFact[]
  models: ModelFacts
}

/** Facts about the sessions this client can actually see. */
export interface SessionFacts {
  /** Sessions open right now; empty is a real answer once `phase` is `ready`. */
  readonly currentId: string | null
  readonly subagents: readonly SubagentFact[]
  readonly runningCount: number
}

/** One subagent this client can actually address. */
export interface SubagentFact {
  readonly id: string
  /** Employee name and delegation brief; absent when the descriptor carried none. */
  readonly label: string | undefined
  readonly kind: 'subagent' | 'one-shot'
  readonly running: boolean
  readonly updatedAt: number
}

/** One background process the host reported for a session. */
export interface JobFact {
  readonly id: string
  readonly label: string
  readonly kind: string
  readonly status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  readonly startedAt: number
}

/** The model directory this deployment can actually read. */
export interface ModelFacts {
  readonly providers: readonly ProviderFact[]
  readonly failures: readonly ProviderFact[]
  readonly route: ModelRouteFact | null
  readonly routed: boolean | null
}

/** One provider and the models it published. */
export interface ProviderFact {
  readonly id: string
  readonly name: string
  readonly models: readonly { readonly id: string; readonly name: string }[]
  /** Failure text for a provider whose catalog could not be read. */
  readonly message?: string
}

/** The current session's effective model selection. */
export interface ModelRouteFact {
  readonly provider: string
  readonly model: string
  readonly effort: string | null
}

/** Props of the shared page frame: headline, actions, then themed sections. */
export interface DestinationFrameProps {
  title: string
  position: ForgeBrandKey
  eyebrow: ForgeBrandKey
  t: PageTranslate
  actions: ReactNode
  children: ReactNode
}

/** Decorative glyph for one quick-jump action. */
type ActionGlyph = 'back' | 'agents' | 'workflows' | 'files' | 'models'

/**
 * Render one destination page frame: title, one-line positioning sentence, the
 * quick-jump action row, then the page's own sections.
 * @param props - resolved identity, actions, and page body.
 * @returns the page frame.
 */
export function DestinationFrame({ title, position, eyebrow, t, actions, children }: DestinationFrameProps) {
  return (
    <main className={css.page} data-qianshou-destination="">
      <header className={css.hero}>
        <p className={css.eyebrow}>{t(eyebrow)}</p>
        <h1 className={css.title}>{title}</h1>
        <p className={css.position}>{t(position)}</p>
      </header>
      <nav className={css.actions} aria-label={t('shell.nav')}>{actions}</nav>
      {children}
    </main>
  )
}

/**
 * Render one grouped fact card.
 * @param props - heading key, optional trailing count, and the card body.
 * @returns one section card.
 */
export function SectionCard({ heading, count, children, t }: {
  heading: ForgeBrandKey
  count?: string | undefined
  children: ReactNode
  /**
   * 文案函数。**必须传**：`heading` 是**键**不是文本，早先这里直接渲染
   * `<h2>{heading}</h2>`，于是界面上出现「dest.agents.status.title」这种原始键名。
   * 声明成必填而不是可选，就是为了让"忘了传"在编译期就红，而不是上线后被看到。
   */
  t: PageTranslate
}) {
  return (
    <section className={css.card}>
      <div className={css.cardHead}>
        <h2>{t(heading)}</h2>
        {count !== undefined && <span className={css.count}>{count}</span>}
      </div>
      {children}
    </section>
  )
}

/**
 * Render one instruction list: the action in bold, its reason next to it on the
 * same row, from the page's own `lead|detail` copy.
 */
export function StepList({ steps, t }: { steps: PageSteps; t: PageTranslate }) {
  return (
    <ol className={css.steps}>
      {parseSteps(t(steps.source)).map(step => (
        <li key={step.lead}>
          <strong>{step.lead}</strong>
          <span>{step.detail}</span>
        </li>
      ))}
    </ol>
  )
}

/**
 * One primary or secondary quick-jump action. Always a real <button>: it either
 * performs a verified navigation or it is not rendered at all.
 */
export function ActionButton({ glyph, onClick, children, panel }: {
  glyph: ActionGlyph
  onClick: () => void
  children: ReactNode
  /** Main-panel key this action selects; absent for the back-to-chat action. */
  panel?: string | null
}) {
  return (
    <button type="button" className={css.action} data-nav={panel === null ? 'chat' : panel} onClick={onClick}>
      <ActionIcon glyph={glyph} />
      <span>{children}</span>
    </button>
  )
}

/** Decorative glyph for one quick-jump action or card heading. */
export function ActionIcon({ glyph }: { glyph: ActionGlyph }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {glyph === 'back' ? <path d="M14 6l-6 6 6 6" /> : null}
      {glyph === 'agents' ? <path d="M8 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM4 19c.6-2.8 2.6-4 4-4s3.4 1.2 4 4M12 19c.6-2.8 2.6-4 4-4s3.4 1.2 4 4" /> : null}
      {glyph === 'workflows' ? <path d="M5 7h6l2 3h6M5 17h4l2-3h8M9 7v10" /> : null}
      {glyph === 'files' ? <path d="M7 4h7l5 5v11H7V4Zm7 0v5h5" /> : null}
      {glyph === 'models' ? <path d="M12 4 5 8v8l7 4 7-4V8l-7-4Zm0 4v12M5 8l7 4 7-4" /> : null}
    </svg>
  )
}

/**
 * The page's honest boundary section: the destination's own long-standing
 * statement first, then the page-specific "what this page does not know" note.
 */
export function BoundaryNote({ lead, note }: { lead: string; note: string }) {
  return (
    <footer className={css.notice} data-qianshou-boundary="">
      <p className={css.noticeLead}>{lead}</p>
      <p>{note}</p>
    </footer>
  )
}
