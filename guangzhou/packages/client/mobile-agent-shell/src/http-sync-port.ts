/** Real HTTP sync transport for the mobile shell; carries no model key or task payload. */
import type { MobileCapabilityHeartbeat, MobileSyncRequest } from '@deepseek-ai/dsh-host-platform-observability-contract'

/** One sync transport method the shell calls; declared here to avoid an import cycle. */
interface MobileSyncTransport {
  readonly sync: (request: MobileSyncRequest, heartbeat: MobileCapabilityHeartbeat) => Promise<unknown>
}

/** Absolute path owned by the Host mobile sync plugin. */
export const MOBILE_SYNC_PATH = '/api/qianshou/mobile/sync'

/** Transport request accepted by the Host route: one cursor page plus its heartbeat. */
export interface MobileSyncWireRequest {
  readonly request: MobileSyncRequest
  readonly heartbeat: MobileCapabilityHeartbeat
}

/** Options for the authenticated browser transport. */
export interface MobileHttpSyncPortOptions {
  /** Origin of the running Host, e.g. `http://127.0.0.1:3081`. */
  readonly origin: string
  /** Route override for deployments that mount the plugin elsewhere. */
  readonly path?: string
  /**
   * Explicit `Cookie` header for a Node client that has no cookie jar.
   *
   * A real browser must leave this unset: `credentials: 'same-origin'` makes the
   * browser attach its own session cookie, and a page cannot read or forge that
   * cookie. A Node test client has no jar, so without this injection the carrier
   * correctly refuses the request as unauthenticated.
   */
  readonly cookie?: string
  /** Fetch implementation; defaults to the embedding realm's `fetch`. */
  readonly fetch?: typeof globalThis.fetch
}

/** Perform one authenticated sync call against the Host route.
 *
 * The transport sends the browser's own cookie session (`credentials: 'same-origin'`)
 * and never carries a token in the body, so the carrier's Host fence and browser
 * authentication stay the only authority. A non-2xx response is surfaced as an error
 * carrying the server's code instead of being turned into a fabricated acknowledgement.
 * @param options - Host origin, optional route override, optional explicit cookie and optional fetch.
 * @returns A sync port the shell can be constructed with.
 */
export function createMobileHttpSyncPort(options: MobileHttpSyncPortOptions): MobileSyncTransport {
  const target = new URL(options.path ?? MOBILE_SYNC_PATH, options.origin).href
  const send = options.fetch ?? globalThis.fetch
  return {
    sync: async (request, heartbeat) => {
      const response = await send(target, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        },
        body: JSON.stringify({ request, heartbeat } satisfies MobileSyncWireRequest),
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`MOBILE_SYNC_HTTP_${String(response.status)}${errorCode(text)}`)
      return JSON.parse(text) as unknown
    },
  }
}

function errorCode(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      const failure = (parsed as { error?: unknown }).error
      if (typeof failure === 'object' && failure !== null && 'code' in failure) {
        return `_${String((failure as { code?: unknown }).code)}`
      }
    }
  } catch { /* A non-JSON error body contributes no code. */ }
  return ''
}
