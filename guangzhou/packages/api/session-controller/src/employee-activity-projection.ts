/** Compact replayable activity for employee monitoring without opening child histories. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { EmployeeActivity } from './types.ts'

const schema: z.ZodType<EmployeeActivity> = z.object({
  phase: z.enum(['idle', 'thinking', 'tools', 'completed', 'blocked', 'error', 'stopped']),
  tools: z.record(z.string(), z.string()),
  update: z.string().max(240),
  at: z.number().nullable(),
})

/**
 * Fold only durable public execution facts. Never retain arguments or reasoning text.
 * @param state - Activity before this event.
 * @param event - Next committed Session event.
 * @returns Updated bounded summary or the original state for unrelated events.
 */
export function applyEmployeeActivity(state: EmployeeActivity, event: SessionEvent): EmployeeActivity {
  if (event.type === 'turn/start') return { phase: 'thinking', tools: {}, update: '', at: event.time }
  if (event.type === 'tool/call') return {
    ...state, phase: 'tools', tools: { ...state.tools, [event.data.callId]: event.data.name }, at: event.time,
  }
  if (event.type === 'tool/result') {
    const tools = { ...state.tools }
    delete tools[event.data.message.source.callId]
    return { ...state, tools, phase: Object.keys(tools).length ? 'tools' : 'thinking', at: event.time }
  }
  if (event.type === 'assistant/message') {
    const update = event.data.message.content
      .filter(block => block.type === 'text').map(block => block.text).join(' ')
      .replace(/\s+/g, ' ').trim().slice(0, 240)
    return update ? { ...state, update, at: event.time } : state
  }
  if (event.type === 'turn/end') {
    const reason = event.data.reason.kind
    const phase = reason === 'completed' ? 'completed'
      : reason === 'blocked' ? 'blocked'
        : reason === 'error' ? 'error' : 'stopped'
    return { ...state, phase, tools: {}, at: event.time }
  }
  return state
}

/** Log projection, also cached for cold task rows by the existing projection cache. */
export const employeeActivityProjection = {
  key: 'employeeActivity',
  stateSchema: schema,
  init: (): EmployeeActivity => ({ phase: 'idle', tools: {}, update: '', at: null }),
  apply: applyEmployeeActivity,
  wire: { viewSchema: schema, view: (state: EmployeeActivity) => state },
  stateVersion: 1,
} satisfies ProjectionDefinition<'employeeActivity', EmployeeActivity>

/**
 * Install replayable employee activity into the authoritative summary stream.
 * @param ctx - Session Controller with the authoritative projection registry.
 */
export function installEmployeeActivityProjection(ctx: Context): void {
  ctx.sessionProjections.register(employeeActivityProjection)
}
