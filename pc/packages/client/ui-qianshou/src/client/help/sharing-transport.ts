import type { SharingApiState, SharingAuthorization, SharingCommand, SharingConnectionState, SharingLocalState, SharingMode,
  SharingOperationReceipt, SharingSnapshot } from './sharing-types.ts'

export interface SharingTransport {
  read(signal: AbortSignal, requestId?: string): Promise<SharingSnapshot>
  command(command: SharingCommand, signal: AbortSignal): Promise<SharingSnapshot>
}

/** Project a local status failure to a fixed, address-free UI reason.
 * @param error - The Host or transport failure.
 * @returns A bounded reason without upstream response text.
 */
export function sharingReadFailure(error: unknown): 'timeout' | 'host_missing' | 'host_unavailable' | 'login' | 'response_invalid' | 'unknown' {
  const code = error instanceof Error ? error.message : ''
  const abort = error !== null && typeof error === 'object' && 'name' in error && error.name === 'AbortError'
  if (code === 'SHARING_STATUS_UNAVAILABLE' || code === 'SHARING_REQUEST_ABORTED'
    || abort) return 'timeout'
  if (code === 'SHARING_HOST_MISSING') return 'host_missing'
  if (code === 'SHARING_LOGIN_REQUIRED') return 'login'
  if (code === 'SHARING_RESPONSE_INVALID') return 'response_invalid'
  if (code === 'SHARING_UNAVAILABLE' || error instanceof TypeError) return 'host_unavailable'
  return 'unknown'
}

async function statusError(result: Response): Promise<Error> {
  if (result.status === 404) return new Error('SHARING_HOST_MISSING')
  if (result.status === 401 || result.status === 403) return new Error('SHARING_LOGIN_REQUIRED')
  if (result.status !== 503 || !result.headers.get('content-type')?.startsWith('application/json')) {
    return new Error('SHARING_UNAVAILABLE')
  }
  const reader = result.body?.getReader()
  if (reader === undefined) return new Error('SHARING_UNAVAILABLE')
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    while (size <= 512) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 512) break
      chunks.push(chunk.value)
    }
  } catch { return new Error('SHARING_UNAVAILABLE') }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
  if (size > 512) return new Error('SHARING_UNAVAILABLE')
  try {
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    const data = new TextDecoder().decode(bytes)
    const value: unknown = JSON.parse(data)
    if (value !== null && typeof value === 'object' && !Array.isArray(value)
      && 'error' in value && value.error !== null && typeof value.error === 'object'
      && !Array.isArray(value.error) && 'code' in value.error
      && value.error.code === 'SHARING_STATUS_UNAVAILABLE') return new Error('SHARING_STATUS_UNAVAILABLE')
  } catch { /* An unknown Host response is only an unavailable status. */ }
  return new Error('SHARING_UNAVAILABLE')
}

/** Only the authenticated local Host handles configuration, credentials and model bytes. */
export function createSharingTransport(request: typeof fetch = fetch): SharingTransport {
  const send = async (path: string, signal: AbortSignal, body?: object): Promise<SharingSnapshot> => {
    const result = await request('/api/qianshou/node/sharing/' + path, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal,
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!result.ok) throw await statusError(result)
    return parseSharingSnapshot(await result.json())
  }
  return { read: (signal, requestId) => send('status' + (requestId === undefined ? ''
    : '?request_id=' + encodeURIComponent(requestId)), signal), command: (command, signal) => {
    const { action, ...body } = command
    return send(action, signal, body)
  } }
}

/** Do not spread server objects into the renderer: private endpoints and keys are omitted. */
export function parseSharingSnapshot(value: unknown): SharingSnapshot {
  const record = (row: unknown): Record<string, unknown> => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new Error('SHARING_RESPONSE_INVALID')
    return row as Record<string, unknown>
  }
  const text = (row: unknown): string | null => {
    if (row === null) return null
    if (typeof row !== 'string' || row.length > 128 || /[\x00-\x1f\x7f]/u.test(row)
      || /https?:\/\/|(?:\d{1,3}\.){3}\d{1,3}|localhost|Bearer\s/iu.test(row)) throw new Error('SHARING_RESPONSE_INVALID')
    return row
  }
  const number = (row: unknown): number | null => {
    if (row === null) return null
    if (typeof row !== 'number' || !Number.isSafeInteger(row) || row < 0) throw new Error('SHARING_RESPONSE_INVALID')
    return row
  }
  const root = record(value)
  if (root.schema !== 'qianshou.compute-sharing.v1' || typeof root.authenticated !== 'boolean'
    || !Array.isArray(root.modes) || root.modes.length !== 2) throw new Error('SHARING_RESPONSE_INVALID')
  const uuid = (row: unknown): row is string => typeof row === 'string'
    && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(row)
  const scopeId = root.scopeId ?? null
  if (scopeId !== null && (!uuid(scopeId) || !root.authenticated)) throw new Error('SHARING_RESPONSE_INVALID')
  let operation: SharingOperationReceipt | null = null
  if (root.operation !== undefined && root.operation !== null) {
    const item = record(root.operation)
    if (!uuid(item.requestId) || !['applied', 'not_found'].includes(String(item.status))) throw new Error('SHARING_RESPONSE_INVALID')
    if (item.status === 'not_found') {
      if (item.mode !== null || item.action !== null) throw new Error('SHARING_RESPONSE_INVALID')
      operation = { requestId: item.requestId, status: 'not_found', mode: null, action: null }
    } else {
      if (!['image', 'video'].includes(String(item.mode)) || !['enable', 'pause', 'resume', 'revoke'].includes(String(item.action))
        || scopeId === null) throw new Error('SHARING_RESPONSE_INVALID')
      operation = { requestId: item.requestId, status: 'applied', mode: item.mode as 'image' | 'video',
        action: item.action as 'enable' | 'pause' | 'resume' | 'revoke' }
    }
  }
  const hardware = root.hardware === null ? null : record(root.hardware)
  let connection: SharingConnectionState = { gateway: 'unknown', deviceAuthorization: 'unknown', channel: 'idle',
    heartbeat: 'unknown', checkedAt: null, heartbeatAt: null }
  if (root.connection !== undefined) {
    const item = record(root.connection)
    if (typeof item.gateway !== 'string' || !['unknown', 'unconfigured', 'checking', 'reachable', 'unavailable'].includes(item.gateway)
      || typeof item.deviceAuthorization !== 'string' || !['unknown', 'authorized', 'unauthorized'].includes(item.deviceAuthorization)
      || typeof item.channel !== 'string' || !['idle', 'connecting', 'connected', 'offline'].includes(item.channel)
      || typeof item.heartbeat !== 'string' || !['unknown', 'accepted'].includes(item.heartbeat)) throw new Error('SHARING_RESPONSE_INVALID')
    const checkedAt = number(item.checkedAt); const heartbeatAt = number(item.heartbeatAt)
    const now = Math.floor(Date.now() / 1000)
    if (checkedAt !== null && checkedAt > now + 60 || heartbeatAt !== null && heartbeatAt > now + 60
      || item.gateway === 'reachable' && (checkedAt === null || checkedAt < now - 60)
      || item.deviceAuthorization === 'authorized' && (!root.authenticated || item.channel !== 'connected')
      || item.channel === 'connected' && item.deviceAuthorization !== 'authorized'
      || item.heartbeat === 'accepted' && (item.channel !== 'connected' || heartbeatAt === null || heartbeatAt < now - 60)
      || item.heartbeat === 'unknown' && heartbeatAt !== null) throw new Error('SHARING_RESPONSE_INVALID')
    connection = { gateway: item.gateway as SharingConnectionState['gateway'],
      deviceAuthorization: item.deviceAuthorization as SharingConnectionState['deviceAuthorization'],
      channel: item.channel as SharingConnectionState['channel'], heartbeat: item.heartbeat as SharingConnectionState['heartbeat'],
      checkedAt, heartbeatAt }
  }
  const phases = ['idle', 'detecting', 'matching', 'downloading', 'installing', 'starting', 'connecting', 'recovering', 'sharing', 'paused', 'blocked', 'failed']
  const reasons = ['catalog_unavailable', 'hardware_unsupported', 'disk_space', 'login_required', 'verification_pending', 'runtime_unavailable', 'connection_unavailable', 'download_failed', 'owner_policy_blocked', 'consent_required', 'idle_required', 'resource_unavailable', 'execution_disabled']
  const modes = root.modes.map((row) => {
    const item = record(row)
    let authorization: SharingAuthorization = { connection: 'required', execution: 'disabled', deviceBound: false }
    if (item.authorization !== undefined) {
      const grant = record(item.authorization)
      if (!['required', 'granted', 'revoked'].includes(String(grant.connection))
        || !['disabled', 'idle_only'].includes(String(grant.execution)) || typeof grant.deviceBound !== 'boolean'
        || grant.connection === 'granted' && (scopeId === null || !grant.deviceBound)
        || grant.execution === 'idle_only' && grant.connection !== 'granted') throw new Error('SHARING_RESPONSE_INVALID')
      authorization = { connection: grant.connection as SharingAuthorization['connection'],
        execution: grant.execution as SharingAuthorization['execution'], deviceBound: grant.deviceBound }
    }
    let local: SharingLocalState = { inventory: 'unknown', modelCount: null, runtime: 'unknown', adapter: null,
      adoption: 'unmatched', checkedAt: null }
    if (item.local !== undefined) {
      const observed = record(item.local)
      if (typeof observed.inventory !== 'string' || !['unknown', 'detected', 'empty', 'unavailable'].includes(observed.inventory)
        || typeof observed.runtime !== 'string' || !['unknown', 'ready', 'unavailable', 'unsupported', 'authentication_required'].includes(observed.runtime)
        || observed.adapter !== null && (typeof observed.adapter !== 'string' || !['comfyui', 'qianshou_image', 'qianshou_media_runtime'].includes(observed.adapter))
        || typeof observed.adoption !== 'string' || !['unmatched', 'verification_required', 'reusable', 'reused'].includes(observed.adoption)) throw new Error('SHARING_RESPONSE_INVALID')
      const modelCount = number(observed.modelCount); const checkedAt = number(observed.checkedAt)
      const now = Math.floor(Date.now() / 1000)
      if (modelCount !== null && modelCount > 5000 || observed.inventory === 'detected' && (modelCount === null || modelCount === 0)
        || observed.inventory === 'empty' && modelCount !== 0
        || ['unknown', 'unavailable'].includes(observed.inventory) && modelCount !== null
        || checkedAt !== null && checkedAt > now + 60
        || (observed.runtime === 'ready' || ['reusable', 'reused'].includes(observed.adoption))
          && (checkedAt === null || checkedAt < now - 60)
        || ['reusable', 'reused'].includes(observed.adoption) && observed.adapter !== 'qianshou_media_runtime'
        || observed.adoption === 'reused' && observed.runtime !== 'ready') throw new Error('SHARING_RESPONSE_INVALID')
      local = { inventory: observed.inventory as SharingLocalState['inventory'], modelCount,
        runtime: observed.runtime as SharingLocalState['runtime'], adapter: observed.adapter as SharingLocalState['adapter'],
        adoption: observed.adoption as SharingLocalState['adoption'], checkedAt }
    }
    let api: SharingApiState = { status: 'unknown', adapter: null, modelName: null, workflowName: null,
      registration: 'unknown', lastProbedAt: null, probeStatus: 'unknown' }
    if (item.api !== undefined) {
      const observed = record(item.api)
      if (typeof observed.status !== 'string' || !['ready', 'unavailable', 'auth_required', 'unsupported', 'unknown'].includes(observed.status)
        || observed.adapter !== null && (typeof observed.adapter !== 'string'
          || !['qianshou_image', 'comfyui', 'qianshou_media_runtime'].includes(observed.adapter))
        || typeof observed.registration !== 'string' || !['pending', 'registered', 'unavailable', 'unknown'].includes(observed.registration)
        || typeof observed.probeStatus !== 'string' || !['passed', 'failed', 'pending', 'unknown'].includes(observed.probeStatus)) {
        throw new Error('SHARING_RESPONSE_INVALID')
      }
      const label = (value: unknown): string | null => {
        const valueText = text(value)
        if (valueText !== null && (!valueText.trim() || /[/\\<>]/u.test(valueText))) throw new Error('SHARING_RESPONSE_INVALID')
        return valueText
      }
      const modelName = label(observed.modelName), workflowName = label(observed.workflowName)
      const lastProbedAt = observed.lastProbedAt
      const now = Date.now()
      if (lastProbedAt !== null && (typeof lastProbedAt !== 'string'
        || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(lastProbedAt)
        || !Number.isFinite(Date.parse(lastProbedAt)) || Date.parse(lastProbedAt) > now + 60000)
        || observed.status === 'ready' && (observed.adapter === null || modelName === null || workflowName === null)
        || observed.probeStatus === 'passed' && (observed.status !== 'ready' || observed.registration !== 'registered'
          || lastProbedAt === null)) throw new Error('SHARING_RESPONSE_INVALID')
      const current = root.authenticated && scopeId !== null && authorization.connection === 'granted'
        && connection.deviceAuthorization === 'authorized' && connection.channel === 'connected' && connection.heartbeat === 'accepted'
      const fresh = lastProbedAt !== null && Date.parse(lastProbedAt) > now - 120000
      api = { status: observed.status as SharingApiState['status'], adapter: observed.adapter as SharingApiState['adapter'],
        modelName, workflowName, registration: !current && observed.registration === 'registered' ? 'unknown'
          : observed.registration as SharingApiState['registration'], lastProbedAt,
        probeStatus: observed.probeStatus === 'passed' && (!current || !fresh)
          ? 'unknown' : observed.probeStatus as SharingApiState['probeStatus'] }
    }
    if (typeof item.mode !== 'string' || !['image', 'video'].includes(item.mode)
      || typeof item.phase !== 'string' || !phases.includes(item.phase)
      || item.reason !== null && (typeof item.reason !== 'string' || !reasons.includes(item.reason))
      || !Array.isArray(item.completedSteps) || item.completedSteps.length > 7
      || item.completedSteps.some(step => typeof step !== 'string' || !['detect', 'download', 'install', 'api', 'connect', 'persist', 'earnings'].includes(step))) throw new Error('SHARING_RESPONSE_INVALID')
    const settledYuan = text(item.settledYuan)
    if (settledYuan !== null && !/^\d+(?:\.\d{1,4})?$/u.test(settledYuan)) throw new Error('SHARING_RESPONSE_INVALID')
    return { mode: item.mode as SharingMode, phase: item.phase as SharingSnapshot['modes'][number]['phase'],
      operationId: text(item.operationId), modelName: text(item.modelName),
      downloadedBytes: number(item.downloadedBytes), totalDownloadBytes: number(item.totalDownloadBytes),
      completedSteps: item.completedSteps as string[], reason: item.reason as SharingSnapshot['modes'][number]['reason'],
      completedCalls: number(item.completedCalls), settledYuan, local, authorization, api }
  })
  if (new Set(modes.map(row => row.mode)).size !== 2) throw new Error('SHARING_RESPONSE_INVALID')
  if (modes.every(row => row.completedCalls !== null)
    && !Number.isSafeInteger(modes.reduce((sum, row) => sum + (row.completedCalls ?? 0), 0))) throw new Error('SHARING_RESPONSE_INVALID')
  return { schema: 'qianshou.compute-sharing.v1', authenticated: root.authenticated,
    scopeId, operation, hardware: hardware === null ? null : { name: text(hardware.name) ?? '', memoryMb: number(hardware.memoryMb) ?? 0 },
    connection, modes }
}
