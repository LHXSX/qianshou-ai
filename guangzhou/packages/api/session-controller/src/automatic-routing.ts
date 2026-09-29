/** Resolve newly claimed human work before prompt assembly snapshots its model. */
import { agentRoutingIntent, hasAutomaticRouting, resolveTaskRouting } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { LlmRuntime, UserMessage } from '@deepseek-ai/dsh-llm'

/**
 * Bind task-scoped routing to an existing Agent without changing loop ordering.
 * @param agent - Agent whose claimed inbox work supplies the task.
 * @param llm - Registered provider runtime.
 * @param selection - Existing prompt/request selection reference.
 * @param timeoutMs - Auxiliary request deadline.
 * @param maxOutputTokens - Auxiliary generation cap.
 */
export function installAutomaticRouting(
  agent: Agent, llm: LlmRuntime, selection: ModelSelectionRef, timeoutMs: number, maxOutputTokens: number,
): void {
  let claimed: UserMessage[] = []
  agent.ctx.on('agent/inbox/claimed', ({ message }) => {
    if (message.source.kind === 'user') claimed.push(message)
  })
  agent.ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const messages = claimed
    claimed = []
    const intent = agentRoutingIntent(agent)
    if (messages.length > 0 && intent !== undefined && hasAutomaticRouting(intent)) {
      const resolved = await resolveTaskRouting(llm, agent.session, messages.map(message => message.id).join(':'), intent,
        messages, context.signal ?? new AbortController().signal, timeoutMs, maxOutputTokens)
      // An explicit switch arriving during interpretation keeps human precedence.
      if (agentRoutingIntent(agent) === intent) {
        selection.current = { ...resolved, ...(intent.routing === undefined ? {} : { routing: intent.routing }) }
      }
    }
    return next()
  }, { prepend: true })
}
