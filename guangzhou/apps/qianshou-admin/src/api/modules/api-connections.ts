/** Redacted device connections. Counts come from Guangzhou's durable task records. */
import { postJson } from '../client'
import { apply, preflight } from '../confirm'
import { ENDPOINTS } from '../endpoints'
import { AdminApiError } from '../errors'
import type { ApplyResult, ConfirmPreview } from '../types'

export type ConnectionAction = 'pause' | 'resume' | 'revoke'
export interface ApiDeviceInfo {
  readonly os: 'darwin' | 'win32' | 'linux'
  readonly osVersion: string | null
  readonly arch: 'arm64' | 'x64' | 'ia32' | 'arm'
  readonly deviceName: string | null
  readonly cpu: string | null
  readonly gpu: string | null
  readonly memoryMb: number | null
  readonly vramMb: number | null
}
export interface ApiLocalService {
  readonly mode: 'image' | 'video'
  readonly adapter: string
  readonly status: 'ready' | 'unavailable' | 'auth_required' | 'unsupported' | 'unknown'
  readonly model: { readonly id: string; readonly sha256: string | null; readonly version: string | null } | null
  readonly workflow: { readonly id: string; readonly sha256: string | null; readonly version: string | null } | null
  readonly observedAt: string
  readonly registration: 'reported'
  readonly probe: { readonly state: 'pending' | 'confirmed' | 'failed' | 'expired'; readonly completedAt: string | null }
}
export interface ApiConnection {
  readonly deviceId: string
  readonly ownerId: string
  readonly username: string | null
  readonly deviceInfo: ApiDeviceInfo | null
  readonly online: boolean
  readonly authorization: 'active' | 'paused' | 'revoked'
  readonly modes: readonly ('image' | 'video')[]
  readonly lastHeartbeatAt: string | null
  readonly connectionEpoch: number
  readonly activeTasks: number
  readonly totalTasks: number
  readonly settledTasks: number
  readonly localServices: readonly ApiLocalService[]
}
export interface ApiConnectionsList {
  readonly nodes: readonly ApiConnection[]
  readonly total: number
  readonly truncated: boolean
  readonly generatedAt: string
  readonly integration: ApiPlatformIntegration
}
export type IntegrationConfiguration = 'configured' | 'unavailable' | 'unknown'
export interface ApiPlatformIntegration {
  readonly checkedAt: string | null
  readonly probe: 'reachable' | 'unavailable' | 'unknown'
  readonly deviceChannel: IntegrationConfiguration
  readonly metadata: IntegrationConfiguration
  readonly exchange: IntegrationConfiguration
  readonly dispatch: IntegrationConfiguration
  readonly readiness: 'ready' | 'unavailable' | 'unknown'
  readonly code: string | null
}
export interface ApiConnectionGuide {
  readonly version: string
  readonly scope: 'self' | 'all'
  readonly markdown: string
}
export interface ApiConnectionDetail {
  readonly node: ApiConnection
  readonly tasks: readonly { readonly taskId: string; readonly attemptId: string; readonly stage: string }[]
  readonly audit: readonly { readonly ref: string; readonly action: ConnectionAction; readonly operatorAccountId: string; readonly reason: string; readonly occurredAt: string }[]
}
export interface ConnectionDraft { readonly deviceId: string; readonly action: ConnectionAction; readonly ref: string }
export interface ConnectionCheck { readonly ref: string; readonly recorded: boolean }
const invalid = (): never => { throw new AdminApiError({ status: 502, code: 'unexpected_response', message: '广州返回的设备状态不完整，请重新查询。' }) }
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid()
const id = (value: unknown): string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value) ? value : invalid()
const identifier = (value: unknown): string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/u.test(value) && !/(?:\d{1,3}\.){3}\d{1,3}/u.test(value) ? value : invalid()
const account = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]{0,15}$/u.test(value) ? value : invalid()
const count = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalid()
const bool = (value: unknown): boolean => typeof value === 'boolean' ? value : invalid()
const date = (value: unknown): string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/u.test(value) && Number.isFinite(Date.parse(value)) ? value : invalid()
const action = (value: unknown): ConnectionAction => value === 'pause' || value === 'resume' || value === 'revoke' ? value : invalid()
const safeNote = (value: unknown): string => typeof value === 'string' && value.length <= 200 && !/https?:|Bearer\s|(?:\d{1,3}\.){3}\d{1,3}|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/iu.test(value) ? value : invalid()
function publicLabel(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !value.trim() || new TextEncoder().encode(value).length > 256
    || /[\x00-\x1f\x7f/\\<>]|https?:|Bearer\s|(?:\d{1,3}\.){3}\d{1,3}/iu.test(value)) return invalid()
  return value
}
function parseDeviceInfo(value: unknown): ApiDeviceInfo | null {
  if (value === null || value === undefined) return null
  const row = object(value)
  if (typeof row.os !== 'string' || !['darwin', 'win32', 'linux'].includes(row.os)
    || typeof row.arch !== 'string' || !['arm64', 'x64', 'ia32', 'arm'].includes(row.arch)) return invalid()
  const memory = (value: unknown, minimum: number): number | null => value === null ? null
    : typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= 2097152 ? value : invalid()
  return { os: row.os as ApiDeviceInfo['os'], osVersion: publicLabel(row.osVersion), arch: row.arch as ApiDeviceInfo['arch'],
    deviceName: publicLabel(row.deviceName), cpu: publicLabel(row.cpu), gpu: publicLabel(row.gpu),
    memoryMb: memory(row.memoryMb, 1), vramMb: memory(row.vramMb, 0) }
}
export const UNKNOWN_API_INTEGRATION: ApiPlatformIntegration = Object.freeze({ checkedAt: null, probe: 'unknown',
  deviceChannel: 'unknown', metadata: 'unknown', exchange: 'unknown', dispatch: 'unknown', readiness: 'unknown', code: null })
const configuration = (value: unknown): IntegrationConfiguration => value === 'configured' || value === 'unavailable' || value === 'unknown' ? value : invalid()
function parseLocalServices(value: unknown, online: boolean, authorization: ApiConnection['authorization']): readonly ApiLocalService[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 2) return invalid()
  const publicId = (value: unknown): string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}$/u.test(value)
    && !/(?:\d{1,3}\.){3}\d{1,3}/u.test(value) && value !== 'localhost' && !value.includes('..') ? value : invalid()
  const utc = (value: unknown): string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(value) ? date(value) : invalid()
  const identity = (value: unknown): ApiLocalService['model'] => {
    if (value === null) return null
    const row = object(value)
    if (row.sha256 !== null && (typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(row.sha256))) return invalid()
    return { id: publicId(row.id), sha256: row.sha256 as string | null, version: row.version === null ? null : publicId(row.version) }
  }
  const now = Date.now()
  const services = value.map((item): ApiLocalService => {
    const row = object(item), probe = object(row.probe)
    if (row.mode !== 'image' && row.mode !== 'video' || !['ready', 'unavailable', 'auth_required', 'unsupported', 'unknown'].includes(String(row.status))
      || row.registration !== 'reported' || !['pending', 'confirmed', 'failed', 'expired'].includes(String(probe.state))) return invalid()
    const observedAt = utc(row.observedAt), completedAt = probe.completedAt === null ? null : utc(probe.completedAt)
    if (Date.parse(observedAt) > now + 60000 || completedAt !== null && Date.parse(completedAt) > now + 60000
      || probe.state === 'confirmed' && (completedAt === null || row.status !== 'ready')
      || probe.state === 'pending' && completedAt !== null) return invalid()
    const current = online && authorization === 'active'
    const expired = probe.state === 'confirmed' && (!current || Date.parse(completedAt!) <= now - 120000)
    const model = identity(row.model), workflow = identity(row.workflow)
    if (row.status === 'ready' && (model === null || workflow === null)) return invalid()
    return { mode: row.mode, adapter: publicId(row.adapter), status: current ? row.status as ApiLocalService['status'] : 'unknown',
      model, workflow, observedAt, registration: 'reported',
      probe: { state: expired ? 'expired' : probe.state as ApiLocalService['probe']['state'], completedAt } }
  })
  if (new Set(services.map(row => row.mode)).size !== services.length) return invalid()
  return services
}
/** Configuration and a public probe cannot establish formal exchange readiness. Older backends remain unknown. */
export function parseApiPlatformIntegration(value: unknown): ApiPlatformIntegration {
  if (value === undefined) return UNKNOWN_API_INTEGRATION
  const row = object(value)
  if (row.schema !== 'qianshou.api-platform-integration.v1' || row.publicBaseUrl !== 'https://app.qianshousuanli.com'
    || row.probePath !== '/v1/nodes/probe' || !['reachable', 'unavailable', 'unknown'].includes(String(row.probe))
    || !['ready', 'unavailable', 'unknown'].includes(String(row.readiness))
    || row.code !== null && (typeof row.code !== 'string' || !/^[A-Za-z0-9_]{1,100}$/u.test(row.code))) return invalid()
  return { checkedAt: date(row.checkedAt), probe: row.probe as ApiPlatformIntegration['probe'],
    deviceChannel: configuration(row.deviceChannel), metadata: configuration(row.metadata),
    exchange: configuration(row.exchange), dispatch: configuration(row.dispatch),
    readiness: row.readiness as ApiPlatformIntegration['readiness'], code: row.code as string | null }
}
/** Only project the documented fields; private transport and credential fields are discarded. */
export function parseApiConnection(value: unknown): ApiConnection {
  const row = object(value)
  if (!['active', 'paused', 'revoked'].includes(String(row.authorization)) || !Array.isArray(row.modes)
    || row.modes.length > 2 || row.modes.some(mode => mode !== 'image' && mode !== 'video')
    || new Set(row.modes).size !== row.modes.length) return invalid()
  const online = bool(row.online), authorization = row.authorization as ApiConnection['authorization']
  return { deviceId: identifier(row.deviceId), ownerId: account(row.ownerId), online,
    username: publicLabel(row.username), deviceInfo: parseDeviceInfo(row.deviceInfo),
    authorization, modes: row.modes as ApiConnection['modes'], localServices: parseLocalServices(row.localServices, online, authorization),
    lastHeartbeatAt: row.lastHeartbeatAt === null ? null : date(row.lastHeartbeatAt),
    connectionEpoch: count(row.connectionEpoch), activeTasks: count(row.activeTasks), totalTasks: count(row.totalTasks), settledTasks: count(row.settledTasks) }
}
export function parseApiConnectionsList(value: unknown): ApiConnectionsList {
  const body = object(value)
  if (body.ok !== true || !Array.isArray(body.nodes) || body.nodes.length > 1000) return invalid()
  return { nodes: body.nodes.map(parseApiConnection), total: count(body.total), truncated: bool(body.truncated), generatedAt: date(body.generatedAt),
    integration: parseApiPlatformIntegration(body.integration) }
}
export function parseApiConnectionDetail(value: unknown): ApiConnectionDetail {
  const body = object(value)
  if (body.ok !== true || !Array.isArray(body.tasks) || body.tasks.length > 100 || !Array.isArray(body.audit) || body.audit.length > 100) return invalid()
  return { node: parseApiConnection(body.node), tasks: body.tasks.map(value => {
    const row = object(value)
    const stage = row.stage
    if (typeof stage !== 'string' || !/^[a-z_]{1,40}$/u.test(stage)) return invalid()
    return { taskId: identifier(row.taskId), attemptId: identifier(row.attemptId), stage }
  }), audit: body.audit.map(value => {
    const row = object(value)
    return { ref: id(row.ref), action: action(row.action), operatorAccountId: account(row.operatorAccountId), reason: safeNote(row.reason), occurredAt: date(row.occurredAt) }
  }) }
}
export async function fetchApiConnections(signal?: AbortSignal): Promise<ApiConnectionsList> {
  return parseApiConnectionsList(await postJson(ENDPOINTS.apiConnectionsList, {}, signal))
}
/** The server publishes a fixed, public protocol; caller identity and transport secrets are not projected. */
export function parseApiConnectionGuide(value: unknown): ApiConnectionGuide {
  const body = object(value)
  const guide = object(body.guide)
  if (body.ok !== true || guide.schema !== 'qianshou.external-node-guide.v1' || guide.publicBaseUrl !== 'https://app.qianshousuanli.com'
    || typeof guide.version !== 'string' || !/^\d{4}-\d{2}-\d{2}\.\d{1,6}$/u.test(guide.version)
    || guide.scope !== 'self' && guide.scope !== 'all' || typeof guide.markdown !== 'string' || !guide.markdown.trim()
    || new TextEncoder().encode(guide.markdown).length > 96 * 1024 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(guide.markdown)
    || /https?:\/\/(?!app\.qianshousuanli\.com(?:[\s/)>`"'\]]|$))/iu.test(guide.markdown)
    || /Bearer\s+[A-Za-z0-9._~+\/-]{16,}/u.test(guide.markdown)) return invalid()
  return { version: guide.version, scope: guide.scope, markdown: guide.markdown }
}
export async function fetchApiConnectionGuide(signal?: AbortSignal): Promise<ApiConnectionGuide> {
  return parseApiConnectionGuide(await postJson(ENDPOINTS.apiConnectionsGuide, {}, signal))
}
export async function fetchApiConnection(deviceId: string, signal?: AbortSignal): Promise<ApiConnectionDetail> {
  return parseApiConnectionDetail(await postJson(ENDPOINTS.apiConnectionsDetail, { deviceId: identifier(deviceId) }, signal))
}
export function preflightApiConnection(draft: ConnectionDraft): Promise<ConfirmPreview> {
  return preflight(ENDPOINTS.apiConnectionsPreflight, { ...draft })
}
export function applyApiConnection(draft: ConnectionDraft, token: string, reason: string): Promise<ApplyResult> {
  return apply(ENDPOINTS.apiConnectionsApply, token, reason, { ...draft })
}
export async function checkApiConnection(ref: string): Promise<ConnectionCheck> {
  const body = object(await postJson(ENDPOINTS.apiConnectionsCheck, { ref: id(ref) }))
  if (body.ref !== ref) return invalid()
  return { ref, recorded: bool(body.recorded) }
}
