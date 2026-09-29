/** Read-only feature contributions to the viewed Session's Chat flow. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** Immutable submission identity; completion updates must retain these fields. */
export interface ChatTimelineEntry {
  readonly id: string
  /** Original submission wall-clock milliseconds, never a completion time. */
  readonly createdAt: number
}

/** One feature owns its history, validation, persistence, and precise invalidations. */
export interface ChatTimelineEntryProvider {
  /** Stable registration identity, also the timeline renderer's keyed-slot key. */
  readonly id: string
  read(sessionId: SessionId): readonly ChatTimelineEntry[]
  subscribe(listener: (sessionId: SessionId) => void): () => void
}

/** Effect-scoped registration; this service never writes Session events or invokes tasks. */
export interface ChatTimelineEntries {
  /**
   * Register one feature's read-only rows for exact viewed Sessions.
   * @param provider - The feature's stable identity, history reader, and invalidation subscription.
   * @returns An idempotent disposer that removes the provider and its visible rows.
   * @throws When the source identity is invalid or duplicated, or its subscription fails.
   */
  register(provider: ChatTimelineEntryProvider): () => void
}

/** The renderer receives feature identity within its standard, exact Session scope. */
export interface ChatTimelineEntryOwnerProps {
  readonly sourceId: string
  readonly entryId: string
  readonly createdAt: number
}

/** Full props of one feature's registered timeline renderer. */
export type ChatTimelineEntryProps = PropsRuntime<'conversation.chat.timelineEntry'>

/** Normalized registration identity plus an immutable feature entry. */
export interface ChatTimelineEntryView extends ChatTimelineEntry {
  readonly sourceId: string
}

/** Recorded event times used only to locate display gaps, never to manufacture a Turn. */
export interface ChatTimelineEventTime {
  readonly seq: number
  readonly time: number
}

/** Registrant-private presentation facts delivered through a framework hook. */
export interface ChatTimelineEntriesSnapshot {
  readonly entries: readonly ChatTimelineEntryView[]
  readonly eventTimes: readonly ChatTimelineEventTime[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Read-only, exact-Session feature rows in the Chat flow. */
    chatTimelineEntries: ChatTimelineEntries
  }
}
