/**
 * Type-only mobile build mapping for the PC-window bridge's two branded IDs.
 *
 * The full Session/SessionController type modules pull in the entire desktop
 * workspace, whose generated lib files are not part of this mobile source
 * snapshot. These two aliases match the definitions in
 * packages/core/session/src/types.ts and
 * packages/api/session-controller/src/types.ts respectively. Runtime bridge
 * code is loaded directly from its own source by vite.config.ts.
 */
import type { Branded } from '@deepseek-ai/dsh-brand'

export type SessionId = Branded<'SessionId'>
export type SessionRequestId = Branded<'session-request-id'>
