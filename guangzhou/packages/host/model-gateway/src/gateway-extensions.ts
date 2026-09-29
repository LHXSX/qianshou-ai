/** Adds reviewed media/ordinary routes to the preserved live finance runtime. No old adapter market is mounted. */
import { MediaNodeStore } from './media-node-store.ts'
import { createMediaNodeRoutes } from './media-node-http.ts'
import { createMediaExchangeHttp } from './media-exchange-http.ts'
import { createPluginLicenseBearerVerifier } from './plugin-license-bearer.ts'
import { createOrdinarySkillPublication, ORDINARY_SKILL_PATH, ORDINARY_SKILL_ADMIN_PATH } from './ordinary-skill-publication.ts'
import { createOrdinarySkillBearerRoute } from './ordinary-skill-bearer.ts'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { CREDENTIALS_FILENAME, parseCredentialsDocument } from '@deepseek-ai/dsh-credentials-local'

interface Scope {
  effect(effect: () => (() => void) | undefined, label?: string): void
  inject(deps: string[], callback: (scope: Scope) => void): unknown
  get(name: string): unknown
  connection: { fetch: { register(route: unknown): () => void } }
  webServer: { register(route: unknown): () => void }
}
export interface GatewayExtensionsConfig {
  readonly dshHome?: string
  readonly adminRoles?: readonly string[]
  readonly marketOrdinarySkillStorePath?: string
  readonly marketLicenseAccountApiOrigin?: string
  readonly marketOperatorKeys?: Readonly<Record<string, string>>
  readonly marketOperatorAccounts?: Readonly<Record<string, string>>
  readonly marketOfficialSkillAccounts?: readonly string[]
  readonly mediaNodes?: {
    readonly storePath: string
    readonly accountApiOrigin: string
    readonly heartbeatIntervalMs: number
    readonly heartbeatTimeoutMs: number
    readonly maxLongPollRequests: number
    readonly dispatchCredentialRef?: string
    readonly resultVerifierPublicKeys?: Readonly<Record<string, string>>
    readonly orderAuthorizationPublicKeys?: Readonly<Record<string, string>>
    readonly exchangeOrigin?: string
    readonly exchangeCredentialRef?: string
    /** Installation/directory only; this origin never receives bytes or orders. */
    readonly metadataOrigin?: string
    readonly metadataCredentialRef?: string
    readonly adminControl?: { readonly keyId: string; readonly audience: string; readonly credentialRef: string;
      readonly scopes: readonly ('nodes.read' | 'nodes.manage')[] }
  }
}

export function applyGatewayExtensions(ctx: Scope, config: GatewayExtensionsConfig = {}): void {
  const verifyAccount = createPluginLicenseBearerVerifier({
    ...(config.marketLicenseAccountApiOrigin === undefined ? {} : { accountApiOrigin: config.marketLicenseAccountApiOrigin }),
  })
  const adminRoles = new Set(config.adminRoles ?? ['admin'])
  const ordinary = createOrdinarySkillPublication({
    ...(config.marketOrdinarySkillStorePath === undefined ? {} : { storePath: config.marketOrdinarySkillStorePath }),
    ...(config.marketOperatorKeys === undefined ? {} : { operatorKeys: config.marketOperatorKeys }),
    ...(config.marketOperatorAccounts === undefined ? {} : { operatorAccounts: config.marketOperatorAccounts }),
    ...(config.marketOfficialSkillAccounts === undefined ? {} : { officialAccounts: config.marketOfficialSkillAccounts }),
    authenticate: async request => {
      const principal = await verifyAccount(request)
      return principal === null || new URL(request.url).pathname === ORDINARY_SKILL_PATH ? principal
        : { ...principal, isAdmin: adminRoles.has(principal.role) }
    },
  })
  ctx.effect(() => () => ordinary.close(), 'model-gateway extensions: ordinary store')
  ctx.effect(() => ctx.connection.fetch.register({
    path: ORDINARY_SKILL_ADMIN_PATH, methods: ['POST'], requestBody: 'buffered',
    fetch: async (request: Request) => {
      const size = Number(request.headers.get('content-length') ?? '0')
      if (!Number.isSafeInteger(size) || size < 0 || size > 64 * 1024) return Response.json({ ok: false, code: 'BAD_REQUEST' }, { status: 413 })
      if (!/^Bearer [\x21-\x7e]{16,4096}$/u.test(request.headers.get('authorization') ?? '')) return Response.json({ ok: false, code: 'LOGIN_REQUIRED' }, { status: 401 })
      return ordinary.handler(request)
    },
  }), 'model-gateway extensions: ordinary employee review')
  ctx.inject(['webServer'], webCtx => {
    webCtx.effect(() => webCtx.webServer.register(createOrdinarySkillBearerRoute({ handle: ordinary.handler,
      path: ORDINARY_SKILL_PATH, actions: ['submit', 'mine', 'catalog'], publicRead: ordinary.catalog })), 'model-gateway extensions: ordinary public carrier')
    const media = config.mediaNodes
    if (media === undefined) return
    if (media.adminControl && !/^[A-Z_][A-Z0-9_]*$/u.test(media.adminControl.credentialRef)) throw new Error('MEDIA_ADMIN_CONFIG_INVALID')
    const resolve = async (ref: string | undefined): Promise<string | undefined> => {
      if (ref === undefined) return undefined
      if (!/^[A-Z_][A-Z0-9_]*$/u.test(ref) || process.env[ref] !== undefined) return undefined
      // The live shared server has no required credentials service. Reuse its owner-only refs document, uncached.
      try {
        const path = join(resolveDshHome(config.dshHome), CREDENTIALS_FILENAME)
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const info = await handle.stat()
          if (!info.isFile() || info.size > 1024 * 1024 || (info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid()) return undefined
          return parseCredentialsDocument(await handle.readFile('utf8'), path).refs.get(ref)
        } finally { await handle.close() }
      } catch { return undefined }
    }
    const store = new MediaNodeStore({ path: media.storePath, heartbeatIntervalMs: media.heartbeatIntervalMs,
      heartbeatTimeoutMs: media.heartbeatTimeoutMs,
      ...(media.orderAuthorizationPublicKeys === undefined ? {} : { orderAuthorizationPublicKeys: media.orderAuthorizationPublicKeys }) })
    const nodeRoutes = createMediaNodeRoutes({ store,
      verifyAccount: createPluginLicenseBearerVerifier({ accountApiOrigin: media.accountApiOrigin }),
      maxLongPollRequests: media.maxLongPollRequests,
      ...(media.exchangeOrigin === undefined ? {} : { mediaExchange: createMediaExchangeHttp(media.exchangeOrigin, () => resolve(media.exchangeCredentialRef)) }),
      ...(media.metadataOrigin === undefined ? {} : { mediaMetadata: createMediaExchangeHttp(media.metadataOrigin, () => resolve(media.metadataCredentialRef)) }),
      ...(media.resultVerifierPublicKeys === undefined ? {} : { resultVerifierPublicKeys: media.resultVerifierPublicKeys }),
      dispatchToken: () => resolve(media.dispatchCredentialRef),
      ...(media.adminControl === undefined ? {} : { adminControl: { keyId: media.adminControl.keyId,
        audience: media.adminControl.audience, scopes: media.adminControl.scopes, token: () => resolve(media.adminControl!.credentialRef) } }),
    })
    webCtx.effect(() => () => nodeRoutes.close(), 'model-gateway extensions: durable node store')
    for (const route of nodeRoutes.routes) webCtx.effect(() => webCtx.webServer.register(route), `model-gateway extensions: ${route.path}`)
  })
}
