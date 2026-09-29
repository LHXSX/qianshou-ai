/** Lifetime, admission single-flight and grant revocation over the bounded store. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConnectStore } from './store.ts'
import { digest } from './store.ts'
import type { ConnectSessionPort } from './session-port.ts'
import { ConnectFailure, parseGrant } from './validation.ts'
import { PHONE_TURN_BYTE_LIMIT, projectConnectionPage, VIEW_TURN_BYTE_LIMIT } from './projection.ts'
import type { ConnectionGrantCreated, ConnectionGrantInput, ConnectionOwnerState, ConnectionPage, ConnectionReceipt } from './types.ts'

/** Request coordinator; cancellation before admission never creates a replacement Agent loop. */
export class ConnectService {
  private readonly lifetime = new AbortController()
  private readonly active = new Map<AbortController, string>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly sending = new Map<string, { hash: string; promise: Promise<ConnectionReceipt> }>()
  constructor(private readonly store: ConnectStore, private readonly port: ConnectSessionPort, private readonly maxRequests: number,
    private readonly timeoutMs: number, private readonly now: () => number = Date.now) {}
  private live(): void { if (this.lifetime.signal.aborted) throw new ConnectFailure('closed', 503) }
  /**
   * Reject invalid or no-longer-valid grants before reading an upload.
   * @param token - Untrusted narrow bearer.
   * @param deviceId - Device the request presents, when it presents one.
   */
  authorize(token: string, deviceId?: string): void { this.live(); this.store.authorize(token, this.now(), deviceId) }
  /**
   * Read owner grants for one selected Session.
   * @param sessionId - Exact Session selected by the owner.
   * @param origin - Configured reachable origin, never inferred from a request header.
   * @returns Current non-secret grant state.
   */
  state(sessionId: SessionId, origin: string): ConnectionOwnerState { this.live(); return { grants: this.store.list(sessionId), available: true, owner: 'local-device', origin, maxDurationMinutes: 1440 } }
  /**
   * Inspect a real ordinary Session before granting any access.
   * @param value - Explicit owner choice.
   * @returns Grant and one-time-returned secret link.
   */
  create(value: ConnectionGrantInput): Promise<ConnectionGrantCreated> {
    this.live()
    const input = parseGrant(value)
    return this.run('', async (signal) => { await this.port.inspect(input.sessionId, signal); this.live(); signal.throwIfAborted(); return this.store.create(input, this.now()) })
  }
  /**
   * Revoke the selected authorization and abort its in-flight observations/admissions.
   * @param sessionId - Owner's selected Session fence.
   * @param grantId - Authorization to revoke.
   */
  revoke(sessionId: SessionId, grantId: string): void {
    this.live(); if (!this.store.revoke(sessionId, grantId)) return
    for (const [controller, id] of this.active) if (id === grantId) controller.abort(new ConnectFailure('revoked', 403))
  }
  /**
   * Read a bounded increment of the granted Session's committed text.
   * @param token - Narrow bearer, never an owner cookie.
   * @param cursor - Last successful projection cursor.
   * @param signal - HTTP request lifetime.
   * @param deviceId - Device the request presents, when it presents one.
   * @returns Safe text page.
   */
  read(token: string, cursor: string | null, signal: AbortSignal, deviceId?: string): Promise<ConnectionPage> {
    this.live(); const grant = this.store.authorize(token, this.now(), deviceId)
    return this.run(grant.id, async (combined) => {
      const snapshot = await this.port.inspect(grant.sessionId, combined)
      combined.throwIfAborted(); this.store.authorize(token, this.now(), deviceId)
      // A request that names a device is the phone transport, whose parser rejects
      // an over-long turn instead of truncating it; the browser view keeps its own limit.
      const page = projectConnectionPage(grant, snapshot.events, cursor, snapshot.running,
        deviceId === undefined ? VIEW_TURN_BYTE_LIMIT : PHONE_TURN_BYTE_LIMIT)
      this.store.touch(grant.id, this.now()); return page
    }, signal)
  }
  /**
   * Submit or reconcile one stable text command without automatic re-execution.
   * @param token - Narrow bearer.
   * @param requestId - Client-created stable id retained on retries.
   * @param text - Bounded plain text.
   * @param signal - HTTP request lifetime.
   * @param deviceId - Device the request presents, when it presents one.
   * @returns Admission receipt, distinct from a task result.
   */
  send(token: string, requestId: string, text: string, signal: AbortSignal, deviceId?: string): Promise<ConnectionReceipt> {
    this.live(); const grant = this.store.authorize(token, this.now(), deviceId)
    if (grant.mode !== 'text') throw new ConnectFailure('read-only', 403)
    const key = `${grant.id}:${requestId}`, hash = digest(text), active = this.sending.get(key)
    if (active) { if (active.hash !== hash) throw new ConnectFailure('conflict', 409); return active.promise }
    const promise = this.run(grant.id, async (combined) => {
      const existing = this.store.receipt(grant.id, requestId)
      const receipt = this.store.claim(grant.id, requestId, text)
      const check = (): void => { combined.throwIfAborted(); this.live(); this.store.authorize(token, this.now(), deviceId) }
      if (existing) {
        if (receipt.state === 'received') return publicReceipt(receipt)
        if (!await this.port.admitted(grant.sessionId, receipt.rpcId, combined)) return publicReceipt(receipt)
      } else {
        check()
        await this.port.submit(grant.sessionId, receipt.rpcId, text, combined, check)
      }
      return this.store.received(grant.id, requestId, this.now())
    }, signal).catch((error: unknown) => {
      const receipt = this.store.receipt(grant.id, requestId)
      if (receipt && receipt.bodyHash === hash && !(error instanceof ConnectFailure && error.code === 'conflict')) return publicReceipt(receipt)
      throw error
    }).finally(() => { if (this.sending.get(key)?.promise === promise) this.sending.delete(key) })
    this.sending.set(key, { hash, promise }); return promise
  }
  /**
   * Query and reconcile a previously claimed command without dispatching it.
   * @param token - Narrow bearer.
   * @param requestId - Client request id.
   * @param signal - HTTP request lifetime.
   * @param deviceId - Device the request presents, when it presents one.
   * @returns Receipt or explicit never-claimed rejection.
   */
  receipt(token: string, requestId: string, signal: AbortSignal, deviceId?: string): Promise<ConnectionReceipt> {
    this.live(); const grant = this.store.authorize(token, this.now(), deviceId)
    return this.run(grant.id, async (combined) => {
      const receipt = this.store.receipt(grant.id, requestId)
      if (!receipt) return { requestId, state: 'rejected', acceptedAt: null }
      if (receipt.state === 'uncertain' && await this.port.admitted(grant.sessionId, receipt.rpcId, combined)) {
        combined.throwIfAborted(); this.store.authorize(token, this.now(), deviceId)
        return this.store.received(grant.id, requestId, this.now())
      }
      return publicReceipt(receipt)
    }, signal)
  }
  private run<T>(grantId: string, operation: (signal: AbortSignal) => Promise<T>, outer?: AbortSignal): Promise<T> {
    this.live()
    if (this.active.size >= this.maxRequests) throw new ConnectFailure('capacity', 429)
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort(new ConnectFailure('timeout', 504)) }, this.timeoutMs)
    timer.unref()
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal, ...(outer ? [outer] : [])])
    this.active.set(controller, grantId)
    const promise = Promise.resolve().then(() => { signal.throwIfAborted(); return operation(signal) }).finally(() => {
      clearTimeout(timer); this.active.delete(controller); this.pending.delete(promise)
    })
    this.pending.add(promise); return promise
  }
  /** Reject new operations, abort current work and wait until it can no longer touch the store. */
  async dispose(): Promise<void> {
    this.lifetime.abort(new ConnectFailure('closed', 503))
    await Promise.allSettled([...this.pending, ...[...this.sending.values()].map(value => value.promise)])
    this.store.close()
  }
}
function publicReceipt(value: ConnectionReceipt): ConnectionReceipt {
  return { requestId: value.requestId, state: value.state, acceptedAt: value.acceptedAt }
}
