/**
 * The one allowlist of `/api` requests that may reach their route without the
 * owner's browser-session cookie, and the matcher that reads it.
 *
 * ## Why the exemption exists
 *
 * The owner cookie authenticates *the owner's browser*, and a browser hands it
 * out one authority at a time (`app.qianshousuanli.com` and
 * `dev.qianshousuanli.com` are two independent cookie jars). The account
 * surface, however, exists to answer requests from a browser that by
 * definition has no cookie yet: `state` is the first call the phone makes, and
 * it is how the page learns whether the session is signed in; `login` is how a
 * session is obtained in the first place. Gating those behind the cookie is a
 * deadlock — a fresh phone (or a fresh browser profile) can never sign in —
 * and the phone reads the resulting 401 as "the account server is
 * unreachable", which is exactly the defect this list fixes.
 *
 * The exemption does **not** relax the fence that matters: {@link
 * isTrustedApiRequest} (Host binding, cross-site marker, Origin/Host equality)
 * still runs first and still returns 403, so a rebound hostname or a page on
 * another origin is refused before this list is ever consulted. The cookie is
 * a second lock on the same door, not the authority for the account itself:
 * which account is signed in lives in the Host process's own credential store
 * (`.qianshou-account.json`), and these routes never return tokens, never
 * create the owner cookie, and cannot read another account's data.
 *
 * ## Why it is an explicit table
 *
 * The exemption is a security boundary, so it is data a reviewer can read and
 * a test can assert, not a rule derived from registration order or a prefix
 * match: only an exact pathname in {@link PUBLIC_API_ENDPOINTS}, combined with
 * a method that entry declares, skips the cookie. Everything else on `/api`
 * (sessions, tasks, models, the RPC surface) keeps its previous behaviour
 * byte for byte. There is deliberately no prefix entry and no wildcard — a
 * path such as `/api/qianshou/account/login/anything` is not on the list and
 * still meets the cookie gate.
 *
 * ## Why not a `public: true` flag on the route registration
 *
 * A registration-site flag would keep the policy next to the handler, and some
 * designs want exactly that. It is refused here because the account routes are
 * ordinary Fetch routes living in another package: once any route may exempt
 * itself, the exemption is no longer a policy this package can state, review
 * or test in one place — the next route added by the next plugin would widen
 * it silently, and "which requests bypass the cookie" would stop having a
 * single answer. Keeping the list here means the worst bug in this design is a
 * missing entry (a route that stays gated — a visible failure), never an
 * accidental one.
 */

import type { ConnectionFetchMethod, ConnectionRequestFacts } from './rpc.ts'

/** The Host account surface prefix; the only prefix this list may ever cover. */
const ACCOUNT_PREFIX = '/api/qianshou/account/'

/**
 * The account routes that answer before, and after, sign-in.
 *
 * Every entry is an exact pathname with the methods the route actually
 * registers, so an entry cannot expose more than the route itself does.
 */
export const PUBLIC_API_ENDPOINTS: Readonly<Record<string, readonly ConnectionFetchMethod[]>> = {
  // The phone's first call: "is this Host signed in, and as whom?". Read-only
  // snapshot of state the Host already holds; no token, no upstream call.
  [`${ACCOUNT_PREFIX}state`]: ['POST'],
  // The credential exchange itself — the deadlock this fixes.
  [`${ACCOUNT_PREFIX}login`]: ['POST'],
  // Second step of a two-factor sign-in; same deadlock, same answer.
  [`${ACCOUNT_PREFIX}login-totp`]: ['POST'],
  // Registration is the same class of unauthenticated operation as login.
  [`${ACCOUNT_PREFIX}register`]: ['POST'],
  // The signed-in reads and the sign-out that follow: a phone or profile whose
  // cookie is for another authority (or which never had one) must still be
  // able to show the account and to sign out — with the cookie gate those
  // paths report a broken account server instead.
  [`${ACCOUNT_PREFIX}me`]: ['POST'],
  [`${ACCOUNT_PREFIX}logout`]: ['POST'],
}

/**
 * Whether one request is on the public allowlist.
 *
 * @param request - request facts; a transport may omit `url`/`method`, and an
 * omitted value never matches — an unrecognisable request keeps the cookie gate.
 * @returns true only for an exact listed pathname carrying a listed method.
 */
export function isPublicApiRequest(request: ConnectionRequestFacts): boolean {
  if (request.url === undefined || request.method === undefined) return false
  /* v8 ignore next 2 -- node:http always sets url on server requests. */
  const url = new URL(request.url, 'http://dsh.invalid')
  const methods = PUBLIC_API_ENDPOINTS[url.pathname]
  if (methods === undefined) return false
  return methods.some(method => method === request.method)
}
