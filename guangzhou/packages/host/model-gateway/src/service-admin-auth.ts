/** Request-scoped service credentials for the two internal finance routes only. */
import { createHash, timingSafeEqual } from 'node:crypto'
import { open } from 'node:fs/promises'
import { parseCredentialsDocument } from '@deepseek-ai/dsh-credentials-local'
import type { Principal } from './admin-routes.ts'

/** Only these operations are delegated to the admin-console service. */
export type ServiceAdminScope = 'ledger.adjust' | 'subscription.grant'
/** Configuration contains references, never credential values. */
export interface ServiceAdminConfig {
  readonly audience: string
  readonly keys: readonly { readonly id: string; readonly credentialRef: string; readonly scopes: readonly ServiceAdminScope[] }[]
}
/** Verified delegation is kept separate from the human principal. */
export interface ServiceAdminOperation {
  readonly ref: string
  readonly serviceId: 'admin-console'
  readonly operatorRole: string
}
/** A service request either supplies its own verified operator or fails closed. */
export type ServiceAdminResult =
  | { readonly ok: true; readonly principal: Principal; readonly operation: ServiceAdminOperation }
  | { readonly ok: false; readonly response: Response }

/** Read the current owner-only file on every call, including after rotation/deletion.
 * @param path - Explicit credentials file in this process's DSH home.
 * @param ref - Dedicated service reference; ambient overrides are refused.
 * @returns Current value, or null when missing, unsafe, conflicting or invalid.
 */
export async function readServiceCredential(path: string, ref: string): Promise<string | null> {
  if (process.env[ref] !== undefined) return null
  try {
    const handle = await open(path, 'r')
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > 1_048_576 || (info.mode & 0o077) !== 0) return null
      if (process.getuid !== undefined && info.uid !== process.getuid()) return null
      return parseCredentialsDocument(await handle.readFile('utf8'), path).refs.get(ref) ?? null
    } finally { await handle.close() }
  } catch { return null /* Missing, unreadable or invalid credentials never grant access. */ }
}

/** Validate references and scopes before registering an enabled service route.
 * @param config - Optional deployment configuration; absent means disabled.
 */
export function validateServiceAdminConfig(config: ServiceAdminConfig | undefined): void {
  if (config === undefined) return
  const raw: unknown = config
  if (raw === null || typeof raw !== 'object') throw new Error('Invalid internalAdmin configuration')
  const input = raw as Record<string, unknown>
  if (typeof input['audience'] !== 'string' || !input['audience'].trim() || input['audience'].length > 128
    || !Array.isArray(input['keys']) || input['keys'].length === 0) throw new Error('Invalid internalAdmin audience/keys')
  const ids = new Set<string>()
  for (const entry of input['keys'] as unknown[]) {
    if (entry === null || typeof entry !== 'object') throw new Error('Invalid internalAdmin key')
    const key = entry as Record<string, unknown>
    const id = key['id'], ref = key['credentialRef'], scopes = key['scopes']
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id) || ids.has(id)
      || typeof ref !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(ref) || !Array.isArray(scopes) || scopes.length === 0
      || scopes.some((scope: unknown) => scope !== 'ledger.adjust' && scope !== 'subscription.grant')) {
      throw new Error('Invalid internalAdmin key reference or scope')
    }
    ids.add(id)
  }
}

/** Build service authentication without owner cookies, browser headers or host login fallback.
 * @param options - Explicit audience/key scopes and uncached credential resolver.
 * @returns Authorizer limited to the exact internal path for each operation.
 */
export function createServiceAdminAuthorizer(options: {
  readonly config?: ServiceAdminConfig
  readonly resolve: (ref: string) => Promise<string | null>
}): (request: Request, scope: ServiceAdminScope) => Promise<ServiceAdminResult> {
  validateServiceAdminConfig(options.config)
  const deny = (status: number, code: string, message: string): ServiceAdminResult => ({ ok: false, response: Response.json({ ok: false, code, message }, { status, headers: { 'cache-control': 'no-store' } }) })
  return async (request, scope) => {
    const config = options.config
    const key = config?.keys.find(item => item.id === request.headers.get('x-qianshou-service-key-id'))
    const token = /^Bearer ([A-Za-z0-9_-]{43,256})$/.exec(request.headers.get('authorization') ?? '')?.[1]
    const value = key === undefined ? null : await options.resolve(key.credentialRef)
    const hash = (input: string): Buffer => createHash('sha256').update(input).digest()
    if (config === undefined || key === undefined || token === undefined || value === null || !/^[A-Za-z0-9_-]{43,256}$/.test(value)
      || !timingSafeEqual(hash(token), hash(value))) return deny(401, 'workbench_service_unauthorized', '工作台服务凭据未配置、失效或已吊销，请联系管理员修复服务连接。')
    const path = scope === 'ledger.adjust' ? '/internal/ledger/adjust' : '/internal/subscriptions/grant'
    if (request.method !== 'POST' || new URL(request.url).pathname !== path || !key.scopes.includes(scope)) return deny(403, 'workbench_service_forbidden', '此服务凭据没有执行该操作的权限。')
    let body: Record<string, unknown>
    try {
      const raw = await request.clone().text()
      if (Buffer.byteLength(raw) > 65_536) return deny(413, 'bad_request', '管理请求过大。')
      const parsed: unknown = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return deny(400, 'bad_request', '请求必须是 JSON 对象。')
      body = parsed as Record<string, unknown>
    } catch { return deny(400, 'bad_request', '请求必须是 JSON 对象。') }
    if (body['dryRun'] !== undefined && typeof body['dryRun'] !== 'boolean') return deny(400, 'bad_request', 'dryRun 必须是布尔值。')
    const raw = body['_admin']
    const context = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
    const accountId = context['operatorAccountId'], role = context['operatorRole'], operationId = context['operationId']
    if (context['audience'] !== config.audience || typeof accountId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(accountId)
      || typeof role !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(role)
      || typeof operationId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(operationId) || body['ref'] !== operationId) return deny(403, 'workbench_service_forbidden', '服务请求缺少有效的操作者、受众或操作标识。')
    return { ok: true, principal: { accountId, role, isAdmin: true }, operation: { ref: operationId, serviceId: 'admin-console', operatorRole: role } }
  }
}
