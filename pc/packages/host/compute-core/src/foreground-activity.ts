/** Distinguish explicitly owned contribution agents from the owner's interactive work. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

// Object identity prevents a session name or persisted metadata from claiming background status.
const contributionAgents = new WeakMap<Agent, number>()

/**
 * Mark a live agent while the contribution runner owns and drains it.
 * @param agent - Exact agent returned by the registry's creation handle.
 * @returns Idempotent release to call after handle disposal settles.
 */
export function trackContributionAgent(agent: Agent): () => void {
  contributionAgents.set(agent, (contributionAgents.get(agent) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = (contributionAgents.get(agent) ?? 1) - 1
    if (remaining === 0) contributionAgents.delete(agent)
    else contributionAgents.set(agent, remaining)
  }
}

/**
 * Read live foreground work without treating a contribution agent as its own blocker.
 * @param ctx - Host scope with the live registry; missing registry means unknown.
 * @returns True for running owner agents, false for measured inactivity, or null without a registry.
 */
export function readHostForegroundTaskActivity(ctx: Context): boolean | null {
  const agents = ctx.get('agents')
  if (!agents) return null
  return agents.list().some(agent => agent.status === 'running' && !contributionAgents.has(agent))
}
