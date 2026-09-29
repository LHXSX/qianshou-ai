/* oxlint-disable typescript/require-await -- Owner Remote methods convert synchronous storage failures into rejected promises. */
/** Device-owner grants for a single local Session, served independently of owner RPC credentials. */
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { ConnectStore } from './store.ts'
import { ConnectService } from './service.ts'
import { ConnectHttp, connectOrigin } from './http.ts'
import { sessionPort } from './session-port.ts'
import { ConnectFailure, safeFailure } from './validation.ts'
import type { ConnectionOwnerState, ConnectionGrantInput, ConnectionGrantCreated } from './types.ts'
export type * from './types.ts'
export { sessionPort }
export type { ConnectSessionPort } from './session-port.ts'
export { PHONE_TURN_BYTE_LIMIT, projectConnectionPage } from './projection.ts'
export { ConnectFailure }

/** Storage, concurrency and external reachability are deployment-owned choices. */
export interface Config {
  /** Dedicated new-format database; empty resolves beneath DSH_HOME. */
  path: string
  /** Empty allows only the current loopback origin; otherwise an explicit HTTPS proxy origin. */
  publicOrigin: string
  /** Maximum retained grants, including expired/revoked grants until reclaimed. */
  maxGrants: number
  /** Maximum retained idempotency receipts; active receipts are never evicted. */
  maxReceipts: number
  /** Maximum active requests, including incomplete bodies. */
  maxRequests: number
  /** Deadline from request admission through body and Session observation. */
  requestTimeoutMs: number
}
declare module '@deepseek-ai/cordis' { interface Context { qianshouSessionConnect: QianshouSessionConnect } }

/** Owner-authenticated Remote creates and revokes narrow grants; it never exports an owner credential. */
export class QianshouSessionConnect extends TypertRemoteService {
  static inject = ['sessions', 'agents', 'sessionController', 'webServer']
  static Config: Schema<Config> = Schema.object({
    path: Schema.string().default(''), publicOrigin: Schema.string().default(''),
    maxGrants: Schema.natural().min(1).max(1000).default(100),
    maxReceipts: Schema.natural().min(1).max(100000).default(10000),
    maxRequests: Schema.natural().min(1).max(64).default(12),
    requestTimeoutMs: Schema.natural().min(100).max(60000).default(15000),
  })
  private service: ConnectService | undefined
  private origin = ''
  constructor(ctx: Context, private readonly config: Config) { super(ctx, 'qianshouSessionConnect') }
  protected async [Service.init](): Promise<void> {
    const lifetime: { disposed: boolean; opening?: Promise<ConnectStore>; service?: ConnectService; http?: ConnectHttp } = {
      disposed: false,
    }
    const disposed = (): boolean => lifetime.disposed
    this.ctx.effect(() => async () => {
      lifetime.disposed = true; this.service = undefined
      await lifetime.http?.dispose()
      if (lifetime.service) await lifetime.service.dispose()
      else (await lifetime.opening?.catch(() => undefined))?.close()
    }, 'qianshou-session-connect: lifetime')
    this.origin = connectOrigin(this.config.publicOrigin, this.ctx.webServer.port)
    const packageRoot = dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-host-qianshou-session-connect/package.json')))
    // Both supported source and artifact launches consume the declared built browser asset.
    const viewer = await readFile(join(packageRoot, 'lib', 'viewer.js'), 'utf8')
    if (Buffer.byteLength(viewer) > 1024 * 1024) throw new Error('Session connection viewer exceeds its static asset limit')
    if (disposed()) return
    const home = process.env.DSH_HOME ?? join(homedir(), '.deepseek-harness')
    lifetime.opening = ConnectStore.open(this.config.path || join(home, 'qianshou', 'session-connect', 'v1.sqlite'), this.config.maxGrants, this.config.maxReceipts)
    const store = await lifetime.opening
    if (disposed()) return
    const service = new ConnectService(store, sessionPort(this.ctx), this.config.maxRequests, this.config.requestTimeoutMs)
    const http = new ConnectHttp(service, { origin: this.origin, viewer,
      maxRequests: this.config.maxRequests, timeoutMs: this.config.requestTimeoutMs })
    lifetime.service = service; lifetime.http = http; this.service = service
    this.ctx.effect(() => this.ctx.webServer.register({ kind: 'prefix', path: '/qianshou-connect', handler: (req, res) => http.handle(req, res) }), 'qianshou-session-connect: routes')
  }
  private current(): ConnectService { if (!this.service) throw new ConnectFailure('closed', 503); return this.service }
  /**
   * List the selected Session's non-secret authorizations.
   * @param sessionId - Explicit owner-selected Session.
   * @returns Current local-device grant metadata and configured reachability.
   */
  @Remote
  async state(sessionId: SessionId): Promise<ConnectionOwnerState> {
    try { return this.current().state(sessionId, this.origin) } catch (error) { throw safeFailure(error) }
  }
  /**
   * Create one revocable authorization after inspecting the real Session.
   * @param input - Selected Session, mode, label and lifetime.
   * @returns Grant metadata and one secret fragment link, returned only here.
   */
  @Remote
  async create(input: ConnectionGrantInput): Promise<ConnectionGrantCreated> {
    try { return await this.current().create(input) } catch (error) { throw safeFailure(error) }
  }
  /**
   * Revoke access to one selected Session without interrupting its work.
   * @param sessionId - Owner's explicit Session fence.
   * @param grantId - Selected authorization id.
   */
  @Remote
  async revoke(sessionId: SessionId, grantId: string): Promise<void> {
    try { this.current().revoke(sessionId, grantId) } catch (error) { throw safeFailure(error) }
  }
}
export default QianshouSessionConnect
