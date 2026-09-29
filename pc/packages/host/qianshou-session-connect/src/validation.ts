/** Wire limits and safe failures for the owner-authorized Session connection. */
import { z } from 'zod'
import type { ConnectionGrantInput } from './types.ts'

/** Safe error codes never embed bearer values, message text or local paths. */
export class ConnectFailure extends Error {
  constructor(readonly code: 'invalid-request' | 'unauthorized' | 'read-only' | 'expired' | 'revoked' | 'capacity'
    | 'session-unavailable' | 'conflict' | 'closed' | 'storage-failed' | 'timeout' | 'cursor-invalid' | 'history-too-large'
    | 'device-mismatch', readonly status = 400) {
    super(`QIANSHOU_SESSION_CONNECT_${code}`)
  }
}
const identifier = z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/u)
const grantInput = z.object({ sessionId: identifier, label: z.string().trim().min(1).max(80),
  mode: z.enum(['read', 'text']), durationMinutes: z.number().int().min(1).max(1440),
  pcId: identifier.optional(), deviceId: identifier.optional() }).strict()
const sendInput = z.object({ requestId: z.string().regex(/^[a-zA-Z0-9_-]{8,96}$/u), text: z.string().trim().min(1).max(4096) }).strict()
const receiptInput = z.object({ requestId: sendInput.shape.requestId }).strict()
const readInput = z.object({ cursor: z.string().max(160).nullable() }).strict()
/**
 * Validate the exact owner input before creating any grant.
 * @param value - Owner RPC input.
 * @returns Validated grant description.
 */
export function parseGrant(value: ConnectionGrantInput): ConnectionGrantInput {
  const parsed = grantInput.safeParse(value)
  if (!parsed.success) throw new ConnectFailure('invalid-request')
  return parsed.data as ConnectionGrantInput
}
/**
 * Validate one narrow endpoint's complete JSON request.
 * @param action - Fixed endpoint action.
 * @param value - Untrusted JSON body.
 * @returns The validated input for that action.
 */
export function parseRequest(action: 'read' | 'send' | 'receipt', value: unknown): { cursor?: string | null; requestId?: string; text?: string } {
  const parsed = (action === 'read' ? readInput : action === 'send' ? sendInput : receiptInput).safeParse(value)
  if (!parsed.success) throw new ConnectFailure('invalid-request')
  if ('text' in parsed.data && typeof parsed.data.text === 'string' && Buffer.byteLength(parsed.data.text) > 12000) throw new ConnectFailure('invalid-request')
  return parsed.data
}
/**
 * Hide SQLite and adapter diagnostics at the untrusted wire.
 * @param error - Any internal failure.
 * @returns A safe, stable response error.
 */
export function safeFailure(error: unknown): ConnectFailure { return error instanceof ConnectFailure ? error : new ConnectFailure('session-unavailable', 503) }
