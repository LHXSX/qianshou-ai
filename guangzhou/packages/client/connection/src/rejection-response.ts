/**
 * The response the `/api` gate writes when it refuses a request, in one place.
 *
 * ## Why the body is JSON, not the words `unauthorized` / `forbidden`
 *
 * The status code is the decision; the body is what a client can act on. A
 * plain-text body forced every browser-side caller to guess: the account client
 * parses each response as JSON, so a text body became `ok:false` with no `code`
 * and no `message`, and the page could not tell "you are not signed in yet"
 * from "the server answered something we cannot read". The shape below is the
 * one that client already understands (`{ok:false, code, message}`), so a
 * refusal from the gate classifies like any other account failure.
 *
 * ## Why there is no `message`
 *
 * The gate cannot know which operation it is refusing. The same 401 on `login`
 * means "the credentials are wrong", and on `me` means "your session expired" —
 * the account client already picks the right copy from the operation, and it
 * only uses a server message when one is present. Writing any string here would
 * overwrite that correct copy with a worse one, so `message` is omitted on
 * purpose and the field stays reserved for callers that do know (the account
 * routes in the Host fill it from the upstream failure).
 *
 * ## What is deliberately absent
 *
 * No Host, no Origin, no path, no token, no hint about why trust failed:
 * a refused caller learns the status and the code, which is all a legitimate
 * client needs, and a probe learns nothing it did not send.
 */

import type { ConnectionRequestRejection } from './rpc.ts'

/** Gate-refusal body fields shared by every writer of the `/api` gate. */export interface ConnectionRejectionBody {
  readonly ok: false
  readonly code: 'AUTH_REQUIRED' | 'FORBIDDEN'
}

/** Headers accompanying a gate refusal: JSON for the clients above, never cached. */
export const CONNECTION_REJECTION_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}

/**
 * Serialize one gate refusal.
 *
 * `AUTH_REQUIRED` is a code the account client already knows, and `FORBIDDEN`
 * is its own explicit name for the fence's 403 — neither is invented here.
 * @param status - the refusal's HTTP status; any other value is indistinguishable from 403.
 * @returns the JSON body for a 401 or 403 refusal.
 */
export function connectionRejectionBody(status: 401 | 403): ConnectionRejectionBody {
  return { ok: false, code: status === 401 ? 'AUTH_REQUIRED' : 'FORBIDDEN' }
}

/**
 * Serialize one gate refusal for a `node:http` response body.
 * @param status - the refusal's HTTP status: 401 for the cookie gate, 403 for the fence.
 * @returns the refusal's JSON text, ready for `ServerResponse.end`.
 */
export function connectionRejectionText(status: ConnectionRequestRejection & (401 | 403)): string {
  return JSON.stringify(connectionRejectionBody(status))
}
