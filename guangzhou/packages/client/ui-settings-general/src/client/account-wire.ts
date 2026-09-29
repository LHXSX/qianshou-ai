/**
 * Account surface wire contract: the six Host routes the desktop workbench
 * calls, plus the strict parsing that keeps an unverified response from
 * reaching the screen as a fact.
 *
 * Three rules shape this module:
 *
 * 1. **Plain `fetch`.** The routes live on the already-authenticated owner
 *    connection of the workbench itself, so the browser's own same-origin
 *    request (with its session cookie) is the whole transport. No client
 *    account library is imported here: `@deepseek-ai/dsh-client-account` is a
 *    Host/mobile library, not a `dsh.client` module-table row, and cannot be
 *    resolved inside a client plugin bundle.
 * 2. **No token ever appears in this file.** The Host never sends one, and
 *    nothing here asks for one. The only secret that crosses this boundary is
 *    a password travelling *inward* on a request body, and a 2FA challenge
 *    token travelling back to the caller that owns it in memory.
 * 3. **Unknown is not success.** Every field is narrowed; a response whose
 *    shape does not match throws {@link AccountFailure} instead of being
 *    rendered as a state the Host cannot mean.
 */

/** Mount point of the account routes on the workbench's authenticated connection. */
export const ACCOUNT_PREFIX = '/api/qianshou/account/'

/** The six routes, spelled exactly as the Host plugin registers them. */
export const ACCOUNT_ROUTES = {
  /** Session state plus the Host's cached account (no network round trip upstream). */
  state: `${ACCOUNT_PREFIX}state`,
  /** Re-reads the upstream profile: the fresh-balance path. */
  me: `${ACCOUNT_PREFIX}me`,
  /** Password login; may answer with a 2FA challenge instead of a session. */
  login: `${ACCOUNT_PREFIX}login`,
  /** The mandatory second step of a 2FA login. */
  loginTotp: `${ACCOUNT_PREFIX}login-totp`,
  /** Account creation. The Host never signs the new account in. */
  register: `${ACCOUNT_PREFIX}register`,
  /** Revokes the upstream session and clears the local credential file. */
  logout: `${ACCOUNT_PREFIX}logout`,
} as const

/**
 * Account fields the UI displays. Field names are copied verbatim from the
 * upstream OpenAPI shape (the Host forwards them unchanged) rather than
 * re-mapped, because a rename here would be a silent way to lose a field.
 */
export interface AccountProfile {
  readonly id: number | string
  readonly username: string
  readonly email: string
  readonly role: string
  readonly status: string
  /** Upstream balance, string or number; `null` means unreported, never zero. */
  readonly balance: number | string | null
  readonly created_at: string | null
  readonly last_login_at: string | null
}

/** Session states the Host reports (`AccountSessionState`). */
export type SessionState = 'signed-out' | 'authenticated' | 'expired'

/** One observation of the Host's account session. */
export interface AccountSnapshot {
  readonly state: SessionState
  readonly account: AccountProfile | null
}

/** The 2FA challenge: the UI must take a second, separate step with it. */
export interface TotpChallenge {
  /** Opaque challenge token; held in memory only and never rendered. */
  readonly token: string
  /** Upstream's default verification method (currently always `totp`). */
  readonly method: string
}

/** Outcome of `POST /login`: either a session, or a required second step. */
export type LoginOutcome =
  | { readonly kind: 'signed-in'; readonly account: AccountProfile | null }
  | { readonly kind: 'two-factor'; readonly challenge: TotpChallenge }

/** Outcome of `POST /register`. */
export interface RegisterOutcome {
  /** Whether the Host also established a session. Today's Host always says false. */
  readonly signedIn: boolean
}

/** Why a call failed; the UI renders the Host's own sentence for `host`. */
export type AccountFailureCode = 'host' | 'invalid' | 'unreachable' | 'rejected'

/**
 * One failed account call.
 *
 * `host` carries the sentence the Host (or upstream) wrote — it is already
 * user-facing Chinese and is shown verbatim, because re-writing it here would
 * replace a specific reason with a guess. The other codes are transport-level
 * facts the Host never sees, so the UI owns their copy.
 */
export class AccountFailure extends Error {
  /**
   * @param code - failure family.
   * @param message - Host sentence for `host`, diagnostic text otherwise.
   */
  constructor(readonly code: AccountFailureCode, message: string) {
    super(message)
    this.name = 'AccountFailure'
  }
}

/** Whether a value is a plain JSON object. */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a value is a non-empty string. */
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Whether a value is a usable display identity. */
function identity(value: unknown): value is number | string {
  return typeof value === 'number' || text(value)
}

/** Read the Host's failure sentence, or fall back to a status-only rejection. */
function failureOf(payload: unknown, status: number): AccountFailure {
  if (record(payload) && text(payload['message'])) {
    return new AccountFailure('host', payload['message'])
  }
  return new AccountFailure('rejected', `HTTP_${status}`)
}

/**
 * Parse one account response.
 *
 * A `2xx` body must be `{ok: true}`: the Host answers failures with
 * `{ok: false, message}`, so `ok` is the one discriminator that cannot be
 * inferred from the HTTP status alone (`/me` answers 401, argument errors
 * answer 400, and both are legitimate answers rather than transport faults).
 * @param payload - decoded JSON body.
 * @param status - HTTP status, for the message-less fallback only.
 * @returns the successful payload.
 * @throws {AccountFailure} when the body is missing, malformed, or `ok: false`.
 */
export function parseSuccess(payload: unknown, status: number): Record<string, unknown> {
  if (!record(payload)) throw new AccountFailure('invalid', 'ACCOUNT_RESPONSE_NOT_AN_OBJECT')
  if (payload['ok'] !== true) throw failureOf(payload, status)
  return payload
}

/**
 * Parse an account object, or `null` when the Host reports no account.
 * @param value - the response's `account` field.
 * @returns the display profile, or null.
 * @throws {AccountFailure} when a present account is not usable.
 */
export function parseAccount(value: unknown): AccountProfile | null {
  if (value === null || value === undefined) return null
  if (!record(value) || !identity(value['id'])) throw new AccountFailure('invalid', 'ACCOUNT_PROFILE_INVALID')
  const balance = value['balance']
  if (balance !== null && balance !== undefined && typeof balance !== 'number' && typeof balance !== 'string') {
    throw new AccountFailure('invalid', 'ACCOUNT_BALANCE_INVALID')
  }
  return {
    id: value['id'],
    username: typeof value['username'] === 'string' ? value['username'] : '',
    email: typeof value['email'] === 'string' ? value['email'] : '',
    role: typeof value['role'] === 'string' ? value['role'] : '',
    status: typeof value['status'] === 'string' ? value['status'] : '',
    balance: balance ?? null,
    created_at: typeof value['created_at'] === 'string' ? value['created_at'] : null,
    last_login_at: typeof value['last_login_at'] === 'string' ? value['last_login_at'] : null,
  }
}

/** Read the Host's session state; an unrecognized state is rejected, not mapped. */
function parseState(value: unknown): SessionState {
  if (value === 'signed-out' || value === 'authenticated' || value === 'expired') return value
  throw new AccountFailure('invalid', 'ACCOUNT_STATE_INVALID')
}

/**
 * Parse `state` / `me` into one observation.
 * @param payload - decoded JSON body.
 * @param status - HTTP status.
 * @returns the reported session state and account.
 * @throws {AccountFailure} on a malformed or failed response.
 */
export function parseSnapshot(payload: unknown, status: number): AccountSnapshot {
  const body = parseSuccess(payload, status)
  return { state: parseState(body['state']), account: parseAccount(body['account']) }
}

/**
 * Parse a login result. `twoFactor: true` is a *different outcome*, not a
 * successful sign-in: the caller must run the challenge step before it may
 * claim the user is logged in.
 * @param payload - decoded JSON body.
 * @param status - HTTP status.
 * @returns either the signed-in account or the pending challenge.
 * @throws {AccountFailure} on a malformed or failed response.
 */
export function parseLogin(payload: unknown, status: number): LoginOutcome {
  const body = parseSuccess(payload, status)
  if (typeof body['twoFactor'] !== 'boolean') throw new AccountFailure('invalid', 'ACCOUNT_TWO_FACTOR_FLAG_INVALID')
  if (!body['twoFactor']) return { kind: 'signed-in', account: parseAccount(body['account']) }
  const challenge = body['challenge']
  if (!record(challenge) || !text(challenge['challenge_token'])) {
    throw new AccountFailure('invalid', 'ACCOUNT_CHALLENGE_INVALID')
  }
  return {
    kind: 'two-factor',
    challenge: {
      token: challenge['challenge_token'],
      method: text(challenge['default_method']) ? challenge['default_method'] : 'totp',
    },
  }
}

/**
 * Parse a response that only acknowledges success plus an account, which is
 * the shape of `login-totp` (`{ok:true, account}`) and `logout` (`{ok:true}`).
 * @param payload - decoded JSON body.
 * @param status - HTTP status.
 * @returns the returned account, or null when the route reports none.
 * @throws {AccountFailure} on a malformed or failed response.
 */
export function parseAcknowledged(payload: unknown, status: number): AccountProfile | null {
  const body = parseSuccess(payload, status)
  return parseAccount(body['account'])
}

/**
 * Parse the accepted-but-not-signed-in register answer.
 * @param payload - decoded JSON body.
 * @param status - HTTP status.
 * @returns whether the Host also signed the account in.
 * @throws {AccountFailure} on a malformed or failed response.
 */
export function parseRegister(payload: unknown, status: number): RegisterOutcome {
  const body = parseSuccess(payload, status)
  if (typeof body['signedIn'] !== 'boolean') throw new AccountFailure('invalid', 'ACCOUNT_REGISTER_FLAG_INVALID')
  return { signedIn: body['signedIn'] }
}

/**
 * Narrow any thrown value into one failed call.
 * @param error - whatever the call threw.
 * @returns the failure to publish; anything that is not already an
 * {@link AccountFailure} came from `fetch` itself or from decoding its body,
 * so the Host was never reached or answered with no JSON.
 */
export function toFailure(error: unknown): AccountFailure {
  if (error instanceof AccountFailure) return error
  return new AccountFailure('unreachable', error instanceof Error ? error.message : 'ACCOUNT_REQUEST_FAILED')
}
