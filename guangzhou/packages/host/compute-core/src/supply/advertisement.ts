/** Advertisement channel for deployment-declared endpoints; connection state and acknowledgement are never invented. */
import { requestJson, validateTransportOptions, type JsonTransportOptions } from './http.ts'
import { SupplyError } from './policy.ts'
import type { LocalSupplyService, SupplyAdvertisementPort } from './types.ts'

/** Wire version this port sends; an endpoint that does not answer it fails the exchange instead of advertising. */
export const SUPPLY_ADVERTISEMENT_VERSION = 'qianshou.supply.advertisement.v1'

/** Honest channel states: a profile without an endpoint is never reported as a transient outage, and vice versa. */
export type SupplyAdvertisementLinkState = 'not-configured' | 'unauthenticated' | 'ready' | 'failed'

/** Stable code for every rejection that means "no channel carried this publication". */
export const ADVERTISEMENT_TRANSPORT_UNAVAILABLE = 'ADVERTISEMENT_TRANSPORT_UNAVAILABLE'

/** Stable code for a server answer that does not carry the acknowledgement shape this port requires. */
export const ADVERTISEMENT_RESPONSE_INVALID = 'ADVERTISEMENT_RESPONSE_INVALID'

/** Rejection that names both the stable code and the observed channel state.
 * A caller can therefore tell "this deployment declared no endpoint" apart from "a declared channel failed"
 * without reading private transport details.
 */
export class SupplyAdvertisementError extends SupplyError {
  /** Bind one stable public code to the channel state that produced it.
   * @param code - Stable public code from this module.
   * @param state - Channel state observed when the exchange was rejected.
   */
  constructor(code: string, readonly state: SupplyAdvertisementLinkState) { super(code); this.name = 'SupplyAdvertisementError' }
}

/** Deployment-owned advertisement endpoint plus the host credential that authenticates to it. */
export interface HttpSupplyAdvertisementOptions extends JsonTransportOptions {
  /** Absolute endpoint owned by the deployment; empty or null means this profile advertises nothing. */
  readonly endpoint: string | null
  /** Existing host credential source; a missing value is reported as unauthenticated and never guessed. */
  readonly tokenProvider: () => string | undefined
}

/** One capability offer as the advertisement endpoint receives it; no local path, rate or secret is included. */
interface AdvertisementCapability {
  readonly id: string
  readonly kind: 'tool' | 'local-model'
  readonly name: string
  readonly version: string | null
}

/** HTTP advertisement channel for one deployment endpoint.
 *
 * The port is always constructed, so the controller reaches a real transport instead of a missing port. With no
 * endpoint declared it reports `not-configured`, `connected()` is false, and every exchange rejects with
 * {@link ADVERTISEMENT_TRANSPORT_UNAVAILABLE} — no caller can mistake it for a successful publication. With an
 * endpoint declared it performs one bounded authenticated request per replacement and returns only the identifiers
 * the server acknowledged. A declared channel that fails is state `failed` while remaining connected, so the next
 * observation retries instead of silently giving up.
 */
export class HttpSupplyAdvertisementPort implements SupplyAdvertisementPort {
  private readonly endpoint: URL | null
  private failure: string | null = null
  /** Validate the deployment endpoint and bound the transport; no request occurs here.
   * @param options - Endpoint, credential source and transport limits.
   */
  constructor(private readonly options: HttpSupplyAdvertisementOptions) {
    validateTransportOptions(options)
    this.endpoint = options.endpoint === null || options.endpoint === '' ? null : advertisementEndpoint(options.endpoint)
  }
  /** Whether a real exchange can be attempted now: an endpoint is declared and a credential is currently available.
   * @returns True only when this port will attempt a real authenticated request.
   */
  connected(): boolean { return this.endpoint !== null && this.credential() !== undefined }
  /** Diagnose the channel without performing a request.
   * @returns Configuration state, credential state, or the outcome of the last real exchange.
   */
  linkState(): SupplyAdvertisementLinkState {
    if (this.endpoint === null) return 'not-configured'
    if (this.credential() === undefined) return 'unauthenticated'
    return this.failure === null ? 'ready' : 'failed'
  }
  /** Report why the most recent exchange failed.
   * @returns The stable code of that failure, or null when no exchange has failed.
   */
  lastFailureCode(): string | null { return this.failure }
  /** Replace the advertised services through one authenticated request.
   * @param services - Verified local services the owner enabled for contribution.
   * @param signal - Caller cancellation.
   * @returns Only the service identifiers the endpoint acknowledged.
   */
  publish(services: readonly LocalSupplyService[], signal: AbortSignal): Promise<readonly string[]> {
    return this.exchange(services.map(service => ({ id: service.id, kind: service.kind,
      name: service.name, version: service.version })), signal)
  }
  /** Withdraw future offers by replacing the advertised set with an empty one.
   * @param signal - Caller cancellation.
   * @returns Resolves only after the endpoint acknowledged the empty set.
   */
  async withdraw(signal: AbortSignal): Promise<void> { await this.exchange([], signal) }
  private credential(): string | undefined {
    let token: string | undefined
    try { token = this.options.tokenProvider() } catch { return undefined }
    if (typeof token !== 'string') return undefined
    const value = token.trim()
    return value.length > 0 && value.length <= 4096 && !/[\r\n]/.test(value) ? value : undefined
  }
  private async exchange(capabilities: readonly AdvertisementCapability[], signal: AbortSignal): Promise<readonly string[]> {
    const endpoint = this.endpoint
    if (endpoint === null) throw new SupplyAdvertisementError(ADVERTISEMENT_TRANSPORT_UNAVAILABLE, 'not-configured')
    const token = this.credential()
    if (token === undefined) throw new SupplyAdvertisementError(ADVERTISEMENT_TRANSPORT_UNAVAILABLE, 'unauthenticated')
    try {
      const value = await requestJson(endpoint, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ version: SUPPLY_ADVERTISEMENT_VERSION, capabilities }) }, this.options, signal)
      const accepted = parseAcknowledgement(value, capabilities)
      this.failure = null
      return accepted
    } catch (error) {
      if (error instanceof SupplyError && error.code === 'SUPPLY_ABORTED') throw error
      this.failure = error instanceof SupplyError ? error.code : ADVERTISEMENT_TRANSPORT_UNAVAILABLE
      if (error instanceof SupplyAdvertisementError) throw error
      throw new SupplyAdvertisementError(ADVERTISEMENT_TRANSPORT_UNAVAILABLE, 'failed')
    }
  }
}

/** Require a bounded endpoint owned by the deployment: HTTPS, or literal-loopback HTTP for local test endpoints.
 * @param value - Endpoint from trusted Host configuration.
 * @returns The validated endpoint URL.
 */
function advertisementEndpoint(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new SupplyError('SUPPLY_CONFIG_INVALID') }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.username || url.password || url.search || url.hash || url.pathname.length > 512
    || !/^\/(?:[\w.~@%-]+\/)*[\w.~@%-]*$/.test(url.pathname)
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw new SupplyError('SUPPLY_CONFIG_INVALID')
  return url
}

/** Adopt only identifiers the endpoint explicitly acknowledged from the set this port sent.
 * @param value - Untrusted decoded JSON response.
 * @param capabilities - Exact set sent in this exchange.
 * @returns Frozen acknowledged identifiers in server order.
 */
function parseAcknowledgement(value: unknown, capabilities: readonly AdvertisementCapability[]): readonly string[] {
  if (!object(value) || value.ok !== true || !Array.isArray(value.accepted) || value.accepted.length > 128) invalid()
  const offered = new Set(capabilities.map(capability => capability.id))
  const accepted: string[] = []
  for (const id of value.accepted) {
    if (typeof id !== 'string' || !offered.has(id) || accepted.includes(id)) invalid()
    accepted.push(id)
  }
  return Object.freeze(accepted)
}

/** Fail closed on any acknowledgement that could be read as a success this port did not verify. */
function invalid(): never { throw new SupplyAdvertisementError(ADVERTISEMENT_RESPONSE_INVALID, 'failed') }

/** Narrow one decoded JSON value to a plain object.
 * @param value - Untrusted decoded JSON value.
 * @returns Whether the value is a non-array object.
 */
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
