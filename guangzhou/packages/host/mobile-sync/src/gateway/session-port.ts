/** Adapt the existing Host Session authority to the gateway's narrow command port.
 *
 * This file adds no Session write path. Every mutation it performs is an existing
 * public method of `SessionController`, so the conversation log, its admission
 * checks and its own idempotency stay owned by the component that already has them.
 *
 * The controller is described structurally rather than imported: `mobile-sync`
 * ships into profiles that may not mount `session-controller` at all, and a
 * type-only import would turn an optional neighbour into a load-bearing dependency.
 * The caller in `index.ts` asserts the real controller satisfies these shapes, so
 * the structural contract is checked at the composition point.
 */
import { MobileSyncError } from '../errors.ts'
import type { SessionCommandPort, WindowCommand } from './types.ts'

/** The single Session outcome the port needs to observe. */
interface PromptValue {
  readonly accepted: true
}

/** One user-visible prompt part, matching the Session intake contract. */
interface PromptPart {
  readonly type: 'text'
  readonly text: string
}

/** The Session authority surface this port actually uses. */
export interface PreparedSessionController {
  /**
   * Resolve or resume one Session and admit a prompt to it.
   * @param request - Session identity, stable request id, delivery mode and content.
   * @param signal - Caller cancellation before admission begins.
   * @returns Acknowledgement that the Agent accepted the prompt.
   */
  readonly prompt: (
    request: {
      readonly requestId: string
      readonly sessionId: string
      readonly mode: 'queue' | 'steer'
      readonly content: readonly PromptPart[]
    },
    signal: AbortSignal,
  ) => Promise<PromptValue>
  /**
   * Cancel the addressed Session's active turn without dropping its pending inbox.
   * @param request - Session whose active turn is cancelled.
   * @returns Acknowledgement that cancellation was requested.
   */
  readonly cancel: (request: { readonly sessionId: string }) => { readonly accepted: true }
  /**
   * Inspect one attached or persisted Session without activating its Agent.
   * @param sessionId - Durable Session identity.
   * @returns The attached header and its event prefix.
   */
  readonly inspect: (sessionId: string) => Promise<{ readonly events: readonly unknown[] }>
}

/** How the adapter reaches the Session authority. */
export interface SessionCommandPortOptions {
  /** Resolve the controller at call time; `undefined` means the profile did not mount it. */
  readonly controller: () => PreparedSessionController | undefined
}

/**
 * Build the gateway's Session port over the existing controller.
 * @param options - Lazy controller access so plugin load order cannot pin a stale reference.
 * @returns A port that reports unavailability instead of pretending to execute.
 */
export function createSessionCommandPort(options: SessionCommandPortOptions): SessionCommandPort {
  const require = (): PreparedSessionController => {
    const controller = options.controller()
    if (controller === undefined) throw new MobileSyncError('PC_WINDOW_SESSION_UNAVAILABLE', 503)
    return controller
  }

  /** Read one Session's durable event prefix, or nothing when it cannot be read at all. */
  const eventsOf = async (sessionId: string): Promise<readonly unknown[]> => {
    try { return (await require().inspect(sessionId)).events } catch { return [] }
  }

  return {
    available: () => options.controller() !== undefined,

    /**
     * Prove a prompt was already admitted by looking for this exact request id in
     * the Session's own durable log. This is the only evidence the gateway accepts
     * when reconciling a command whose first attempt had an unknown outcome; a
     * missing id is reported as "not proven", never as "proven not sent".
     */
    alreadyAccepted: async (binding, requestId) => {
      const events = await eventsOf(binding.sessionId)
      return events.some(event => isAdmittedPrompt(event, requestId))
    },

    dispatch: async (binding, command) => {
      await require().prompt({ ...promptRequest(binding.sessionId, command) }, new AbortController().signal)
    },

    append: async (binding, command) => {
      await require().prompt({ ...promptRequest(binding.sessionId, command) }, new AbortController().signal)
    },

    cancel: (binding) => {
      require().cancel({ sessionId: binding.sessionId })
      return Promise.resolve()
    },
  }
}

/**
 * Project a command onto the Session intake contract.
 *
 * Both `dispatch` and `append` are admitted with `mode: 'queue'`, because neither
 * may interrupt a turn already running on the original conversation: independent
 * input waits for its turn instead of steering the PC's active work.
 */
function promptRequest(sessionId: string, command: WindowCommand): {
  readonly requestId: string
  readonly sessionId: string
  readonly mode: 'queue'
  readonly content: readonly PromptPart[]
} {
  const action = command.action
  if (action.type === 'cancel') throw new MobileSyncError('PC_WINDOW_COMMAND_INVALID')
  return {
    requestId: command.requestId,
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: action.text }],
  }
}

/** Whether one durable Session event is the admitted user message for `requestId`. */
function isAdmittedPrompt(event: unknown, requestId: string): boolean {
  if (typeof event !== 'object' || event === null) return false
  const candidate = event as { type?: unknown; data?: unknown }
  if (candidate.type !== 'user/message') return false
  const data = candidate.data
  if (typeof data !== 'object' || data === null) return false
  const source = (data as { source?: unknown }).source
  if (typeof source !== 'object' || source === null) return false
  const row = source as { kind?: unknown; rpcId?: unknown }
  return row.kind === 'user' && row.rpcId === requestId
}
