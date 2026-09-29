/**
 * Isolated node agent session: a fresh `ctx.agents` child on an explicit
 * provider and model. The CEO default route is never used.
 *
 * Setup mounts the host's default agent preset, so the specialist can run
 * the same shell and files as a normal session on this machine. Its cwd is a
 * private, empty directory for this assignment rather than the owner's
 * workspace. The host sandbox and approval stay in force. A host with no
 * preset roster keeps whatever tools that process already published.
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { ComputeError, trackContributionAgent, type IsolatedAgentSession } from '@deepseek-ai/dsh-compute-core'
import { createUserMessage, type ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'

/** Explicit LLM route that must be named in contributor Config. */
export interface IsolatedAgentRoute {
  readonly provider: string
  readonly model: string
  /** Optional task-only effort; never read from the owner's foreground session. */
  readonly reasoningEffort?: ReasoningEffortId
  /**
   * Owner's attempt storage root. Never supplied to the model or used as cwd;
   * the result guard hides it if a host tool mentions it anyway.
   */
  readonly ownerWorkspaceRoot?: string
}

/**
 * Drive one isolated agent turn through the Host agent registry.
 * @param ctx - Host scope that may provide `agents`; absence fails at run time.
 * @param route - Provider and model that must both be set; never omitted.
 * @returns An isolated agent session for admitted inline assignments.
 */
export function createIsolatedAgentSession(ctx: Context, route: IsolatedAgentRoute): IsolatedAgentSession {
  return {
    async run({ inlineInput, signal }) {
      assertActive(signal)
      const agents = ctx.get('agents')
      if (agents === undefined) throw new ComputeError('COMPUTE_ISOLATED_SESSION_UNAVAILABLE', 503)
      // The deployment preset includes `{{cwd}}` in its model-visible prompt.
      // Pointing that header at the owner's attempt root disclosed its absolute path in a real order.
      const privateCwd = await mkdtemp(join(tmpdir(), 'qianshou-order-'))
      try {
        assertActive(signal)
        let handle: AgentHandle
        try {
          handle = await agents.create({
            sessionId: SessionId(`qianshou.node.${randomUUID()}`),
            agentOptions: {
              provider: route.provider,
              model: route.model,
              ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
            },
            meta: { cwd: privateCwd },
            signal,
            setup: async (agentCtx) => {
              const roster = agentPresetRoster(ctx)
              if (roster !== undefined) await roster.mount(agentCtx)
            },
          })
        } catch (error) {
          // Missing factory, unpublished setup failure, or an unregistered adapter.
          void error
          assertActive(signal)
          throw new ComputeError('COMPUTE_ISOLATED_SESSION_UNAVAILABLE', 503)
        }
        const releaseActivity = trackContributionAgent(handle.agent)
        const onAbort = (): void => {
          handle.agent.cancel({ kind: 'parent' })
        }
        try {
          assertActive(signal)
          signal.addEventListener('abort', onAbort, { once: true })
          handle.agent.followup(createUserMessage({
            content: [{ type: 'text', text: inlineInput }],
            source: { kind: 'user' },
          }))
          await handle.agent.whenIdle()
          assertActive(signal)
          return { text: redactUnrequestedLocalPaths(assistantText(handle.agent.session), inlineInput, [
            privateCwd, route.ownerWorkspaceRoot, homedir(),
          ]) }
        } finally {
          signal.removeEventListener('abort', onAbort)
          try { await handle.dispose() }
          finally { releaseActivity() }
        }
      } finally {
        await rm(privateCwd, { recursive: true, force: true })
      }
    },
  }
}

/** Hide machine-local paths the customer did not supply in the assignment. */
function redactUnrequestedLocalPaths(reply: string, request: string, roots: readonly (string | undefined)[]): string {
  let safe = reply
  for (const root of roots) {
    if (root === undefined || root.length < 2) continue
    let from = 0
    while (from < safe.length) {
      const start = safe.indexOf(root, from)
      if (start < 0) break
      let end = start + root.length
      // Both slash styles occur in answers: Windows drives and UNC shares use `\`.
      // Stop at prose, Markdown and JSON delimiters; retain unrelated answer text.
      if (safe[end] === '/' || safe[end] === '\\') {
        while (end < safe.length && !/[\s"'`<>()[\]{}，。！？；：、]/u.test(safe[end] ?? '')) end += 1
      }
      const path = safe.slice(start, end)
      const replacement = request.includes(path) ? path : '【本机路径已隐藏】'
      safe = `${safe.slice(0, start)}${replacement}${safe.slice(end)}`
      from = start + replacement.length
    }
  }
  return safe
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw new ComputeError('COMPUTE_INLINE_SESSION_ABORTED', 499)
}

/** Host roster that composes one agent's shell, files, and other preset tools. */
interface AgentPresetRoster {
  mount(agentCtx: Context, id?: string): Promise<unknown>
}

/**
 * Read the host preset roster.
 * @param ctx - Host scope.
 * @returns The roster, or undefined when this process publishes tools another way.
 */
function agentPresetRoster(ctx: Context): AgentPresetRoster | undefined {
  const candidate = ctx.get('agentPresets') as Partial<AgentPresetRoster> | undefined
  if (candidate === undefined || typeof candidate.mount !== 'function') return undefined
  return candidate as AgentPresetRoster
}

function assistantText(session: Session): string {
  // oxlint-disable-next-line typescript/no-deprecated -- Isolated node result reads the child's own log once after idle.
  const events = session.snapshotEvents(SessionLogOffset(0))
  const ended = events.findLast(event => event.type === 'turn/end')
  if (ended?.data.reason.kind !== 'completed') throw new ComputeError('COMPUTE_INLINE_SESSION_INCOMPLETE', 502)
  let last = ''
  for (const event of events) {
    if (event.type === 'assistant/message') last = messageText(event)
  }
  if (last.trim().length === 0) throw new ComputeError('COMPUTE_INLINE_SESSION_INCOMPLETE', 502)
  return last
}

function messageText(event: SessionEvent): string {
  if (event.type !== 'assistant/message') return ''
  return event.data.message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('')
}
