/**
 * Narrow Session seam for the phone port. Admission, duplicate detection and the bounded text projection are the
 * qianshou-session-connect implementations, imported rather than copied; this module adds only the continuable
 * Session listing and the phone-facing turn fields the relay validates.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { PHONE_TURN_BYTE_LIMIT, projectConnectionPage, sessionPort } from '@deepseek-ai/dsh-host-qianshou-session-connect'
import type { ConnectSessionPort } from '@deepseek-ai/dsh-host-qianshou-session-connect'
import type { ConnectionGrant } from '@deepseek-ai/dsh-host-qianshou-session-connect/types'
import { MobileSyncFailure, safeFailure } from './failure.ts'
import type { WindowBinding, WindowSessionSummary, WindowTranscript, WindowTurn } from './types.ts'

/** Projection result before the binding echo is attached. */
export type TranscriptWindow = Omit<WindowTranscript, 'binding'>

/** Everything the phone port needs from the Session authority, and nothing more. */
export interface MobileSessionPort {
  /** Continuable Sessions: non-blank, not a subagent child, newest activity first. */
  listContinuable(signal: AbortSignal): Promise<WindowSessionSummary[]>
  /** Throws `PC_WINDOW_NO_SESSION` for a missing, blank or subagent Session. */
  requireContinuable(sessionId: string, signal: AbortSignal): Promise<void>
  /** Bounded committed-text window scoped to the binding; a foreign cursor is refused. */
  transcript(binding: WindowBinding, cursor: string | null, signal: AbortSignal): Promise<TranscriptWindow>
  /** Whether this exact request identity already reached the Session log or its durable inbox. */
  admitted(sessionId: string, rpcId: string, signal: AbortSignal): Promise<boolean>
  /** Queue one text message once; `check` runs synchronously before admission. */
  submit(sessionId: string, rpcId: string, text: string, signal: AbortSignal, check: () => void): Promise<void>
}

const continuable = (events: readonly SessionEvent[]): boolean => events.some(event => event.type === 'turn/start' || event.type === 'user/message')
const grantOf = (binding: WindowBinding): ConnectionGrant => ({ id: `mobile:${binding.sourceDeviceId}`, sessionId: SessionId(binding.sessionId),
  label: '', mode: 'text', createdAt: 0, expiresAt: 0, revoked: false, lastAccessAt: null, acceptedCommands: 0,
  pcId: binding.pcId, deviceId: binding.sourceDeviceId })

/**
 * Build the phone port over the real Session controller and the shared session-connect admission port.
 * @param ctx - Host with `sessions`, `agents` and `sessionController`.
 * @param inner - Shared admission port; defaults to the session-connect implementation over `ctx`.
 * @returns Read, list and text-only admission operations.
 */
export function mobileSessionPort(ctx: Context, inner: ConnectSessionPort = sessionPort(ctx)): MobileSessionPort {
  const inspect = async (sessionId: string, signal: AbortSignal) => {
    try { return await inner.inspect(SessionId(sessionId), signal) }
    catch (error) { throw error instanceof MobileSyncFailure ? error : safeFailure(error) }
  }
  return {
    async listContinuable(signal) {
      let items
      try { items = (await ctx.sessionController.list({}, signal)).items }
      catch (error) { throw safeFailure(error) }
      return items.filter(item => !item.blank && item.origin !== 'subagent' && item.parentSessionId === undefined)
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map(item => ({ sessionId: String(item.sessionId), updatedAt: item.updatedAt, running: item.running }))
    },
    async requireContinuable(sessionId, signal) {
      let snapshot
      try { snapshot = await inspect(sessionId, signal) }
      catch (error) {
        if (error instanceof MobileSyncFailure && error.kind !== 'SESSION_UNAVAILABLE') throw error
        throw new MobileSyncFailure('NO_SESSION')
      }
      if (!continuable(snapshot.events)) throw new MobileSyncFailure('NO_SESSION')
    },
    async transcript(binding, cursor, signal) {
      const snapshot = await inspect(binding.sessionId, signal)
      let page
      try { page = projectConnectionPage(grantOf(binding), snapshot.events, cursor, snapshot.running, PHONE_TURN_BYTE_LIMIT) }
      catch (error) { throw safeFailure(error) }
      const at = new Map<number, number>()
      for (const event of snapshot.events) at.set(event.seq, event.time)
      /* v8 ignore next 3 -- the `?? 0` arm: every projected turn names one of these events, so its time is always known. */
      const turns: WindowTurn[] = page.turns.map(turn => ({ id: `${turn.role === 'user' ? 'u' : 'a'}:${String(turn.seq)}`, role: turn.role,
        text: turn.text, at: at.get(turn.seq) ?? 0, truncated: turn.truncated }))
      return { status: page.running ? 'running' : 'idle', turns, cursor: page.cursor, reset: page.reset, hasMore: page.hasMore, earlierOmitted: page.earlierOmitted }
    },
    async admitted(sessionId, rpcId, signal) {
      try { return await inner.admitted(SessionId(sessionId), rpcId, signal) }
      catch (error) { throw safeFailure(error) }
    },
    async submit(sessionId, rpcId, text, signal, check) {
      try { await inner.submit(SessionId(sessionId), rpcId, text, signal, check) }
      catch (error) { throw safeFailure(error) }
    },
  }
}
