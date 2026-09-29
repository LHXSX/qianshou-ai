/** Real-composition harness: the actual HTTP server, Connection carrier and browser auth. */
import { request as httpRequest } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { ConnectionIndexRequest, ConnectionIndexResponse } from '@deepseek-ai/dsh-client-connection'
import { apply as applyConnection } from '@deepseek-ai/dsh-client-connection'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import { apply as applyMobileSync, inject as mobileSyncInject, type Config as MobileSyncPluginConfig } from '../src/index.ts'
import { MobileSyncService } from '../src/service.ts'
import { MobileSyncStore } from '../src/store.ts'
import { registerRoutes } from '../src/routes.ts'

/** Mutable credential record double; the only double in this harness, and it never holds a secret. */
class RecordCredentials {
  record: CredentialRecord | undefined
  readRecord(): Promise<CredentialRecord | undefined> { return Promise.resolve(this.record) }
  async modifyRecord(_key: unknown, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>): Promise<CredentialRecord | undefined> {
    const next = await mutate(this.record)
    if (next !== undefined) this.record = next
    return this.record
  }
  deleteRecord(): Promise<void> { this.record = undefined; return Promise.resolve() }
}

/** One live host: real listening server, real carrier routes, real cookie authentication. */
export interface Harness {
  /** Loopback origin the server is actually listening on, e.g. `http://127.0.0.1:54321`. */
  readonly origin: string
  /** Process-token-derived browser cookie for the authenticated cases. */
  readonly cookie: string
  /** Perform one real HTTP request over the loopback socket. */
  readonly post: (path: string, body: unknown, options?: { cookie?: string | undefined; host?: string }) => Promise<{ status: number; body: unknown }>
  /** Temporary DSH home used as the sync store root. */
  readonly home: string
  /** Move the injected clock so a cursor lifetime boundary is exercised without waiting. */
  readonly setClock: (now: () => number) => void
  readonly dispose: () => Promise<void>
}

/** Plugin configuration plus the test-only clock override. */
export type HarnessConfig = Partial<MobileSyncPluginConfig> & { readonly clock?: () => number }

/** Boot the real webserver + Connection carrier and mount this package's own routes.
 *
 * Without `clock`, the real plugin entry `apply` runs, so the shipped configuration path
 * is what the test exercises. With `clock`, the same store, service and route registration
 * are wired directly so cursor expiry is deterministic instead of time-dependent.
 * @param config - Plugin configuration; `statePath` is filled from a fresh temporary home.
 * @returns A live harness; call `dispose` to close the server and remove the temporary home.
 */
export async function startHarness(config: HarnessConfig = {}): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-mobile-sync-'))
  const context = new Context()
  context.provide('credentials', new RecordCredentials() as unknown as CredentialProvider)
  const server = await context.plugin(HttpServer, { host: '127.0.0.1', port: 0 })
  await server.await()
  const webServer = context.get('webServer') as { port: number } | undefined
  if (webServer === undefined || !webServer.port) throw new Error('harness: web server did not publish a port')
  const connection = await context.plugin(applyConnection, { trustedHosts: [], cookieMaxAgeDays: 1 })
  await connection.await()
  const statePath = config.statePath ?? join(home, 'mobile-sync.json')
  let clock = config.clock ?? (() => Date.now())
  if (config.clock === undefined) {
    const sync = await context.plugin({ apply: applyMobileSync, inject: [...mobileSyncInject] }, { ...config, statePath })
    await sync.await()
  } else {
    const store = new MobileSyncStore({ path: statePath, maxRecords: config.maxRecords ?? 10000, maxBytes: config.maxStoreBytes ?? 4194304 })
    const service = new MobileSyncService(store, { cursorMaxAgeMs: config.cursorMaxAgeMs ?? 86400000, now: () => clock() })
    const sync = await context.plugin({
      inject: [...mobileSyncInject],
      apply: (pluginCtx) => { pluginCtx.effect(() => () => void store.close(), 'harness: drain store'); registerRoutes(pluginCtx, service, config.maxRequestBytes ?? 65536) },
    })
    await sync.await()
  }
  const origin = `http://127.0.0.1:${String(webServer.port)}`

  const auth = context.get('connection') as {
    authenticatedUrl: (base: string) => string
    authorizeIndex: (index: ConnectionIndexRequest, response: ConnectionIndexResponse) => boolean
  }
  const cookie = await exchangeCookie(auth, origin)

  return {
    origin, cookie, home,
    post: (path, body, options = {}) => realPost(webServer.port, path, body, options, cookie),
    setClock: (now) => { clock = now },
    dispose: async () => {
      await context.fiber.dispose()
      await rm(home, { recursive: true, force: true })
    },
  }
}

/** Turn the one-time launch token into the persistent browser cookie the carrier accepts.
 *
 * `authorizeIndex` answers `false` on success: the token exchange is a redirect that
 * mints the cookie, so the cookie header — not the return value — is the evidence.
 */
async function exchangeCookie(
  auth: { authenticatedUrl: (base: string) => string; authorizeIndex: (index: ConnectionIndexRequest, response: ConnectionIndexResponse) => boolean },
  origin: string,
): Promise<string> {
  const url = new URL(auth.authenticatedUrl(origin))
  const state: { status?: number | undefined; headers?: Readonly<Record<string, string>> | undefined } = {}
  auth.authorizeIndex(
    { method: 'GET', url: `${url.pathname}${url.search}`, headers: { host: new URL(origin).host } },
    {
      writeHead(status: number, headers?: Readonly<Record<string, string>>) { state.status = status; state.headers = headers },
      end() {},
    },
  )
  const setCookie = state.headers?.['set-cookie']
  if (state.status !== 303 || setCookie === undefined) throw new Error('harness: browser token exchange did not issue a cookie')
  return setCookie.split(';', 1)[0]!
}

/** One real request over the loopback socket; `host` may spoof the authority like a LAN client.
 *
 * Omitting `cookie` deliberately sends the authenticated cookie; passing `cookie: undefined`
 * explicitly sends no cookie at all, which is how the unauthenticated cases stay honest.
 */
function realPost(port: number, path: string, body: unknown, options: { cookie?: string | undefined; host?: string }, defaultCookie: string): Promise<{ status: number; body: unknown }> {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  const cookie = Object.hasOwn(options, 'cookie') ? options.cookie : defaultCookie
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: {
        host: options.host ?? `127.0.0.1:${String(port)}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'sec-fetch-site': 'same-origin',
        ...(cookie === undefined ? {} : { cookie }),
      },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed: unknown = text
        try { parsed = JSON.parse(text) } catch { /* Non-JSON bodies stay as text for the assertion. */ }
        resolve({ status: response.statusCode ?? 0, body: parsed })
      })
    })
    request.on('error', reject)
    request.end(payload)
  })
}
