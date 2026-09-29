/** The original Session remains the only log, queue and permission authority. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-query'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import { ConnectFailure } from './validation.ts'

/** Narrow internal seam implemented against real Session services. */
export interface ConnectSessionPort {
  inspect(id: SessionId, signal: AbortSignal): Promise<{ events: readonly SessionEvent[]; running: boolean }>
  admitted(id: SessionId, rpcId: string, signal: AbortSignal): Promise<boolean>
  submit(id: SessionId, rpcId: string, text: string, signal: AbortSignal, check: () => void): Promise<void>
}
function matches(events: readonly SessionEvent[], rpcId: string): boolean {
  return events.some((event) => {
    const messages = event.type === 'user/message' ? [event.data] : event.type === 'agent/inbox/spliced' ? event.data.inserted : []
    return messages.some(message => message.source.kind === 'user' && 'rpcId' in message.source && message.source.rpcId === rpcId)
  })
}
function queued(agent: Agent, rpcId: string): boolean {
  return [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => message.source.kind === 'user'
    && 'rpcId' in message.source && message.source.rpcId === rpcId)
}
/**
 * Adapt the real Session controller without granting arbitrary Remote access.
 * @param ctx - Host with the current Session services.
 * @returns Read and text-only admission operations.
 */
export function sessionPort(ctx: Context): ConnectSessionPort {
  const inspect = async (id: SessionId, signal: AbortSignal) => {
    signal.throwIfAborted()
    const snapshot = await ctx.sessionController.inspect(id, signal)
    signal.throwIfAborted()
    if (snapshot.meta.origin === 'subagent') throw new ConnectFailure('session-unavailable', 409)
    return { events: snapshot.events, running: ctx.agents.get(id)?.status === 'running' }
  }
  return {
    inspect,
    admitted: async (id, rpcId, signal) => {
      const snapshot = await inspect(id, signal)
      const agent = ctx.agents.get(id)
      const found = matches(snapshot.events, rpcId) || (agent !== undefined && queued(agent, rpcId))
      const live = ctx.sessions.get(id)
      if (found && live && !await ctx.sessions.flush(live)) throw new ConnectFailure('storage-failed', 503)
      return found
    },
    submit: async (id, rpcId, text, signal, check) => {
      await inspect(id, signal)
      check(); signal.throwIfAborted()
      const resolved = await ctx.sessionController.resolveAgent(id)
      if ('error' in resolved) throw new ConnectFailure('session-unavailable', 409)
      const agent = resolved.agent
      check(); signal.throwIfAborted()
      if (ctx.agents.get(id) !== agent) throw new ConnectFailure('session-unavailable', 409)
      // The check and synchronous inbox admission share one turn; revocation cannot interleave.
      if (!queued(agent, rpcId)) {
        // oxlint-disable-next-line typescript/no-deprecated -- Existing Session authority supplies the durable duplicate check.
        if (!matches(agent.session.snapshotEvents(), rpcId)) agent.followup(createUserMessage({
          content: [{ type: 'text', text }], source: { kind: 'user', rpcId },
        }))
      }
      // Admission already happened: do not abort or claim rollback while its persistence checkpoint settles.
      if (!await ctx.sessions.flush(agent.session)) throw new ConnectFailure('storage-failed', 503)
    },
  }
}
