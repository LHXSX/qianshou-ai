// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { createSharingTransport, parseSharingSnapshot, sharingReadFailure } from '../src/client/help/sharing-transport.ts'
import { SHARING_CONSENT_VERSION } from '../src/client/help/sharing-types.ts'

const scopeId = '10000000-0000-4000-8000-000000000001'
const requestId = '20000000-0000-4000-8000-000000000001'

function receipt() {
  const mode = (name: string) => ({ mode: name, phase: 'idle', operationId: null, modelName: null,
    downloadedBytes: null, totalDownloadBytes: null, completedSteps: [], reason: null,
    completedCalls: null, settledYuan: null })
  return { schema: 'qianshou.compute-sharing.v1', authenticated: true, hardware: null,
    modes: [mode('image'), mode('video')] }
}
it('keeps credentials and private service addresses out of the renderer receipt', () => {
  const value = receipt()
  const parsed = parseSharingSnapshot({ ...value, token: 'secret', upstream: 'http://192.168.0.10',
    modes: value.modes.map(row => ({ ...row, secret: 'private-node-token' })) })
  expect(JSON.stringify(parsed)).not.toMatch(/secret|192\.168|upstream/u)
  expect(() => parseSharingSnapshot({ ...value, hardware: { name: 'http://127.0.0.1:8000', memoryMb: 8192 } }))
    .toThrow('SHARING_RESPONSE_INVALID')
})
it('rejects duplicate modes and fabricated, negative or imprecise earnings instead of showing zero', () => {
  const value = receipt()
  expect(parseSharingSnapshot(value).modes[0]?.settledYuan).toBeNull()
  expect(() => parseSharingSnapshot({ ...value, modes: [value.modes[0], value.modes[0]] })).toThrow()
  for (const change of [{ settledYuan: '1.12345' }, { settledYuan: '-0.5' }, { completedCalls: -1 },
    { completedCalls: Number.MAX_SAFE_INTEGER + 1 }, { phase: 'pretend-ready' }]) {
    expect(() => parseSharingSnapshot({ ...value, modes: [{ ...value.modes[0], ...change }, value.modes[1]] })).toThrow()
  }
})
it('uses only authenticated same-origin endpoints with one stable command identity', async () => {
  const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(receipt()), { status: 200 }))
  const transport = createSharingTransport(request)
  const signal = new AbortController().signal
  await transport.read(signal)
  const consent = { version: SHARING_CONSENT_VERSION, connection: true as const, execution: 'idle_only' as const }
  await transport.command({ mode: 'image', action: 'enable', requestId, scopeId, consent }, signal)
  await transport.read(signal, requestId)
  await transport.command({ mode: 'image', action: 'pause', requestId, scopeId }, signal)
  expect(request.mock.calls).toHaveLength(4)
  expect(request.mock.calls[0]?.[0]).toBe('/api/qianshou/node/sharing/status')
  const [url, init] = request.mock.calls[1]!
  expect(url).toBe('/api/qianshou/node/sharing/enable')
  expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', signal })
  const body = init?.body
  if (typeof body !== 'string') throw new Error('expected a JSON request body')
  expect(JSON.parse(body)).toEqual({ mode: 'image', requestId, scopeId, consent })
  expect(request.mock.calls[2]?.[0]).toBe('/api/qianshou/node/sharing/status?request_id=' + requestId)
  expect(request.mock.calls[2]?.[1]).toMatchObject({ method: 'GET', credentials: 'same-origin' })
  const pauseBody = request.mock.calls[3]?.[1]?.body
  if (typeof pauseBody !== 'string') throw new Error('expected a JSON pause body')
  expect(JSON.parse(pauseBody)).toEqual({ mode: 'image', requestId, scopeId })
})
it('distinguishes a missing Host route from a bounded local status timeout without exposing response text', async () => {
  const status = new AbortController().signal
  const missing = createSharingTransport(async () => new Response('missing', { status: 404 }))
  await expect(missing.read(status)).rejects.toThrow('SHARING_HOST_MISSING')
  const timedOut = createSharingTransport(async () => Response.json({ error: {
    code: 'SHARING_STATUS_UNAVAILABLE', token: 'private-local-secret' }, endpoint: 'http://127.0.0.1:8188',
  }, { status: 503 }))
  await expect(timedOut.read(status)).rejects.toThrow('SHARING_STATUS_UNAVAILABLE')
  expect(sharingReadFailure(new Error('SHARING_HOST_MISSING'))).toBe('host_missing')
  expect(sharingReadFailure(new Error('SHARING_STATUS_UNAVAILABLE'))).toBe('timeout')
  expect(sharingReadFailure(new Error('SHARING_RESPONSE_INVALID'))).toBe('response_invalid')
  expect(sharingReadFailure(new DOMException('The operation was aborted', 'AbortError'))).toBe('timeout')
  expect(sharingReadFailure(new TypeError('Failed to fetch'))).toBe('host_unavailable')
})

it('projects scoped consent separately from qualification and rejects contradictory grants or operation receipts', () => {
  const value = receipt()
  const authorization = { connection: 'granted', execution: 'idle_only', deviceBound: true }
  const modes = value.modes.map(row => ({ ...row, reason: 'idle_required', authorization }))
  const operation = { requestId, mode: 'image', action: 'enable', status: 'applied' }
  const parsed = parseSharingSnapshot({ ...value, scopeId, operation, modes })
  expect(parsed.scopeId).toBe(scopeId)
  expect(parsed.operation).toEqual(operation)
  expect(parsed.modes[0]?.authorization).toEqual(authorization)
  expect(parsed.modes[0]?.phase).toBe('idle')
  const older = parseSharingSnapshot(value)
  expect(older.scopeId).toBeNull()
  expect(older.modes[0]?.authorization).toEqual({ connection: 'required', execution: 'disabled', deviceBound: false })
  const notFound = { requestId, mode: null, action: null, status: 'not_found' }
  expect(parseSharingSnapshot({ ...value, scopeId, operation: notFound }).operation).toEqual(notFound)
  for (const change of [{ connection: 'required' }, { deviceBound: false }, { execution: 'all_time' }]) {
    expect(() => parseSharingSnapshot({ ...value, scopeId, modes: [
      { ...modes[0], authorization: { ...authorization, ...change } }, modes[1]] })).toThrow()
  }
  for (const change of [{ authenticated: false }, { scopeId: 'owner-168' }, { scopeId: null },
    { operation: { ...notFound, mode: 'image' } }, { operation: { ...operation, requestId: 'new-request' } }]) {
    expect(() => parseSharingSnapshot({ ...value, scopeId, operation, modes, ...change })).toThrow()
  }
})

it('keeps anonymous public gateway reachability separate from live device authorization and accepted heartbeat', () => {
  const checkedAt = Math.floor(Date.now() / 1000)
  const connection = { gateway: 'reachable', deviceAuthorization: 'unknown', channel: 'idle', heartbeat: 'unknown',
    checkedAt, heartbeatAt: null }
  expect(parseSharingSnapshot({ ...receipt(), authenticated: false, connection }).connection).toEqual(connection)
  expect(parseSharingSnapshot(receipt()).connection).toMatchObject({ gateway: 'unknown', deviceAuthorization: 'unknown' })
  expect(() => parseSharingSnapshot({ ...receipt(), authenticated: false, connection: { ...connection,
    deviceAuthorization: 'authorized', channel: 'connected' } })).toThrow('SHARING_RESPONSE_INVALID')
  for (const change of [{ gateway: 'http://127.0.0.1' }, { checkedAt: checkedAt - 120 }, { heartbeat: 'accepted' },
    { channel: 'connected' }, { gateway: { toString: () => 'reachable' } }]) {
    expect(() => parseSharingSnapshot({ ...receipt(), connection: { ...connection, ...change } })).toThrow('SHARING_RESPONSE_INVALID')
  }
  const live = { ...connection, deviceAuthorization: 'authorized', channel: 'connected', heartbeat: 'accepted', heartbeatAt: checkedAt }
  expect(parseSharingSnapshot({ ...receipt(), connection: { ...live, token: 'secret', endpoint: 'http://192.168.0.1' } }).connection)
    .toEqual(live)
})


it('projects finite local observations separately from dispatch and refuses stale or contradictory reuse claims', () => {
  const checkedAt = Math.floor(Date.now() / 1000)
  const local = { inventory: 'detected', modelCount: 3, runtime: 'ready', adapter: 'qianshou_image',
    adoption: 'verification_required', checkedAt }
  const value = receipt()
  const parsed = parseSharingSnapshot({ ...value, modes: value.modes.map(row => ({ ...row, local: {
    ...local, endpoint: 'http://127.0.0.1:8189', directory: '/private/models', token: 'fixture-secret',
    filenames: ['private-model.safetensors'] } })) })
  expect(parsed.modes[0]?.local).toEqual(local); expect(parsed.modes[0]?.phase).toBe('idle')
  expect(JSON.stringify(parsed)).not.toMatch(/127\.0|private|secret|safetensors|endpoint|directory/u)
  expect(parseSharingSnapshot(value).modes[0]?.local).toMatchObject({ inventory: 'unknown', modelCount: null, runtime: 'unknown' })
  for (const change of [{ checkedAt: checkedAt - 120 }, { modelCount: null }, { inventory: 'empty' },
    { adoption: 'reused' }, { runtime: 'http://127.0.0.1' }]) {
    expect(() => parseSharingSnapshot({ ...value, modes: [{ ...value.modes[0], local: { ...local, ...change } },
      value.modes[1]] })).toThrow('SHARING_RESPONSE_INVALID')
  }
})

it('requires a fresh scoped API roundtrip receipt instead of inferring confirmation from local health', () => {
  const value = receipt(), now = Math.floor(Date.now() / 1000)
  const api = { status: 'ready', adapter: 'qianshou_image', modelName: 'Qwen Image 2.1 (INT8 ConvRot)',
    workflowName: 'Qwen Image 2.1 text-to-image', registration: 'registered', probeStatus: 'passed',
    lastProbedAt: new Date().toISOString(), endpoint: 'http://127.0.0.1:8189', token: 'fixture-private-token' }
  const authorization = { connection: 'granted', execution: 'idle_only', deviceBound: true }
  const connection = { gateway: 'reachable', deviceAuthorization: 'authorized', channel: 'connected', heartbeat: 'accepted',
    checkedAt: now, heartbeatAt: now }
  const observed = { ...value, scopeId, connection, modes: value.modes.map(row => ({ ...row, authorization, api })) }
  const parsed = parseSharingSnapshot(observed)
  expect(parsed.modes[0]?.api).toMatchObject({ registration: 'registered', probeStatus: 'passed' })
  expect(JSON.stringify(parsed)).not.toMatch(/endpoint|fixture-private|127\.0/u)
  expect(parseSharingSnapshot(value).modes[0]?.api).toMatchObject({ status: 'unknown', probeStatus: 'unknown' })
  const old = { ...api, lastProbedAt: new Date(Date.now() - 120001).toISOString() }
  expect(parseSharingSnapshot({ ...observed, modes: value.modes.map(row => ({ ...row, authorization, api: old })) })
    .modes[0]?.api?.probeStatus).toBe('unknown')
  expect(parseSharingSnapshot({ ...observed, connection: { ...connection, deviceAuthorization: 'unknown', channel: 'offline',
    heartbeat: 'unknown', heartbeatAt: null } }).modes[0]?.api).toMatchObject({ registration: 'unknown', probeStatus: 'unknown' })
  for (const change of [{ modelName: '/private/models/model.safetensors' }, { workflowName: 'http://localhost/workflow' },
    { registration: 'pending' }, { lastProbedAt: null }, { status: 'unavailable' }]) {
    expect(() => parseSharingSnapshot({ ...observed,
      modes: value.modes.map(row => ({ ...row, authorization, api: { ...api, ...change } })) }))
      .toThrow('SHARING_RESPONSE_INVALID')
  }
})
