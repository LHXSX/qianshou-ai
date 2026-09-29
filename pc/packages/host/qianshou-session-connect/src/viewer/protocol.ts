/** Minimal credential-omitting HTTP client for the three narrow connection actions. */
import type { ConnectionPage, ConnectionReceipt } from '../types.ts'

/** Safe status for the page; response diagnostics never enter the DOM. */
export class ViewerFailure extends Error { constructor(readonly status: number) { super('Session connection request failed') } }
/**
 * Accept only a presentable device id for the narrow request header.
 * @param value - Untrusted optional device claim.
 * @returns The same string when it is safe to send, otherwise undefined.
 */
export function presentableDevice(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value : undefined
}
/**
 * Fetch one bounded JSON response without owner cookies.
 * @param token - Tab-owned grant bearer.
 * @param action - Narrow endpoint action.
 * @param body - Exact action input.
 * @param signal - Page operation lifetime.
 * @param deviceId - Optional phone device claim for a device-bound grant.
 * @returns Parsed JSON after transport and byte bounds.
 */
export async function request(
  token: string, action: 'read' | 'send' | 'receipt', body: unknown, signal: AbortSignal, deviceId?: string,
): Promise<unknown> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const device = presentableDevice(deviceId)
  if (device !== undefined) headers['X-Qianshou-Device'] = device
  const response = await fetch(`/qianshou-connect/api/${action}`, { method: 'POST', credentials: 'omit', cache: 'no-store',
    headers, body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]), redirect: 'error', referrerPolicy: 'no-referrer' })
  if (!response.ok) { await response.body?.cancel(); throw new ViewerFailure(response.status) }
  const reader = response.body?.getReader()
  if (!reader) throw new ViewerFailure(502)
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > 262144) throw new ViewerFailure(502)
      chunks.push(chunk.value)
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ViewerFailure(502)
  return value as Record<string, unknown>
}
/**
 * Validate a complete bounded display projection received over HTTP.
 * @param value - Untrusted JSON response.
 * @returns Narrow committed-text page.
 */
export function page(value: unknown): ConnectionPage {
  const row = object(value)
  if (typeof row.sessionId !== 'string' || row.sessionId.length > 256 || typeof row.label !== 'string' || row.label.length > 80
    || (row.mode !== 'read' && row.mode !== 'text') || typeof row.expiresAt !== 'number' || !Number.isSafeInteger(row.expiresAt)
    || typeof row.cursor !== 'string' || row.cursor.length > 160 || typeof row.reset !== 'boolean' || typeof row.running !== 'boolean'
    || typeof row.hasMore !== 'boolean' || typeof row.earlierOmitted !== 'boolean' || !Array.isArray(row.turns) || row.turns.length > 25) throw new ViewerFailure(502)
  for (const item of row.turns) {
    const turn = object(item)
    if (!Number.isSafeInteger(turn.seq) || (turn.role !== 'user' && turn.role !== 'assistant') || typeof turn.text !== 'string'
      || turn.text.length > 6000 || typeof turn.truncated !== 'boolean') throw new ViewerFailure(502)
  }
  return row as unknown as ConnectionPage
}
/**
 * Validate the receipt for exactly the pending request.
 * @param value - Untrusted JSON response.
 * @param requestId - Tab's expected stable id.
 * @returns Safe delivery status.
 */
export function receipt(value: unknown, requestId: string): ConnectionReceipt {
  const row = object(value)
  if (row.requestId !== requestId || !['received', 'uncertain', 'rejected'].includes(String(row.state))
    || (row.acceptedAt !== null && !Number.isSafeInteger(row.acceptedAt))) throw new ViewerFailure(502)
  return row as unknown as ConnectionReceipt
}
