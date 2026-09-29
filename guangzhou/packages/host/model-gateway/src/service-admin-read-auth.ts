/** Exact read-only service delegation; no browser session, role fallback or write path. */
import { createHash, timingSafeEqual } from 'node:crypto'
import type { Principal } from './admin-routes.ts'

export interface ModelReadConfig {
  readonly audience: string
  readonly keyId: string
  readonly credentialRef: string
  readonly scopes: readonly 'models.read'[]
}

/** Authenticate a model directory request with the current dedicated service reference.
 * @param config - Deployment-owned identity and the sole supported read scope.
 * @param resolve - Uncached owner-only credential resolver.
 * @returns Request authorizer; no credential or submitted identity is echoed.
 */
export function createModelReadAuthorizer(config: ModelReadConfig, resolve: (ref: string) => Promise<string | null>) {
  if (!config || !/^[A-Za-z0-9_-]{1,80}$/.test(config.keyId) || !/^[A-Z_][A-Z0-9_]*$/.test(config.credentialRef)
    || typeof config.audience !== 'string' || !config.audience.trim() || config.audience.length > 128
    || !Array.isArray(config.scopes) || config.scopes.length !== 1 || config.scopes[0] !== 'models.read') {
    throw new Error('Invalid model read service configuration')
  }
  const deny = (status: number, code: string) => ({ ok: false as const, response: Response.json({ ok: false, code,
    message: status === 401 ? '工作台服务身份失效，请核查专用凭据。' : '此服务请求没有模型只读权限。' },
  { status, headers: { 'cache-control': 'no-store' } }) })
  return async (request: Request): Promise<{ readonly ok: true; readonly principal: Principal } | { readonly ok: false; readonly response: Response }> => {
    const token = /^Bearer ([A-Za-z0-9_-]{43,256})$/.exec(request.headers.get('authorization') ?? '')?.[1]
    const key = await resolve(config.credentialRef)
    const hash = (value: string) => createHash('sha256').update(value).digest()
    if (request.headers.get('x-qianshou-service-key-id') !== config.keyId || !token || !key
      || !/^[A-Za-z0-9_-]{43,256}$/.test(key) || !timingSafeEqual(hash(token), hash(key))) return deny(401, 'workbench_service_unauthorized')
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/internal/models/names') return deny(403, 'workbench_service_forbidden')
    let body: Record<string, unknown>
    try {
      const raw = await request.clone().text()
      if (Buffer.byteLength(raw) > 65_536) return deny(413, 'bad_request')
      const value: unknown = JSON.parse(raw)
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return deny(400, 'bad_request')
      body = value as Record<string, unknown>
    } catch { return deny(400, 'bad_request') }
    const raw = body['_admin']
    const context = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
    const id = context['operatorAccountId'], role = context['operatorRole'], operation = context['operationId']
    if (context['audience'] !== config.audience || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)
      || typeof role !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(role) || typeof operation !== 'string'
      || !/^[A-Za-z0-9_-]{16,128}$/.test(operation) || operation !== body['ref']) return deny(403, 'workbench_service_forbidden')
    return { ok: true, principal: { accountId: id, role, isAdmin: true } }
  }
}
