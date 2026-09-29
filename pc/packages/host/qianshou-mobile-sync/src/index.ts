/* oxlint-disable typescript/require-await -- Owner Remote methods convert synchronous storage failures into rejected promises. */
/** PC-side session port for the Qianshou mobile relay: registration per signed-in account and phone command admission into original Sessions. */
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-host-qianshou-account'
import type {} from '@deepseek-ai/dsh-client-connection'
import { ACCOUNT_ACCESS_REF } from '@deepseek-ai/dsh-host-qianshou-account'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { AccountWatch } from './account-watch.ts'
import { MobileSyncFailure } from './failure.ts'
import { resolvePcId } from './pc-id.ts'
import type { ResolvedPcId } from './pc-id.ts'
import { WorkerPresence } from './presence.ts'
import { RelayLink } from './relay-link.ts'
import { PcWindowService } from './service.ts'
import { mobileSessionPort } from './session-port.ts'
import { MobileSyncStore } from './store.ts'
import type { MobileSyncStatus } from './types.ts'
import { registerPhoneWindowRoutes } from './window-http.ts'
export type * from './types.ts'

/** Relay reachability, identity and storage are deployment-owned choices. */
export interface Config {
  /**
   * Relay base for the PC link. Default: the Guangzhou gateway host used by qianshou-account (`gatewayBase`
   * origin, qianshou-account/src/index.ts) plus the mobile-PC relay prefix `MOBILE_PC_RELAY_PREFIX` from the old
   * relay (mobile-agent-gateway/src/pc-relay.ts). The `/pc/*` endpoints beneath it are this package's proposal and
   * are not yet served there.
   */
  relayUrl: string
  /** Explicit opaque PC id; empty uses the persisted id beneath DSH_HOME, generated once. */
  pcId: string
  /** Private identity file; empty resolves beneath DSH_HOME. */
  pcIdPath: string
  /** Dedicated binding/receipt database; empty resolves beneath DSH_HOME. */
  path: string
  /** Interval for reading the account snapshot; the account plugin publishes no change event. */
  accountPollMs: number
  /** Relay long-poll hold; must stay below `requestTimeoutMs`. */
  pollWaitMs: number
  /** Deadline for one relay HTTP request including the long-poll hold. */
  requestTimeoutMs: number
  /** First reconnect delay after a relay failure. */
  reconnectMinMs: number
  /** Reconnect delay ceiling. */
  reconnectMaxMs: number
  /** Replies retained by relay delivery id so a redelivery is answered without re-execution. */
  replyCacheSize: number
  /** Maximum retained bindings, including revoked bindings until reclaimed. */
  maxBindings: number
  /** Maximum retained idempotency receipts. */
  maxReceipts: number
  /** Maximum concurrent Session operations. */
  maxRequests: number
  /** Deadline for one Session operation. */
  sessionTimeoutMs: number
  /**
   * Serve the routes Guangzhou already calls, and publish this PC on the Shanghai
   * worker directory. The outbound long-poll stays off: that `/pc/*` API is not served.
   */
  serveInbound: boolean
  /** Shanghai account origin used to prove the phone token and to open the worker socket. */
  accountOrigin: string
  /** Public window origin stored on the worker. Empty selects the macOS or Windows origin for this process. */
  windowOrigin: string
}
declare module '@deepseek-ai/cordis' { interface Context { qianshouMobileSync: QianshouMobileSync } }

/** Host Remote exposing only whitelisted diagnostics; no method returns a token, lease or message text. */
export class QianshouMobileSync extends TypertRemoteService {
  static inject = ['sessions', 'agents', 'sessionController', 'credentials', 'qianshouAccount', 'connection']
  static Config: Schema<Config> = Schema.object({
    relayUrl: Schema.string().default('https://app.qianshousuanli.com/api/qianshou/mobile-pc/v1'),
    pcId: Schema.string().default(''), pcIdPath: Schema.string().default(''), path: Schema.string().default(''),
    accountPollMs: Schema.natural().min(250).max(60000).default(2000),
    pollWaitMs: Schema.natural().min(1000).max(60000).default(25000),
    requestTimeoutMs: Schema.natural().min(2000).max(120000).default(40000),
    reconnectMinMs: Schema.natural().min(100).max(60000).default(1000),
    reconnectMaxMs: Schema.natural().min(1000).max(600000).default(30000),
    replyCacheSize: Schema.natural().min(16).max(4096).default(256),
    maxBindings: Schema.natural().min(1).max(1000).default(100),
    maxReceipts: Schema.natural().min(1).max(100000).default(10000),
    maxRequests: Schema.natural().min(1).max(64).default(8),
    sessionTimeoutMs: Schema.natural().min(100).max(60000).default(15000),
    serveInbound: Schema.boolean().default(false),
    accountOrigin: Schema.string().default('https://qianshousuanli.com'),
    windowOrigin: Schema.string().default(''),
  })
  private identity: ResolvedPcId | undefined
  private service: PcWindowService | undefined
  private link: RelayLink | undefined
  private presence: WorkerPresence | undefined
  private watch: AccountWatch | undefined
  constructor(ctx: Context, private readonly config: Config) { super(ctx, 'qianshouMobileSync') }
  protected async [Service.init](): Promise<void> {
    if (this.config.pollWaitMs >= this.config.requestTimeoutMs) throw new Error('qianshou-mobile-sync: pollWaitMs must be below requestTimeoutMs')
    const lifetime: { disposed: boolean; opening?: Promise<MobileSyncStore> } = { disposed: false }
    this.ctx.effect(() => async () => {
      lifetime.disposed = true
      await this.watch?.stop(); this.watch = undefined
      await this.link?.stop(); this.link = undefined
      await this.presence?.stop('stopped'); this.presence = undefined
      const service = this.service; this.service = undefined
      if (service) await service.dispose()
      /* v8 ignore start -- the store arm: an unload landing between opening the database and publishing the service. */
      else (await lifetime.opening?.catch(() => undefined))?.close()
      /* v8 ignore stop */
    }, 'qianshou-mobile-sync: lifetime')
    const home = process.env.DSH_HOME ?? join(homedir(), '.deepseek-harness')
    const root = join(home, 'qianshou', 'mobile-sync')
    const pcIdPath = this.config.pcIdPath || join(root, 'pc-id.json')
    this.identity = await resolvePcId(this.config.pcId, pcIdPath)
    /* v8 ignore next -- an unload landing while the identity file is being read. */
    if (lifetime.disposed) return
    lifetime.opening = MobileSyncStore.open(this.config.path || join(root, 'v1.sqlite'), this.config.maxBindings, this.config.maxReceipts)
    const store = await lifetime.opening
    /* v8 ignore next -- an unload landing while the database is being opened; the effect above closes the store. */
    if (lifetime.disposed) return
    const watch = new AccountWatch(() => this.ctx.qianshouAccount.state(), this.config.accountPollMs, accountId => this.changed(accountId))
    const inbound = this.config.serveInbound
    const presence = inbound ? new WorkerPresence({
      accountOrigin: httpOrigin(this.config.accountOrigin, 'accountOrigin'),
      windowOrigin: phoneWindowOrigin(this.config.windowOrigin),
      workerIdPath: join(dirname(pcIdPath), 'worker-id.json'),
      token: () => this.credential(),
      accountId: () => watch.account() ?? null,
    }) : undefined
    /* v8 ignore next 2 -- the `?? null` arm: no phone request can arrive before the first account read, which starts the registration. */
    const service = new PcWindowService(store, mobileSessionPort(this.ctx), {
      pcId: this.identity.pcId,
      ...(presence === undefined ? {} : { pcIdOf: () => presence.id() }),
      maxRequests: this.config.maxRequests,
      timeoutMs: this.config.sessionTimeoutMs, currentAccount: () => watch.account() ?? null,
    })
    if (presence !== undefined) {
      registerPhoneWindowRoutes(this.ctx, {
        accountOrigin: httpOrigin(this.config.accountOrigin, 'accountOrigin'),
        currentAccount: () => watch.account() ?? null,
        handle: request => service.handle(request),
        issueCookie: host => this.ctx.connection.issueBrowserSessionCookie({ headers: { host } }),
      })
    }
    const link = presence === undefined ? new RelayLink({ relayUrl: this.config.relayUrl, pcId: this.identity.pcId, credential: () => this.credential(),
      handle: request => service.handle(request), pollWaitMs: this.config.pollWaitMs, requestTimeoutMs: this.config.requestTimeoutMs,
      reconnectMinMs: this.config.reconnectMinMs, reconnectMaxMs: this.config.reconnectMaxMs, replyCacheSize: this.config.replyCacheSize }) : undefined
    this.service = service; this.link = link; this.presence = presence; this.watch = watch
    watch.start()
  }
  private async credential(): Promise<string | undefined> {
    return (await this.ctx.credentials.resolve(credentialRef(ACCOUNT_ACCESS_REF)))?.value
  }
  /** Sign-out or switch revokes every binding before the old registration leaves; a new account registers afterwards. */
  private async changed(accountId: string | null): Promise<void> {
    /* v8 ignore next -- the account watch starts after both exist and stops before either is released. */
    if (!this.service) return
    this.service.revokeAll()
    if (this.presence) {
      if (accountId === null) await this.presence.stop('signed-out')
      else this.presence.start()
      return
    }
    if (!this.link) return
    if (accountId === null) await this.link.stop('signed-out')
    else await this.link.start(accountId)
  }
  /**
   * Whitelisted diagnostics for the owner UI and `qianshou:doctor`.
   * @returns PC id, registration state and heartbeat facts; never a credential.
   */
  @Remote
  async status(): Promise<MobileSyncStatus> {
    if (!this.identity || !this.service) throw new MobileSyncFailure('CLOSED')
    if (this.presence) {
      const presence = this.presence.status()
      return { pcId: this.identity.pcId, pcIdSource: this.identity.source, relayUrl: this.config.accountOrigin,
        accountId: this.watch?.account() ?? null, registration: presence.registration, registeredAt: presence.registeredAt,
        lastHeartbeatAt: presence.lastHeartbeatAt, lastFailure: presence.lastFailure, activeBindings: this.service.activeBindings() }
    }
    if (!this.link) throw new MobileSyncFailure('CLOSED')
    const link = this.link.status()
    return { pcId: this.identity.pcId, pcIdSource: this.identity.source, relayUrl: this.config.relayUrl, accountId: link.accountId,
      registration: link.registration, registeredAt: link.registeredAt, lastHeartbeatAt: link.lastHeartbeatAt, lastFailure: link.lastFailure,
      activeBindings: this.service.activeBindings() }
  }
}

const WINDOW_ORIGINS = new Set(['https://pc.qianshousuanli.com', 'https://pc-win.qianshousuanli.com'])

/** HTTPS origin, or loopback HTTP for a test double. Credentials and extra URL parts are refused. */
function httpOrigin(value: string, label: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error(`qianshou-mobile-sync: ${label} is not a URL`) }
  const loopback = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
  if ((!loopback && url.protocol !== 'https:') || url.username.length > 0 || url.password.length > 0
    || url.search.length > 0 || url.hash.length > 0 || (url.pathname !== '/' && url.pathname.length > 0)) {
    throw new Error(`qianshou-mobile-sync: ${label} is not an account origin`)
  }
  return url.origin
}

/** Official phone window, or the origin for this process when the deployment leaves it empty. */
function phoneWindowOrigin(value: string): string {
  if (value.length === 0) return process.platform === 'win32' ? 'https://pc-win.qianshousuanli.com' : 'https://pc.qianshousuanli.com'
  const origin = httpOrigin(value, 'windowOrigin')
  if (!WINDOW_ORIGINS.has(origin)) throw new Error('qianshou-mobile-sync: windowOrigin is not a phone window')
  return origin
}
export default QianshouMobileSync
