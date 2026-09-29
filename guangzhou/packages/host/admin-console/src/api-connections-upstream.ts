/** Dedicated scope-bound administrator metadata client. No node credential or media bytes cross this API. */
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { isIP } from 'node:net'
import { CREDENTIALS_FILENAME, parseRefsDocument } from './upstream-keys.ts'
import type { WorkbenchAdminConfig } from './workbench-upstream.ts'
import { createApiPlatformMetadata, type ApiPlatformConfig } from './api-connections-platform.ts'

export class ApiConnectionsError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code }
}
/** Read-only local API evidence; it does not grant paid capability or idle GPU capacity. */
export interface ApiLocalServiceProjection {
  mode: 'image' | 'video'; adapter: string; status: 'ready' | 'unavailable' | 'auth_required' | 'unsupported' | 'unknown'
  model: { id: string; sha256: string | null; version: string | null } | null
  workflow: { id: string; sha256: string | null; version: string | null } | null
  observedAt: string; registration: 'reported'
  probe: { state: 'pending' | 'confirmed' | 'failed' | 'expired'; completedAt: string | null }
}
export interface ApiNodeProjection {
  deviceId: string; ownerId: string; online: boolean; authorization: 'active' | 'paused' | 'revoked';
  modes: ('image' | 'video')[]; lastHeartbeatAt: string | null; connectionEpoch: number;
  activeTasks: number; totalTasks: number; settledTasks: number; localServices?: ApiLocalServiceProjection[]
  username?: string | null; deviceInfo?: ApiDeviceInfoProjection | null
}
/** Device-reported display labels; they confer no verified hardware capability. */
export interface ApiDeviceInfoProjection {
  os: 'darwin' | 'win32' | 'linux'; osVersion: string | null; arch: 'arm64' | 'x64' | 'ia32' | 'arm'
  deviceName: string | null; cpu: string | null; gpu: string | null; memoryMb: number | null; vramMb: number | null
}
const row = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CONTRACT_INVALID')
  return value as Record<string, unknown>
}
const localService = (value: unknown): ApiLocalServiceProjection => {
  const p = row(value); const q = row(p['probe'])
  const identifier = (v: unknown): string => {
    if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}$/u.test(v) || isIP(v) !== 0 || v === 'localhost' || v.includes('..')) throw new Error('CONTRACT_INVALID')
    return v
  }
  const time = (v: unknown): string => {
    if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(v) || !Number.isFinite(Date.parse(v))) throw new Error('CONTRACT_INVALID')
    return v
  }
  const identity = (v: unknown): ApiLocalServiceProjection['model'] => {
    if (v === null) return null
    const i = row(v)
    if (i['sha256'] !== null && (typeof i['sha256'] !== 'string' || !/^[0-9a-f]{64}$/u.test(i['sha256']))) throw new Error('CONTRACT_INVALID')
    return { id: identifier(i['id']), sha256: i['sha256'] as string | null, version: i['version'] === null ? null : identifier(i['version']) }
  }
  if (p['mode'] !== 'image' && p['mode'] !== 'video' || !['ready', 'unavailable', 'auth_required', 'unsupported', 'unknown'].includes(String(p['status']))
    || p['registration'] !== 'reported' || !['pending', 'confirmed', 'failed', 'expired'].includes(String(q['state']))) throw new Error('CONTRACT_INVALID')
  const model = identity(p['model']); const workflow = identity(p['workflow'])
  if (p['status'] === 'ready' && (!model || !workflow) || q['state'] === 'confirmed' && q['completedAt'] === null) throw new Error('CONTRACT_INVALID')
  return { mode: p['mode'] as ApiLocalServiceProjection['mode'], adapter: identifier(p['adapter']), status: p['status'] as ApiLocalServiceProjection['status'],
    model, workflow, observedAt: time(p['observedAt']), registration: 'reported', probe: { state: q['state'] as ApiLocalServiceProjection['probe']['state'],
      completedAt: q['completedAt'] === null ? null : time(q['completedAt']) } }
}
const projection = (value: unknown): ApiNodeProjection => {
  const p = row(value)
  const fields = ['deviceId', 'ownerId', 'online', 'authorization', 'modes', 'lastHeartbeatAt', 'connectionEpoch', 'activeTasks', 'totalTasks', 'settledTasks']
  const optional = ['localServices', 'username', 'deviceInfo']
  if (Object.keys(p).length !== fields.length + optional.filter(k => Object.hasOwn(p, k)).length || Object.keys(p).some(k => !fields.includes(k) && !optional.includes(k))
    || typeof p['deviceId'] !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(p['deviceId']) || typeof p['ownerId'] !== 'string' || !/^[1-9][0-9]*$/u.test(p['ownerId'])
    || typeof p['online'] !== 'boolean' || !['active', 'paused', 'revoked'].includes(String(p['authorization']))
    || !Array.isArray(p['modes']) || p['modes'].some(x => x !== 'image' && x !== 'video')
    || p['lastHeartbeatAt'] !== null && (typeof p['lastHeartbeatAt'] !== 'string' || !Number.isFinite(Date.parse(p['lastHeartbeatAt'])))
    || ['activeTasks', 'totalTasks', 'settledTasks'].some(k => !Number.isSafeInteger(p[k]) || Number(p[k]) < 0)
    || !Number.isSafeInteger(p['connectionEpoch']) || Number(p['connectionEpoch']) < 1) throw new Error('CONTRACT_INVALID')
  let localServices: ApiLocalServiceProjection[] | undefined
  if (p['localServices'] !== undefined) {
    if (!Array.isArray(p['localServices']) || p['localServices'].length > 2) throw new Error('CONTRACT_INVALID')
    localServices = p['localServices'].map(localService)
    if (new Set(localServices.map(s => s.mode)).size !== localServices.length) throw new Error('CONTRACT_INVALID')
  }
  let username: string | null | undefined
  if (Object.hasOwn(p, 'username')) {
    if (p['username'] !== null && (typeof p['username'] !== 'string' || !p['username'].trim() || Buffer.byteLength(p['username']) > 512 || /[\u0000-\u001f\u007f]/u.test(p['username']))) throw new Error('CONTRACT_INVALID')
    username = p['username'] as string | null
  }
  let deviceInfo: ApiDeviceInfoProjection | null | undefined
  if (Object.hasOwn(p, 'deviceInfo')) {
    if (p['deviceInfo'] === null) deviceInfo = null
    else {
      const info = row(p['deviceInfo']); const keys = ['os', 'osVersion', 'arch', 'deviceName', 'cpu', 'gpu', 'memoryMb', 'vramMb']
      if (Object.keys(info).length !== keys.length || Object.keys(info).some(k => !keys.includes(k))
        || typeof info['os'] !== 'string' || !['darwin', 'win32', 'linux'].includes(info['os'])
        || typeof info['arch'] !== 'string' || !['arm64', 'x64', 'ia32', 'arm'].includes(info['arch'])) throw new Error('CONTRACT_INVALID')
      for (const key of ['osVersion', 'deviceName', 'cpu', 'gpu']) {
        const v = info[key]
        if (v !== null && (typeof v !== 'string' || !v.trim() || Buffer.byteLength(v) > 256 || /[\u0000-\u001f\u007f/\\]/u.test(v) || v.includes('://') || isIP(v) !== 0)) throw new Error('CONTRACT_INVALID')
      }
      for (const key of ['memoryMb', 'vramMb']) if (info[key] !== null && (!Number.isSafeInteger(info[key]) || Number(info[key]) < (key === 'memoryMb' ? 1 : 0) || Number(info[key]) > 2_097_152)) throw new Error('CONTRACT_INVALID')
      deviceInfo = Object.fromEntries(keys.map(k => [k, info[k]])) as unknown as ApiDeviceInfoProjection
    }
  }
  return { ...Object.fromEntries(fields.map(k => [k, p[k]])) as unknown as ApiNodeProjection,
    ...(localServices === undefined ? {} : { localServices }), ...(username === undefined ? {} : { username }), ...(deviceInfo === undefined ? {} : { deviceInfo }) }
}

export function createApiConnectionsUpstream(options: { config?: WorkbenchAdminConfig; platform?: ApiPlatformConfig; dshHome: string; fetch?: typeof fetch; now?: () => number }) {
  const config = options.config
  const platform = createApiPlatformMetadata({ ...(options.platform === undefined ? {} : { config: options.platform }), ...(options.fetch === undefined ? {} : { fetch: options.fetch }), ...(options.now === undefined ? {} : { now: options.now }) })
  let origin: string | undefined
  if (config) {
    const u = new URL(config.baseUrl)
    if (u.username || u.password || u.search || u.hash || u.pathname !== '/' || !(u.protocol === 'https:' || u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
      || !/^[A-Z][A-Z0-9_]*$/u.test(config.credentialRef) || !/^[A-Za-z0-9_-]{1,64}$/u.test(config.keyId) || !config.audience.trim()) throw new Error('API_CONNECTIONS_CONFIG_INVALID')
    origin = u.origin
  }
  const request = async (action: 'list' | 'detail' | 'preflight' | 'apply' | 'check', input: {
    operatorAccountId: string; operatorRole: string; scope: 'self' | 'all'; ref: string; body: Record<string, unknown>
  }): Promise<Record<string, unknown>> => {
    if (!config || !origin) throw new ApiConnectionsError(503, 'dependency_unavailable', '节点管理服务身份尚未配置。')
    let key: string
    try {
      const handle = await open(join(options.dshHome, CREDENTIALS_FILENAME), constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const info = await handle.stat()
        if (!info.isFile() || (info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid() || info.size > 1024 * 1024 || process.env[config.credentialRef] !== undefined) throw new Error('CREDENTIAL_INVALID')
        const value = parseRefsDocument(await handle.readFile('utf8')).refs.get(config.credentialRef)
        if (!value || !/^[A-Za-z0-9_-]{43,256}$/u.test(value)) throw new Error('CREDENTIAL_INVALID')
        key = value
      } finally { await handle.close() }
    } catch { throw new ApiConnectionsError(503, 'api_connections_credentials_unavailable', '节点管理专用凭据未就绪。') }
    try {
      const response = await (options.fetch ?? fetch)(origin + '/internal/media/admin/' + action, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { authorization: 'Bearer ' + key, 'x-qianshou-service-key-id': config.keyId, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ ...input.body, ref: input.ref, _admin: { audience: config.audience, operatorAccountId: input.operatorAccountId, operatorRole: input.operatorRole, operationId: input.ref, scope: input.scope } }),
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new ApiConnectionsError(response.status, response.status === 409 ? 'api_connections_conflict' : response.status === 401 || response.status === 403 ? 'api_connections_service_unauthorized' : 'api_connections_rejected', '节点管理服务拒绝本次请求；请保留原操作号核查。')
      }
      const reader = response.body?.getReader(); if (!reader) throw new Error('CONTRACT_INVALID')
      const chunks: Buffer[] = []; let size = 0
      try { while (true) { const r = await reader.read(); if (r.done) break; size += r.value.length; if (size > 2 * 1024 * 1024) throw new Error('CONTRACT_TOO_LARGE'); chunks.push(Buffer.from(r.value)) } }
      finally { await reader.cancel().catch(() => undefined) }
      const result = row(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      if (result['ok'] !== true) throw new Error('CONTRACT_INVALID')
      if (action === 'list') {
        if (!Array.isArray(result['nodes']) || !Number.isSafeInteger(result['total']) || Number(result['total']) < 0 || typeof result['truncated'] !== 'boolean' || typeof result['generatedAt'] !== 'string' || !Number.isFinite(Date.parse(result['generatedAt']))) throw new Error('CONTRACT_INVALID')
        const nodes = result['nodes'].map(projection)
        if (input.scope === 'self' && nodes.some(n => n.ownerId !== input.operatorAccountId)) throw new Error('SCOPE_VIOLATION')
        return { ok: true, nodes, total: result['total'], truncated: result['truncated'], generatedAt: result['generatedAt'], integration: await platform.observe(result['integration']) }
      }
      if (action === 'detail') {
        const node = projection(result['node'])
        if (input.scope === 'self' && node.ownerId !== input.operatorAccountId || node.deviceId !== input.body['deviceId'] || !Array.isArray(result['tasks']) || !Array.isArray(result['audit'])) throw new Error('CONTRACT_INVALID')
        const tasks = result['tasks'].map(value => { const p = row(value); if (Object.keys(p).length !== 3 || ['taskId', 'attemptId', 'stage'].some(k => typeof p[k] !== 'string')) throw new Error('CONTRACT_INVALID'); return { taskId: p['taskId'], attemptId: p['attemptId'], stage: p['stage'] } })
        const audit = result['audit'].map(value => { const p = row(value); if (Object.keys(p).length !== 5 || ['ref', 'action', 'operatorAccountId', 'reason', 'occurredAt'].some(k => typeof p[k] !== 'string')) throw new Error('CONTRACT_INVALID'); return Object.fromEntries(['ref', 'action', 'operatorAccountId', 'reason', 'occurredAt'].map(k => [k, p[k]])) })
        return { ok: true, node, tasks, audit }
      }
      if (result['ref'] !== input.ref) throw new Error('CONTRACT_INVALID')
      return result
    } catch (error) {
      if (error instanceof ApiConnectionsError) throw error
      throw new ApiConnectionsError(502, action === 'apply' ? 'api_connections_outcome_unknown' : 'api_connections_unavailable', action === 'apply' ? '节点操作结果未确认，请用原操作号查询，勿重复应用。' : '节点管理服务暂不可用。')
    }
  }
  return { configured: config !== undefined, request, guide: platform.guide }
}
