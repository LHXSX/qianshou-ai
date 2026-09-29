/** Dedicated service identity for the two workbench money routes; account tokens are never reused. */
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { CREDENTIALS_FILENAME, parseRefsDocument } from './upstream-keys.ts'

export interface WorkbenchAdminConfig {
  readonly baseUrl: string
  readonly keyId: string
  readonly credentialRef: string
  readonly audience: string
}
export type WorkbenchMoneyAction = 'ledger.adjust' | 'subscription.grant'
export const WORKBENCH_PATHS: Readonly<Record<WorkbenchMoneyAction | 'models.read', string>> = {
  'ledger.adjust': '/internal/ledger/adjust',
  'subscription.grant': '/internal/subscriptions/grant',
  'models.read': '/internal/models/names',
}
export class WorkbenchUpstreamError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code }
}
export type WorkbenchProbeResult = { readonly status: 'ready' | 'unconfigured' | 'unauthorized' | 'unavailable'; readonly detail: string }

/** Resolve the same refs document afresh through an owner-only file descriptor, without env fallback or caching. */
async function serviceKey(dshHome: string, ref: string): Promise<string> {
  try {
    const handle = await open(join(dshHome, CREDENTIALS_FILENAME), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const metadata = await handle.stat()
      if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) throw new Error('CREDENTIAL_MODE')
      const key = parseRefsDocument(await handle.readFile('utf8')).refs.get(ref)
      if (key === undefined || !/^[A-Za-z0-9_-]{43,256}$/.test(key) || process.env[ref] !== undefined) throw new Error('CREDENTIAL_MISSING')
      return key
    } finally { await handle.close() }
  } catch {
    throw new WorkbenchUpstreamError(503, 'workbench_credentials_unavailable', '工作台服务凭据未就绪，请管理员核查专用引用和文件权限。')
  }
}

/** Immutable deployment origin and audience; this client neither follows redirects nor retries money requests. */
export function createWorkbenchUpstream(options: {
  readonly config?: WorkbenchAdminConfig
  readonly dshHome: string
  readonly fetch?: typeof fetch
}) {
  const config = options.config
  let origin: string | null = null
  if (config !== undefined) {
    const url = new URL(config.baseUrl)
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      || !/^[A-Z][A-Z0-9_]*$/.test(config.credentialRef)
      || !/^[A-Za-z0-9_-]{1,64}$/.test(config.keyId) || !config.audience.trim()) {
      throw new Error('WORKBENCH_ADMIN_CONFIG_INVALID')
    }
    origin = url.origin
  }
  const send = options.fetch ?? fetch
  const request = async (input: {
      readonly action: WorkbenchMoneyAction | 'models.read'
      readonly operatorAccountId: string
      readonly operatorRole: string
      readonly operationId: string
      readonly body: Record<string, unknown>
      readonly dryRun: boolean
    }): Promise<Record<string, unknown>> => {
      if (config === undefined || origin === null) throw new WorkbenchUpstreamError(503, 'dependency_unavailable', '工作台服务身份尚未配置，不能调整 SP 或订阅。')
      const key = await serviceKey(options.dshHome, config.credentialRef)
      const controller = new AbortController()
      const timeout = setTimeout(() => { controller.abort() }, 10_000)
      try {
        const response = await send(`${origin}${WORKBENCH_PATHS[input.action]}`, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${key}`, 'x-qianshou-service-key-id': config.keyId },
          body: JSON.stringify({ ...input.body, ref: input.operationId,
            ...(input.dryRun ? { dryRun: true } : {}),
            _admin: { audience: config.audience, operatorAccountId: input.operatorAccountId,
              operatorRole: input.operatorRole, operationId: input.operationId },
          }),
        })
        if (response.status === 401) throw new WorkbenchUpstreamError(401, 'workbench_service_unauthorized', '工作台拒绝服务凭据，请管理员核查服务密钥；你的管理台登录仍然有效。')
        if (response.status === 403) throw new WorkbenchUpstreamError(403, 'workbench_service_forbidden', '工作台拒绝本次服务范围或管理员委托，请核查授权。')
        if (response.status === 409) throw new WorkbenchUpstreamError(409, 'workbench_operation_conflict', '工作台发现相同操作号的内容冲突，请核查原操作，勿另建重复调账。')
        if (response.status >= 400 && response.status < 500) throw new WorkbenchUpstreamError(response.status, 'workbench_rejected', '工作台拒绝本次参数或操作，请核查目标、金额、档位和期限。')
        if (!response.ok) throw new Error('WORKBENCH_FAILED')
        const payload: unknown = await response.json()
        if (payload === null || typeof payload !== 'object' || Array.isArray(payload) || (payload as Record<string, unknown>)['ok'] !== true) throw new Error('WORKBENCH_INVALID_RESPONSE')
        return payload as Record<string, unknown>
      } catch (error) {
        if (error instanceof WorkbenchUpstreamError) throw error
        throw new WorkbenchUpstreamError(502, input.dryRun ? 'workbench_unavailable' : 'workbench_outcome_unknown', input.dryRun
          ? '工作台预览暂不可用，本次未执行修改。'
          : '工作台执行结果未确认，请保留本次操作号核查，勿另建操作或重复提交。')
      } finally { clearTimeout(timeout) }
    }
  const probe = async (action: WorkbenchMoneyAction = 'ledger.adjust'): Promise<WorkbenchProbeResult> => {
    if (config === undefined || origin === null) return { status: 'unconfigured', detail: '工作台服务身份尚未配置。' }
    try {
      const body = action === 'ledger.adjust'
        ? { accountId: '__qianshou_readiness_probe__', deltaSp: 1, bucket: 'recharge', tier: 'free', reason: 'readiness probe' }
        : { accountId: '__qianshou_readiness_probe__', tier: 'free', from: Date.now(), to: Date.now() + 3_600_000, reason: 'readiness probe' }
      await request({ action, operatorAccountId: '__qianshou_admin_probe__', operatorRole: 'super-admin', operationId: `readiness-${randomUUID()}`, body, dryRun: true })
      return { status: 'ready', detail: '工作台 dry-run 授权和契约检查通过。' }
    } catch (error) {
      if (error instanceof WorkbenchUpstreamError) {
        if (error.code === 'workbench_service_unauthorized' || error.code === 'workbench_service_forbidden') return { status: 'unauthorized', detail: error.message }
        if (error.code === 'workbench_rejected' || error.code === 'workbench_operation_conflict') return { status: 'ready', detail: '工作台已收到 dry-run，业务目标校验被拒但服务身份有效。' }
        if (error.code === 'dependency_unavailable' || error.code === 'workbench_credentials_unavailable') return { status: 'unconfigured', detail: error.message }
        return { status: 'unavailable', detail: error.message }
      }
      return { status: 'unavailable', detail: '工作台 dry-run 未完成。' }
    }
  }
  return { configured: config !== undefined, probe, request }
}
