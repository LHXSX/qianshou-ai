/** Parent-owned, append-only membership retirement; original child logs remain unchanged. */
import { z } from 'zod'
import type { SessionEvent, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

/** Lifecycle witness prevents a reused id from inheriting another child's retirement. */
export interface RetiredSubagent {
  readonly id: SessionId
  readonly createdAt: number
  readonly parentSessionId: SessionId
}
/** One atomic retirement decision for a complete inactive subtree. */
export interface SubagentRetiredEvent {
  readonly version: 1
  readonly childId: SessionId
  readonly children: readonly RetiredSubagent[]
}
interface RetirementState {
  readonly inheritedEventCount: SessionLogOffset
  readonly entries: readonly RetiredSubagent[]
}
const id = z.string().min(1) as unknown as z.ZodType<SessionId>
const witness = z.object({ id, createdAt: z.number().int().nonnegative(), parentSessionId: id }).strict()
const stateSchema: z.ZodType<RetirementState> = z.object({
  inheritedEventCount: z.number().int().nonnegative() as unknown as z.ZodType<SessionLogOffset>,
  entries: z.array(witness),
}).strict()
/** Validate retirement events at their durable JSON boundary. */
export const subagentRetiredSchema: z.ZodType<SubagentRetiredEvent> = z.object({
  version: z.literal(1), childId: id, children: z.array(witness).min(1),
}).strict().refine(value => value.children.some(child => child.id === value.childId)
  && new Set(value.children.map(child => child.id)).size === value.children.length)

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A human retired an idle subtree from its direct parent's team without deleting history.
     * @param data - Complete lifecycle witnesses.
     */
    'subagent/retired': SubagentRetiredEvent
  }
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { subagentRetirements: RetirementState }
  interface SessionProjectionMap { subagentRetirements: readonly RetiredSubagent[] }
}
/** Required-on-read retirement projection excludes inherited parent decisions from fork seeds. */
export const subagentRetirementProjectionDefinition = {
  key: 'subagentRetirements',
  stateVersion: 1,
  stateSchema,
  init: (_header, inheritedEventCount): RetirementState => ({ inheritedEventCount, entries: [] }),
  apply: (state, event: SessionEvent) => {
    if (event.type !== 'subagent/retired' || event.seq < state.inheritedEventCount) return state
    const data = subagentRetiredSchema.parse(event.data)
    const entries = new Map(state.entries.map(entry => [entry.id, entry]))
    for (const child of data.children) entries.set(child.id, child)
    return { ...state, entries: [...entries.values()] }
  },
  wire: { viewSchema: z.array(witness), view: state => state.entries },
} satisfies ProjectionDefinition<'subagentRetirements', RetirementState>
