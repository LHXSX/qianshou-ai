/**
 * Account section store: one plugin-lifetime controller behind the desktop
 * workbench's「账号」page.
 *
 * The controller owns exactly the facts the page displays and the six
 * mutations it can perform, and it never lets a request outcome skip a step:
 *
 * - A 2FA login **stops at the challenge**, moves the page to its own code
 *   step, and keeps the challenge token in memory only. Nothing signs in until
 *   `login-totp` answers.
 * - A registration **never claims a session**. The notice it publishes is
 *   derived from the session the Host actually reports afterwards, so the
 *   sentence on screen and the Host's state cannot disagree.
 * - A password exists only as a request-body argument for the duration of one
 *   call: it is not stored on this object, not persisted, and not logged.
 *
 * Session states come from the Host's own observation (`/state`), never from a
 * local guess at what a successful response implies.
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  ACCOUNT_ROUTES, AccountFailure, parseAcknowledged, parseLogin, parseRegister, parseSnapshot, toFailure,
  type AccountFailureCode, type AccountProfile, type SessionState,
} from './account-wire.ts'

/** The page's two input steps. `totp` exists only while a challenge is pending. */
export type AccountStep = 'credentials' | 'totp'

/** Which credentials form the page shows; a registration hands back to `login`. */
export type AccountMode = 'login' | 'register'

/**
 * Product copy the page shows after a successful call. It is a key, not a
 * sentence: the section owns the bilingual dictionary, exactly like every
 * other string on the page.
 */
export type AccountNotice = 'registered' | 'totpRequired' | 'signedOut'

/**
 * A failed call, ready to render.
 *
 * `host` carries the Host's or upstream's own Chinese sentence and is shown
 * verbatim — replacing it here would swap a specific reason for a guess.
 */
export interface AccountError {
  readonly kind: AccountFailureCode
  /** Host sentence for `host`; wire diagnostic otherwise (never shown). */
  readonly message: string
}

/** Everything the account page renders. */
export interface AccountSectionState {
  /** Host-reported session state; null until the first observation lands. */
  session: SessionState | null
  /** Host-reported account (name, role, balance); null when none is known. */
  account: AccountProfile | null
  /** Which input step the page is on. */
  step: AccountStep
  /**
   * Which credentials form is on screen. It lives here rather than in the
   * component because the successful-registration hand-off (form + notice) is
   * one transition: a component-local copy could show the register form next
   * to a notice telling the user to sign in.
   */
  mode: AccountMode
  /** True until the first observation completes (mount-time read). */
  loading: boolean
  /** True while a call is in flight (all inputs are held). */
  busy: boolean
  /** Success notice to show next to the state line. */
  notice: AccountNotice | null
  /** Failure to show; cleared when the next call starts. */
  error: AccountError | null
}

const INITIAL: AccountSectionState = {
  session: null, account: null, step: 'credentials', mode: 'login', loading: true, busy: false, notice: null, error: null,
}

/** One JSON request to one account route. */
async function request(
  transport: typeof fetch,
  path: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ payload: unknown; status: number }> {
  const response = await transport(path, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  try {
    return { payload: await response.json() as unknown, status: response.status }
  } catch {
    // An HTTP answer without JSON is a malformed response, not a network fault.
    throw new AccountFailure('invalid', `HTTP_${response.status}`)
  }
}

/** Own the account projection and the six calls for one plugin lifetime. */
export class AccountController {
  /** Snapshot bound by the slot renderer; no credential is ever persisted here. */
  readonly store = createSnapshotStore<AccountSectionState>({ ...INITIAL })
  private readonly abort = new AbortController()
  /** Pending 2FA challenge token: memory only, never rendered, gone on unload. */
  private challenge: string | null = null
  /** True while a call is in flight; one account mutation at a time. */
  private inFlight = false

  /**
   * Bind the transport.
   * @param transport - Fetch implementation; injectable so tests drive real `Response` objects.
   */
  constructor(private readonly transport: typeof fetch = (input, init) => globalThis.fetch(input, init)) {}

  /** Start one call, or refuse when another is running / the plugin left. */
  private begin(): boolean {
    if (this.inFlight || this.abort.signal.aborted) return false
    this.inFlight = true
    this.store.update((state) => { state.busy = true; state.error = null; state.notice = null })
    return true
  }

  /** Finish one call, publishing the completed observation. */
  private end(): void {
    this.inFlight = false
    if (this.abort.signal.aborted) return
    this.store.update((state) => { state.busy = false; state.loading = false })
  }

  /**
   * Publish a failure without discarding the session the Host last reported.
   *
   * A failure arriving after disposal is dropped: the section it belonged to
   * is gone, and an abort is not the user's failure to read.
   */
  private fail(error: unknown): void {
    if (this.abort.signal.aborted) return
    const failure = toFailure(error)
    this.store.update((state) => { state.error = { kind: failure.code, message: failure.message } })
  }

  /**
   * Publish one Host observation.
   *
   * A signed-out Host means there is no account. Otherwise its account wins
   * when present, and a missing one leaves the displayed account alone: an
   * already-shown name and balance are facts and are not erased into unknown
   * by a response that simply omitted them.
   */
  private publish(snapshot: { state: SessionState; account: AccountProfile | null }): void {
    // A late answer must not resurrect a section the plugin already left.
    if (this.abort.signal.aborted) return
    this.store.update((state) => {
      state.session = snapshot.state
      state.account = snapshot.state === 'signed-out' ? null : snapshot.account ?? state.account
    })
  }

  /** Read the Host's session state and account (no upstream round trip). */
  private async observe(): Promise<void> {
    const { payload, status } = await request(this.transport, ACCOUNT_ROUTES.state, {}, this.abort.signal)
    this.publish(parseSnapshot(payload, status))
  }

  /** Re-read the Host's session state. Runs on mount and on demand. */
  async refresh(): Promise<void> {
    if (!this.begin()) return
    try {
      await this.observe()
    } catch (error) { this.fail(error) } finally { this.end() }
  }

  /**
   * Re-read the upstream profile, which is the fresh-balance path.
   *
   * The Host answers 401 with its own sentence when the session cannot read
   * the profile; that sentence is shown as-is.
   */
  async verify(): Promise<void> {
    if (!this.begin()) return
    try {
      const { payload, status } = await request(this.transport, ACCOUNT_ROUTES.me, {}, this.abort.signal)
      this.publish(parseSnapshot(payload, status))
    } catch (error) { this.fail(error) } finally { this.end() }
  }

  /**
   * Sign in with a password.
   *
   * A 2FA answer is **not** a signed-in result: the page moves to the code
   * step and stays there until {@link submitTotp} completes.
   * @param username - account name or email exactly as typed.
   * @param password - the password; carried into this one request body only.
   */
  async login(username: string, password: string): Promise<void> {
    if (!this.begin()) return
    try {
      const { payload, status } = await request(
        this.transport, ACCOUNT_ROUTES.login, { username, password }, this.abort.signal,
      )
      const outcome = parseLogin(payload, status)
      if (outcome.kind === 'two-factor') {
        this.challenge = outcome.challenge.token
        this.store.update((state) => { state.step = 'totp'; state.notice = 'totpRequired' })
        return
      }
      await this.observe()
      this.store.update((state) => { state.step = 'credentials'; state.mode = 'login' })
    } catch (error) { this.fail(error) } finally { this.end() }
  }

  /**
   * Complete the 2FA step with a verification code.
   * @param code - the one-time code from the authenticator.
   * @param trustDevice - whether to ask upstream to trust this device.
   */
  async submitTotp(code: string, trustDevice: boolean): Promise<void> {
    const challenge = this.challenge
    // Only reachable by driving the controller out of order: the code step and
    // the challenge are published in one update, so the page cannot show the
    // step without one. Doing nothing keeps an unverifiable code off the wire.
    if (challenge === null) return
    if (!this.begin()) return
    try {
      const { payload, status } = await request(this.transport, ACCOUNT_ROUTES.loginTotp, {
        challengeToken: challenge,
        code,
        ...(trustDevice ? { trustDevice: true } : {}),
      }, this.abort.signal)
      // The route answers `{ok:true, account}` with no state field; the sign-in
      // is therefore confirmed by the Host's own observation, never by the
      // presence of an account in this response.
      parseAcknowledged(payload, status)
      await this.observe()
      this.challenge = null
      this.store.update((state) => { state.step = 'credentials'; state.mode = 'login' })
    } catch (error) { this.fail(error) } finally { this.end() }
  }

  /** Leave the code step without signing in (a lost authenticator is not a dead end). */
  backToCredentials(): void {
    this.challenge = null
    this.store.update((state) => { state.step = 'credentials'; state.notice = null })
  }

  /**
   * Switch the credentials form. The session is untouched: this is a view of
   * the same sign-in, not a state change.
   * @param mode - the form to show.
   */
  showForm(mode: AccountMode): void {
    this.store.update((state) => { state.mode = mode; state.error = null })
  }

  /**
   * Create an account. The Host never signs the new account in, so this call
   * only reports what happened and the page asks the user to sign in.
   * @param password - the new password; one request body only.
   * @param username - optional account name.
   * @param email - optional email.
   */
  async register(password: string, username: string, email: string): Promise<void> {
    if (!this.begin()) return
    try {
      const { payload, status } = await request(this.transport, ACCOUNT_ROUTES.register, {
        password,
        ...(username.length === 0 ? {} : { username }),
        ...(email.length === 0 ? {} : { email }),
      }, this.abort.signal)
      const outcome = parseRegister(payload, status)
      await this.observe()
      this.store.update((state) => {
        state.step = 'credentials'
        // A created account belongs on the sign-in form: the notice below asks
        // the user to sign in, so the register form must not stay on screen.
        state.mode = 'login'
        // Both facts must agree before the page tells the user to sign in:
        // the Host said it did not create a session, and the observed session
        // is indeed signed out.
        state.notice = !outcome.signedIn && state.session === 'signed-out' ? 'registered' : null
      })
    } catch (error) { this.fail(error) } finally { this.end() }
  }

  /** Sign out: the Host revokes the upstream session and clears its credentials. */
  async logout(): Promise<void> {
    if (!this.begin()) return
    try {
      const { payload, status } = await request(this.transport, ACCOUNT_ROUTES.logout, {}, this.abort.signal)
      parseAcknowledged(payload, status)
      await this.observe()
      this.challenge = null
      this.store.update((state) => { state.step = 'credentials'; state.mode = 'login'; state.notice = 'signedOut' })
    } catch (error) { this.fail(error) } finally { this.end() }
  }

  /** Abort in-flight requests and suppress late responses when the plugin leaves. */
  dispose(): void { this.abort.abort() }
}
