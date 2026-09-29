/** Session and workspace admission shared by every authenticated voice route. */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { VoiceFailure } from './failure.ts'

/** A live Session instance and the workspace root the caller expects it to own. */
export interface VoiceSessionGuard { readonly session: Session; readonly cwd: string }

/**
 * Resolve exactly one live Session whose immutable cwd equals the caller's expected workspace root.
 * @param ctx - Plugin context supplying the SessionStore.
 * @param url - Route URL carrying `sessionId` and `workspaceRoot` query parameters.
 * @returns The admitted Session and cwd.
 * @throws VoiceFailure `SESSION_UNAVAILABLE` for missing, duplicated, oversized or unknown identifiers; `SESSION_MISMATCH` for another cwd.
 */
export function admitSession(ctx: Context, url: URL): VoiceSessionGuard {
  const ids = url.searchParams.getAll('sessionId'), roots = url.searchParams.getAll('workspaceRoot')
  if (ids.length !== 1 || !ids[0] || ids[0].length > 256 || roots.length !== 1 || !roots[0] || roots[0].length > 32768) {
    throw new VoiceFailure('SESSION_UNAVAILABLE', 409)
  }
  const session = ctx.sessions.get(SessionId(ids[0]))
  if (!session) throw new VoiceFailure('SESSION_UNAVAILABLE', 409)
  if (session.header.cwd !== roots[0]) throw new VoiceFailure('SESSION_MISMATCH', 409)
  return { session, cwd: roots[0] }
}

/**
 * Re-check after an asynchronous step that the same Session instance is still registered with the same cwd.
 * @param ctx - Plugin context supplying the SessionStore.
 * @param guard - Previously admitted Session and cwd.
 * @throws VoiceFailure when the instance was replaced or released, or its cwd no longer matches.
 */
export function assertCurrent(ctx: Context, guard: VoiceSessionGuard): void {
  if (ctx.sessions.get(guard.session.id) !== guard.session) throw new VoiceFailure('SESSION_UNAVAILABLE', 409)
  if (guard.session.header.cwd !== guard.cwd) throw new VoiceFailure('SESSION_MISMATCH', 409)
}
