/** One account owner serializes durable writes and rejects results from an older login. */
import { buyCommerce, quoteCommerce, readCommerce, readWechatChannel, rechargeAmount, rechargeCommerce } from './commerce.ts'
import type { PendingQuote } from './commerce.ts'
import { AccountFailure, AccountProtocol, accountOf, challengeOf, modelsOf, tokensOf } from './protocol.ts'
import type { TokenPair } from './protocol.ts'
import type { AccountAlipayStart, AccountCommerce, AccountFailureCode, AccountSnapshot } from './types.ts'

/** Mainland mobile number after removing presentation separators and a leading country code. */
function mainlandPhone(value: string): string {
  const digits = value.replace(/[\s()-]/g, '').replace(/^\+?86/, '')
  if (!/^1[3-9]\d{9}$/.test(digits)) throw new AccountFailure('invalid-input')
  return digits
}

/** Storage operations never expose a credential through the Remote API. */
export interface AccountStore {
  readRefresh: () => Promise<string | null>
  write: (refresh: string | null, access: string) => Promise<void>
  clear: () => Promise<void>
}

/** Host account lifecycle shared by login, refresh, catalog and model-call admission. */
export class AccountSession {
  private value: AccountSnapshot = {
    phase: 'signed-out', account: null, failure: null, verifiedAt: null,
    restorable: false, models: [], cloudSelected: false,
  }
  private disposed = false
  private generation = 0
  private controller = new AbortController()
  private token: TokenPair | undefined
  private expiresAt = 0
  private challenge: { token: string; expiresAt: number } | undefined
  private commerce: AccountCommerce | null = null
  private pendingQuote: PendingQuote | null = null
  private refreshWork: { generation: number; promise: Promise<string> } | undefined
  private writes: Promise<void> = Promise.resolve()
  private readonly ready: Promise<void>
  private refreshToken: string | null = null

  constructor(private readonly protocol: AccountProtocol, private readonly store: AccountStore,
    private readonly now: () => number = Date.now) {
    this.ready = store.readRefresh().then((refresh) => {
      if (this.generation !== 0 || this.disposed) return
      this.refreshToken = refresh
      this.value.restorable = refresh !== null
    }).catch(() => { if (!this.disposed) this.value.failure = 'storage-failed' })
  }

  /**
   * Return a detached non-secret status projection.
   * @returns A detached status with no credentials or private challenge.
   */
  async snapshot(): Promise<AccountSnapshot> { await this.ready; return structuredClone(this.value) }

  /**
   * Keep the selected route a UI fact, separate from whether the user is signed in.
   * @param selected - Whether settings currently select the Qianshou provider.
   */
  selected(selected: boolean): void { this.value.cloudSelected = selected }

  /** Cancel account-owned network work at teardown; stored completed sessions survive restart. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.advance()
    this.controller.abort()
    await this.writes
  }

  /**
   * Current account lifetime, shared with admitted model transports.
   * @returns The current generation signal, aborted by logout, replacement, or disposal.
   */
  signal(): AbortSignal { return this.controller.signal }

  private current(generation: number): void {
    if (this.disposed || generation !== this.generation || this.controller.signal.aborted) throw new AccountFailure('cancelled')
  }

  private queue(write: () => Promise<void>): Promise<void> {
    const operation = this.writes.then(write)
    this.writes = operation.catch(() => undefined)
    return operation
  }

  private advance(): number {
    this.generation++
    this.controller.abort()
    this.controller = new AbortController()
    this.challenge = undefined
    this.commerce = null
    this.pendingQuote = null
    this.token = undefined
    this.refreshToken = null
    this.expiresAt = 0
    this.value = { ...this.value, phase: 'signed-out', account: null, verifiedAt: null,
      restorable: false, models: [], failure: null }
    return this.generation
  }

  private async commit(pair: TokenPair, generation: number): Promise<string> {
    this.current(generation)
    await this.queue(async () => {
      this.current(generation)
      try {
        await this.store.write(pair.refresh, pair.access)
        this.current(generation)
      } catch (error) {
        await this.store.clear().catch(() => undefined)
        throw error instanceof AccountFailure ? error : new AccountFailure('storage-failed')
      }
    })
    this.current(generation)
    this.token = pair
    this.refreshToken = pair.refresh
    this.expiresAt = this.now() + pair.expiresIn * 1000
    this.value.restorable = pair.refresh !== null
    return pair.access
  }

  private async identity(access: string, generation: number): Promise<void> {
    const payload = await this.protocol.request('/auth/me', 'GET', undefined, access, this.controller.signal)
    this.current(generation)
    this.value.account = accountOf(payload)
    this.value.verifiedAt = this.now()
    this.value.phase = 'authenticated'
    this.value.failure = null
  }

  private async failed(error: unknown, generation: number): Promise<void> {
    if (this.disposed || generation !== this.generation) return
    const code: AccountFailureCode = error instanceof AccountFailure ? error.code : 'storage-failed'
    this.value.failure = code
    if (code === 'auth-required' || code === 'storage-failed') {
      const existed = this.value.restorable || this.value.account !== null
      const cleared = this.advance()
      try { await this.queue(() => this.store.clear()) }
      catch { if (this.generation === cleared) this.value.failure = 'storage-failed' }
      if (this.generation !== cleared) return
      this.value.phase = code === 'storage-failed' ? 'unavailable' : existed ? 'expired' : 'signed-out'
      this.value.failure = code
    } else if (code === 'invalid-credentials' || code === 'invalid-input') {
      this.value.phase = this.challenge === undefined ? 'signed-out' : 'two-factor-required'
    } else this.value.phase = this.challenge === undefined ? 'unavailable' : 'two-factor-required'
  }

  /**
   * Ask Shanghai to send a phone code for the selected account action.
   * @param phone - User-entered mainland number; spaces and a leading +86 are removed here.
   * @param purpose - Login or new-account registration.
   * @returns The detached, non-secret account status after the operation.
   */
  async sendPhoneCode(phone: string, purpose: 'login' | 'register' = 'login'): Promise<AccountSnapshot> {
    await this.ready
    if (this.disposed) return this.snapshot()
    const generation = this.generation
    try {
      await this.protocol.request('/auth/sms/send', 'POST',
        { phone: mainlandPhone(phone), purpose }, null, this.controller.signal)
      this.current(generation)
      this.value.failure = null
    } catch (error) {
      if (!this.disposed && generation === this.generation) {
        this.value.failure = error instanceof AccountFailure ? error.code : 'unavailable'
      }
    }
    return this.snapshot()
  }

  /**
   * Sign in with a phone code through the same token and identity steps as a password login.
   * @param phone - User-entered mainland number.
   * @param code - User-entered six-digit SMS code.
   * @returns The detached, non-secret account status after the operation.
   */
  async loginWithPhone(phone: string, code: string): Promise<AccountSnapshot> {
    await this.ready
    if (this.disposed) return this.snapshot()
    const generation = this.advance()
    this.value.phase = 'authorizing'
    try {
      await this.queue(() => this.store.clear())
      this.current(generation)
      if (!/^\d{6}$/.test(code)) throw new AccountFailure('invalid-input')
      const payload = await this.protocol.request('/auth/login/phone', 'POST',
        { phone: mainlandPhone(phone), code, remember_me: true }, null, this.controller.signal)
      this.current(generation)
      const challenge = challengeOf(payload)
      if (challenge !== undefined) {
        this.challenge = { token: challenge.token, expiresAt: this.now() + challenge.expiresIn * 1000 }
        this.value.phase = 'two-factor-required'
      } else await this.identity(await this.commit(tokensOf(payload), generation), generation)
    } catch (error) { await this.failed(error, generation) }
    return this.snapshot()
  }

  /**
   * Create a phone account after Shanghai consumes its registration code.
   * @param phone - User-entered mainland number.
   * @param code - User-entered six-digit registration code.
   * @returns The detached account status after registration and token validation.
   */
  async registerWithPhone(phone: string, code: string): Promise<AccountSnapshot> {
    await this.ready
    if (this.disposed) return this.snapshot()
    const generation = this.advance()
    this.value.phase = 'authorizing'
    try {
      await this.queue(() => this.store.clear())
      this.current(generation)
      if (!/^\d{6}$/.test(code)) throw new AccountFailure('invalid-input')
      const payload = await this.protocol.request('/auth/register/phone', 'POST',
        { phone: mainlandPhone(phone), code, remember_me: true }, null, this.controller.signal)
      this.current(generation)
      await this.identity(await this.commit(tokensOf(payload), generation), generation)
    } catch (error) { await this.failed(error, generation) }
    return this.snapshot()
  }

  /**
   * Sign in with a password without publishing the token pair or changing the selected model.
   * @param username - Account name or email.
   * @param password - Ephemeral password submitted only to the account authority.
   * @returns The detached, non-secret account status after the operation.
   */
  async login(username: string, password: string): Promise<AccountSnapshot> {
    await this.ready
    if (this.disposed) return this.snapshot()
    const generation = this.advance()
    this.value.phase = 'authorizing'
    try {
      await this.queue(() => this.store.clear())
      this.current(generation)
      if (!username.trim() || username.length > 254 || !password || password.length > 4096) throw new AccountFailure('invalid-input')
      const payload = await this.protocol.request('/auth/login', 'POST',
        { username: username.trim(), password, remember_me: true }, null, this.controller.signal)
      this.current(generation)
      const challenge = challengeOf(payload)
      if (challenge !== undefined) {
        this.challenge = { token: challenge.token, expiresAt: this.now() + challenge.expiresIn * 1000 }
        this.value.phase = 'two-factor-required'
      } else await this.identity(await this.commit(tokensOf(payload), generation), generation)
    } catch (error) { await this.failed(error, generation) }
    return this.snapshot()
  }

  /**
   * Complete the private pending TOTP challenge; the browser sends only the code and trust choice.
   * @param code - User-entered six-digit TOTP code.
   * @param trustDevice - Whether the authority may retain trust for this device.
   * @returns The detached, non-secret account status after the operation.
   */
  async completeTotp(code: string, trustDevice: boolean): Promise<AccountSnapshot> {
    const generation = this.generation
    try {
      if (this.challenge === undefined || this.challenge.expiresAt <= this.now() || !/^\d{6}$/.test(code)) throw new AccountFailure('invalid-input')
      this.value.phase = 'authorizing'
      const payload = await this.protocol.request('/auth/login/totp', 'POST', {
        challenge_token: this.challenge.token, code, trust_device: trustDevice, remember_me: true,
      }, null, this.controller.signal)
      const access = await this.commit(tokensOf(payload), generation)
      this.challenge = undefined
      await this.identity(access, generation)
    } catch (error) { await this.failed(error, generation) }
    return this.snapshot()
  }

  /**
   * Cancel a login and clear its partial credentials without reviving an older account.
   * @returns The detached, non-secret account status after the operation.
   */
  async cancel(): Promise<AccountSnapshot> {
    const generation = this.advance()
    try { await this.queue(() => this.store.clear()) }
    catch { if (this.generation === generation) this.value.failure = 'storage-failed' }
    return this.snapshot()
  }

  /**
   * Obtain an unexpired access token; concurrent consumers share a single refresh request.
   * @param force - Whether to renew even when the cached token is unexpired.
   * @returns A Host-only access token; callers must not log or send it over Remote.
   */
  async access(force = false): Promise<string> {
    await this.ready
    this.current(this.generation)
    if (!force && this.token !== undefined && this.now() < this.expiresAt - 30_000) return this.token.access
    const generation = this.generation
    if (this.refreshWork?.generation === generation) return this.refreshWork.promise
    const promise = this.refresh(generation)
    this.refreshWork = { generation, promise }
    try { return await promise }
    finally {
      // Another generation can replace or clear the pending refresh while this await settles.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (this.refreshWork?.promise === promise) this.refreshWork = undefined
    }
  }

  private async refresh(generation: number): Promise<string> {
    if (this.refreshToken === null) throw new AccountFailure('auth-required')
    this.value.phase = 'refreshing'
    try {
      const payload = await this.protocol.request('/auth/refresh', 'POST',
        { refresh_token: this.refreshToken }, null, this.controller.signal)
      const access = await this.commit(tokensOf(payload), generation)
      this.value.phase = this.value.account === null ? 'signed-out' : 'authenticated'
      this.value.failure = null
      return access
    } catch (error) { await this.failed(error, generation); throw error }
  }

  /**
   * Reconnect the account and read its real model catalog, retrying only an unbilled 401 once.
   * @returns The detached, non-secret account status after the operation.
   */
  async reconnect(): Promise<AccountSnapshot> {
    const generation = this.generation
    try {
      let access = await this.access()
      try { await this.identity(access, generation) }
      catch (error) {
        if (!(error instanceof AccountFailure) || error.code !== 'auth-required') throw error
        access = await this.access(true)
        await this.identity(access, generation)
      }
      // The deployed Guangzhou catalog accepts POST. GET is rejected before the handler.
      const payload = await this.protocol.request('/models', 'POST', undefined, access, this.controller.signal, true)
      this.current(generation)
      this.value.models = modelsOf(payload)
    } catch (error) { await this.failed(error, generation) }
    return this.snapshot()
  }

  /**
   * Revoke the captured remote session after clearing local credentials, even if the server is unavailable.
   * @returns The detached, non-secret account status after the operation.
   */
  async logout(): Promise<AccountSnapshot> {
    const access = this.token?.access
    const cancelled = this.cancel()
    const generation = this.generation
    const signal = this.controller.signal
    await cancelled
    if (access !== undefined) {
      try { await this.protocol.request('/auth/logout', 'POST', undefined, access, signal) }
      catch { if (this.generation === generation) this.value.failure = 'unavailable' }
    }
    return this.snapshot()
  }

  private async commerceBase(): Promise<AccountCommerce> {
    const accountId = this.value.account?.id
    if (accountId === undefined) throw new AccountFailure('auth-required')
    const access = await this.access()
    const quote = this.pendingQuote?.accountId === accountId ? this.pendingQuote.view : null
    const commerce = await readCommerce(this.protocol, access, this.controller.signal, quote)
    this.commerce = commerce
    return commerce
  }

  /**
   * Read the signed-in plan, five-hour window, and RMB wallet.
   * @returns Server-reported commerce figures. Missing figures stay null.
   */
  async billing(): Promise<AccountCommerce> { return this.commerceBase() }

  /**
   * Price one month of a plan. Confirmation is a separate call.
   * @param tier - `basic`, `plus`, or `max`.
   * @returns The commerce view including the unpaid quote.
   */
  async quotePlan(tier: string): Promise<AccountCommerce> {
    const accountId = this.value.account?.id
    if (accountId === undefined) throw new AccountFailure('auth-required')
    const current = this.commerce ?? await this.commerceBase()
    const access = await this.access()
    const quoted = await quoteCommerce(this.protocol, access, accountId, tier, this.controller.signal, current)
    this.pendingQuote = quoted.pending
    this.commerce = quoted.commerce
    return quoted.commerce
  }

  /**
   * Pay the quote last shown to this account.
   * @returns The commerce view after the purchase attempt.
   */
  async buyPlan(): Promise<AccountCommerce> {
    const accountId = this.value.account?.id
    const pending = this.pendingQuote
    const current = this.commerce
    if (accountId === undefined || pending === null || pending.accountId !== accountId || current === null) throw new AccountFailure('invalid-input')
    const access = await this.access()
    const bought = await buyCommerce(this.protocol, access, pending, this.controller.signal, current)
    this.pendingQuote = bought.pending
    this.commerce = bought.commerce
    return bought.commerce
  }

  /**
   * Open an Alipay recharge for a yuan amount. The browser submits the returned page.
   * @param amount - Yuan amount entered by the user.
   * @returns The original order and signed cashier fields, or a safe recovery state.
   */
  async startRecharge(amount: string, idempotencyKey: string, replay: boolean): Promise<AccountAlipayStart> {
    const accountId = this.value.account?.id
    if (accountId === undefined) throw new AccountFailure('auth-required')
    const signal = this.controller.signal
    const access = await this.access()
    if (signal.aborted || this.value.account?.id !== accountId) throw new AccountFailure('cancelled')
    if (replay && !(await readWechatChannel(this.protocol, access, signal)).rechargeIdempotency) {
      return { kind: 'rejected' }
    }
    if (signal.aborted || this.value.account?.id !== accountId) throw new AccountFailure('cancelled')
    return rechargeCommerce(this.protocol, access, accountId,
      rechargeAmount(amount), idempotencyKey, signal)
  }
}
