/** Public bootstrap observations and a versioned, credential-free external-node contract. */
import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'

export interface ApiPlatformConfig {
  /** The public HTTPS bootstrap origin, never an administrator or exchange private origin. */
  publicBaseUrl?: string
  probeTimeoutMs?: number
}
export interface ApiPlatformIntegration {
  schema: 'qianshou.api-platform-integration.v1'
  checkedAt: string
  publicBaseUrl: string
  probePath: '/v1/nodes/probe'
  probe: 'reachable' | 'unavailable' | 'unknown'
  deviceChannel: 'configured' | 'unavailable' | 'unknown'
  metadata: 'configured' | 'unavailable' | 'unknown'
  exchange: 'configured' | 'unavailable' | 'unknown'
  dispatch: 'configured' | 'unavailable' | 'unknown'
  readiness: 'unavailable' | 'unknown'
  code: string | null
}
const fields = ['deviceId', 'connectionEpoch', 'taskId', 'attemptId', 'leaseEpoch']
const routes = [
  { method: 'GET', path: '/v1/nodes/probe', authentication: 'public', bodyFields: [], queryFields: ['nonce'], notes: 'Canonical lowercase UUID challenge; exact schema/service/nonce/current Unix time; no-store. Reachability only.' },
  { method: 'POST', path: '/v1/nodes/register', authentication: 'account_bearer', bodyFields: ['deviceId', 'deviceToken', 'adapterVersion', 'capabilityRevision', 'capabilities', 'maxConcurrency'], queryFields: [], notes: 'The current authenticated account is the owner. Save the device UUID and cryptographic device token before registration. Empty capabilities register presence with zero free slots.' },
  { method: 'POST', path: '/v1/nodes/reconnect', authentication: 'device_bearer', bodyFields: ['deviceId', 'capabilityRevision'], queryFields: [], notes: 'Use the original saved identity; persist the new connectionEpoch. Restore the inbox before advertising idle capacity.' },
  { method: 'POST', path: '/v1/nodes/channel', authentication: 'device_bearer', bodyFields: ['deviceId', 'connectionEpoch', 'afterSequence', 'waitMs'], queryFields: [], notes: 'POST JSON long polling, not SSE. waitMs is 0..25000. Persist each immutable GPU delivery and local admission before advancing afterSequence. After api-observations, an independent optional apiProbes array carries metadata challenges; it never changes the GPU inbox cursor.' },
  { method: 'POST', path: '/v1/nodes/api-observations', authentication: 'device_bearer', bodyFields: ['deviceId', 'connectionEpoch', 'observationRevision', 'observations'], queryFields: [], notes: 'After explicit mode connection consent, reuse an existing fixed local API; no reviewed package, RTX certificate or paid profile is required. At most image/video one each: mode, adapter, status ready|unavailable|auth_required|unsupported|unknown, model/workflow {id,sha256:null|64hex,version:null|string}|null, observedAt UTC ISO. Ready requires actual identified model and callable workflow. Never send a local path, URL, IP or secret. Persist one stable revision and immutable observations including observedAt; retry the original body. Only unacknowledged stale metadata may be freshly observed and rotated after 60 seconds.' },
  { method: 'POST', path: '/v1/nodes/api-probe-result', authentication: 'device_bearer', bodyFields: ['deviceId', 'connectionEpoch', 'requestId', 'observation'], queryFields: [], notes: 'Channel apiProbes are GET-only metadata challenges {requestId,mode,epoch,kind:metadata,expiresAt}; lifetime 90s. Use only fixed local health/model/workflow GETs, never an arbitrary challenge URL, script, GPU POST or new download. Persist original observation before responding to the original UUID/epoch. ACK {ok,deviceId,connectionEpoch,requestId,status:confirmed|failed,confirmedAt:ISO|null}. Repeated UUID retains the same response; confirmation lasts 120s and a new read challenge renews after 60s. This proves an API roundtrip, not paid qualification or billable output.' },
  { method: 'POST', path: '/v1/nodes/heartbeat', authentication: 'device_bearer', bodyFields: ['deviceId', 'connectionEpoch', 'capabilityRevision', 'freeSlots', 'runningAttemptIds', 'freeVramMb', 'availableSeconds'], queryFields: [], notes: 'Read channel recovery first. Report actual occupancy. Unqualified, paused, unknown resources or presence-only means freeSlots=0.' },
  { method: 'POST', path: '/v1/nodes/disconnect', authentication: 'device_bearer', bodyFields: ['deviceId', 'connectionEpoch'], queryFields: [], notes: 'Invalidates the epoch; preserve original unknown/running attempts. Drain an original attempt before disconnecting its delivery session.' },
  { method: 'POST', path: '/v1/media/install-manifest', authentication: 'account_bearer', bodyFields: ['nonce', 'deviceId', 'workerId', 'mode', 'platform', 'arch', 'hardware'], queryFields: [], notes: 'Mode image|video. Hardware contains gpu_name/vram_mb/memory_mb. A signed reviewed release is required; a healthy local research API is not a release or qualification.' },
  { method: 'POST', path: '/v1/media/devices/qualification', authentication: 'account_bearer', bodyFields: ['nonce', 'deviceId', 'workerId'], queryFields: [], notes: 'Existing worker/account/device binding and independent reviewed receipts only. Verify pinned metadata signature, fresh nonce/TTL and exact capability tuple. Never infer paid qualification from a node claim.' },
  { method: 'POST', path: '/v1/nodes/media/order-current', authentication: 'device_bearer', bodyFields: fields, queryFields: [], notes: 'Returns the Shanghai-signed current order for the original immutable task/attempt/lease. Verify its independent purpose/key, owner, device and plan SHA.' },
  { method: 'POST', path: '/v1/nodes/media/task-status', authentication: 'device_bearer', bodyFields: fields, queryFields: [], notes: 'Read-only recovery of the original attempt, verdict and settlement; not a new dispatch or GPU submission.' },
  { method: 'POST', path: '/v1/nodes/media/input-ticket', authentication: 'device_bearer', bodyFields: [...fields, 'assetId', 'sha256'], queryFields: [], notes: 'The current order must contain this buyer-owned asset and hash. Keep the immutable version; no arbitrary storage key.' },
  { method: 'POST', path: '/v1/media/assets/read', authentication: 'signed_ticket', bodyFields: [], queryFields: [], notes: 'Bearer is the original signed input-read ticket. Empty POST body; exact registered version/hash bytes only, no COS or service key.' },
  { method: 'POST', path: '/v1/nodes/media/result-ticket', authentication: 'device_bearer', bodyFields: [...fields, 'assetId', 'sha256', 'size_bytes', 'content_type'], queryFields: [], notes: 'Exact original output identity, one immutable write. Missing exchange integration returns unavailable; do not reuse a publication/review grant.' },
  { method: 'POST', path: '/v1/media/results/upload', authentication: 'signed_ticket', bodyFields: [], queryFields: [], notes: 'Bearer is the signed original result-upload ticket; body is the exact media bytes, not JSON. An unknown upload/POST outcome requires original result-status recovery, never a second output write.' },
  { method: 'POST', path: '/v1/nodes/media/result-status', authentication: 'device_bearer', bodyFields: [...fields, 'assetId'], queryFields: [], notes: 'Read-only recovery of an original immutable output and its independent verifier receipt.' },
  { method: 'POST', path: '/v1/nodes/events', authentication: 'device_bearer', bodyFields: [...fields, 'sequence', 'stage'], queryFields: [], notes: 'Durable monotonic per-attempt sequence; exact duplicate retries only. Optional percent; awaiting_settlement may add assetId/artifact from original result-status. A node cannot self-report verified/completed or settle a bill.' },
] as const
const rules = [
  'The PC user explicitly confirms the selected image/video mode; its Host automatically registers and heartbeats. The user does not enter an IP, port or service token.',
  'Registration counts are persisted owner-bound devices, including empty-capability zero-slot presence. A public probe or research API health is not registration.',
  'Connection consent is separate from idle-only execution consent. Account changes revoke future supply. Never enable the old text/tool policy, accept terms or invent a worker on the user behalf.',
  'Zero-fee API discovery and metadata roundtrips require current owner mode consent and the original device/epoch, not reviewed packages or paid certificates. Reuse a known running API without downloading or restarting it. Unrecognized workflows remain unsupported; model files or HTTP200 alone do not prove a callable adapter.',
  'Paid intake requires official immutable profile_id/profile_version/model_sha256/workflow_sha256/validation_receipt_sha256 plus trusted device qualification, current authorization and real idle/resource limits.',
  'Metadata/install, Shanghai order authorization, input tickets and formal result verification use distinct pinned purposes/keys. Do not trust keys supplied by the task or an unreviewed model/API.',
  'Use HTTPS, fixed routes, JSON Content-Type for control messages, bounded responses and no redirects, Origin or Cookie. Keep account/device/service credentials and local API addresses exclusively in private Host storage.',
  'Persist taskId/attemptId/leaseEpoch/plan_sha256 and the one-time execution right before the single GPU POST. Persist the external job ID immediately when received. Unknown execution remains occupied and is recovered read-only on that original job; do not resubmit or create a new attempt.',
  'After verified unique Shanghai settlement, retry delivery only. Never regenerate, double-upload or charge again. Paused/revoked supply must not erase or synthesize terminal state for original unfinished attempts.',
  'This guide describes the source contract. Configured and reachable do not mean qualified, dispatchable or billable; missing integrations and unpublished release/validation material remain unavailable.',
]

/** Observe only the public challenge. Trusted runtime flags are optional and independently projected. */
export function createApiPlatformMetadata(options: { config?: ApiPlatformConfig; fetch?: typeof fetch; now?: () => number }) {
  const u = new URL(options.config?.publicBaseUrl ?? 'https://app.qianshousuanli.com')
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/' || u.port || isIP(u.hostname) !== 0 || !/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/u.test(u.hostname) || u.hostname.endsWith('.localhost')) throw new Error('API_CONNECTIONS_PUBLIC_ORIGIN_INVALID')
  const publicBaseUrl = u.origin
  const timeout = options.config?.probeTimeoutMs ?? 1500
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 5000) throw new Error('API_CONNECTIONS_PROBE_TIMEOUT_INVALID')
  const now = options.now ?? Date.now
  const observe = async (flags?: unknown): Promise<ApiPlatformIntegration> => {
    const p = flags && typeof flags === 'object' && !Array.isArray(flags) ? flags as Record<string, unknown> : {}
    const state = (k: string): 'configured' | 'unavailable' | 'unknown' => p[k] === true ? 'configured' : p[k] === false ? 'unavailable' : 'unknown'
    let probe: ApiPlatformIntegration['probe'] = 'unavailable'; let code: string | null = 'gateway_probe_unavailable'
    const nonce = randomUUID()
    try {
      const response = await (options.fetch ?? fetch)(publicBaseUrl + '/v1/nodes/probe?nonce=' + nonce, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(timeout), headers: { accept: 'application/json' } })
      if (!response.ok || !response.headers.get('cache-control')?.split(',').some(v => v.trim() === 'no-store')) { await response.body?.cancel(); throw new Error('PROBE_UNAVAILABLE') }
      const reader = response.body?.getReader(); if (!reader) throw new Error('PROBE_INVALID')
      const chunks: Buffer[] = []; let size = 0
      try { while (true) { const r = await reader.read(); if (r.done) break; size += r.value.length; if (size > 4096) throw new Error('PROBE_INVALID'); chunks.push(Buffer.from(r.value)) } }
      finally { await reader.cancel().catch(() => undefined) }
      const q = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as Record<string, unknown>
      if (!q || typeof q !== 'object' || Array.isArray(q) || Object.keys(q).length !== 4 || q['schema'] !== 'qianshou.media-gateway-probe.v1' || q['service'] !== 'qianshou-guangzhou-media' || q['nonce'] !== nonce || !Number.isSafeInteger(q['time']) || Number(q['time']) < Math.floor(now() / 1000) - 60 || Number(q['time']) > Math.floor(now() / 1000) + 5) throw new Error('PROBE_INVALID')
      probe = 'reachable'; code = null
    } catch { /* A read observation does not fabricate counts or break an otherwise valid node list. */ }
    return { schema: 'qianshou.api-platform-integration.v1', checkedAt: new Date(now()).toISOString(), publicBaseUrl, probePath: '/v1/nodes/probe', probe,
      deviceChannel: state('deviceChannelConfigured'), metadata: state('metadataConfigured'), exchange: state('exchangeConfigured'), dispatch: state('dispatchConfigured'),
      readiness: p['readiness'] === 'unavailable' ? 'unavailable' : 'unknown', code }
  }
  const guide = async (scope: 'self' | 'all') => {
    const markdown = ['# 千手广州节点接入协议', '', '协议版本：2026-09-29.2；公共入口：' + publicBaseUrl, '', '普通 PC 用户在“算力共享”明确确认图像或视频后，由 Host 自动登记并保持心跳。设备列表显示真实已登记设备；空能力、零空闲槽连接也可显示在线/待验证。', '', '先接通已授权本机模型/API：登记设备后提交真实 API observations，由原出站 channel 接收 apiProbes，只读核验本机接口并返回原 UUID，管理员据真实往返回执显示连接。此步骤无需审核材料，不运行 GPU、不收费。正式付费调度仍单独检查发行、设备资格与计费。以下说明供外部机器的 AI 实现协议，不能代替用户账号授权。', '', '## 固定接口', '', ...routes.flatMap(r => ['- `' + r.method + ' ' + r.path + '` — ' + r.authentication + '; body: ' + (r.bodyFields.length ? r.bodyFields.join(', ') : '(empty)') + (r.queryFields.length ? '; query: ' + r.queryFields.join(', ') : '') + '. ' + r.notes]), '', '## 必须遵守', '', ...rules.map(r => '- ' + r), '', '本说明不包含实际账户、设备、密钥、IP 或本机目录。scope=' + scope + ' 仅描述当前管理读取范围，不授予节点执行权限。', ''].join('\n')
    return { ok: true, guide: { schema: 'qianshou.external-node-guide.v1', version: '2026-09-29.2', publicBaseUrl, scope, routes, rules, markdown }, integration: await observe() }
  }
  return { observe, guide }
}
