/**
 * Outbound long-poll link from this PC to the relay. The PC registers `{ pcId, accountId }`, polls for forwarded
 * phone requests, answers each by id and unregisters on sign-out. Every request carries the account bearer read
 * from Host credentials at call time. A redelivered request id after a lost reply returns the cached reply, so a
 * reconnect never executes an already answered submission again.
 */
import { MobileSyncFailure } from './failure.ts'
import type { RegistrationState, RelayReply, RelayRequest } from './types.ts'
import { isOpaqueId, parseRelayRequest, record } from './validation.ts'

/** Protocol name sent at registration so the relay can refuse an incompatible PC build. */
export const PC_LINK_PROTOCOL = 'qianshou.mobile-pc.pc-link.v1'
const MAX_BATCH = 64
const MAX_REPLY_BYTES = 1024 * 1024

/** Deployment limits and Host capabilities the link needs. */
export interface RelayLinkOptions {
  readonly relayUrl: string
  readonly pcId: string
  /** Account bearer resolved per request; `undefined` while signed out. */
  readonly credential: () => Promise<string | undefined>
  readonly handle: (request: RelayRequest) => Promise<RelayReply>
  readonly pollWaitMs: number
  readonly requestTimeoutMs: number
  readonly reconnectMinMs: number
  readonly reconnectMaxMs: number
  readonly replyCacheSize: number
  readonly fetch?: typeof fetch
  readonly now?: () => number
}
/** Non-secret link state. */
export interface RelayLinkStatus {
  readonly accountId: string | null
  readonly registration: RegistrationState
  readonly registeredAt: number | null
  readonly lastHeartbeatAt: number | null
  readonly lastFailure: string | null
}
interface Generation { readonly accountId: string; readonly controller: AbortController; leaseId: string | null; done: Promise<void> }

const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  /* v8 ignore next -- an already-aborted signal needs an abort between the loop's own liveness check and this call, with no await between them. */
  if (signal.aborted) { resolve(); return }
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
  const onAbort = (): void => { clearTimeout(timer); resolve() }
  signal.addEventListener('abort', onAbort, { once: true })
})

/** One PC's registration with the relay for exactly one signed-in account at a time. */
export class RelayLink {
  private generation: Generation | undefined
  private state: RegistrationState = 'signed-out'
  private registeredAt: number | null = null
  private lastHeartbeatAt: number | null = null
  private lastFailure: string | null = null
  private readonly replies = new Map<string, RelayReply>()
  private readonly now: () => number
  private readonly fetchImpl: typeof fetch
  constructor(private readonly options: RelayLinkOptions) {
    if (options.pollWaitMs >= options.requestTimeoutMs) throw new Error('qianshou-mobile-sync: pollWaitMs must be below requestTimeoutMs')
    this.now = options.now ?? Date.now
    this.fetchImpl = options.fetch ?? fetch
  }
  /**
   * Current non-secret link state.
   * @returns Registration state and heartbeat facts.
   */
  status(): RelayLinkStatus {
    return { accountId: this.generation?.accountId ?? null, registration: this.state, registeredAt: this.registeredAt,
      lastHeartbeatAt: this.lastHeartbeatAt, lastFailure: this.lastFailure }
  }
  /**
   * Register for one account; an earlier account's registration is unregistered first.
   * @param accountId - Signed-in account.
   */
  async start(accountId: string): Promise<void> {
    await this.stop('signed-out')
    const controller = new AbortController()
    const generation: Generation = { accountId, controller, leaseId: null, done: Promise.resolve() }
    this.generation = generation
    this.state = 'registering'
    generation.done = this.loop(generation)
  }
  /**
   * Leave the relay: abort polling, then unregister the current lease once with a fresh credential when one exists.
   * @param next - State to report afterwards.
   */
  async stop(next: RegistrationState = 'stopped'): Promise<void> {
    const generation = this.generation
    this.generation = undefined
    if (generation) {
      generation.controller.abort()
      await generation.done
      if (generation.leaseId !== null) {
        const signal = AbortSignal.timeout(this.options.requestTimeoutMs)
        try { await this.post('unregister', generation.accountId, { leaseId: generation.leaseId }, signal) }
        catch (error) { this.lastFailure = `unregister:${error instanceof MobileSyncFailure ? error.label() : 'PC_WINDOW_RELAY_UNAVAILABLE'}` }
      }
    }
    this.state = next
    this.registeredAt = null
  }
  private active(generation: Generation): boolean { return this.generation === generation && !generation.controller.signal.aborted }
  private async loop(generation: Generation): Promise<void> {
    const signal = generation.controller.signal
    let backoff = this.options.reconnectMinMs
    while (this.active(generation)) {
      try {
        this.state = 'registering'
        const registered = await this.post('register', generation.accountId, { protocol: PC_LINK_PROTOCOL }, signal)
        if (!isOpaqueId(registered.leaseId)) throw new MobileSyncFailure('RELAY_INVALID_REPLY')
        generation.leaseId = registered.leaseId
        this.state = 'registered'; this.registeredAt = this.now(); this.lastHeartbeatAt = this.now(); this.lastFailure = null
        backoff = this.options.reconnectMinMs
        while (this.active(generation)) {
          const polled = await this.post('poll', generation.accountId, { leaseId: generation.leaseId, waitMs: this.options.pollWaitMs }, signal)
          this.lastHeartbeatAt = this.now()
          const rows = polled.requests ?? []
          if (!Array.isArray(rows) || rows.length > MAX_BATCH) throw new MobileSyncFailure('RELAY_INVALID_REPLY')
          for (const row of rows) {
            const request = parseRelayRequest(row)
            if (request.accountId !== generation.accountId) throw new MobileSyncFailure('RELAY_INVALID_REPLY')
            const reply = await this.answer(request)
            if (!this.active(generation)) return
            await this.post('reply', generation.accountId, { leaseId: generation.leaseId, ...reply }, signal)
          }
        }
      } catch (error) {
        if (!this.active(generation)) return
        generation.leaseId = null
        this.state = 'disconnected'
        this.lastFailure = error instanceof MobileSyncFailure ? error.label() : 'PC_WINDOW_RELAY_UNAVAILABLE'
        await sleep(backoff, signal)
        backoff = Math.min(backoff * 2, this.options.reconnectMaxMs)
      }
    }
  }
  private async answer(request: RelayRequest): Promise<RelayReply> {
    const cached = this.replies.get(request.id)
    if (cached) return cached
    const reply = await this.options.handle(request)
    this.replies.set(request.id, reply)
    for (const oldest of this.replies.keys()) {
      if (this.replies.size <= this.options.replyCacheSize) break
      this.replies.delete(oldest)
    }
    return reply
  }
  private async post(path: 'register' | 'poll' | 'reply' | 'unregister', accountId: string, body: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const bearer = await this.options.credential()
    if (bearer === undefined) throw new MobileSyncFailure('CREDENTIAL_UNAVAILABLE')
    let response: Response
    try {
      response = await this.fetchImpl(`${this.options.relayUrl}/pc/${path}`, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.requestTimeoutMs)]),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ pcId: this.options.pcId, accountId, ...body }),
      })
    } catch (error) { if (signal.aborted) throw error; throw new MobileSyncFailure('RELAY_UNAVAILABLE') }
    const text = await response.text()
    if (Buffer.byteLength(text) > MAX_REPLY_BYTES) throw new MobileSyncFailure('RELAY_INVALID_REPLY')
    let parsed: unknown = {}
    if (text.length > 0) { try { parsed = JSON.parse(text) } catch { throw new MobileSyncFailure('RELAY_INVALID_REPLY') } }
    const data = record(parsed)
    if (!response.ok) {
      const code = record(data.error).code
      throw new MobileSyncFailure('RELAY_REJECTED', response.status, typeof code === 'string' && /^[A-Z0-9_]{1,96}$/u.test(code) ? code : String(response.status))
    }
    return data
  }
}
