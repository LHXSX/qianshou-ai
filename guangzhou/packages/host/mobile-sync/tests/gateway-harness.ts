/**
 * Real-composition harness for the PC session gateway.
 *
 * Every request travels through a real `node:http` socket into the real webserver
 * plugin, through the real Connection carrier and its Host fence and browser
 * authentication, into the gateway routes, the real file-backed command log and the
 * real gateway service. Only the PC's Session authority is a configured double,
 * because this package must not embed a second Session implementation; the double
 * records exactly what the gateway asked it to do and can be told to fail, so the
 * gateway's delivery claims stay falsifiable.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { ConnectionIndexRequest, ConnectionIndexResponse } from '@deepseek-ai/dsh-client-connection'
import { apply as applyConnection } from '@deepseek-ai/dsh-client-connection'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import { PcWindowGateway } from '../src/gateway/service.ts'
import { PcWindowStore, originKey } from '../src/gateway/store.ts'
import { registerGatewayRoutes } from '../src/gateway/routes.ts'
import { MobileSyncError } from '../src/errors.ts'
import type { SessionCommandPort, WindowBinding, WindowCommand } from '../src/gateway/types.ts'

/** Mutable credential record double; never holds a secret. */
class RecordCredentials {
  record: CredentialRecord | undefined
  readRecord(): Promise<CredentialRecord | undefined> { return Promise.resolve(this.record) }
  async modifyRecord(
    _key: unknown,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const next = await mutate(this.record)
    if (next !== undefined) this.record = next
    return this.record
  }
  deleteRecord(): Promise<void> { this.record = undefined; return Promise.resolve() }
}

/** One real PC Session authority the gateway talks to, with observable effects. */
export interface SessionDouble extends SessionCommandPort {
  /** Every mutation the gateway actually asked the Session authority to perform. */
  readonly calls: readonly { readonly kind: string; readonly requestId: string; readonly sessionId: string }[]
  /** Request ids the authority actually admitted, read live from its own log. */
  readonly admitted: () => readonly string[]
  /** Make the next mutation attempt fail without admitting anything. */
  readonly failNext: () => void
  /**
   * Model a lost answer: the authority's durable log already holds the request id,
   * so a later `alreadyAccepted` observation reports it even though the mutation
   * call itself never returned.
   */
  readonly reportAdmittedInLog: (value: boolean) => void
  /** Report the Session authority as absent, as an unmounted controller does. */
  readonly setAvailable: (value: boolean) => void
  /** Forget every recorded call, for restart-style counting. */
  readonly reset: () => void
}

/** Build the Session authority double. */
export function createSessionDouble(): SessionDouble {
  const calls: { kind: string; requestId: string; sessionId: string }[] = []
  const log = new Set<string>()
  let available = true
  let failing = false
  let inLog = false
  const deny = (): never => { throw new MobileSyncError('PC_WINDOW_SESSION_UNAVAILABLE', 503) }
  const admit = (kind: string, binding: WindowBinding, command: WindowCommand): void => {
    calls.push({ kind, requestId: command.requestId, sessionId: binding.sessionId })
    if (failing) deny()
    log.add(command.requestId)
  }
  return {
    calls,
    admitted: () => [...log],
    available: () => available,
    alreadyAccepted: (_binding, requestId) => Promise.resolve(log.has(requestId) || inLog),
    dispatch: (binding, command) => { admit('dispatch', binding, command); return Promise.resolve() },
    append: (binding, command) => { admit('append', binding, command); return Promise.resolve() },
    cancel: (binding, command) => {
      calls.push({ kind: 'cancel', requestId: command.requestId, sessionId: binding.sessionId })
      if (failing) deny()
      return Promise.resolve()
    },
    failNext: () => { failing = true },
    reportAdmittedInLog: (value) => { inLog = value },
    setAvailable: (value) => { available = value },
    reset: () => { calls.splice(0); failing = false; inLog = false },
  }
}

/** One live gateway host: real listening server, real routes, real durable file. */
export interface GatewayHarness {
  /** Loopback origin the server is actually listening on. */
  readonly origin: string
  /** Process-token-derived browser cookie for the authenticated cases. */
  readonly cookie: string
  /** Temporary DSH home holding the gateway's durable command file. */
  readonly home: string
  /** Absolute path of the durable command file this host is using. */
  readonly windowPath: string
  /** The real gateway the routes call. */
  readonly gateway: PcWindowGateway
  /** The Session authority this gateway talks to. */
  readonly session: SessionDouble
  /** Perform one real HTTP request over the loopback socket. */
  readonly post: (path: string, body: unknown, options?: HarnessRequestOptions) => Promise<HarnessResponse>
  /** Read the raw durable file, so assertions never depend on an in-memory copy. */
  readonly durable: () => Promise<string>
  readonly dispose: () => Promise<void>
}

/** Extra request metadata a harness call may set; both are host-owned. */
interface HarnessRequestOptions {
  readonly cookie?: string | undefined
  readonly host?: string
}

/** One decoded loopback response. */
interface HarnessResponse {
  readonly status: number
  readonly body: unknown
}

/** The connection authority the harness needs to mint a cookie. */
interface HarnessAuthority {
  readonly authenticatedUrl: (base: string) => string
  readonly authorizeIndex: (index: ConnectionIndexRequest, response: ConnectionIndexResponse) => boolean
}

/** Harness configuration. */
export interface GatewayHarnessConfig {
  /** Reuse an existing durable file so a restart is observable. */
  readonly home?: string
  /** Pause the Session authority, letting a command be caught mid-flight. */
  readonly gateSession?: boolean
  /**
   * 引导（配对）闸门的桩。
   *
   * 默认**一律拒绝**：这个脚手架服务的是 pc-window 往返测试，与配对无关；
   * 默认放开等于让测试里的"任何页面都能给自己发一个绑定"变成正常行为，
   * 而「手机不能自己授权自己」正是配对闸门要挡的事。
   * 要测引导的用例显式传一个放行的实现。
   */
  readonly pairing?: {
    readonly redeem?: (ticket: string, source: string) => { readonly ok: boolean; readonly reason?: string }
    readonly accountId?: () => Promise<string | null>
  }
}

/** Boot a real webserver + Connection carrier and mount the gateway routes.
 * @param config - Optional existing home directory and Session gating.
 * @returns A live harness; call `dispose` to close the server.
 */
export async function startGatewayHarness(config: GatewayHarnessConfig = {}): Promise<GatewayHarness> {
  const home = config.home ?? await mkdtemp(join(tmpdir(), 'dsh-pc-window-'))
  const context = new Context()
  context.provide('credentials', new RecordCredentials() as unknown as CredentialProvider)
  const server = await context.plugin(HttpServer, { host: '127.0.0.1', port: 0 })
  await server.await()
  const webServer = context.get('webServer') as { port: number } | undefined
  if (webServer === undefined || !webServer.port) throw new Error('harness: web server did not publish a port')
  const connection = await context.plugin(applyConnection, { trustedHosts: [], cookieMaxAgeDays: 1 })
  await connection.await()

  const windowPath = join(home, 'pc-window.json')
  const store = new PcWindowStore({ path: windowPath, maxBindings: 100, maxCommands: 1000, maxBytes: 8_388_608 })
  const session = createSessionDouble()
  const port: SessionCommandPort = config.gateSession === true ? gatedPort(session, home) : session
  const gateway = new PcWindowGateway(store, port)
  const plugin = await context.plugin({
    inject: ['connection'],
    apply: (pluginCtx) => {
      pluginCtx.effect(() => () => { gateway.close(); void store.close() }, 'harness: drain pc-window writes')
      registerGatewayRoutes(pluginCtx, gateway, 65536, {
        // 默认拒绝配对：这个脚手架不测引导，默认放开会把"自己给自己发绑定"变成正常行为。
        redeem: config.pairing?.redeem ?? (() => ({ ok: false, reason: 'harness: 配对默认关闭' })),
        accountId: config.pairing?.accountId ?? (async () => null),
        pcId: () => 'harness-pc',
        sessionId: () => null,
      })
    },
  })
  await plugin.await()
  const origin = `http://127.0.0.1:${String(webServer.port)}`
  const auth = context.get('connection') as {
    authenticatedUrl: (base: string) => string
    authorizeIndex: (index: ConnectionIndexRequest, response: ConnectionIndexResponse) => boolean
  }
  const cookie = await exchangeCookie(auth, origin)

  return {
    origin, cookie, home, windowPath, gateway, session,
    post: (path, body, options = {}) => realPost(webServer.port, path, body, options, cookie),
    durable: () => readFile(windowPath, 'utf8'),
    dispose: async () => { await context.fiber.dispose() },
  }
}

/** A Session authority that waits for a rendezvous file before answering a dispatch. */
function gatedPort(inner: SessionDouble, home: string): SessionCommandPort {
  const release = join(home, '.session-release')
  return {
    available: inner.available,
    alreadyAccepted: inner.alreadyAccepted,
    dispatch: async (binding, command) => {
      while (true) {
        try {
          await readFile(release, 'utf8')
          break
        } catch { await new Promise(resolve => setTimeout(resolve, 5)) }
      }
      await inner.dispatch(binding, command)
    },
    append: inner.append,
    cancel: inner.cancel,
  }
}

/** Tell a gated Session authority it may answer; the caller flips whatever it needs first. */
export async function releaseSession(home: string): Promise<void> {
  await writeFile(join(home, '.session-release'), 'go', 'utf8')
}

/** Pre-create one command's durable record in the given outcome, for crash-restart cases.
 * @param home - Harness home whose command file is written.
 * @param binding - Origin the seeded binding authorizes.
 * @param command - The exact command a retry will resend, so the replay path is what runs.
 * @param outcome - The interrupted outcome to persist (`attempting` models a crash mid-flight).
 */
export async function seedCommandRecord(
  home: string,
  binding: WindowBinding,
  command: WindowCommand,
  outcome: 'attempting' | 'pending',
): Promise<void> {
  const path = join(home, 'pc-window.json')
  const key = originKey(binding)
  const seededAt = Date.now()
  const file = {
    version: 1,
    bindings: {
      [key]: { key, binding, revision: 1, issuedSequence: 1, registeredAt: seededAt },
    },
    commands: {
      [command.requestId]: {
        requestId: command.requestId,
        key: `${key}#1`,
        command,
        sequence: 1,
        outcome,
        receipt: null,
        errorCode: null,
        updatedAt: seededAt,
      },
    },
  }
  await mkdir(home, { recursive: true })
  await writeFile(path, JSON.stringify(file), 'utf8')
}

/** Turn the one-time launch token into the persistent browser cookie the carrier accepts. */
async function exchangeCookie(auth: HarnessAuthority, origin: string): Promise<string> {
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

/** One real request over the loopback socket. */
function realPost(
  port: number,
  path: string,
  body: unknown,
  options: { cookie?: string | undefined; host?: string },
  defaultCookie: string,
): Promise<{ status: number; body: unknown }> {
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
    }, (response) => {
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

/** Remove one harness home, for tests that create their own. */
export async function removeHome(home: string): Promise<void> {
  await rm(home, { recursive: true, force: true })
}

/** Fresh temporary home path without creating it. */
export async function freshHome(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'dsh-pc-window-seed-')), randomUUID())
}
