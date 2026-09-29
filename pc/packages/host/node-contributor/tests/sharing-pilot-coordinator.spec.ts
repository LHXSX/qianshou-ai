import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { SharingCoordinator, type SharingCoordinatorOptions } from '../src/sharing-coordinator.ts'
import { SharingStore } from '../src/sharing-store.ts'
import { sharingDigest } from '../src/sharing-protocol.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const files: Record<string, string> = { diffusion_models: 'qwen_image_2.1_int8_convrot.safetensors',
  text_encoders: 'qwen3vl_8b_int8_convrot.safetensors', vae: 'qwen_image_2.1_vae_bf16.safetensors' }
async function fixture(imageStatus: number = 404) {
  const classes = JSON.parse(await readFile(new URL('./fixtures/comfy-pilot-metadata.json', import.meta.url), 'utf8')) as Record<string, unknown>
  const calls: { method: string; path: string }[] = []
  let release: (() => void) | undefined; let holdWorkflow = false
  const server = createServer((request, response) => {
    const path = request.url!; calls.push({ method: request.method!, path })
    let value: unknown
    if (path === '/healthz') {
      if (imageStatus !== 200) { response.writeHead(imageStatus, { 'content-type': 'application/json' }).end('{}'); return }
      value = { status: 'ok', model: 'qwen-image-2.1-int8-convrot', comfy_reachable: true, busy: false }
    } else if (path === '/system_stats') value = { devices: [{ name: 'CPU fixture', type: 'cpu', vram_total: 0, vram_free: 0 }] }
    else if (path === '/models') value = Object.keys(files)
    else if (path.startsWith('/models/')) value = [files[path.slice('/models/'.length)]]
    else if (path.startsWith('/object_info/')) { const name = path.slice('/object_info/'.length); value = { [name]: classes[name] } }
    else { response.writeHead(404).end(); return }
    const bytes = Buffer.from(JSON.stringify(value))
    const send = (): void => { response.writeHead(200, { 'content-type': 'application/json', 'content-length': bytes.length }).end(bytes) }
    if (holdWorkflow && path === '/object_info/UNETLoader') { holdWorkflow = false; release = send; return }
    send()
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('fixture listener missing')
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => { resolve() })) })
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'qianshou-pilot-coordinator-')))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const device = randomUUID(); let owner: string | null = '21'; let execution: 'idle' | 'disabled' | 'busy' = 'idle'
  const origin = 'http://127.0.0.1:' + String(address.port)
  const options: SharingCoordinatorOptions = { directory, gatewayOrigin: '', metadataPublicKey: '', metadataKeyId: '',
    guangzhouPublicKey: '', guangzhouKeyId: '', uploadPublicKey: '', uploadKeyId: '', authorizationPublicKey: '',
    authorizationKeyId: '', orderPublicKey: '', orderKeyId: '', downloadOrigins: [], owner: async () => owner,
    token: async () => undefined, workerId: () => null, coreOrigin: () => null, occupancyChanged: () => {},
    legacyBusy: () => false, admission: async operation => operation(), executionState: async () => execution,
    channel: () => ({ ownerId: () => owner, prepare: async () => device, connect: async () => {}, disconnect: async () => {},
      session: () => undefined, status: () => undefined }),
    localDiscovery: { comfyOrigin: origin, imageOrigin: origin, videoOrigin: origin, timeoutMs: 2000 },
    pilot: { timeoutMs: 1000, maximumResultBytes: 67108864 } }
  const coordinator = new SharingCoordinator(options); cleanup.push(() => coordinator.close())
  async function authorize(action: 'enable' | 'pause' | 'resume' | 'revoke' = 'enable') {
    const current = await coordinator.snapshot()
    return coordinator.command('image', action, randomUUID(), current.scopeId!, action === 'enable' || action === 'resume'
      ? { version: 'qianshou.media-sharing-consent.v1', connection: true, execution: 'idle_only' } : undefined)
  }
  const owned = () => Reflect.get(coordinator, 'pilot') as { handle: { handle: { origin: string } } } | undefined
  async function credential() {
    return JSON.parse(await readFile(join(directory, 'accounts', sharingDigest('21'), 'devices', sharingDigest(device),
      'image-pilot', 'identity.json'), 'utf8')) as { token: string }
  }
  return { coordinator, authorize, owned, credential, calls, origin, directory, device,
    holdWorkflow() { holdWorkflow = true }, releaseWorkflow() { release?.() },
    set owner(value: string | null) { owner = value }, set execution(value: typeof execution) { execution = value } }
}

it('wraps only an unavailable known local API with real fixed-model GETs and closes only its own listener on pause', async () => {
  const f = await fixture(); await f.authorize(); await f.coordinator.refreshConnection()
  const state = await f.coordinator.snapshot(); const image = state.modes.find(mode => mode.mode === 'image')!
  expect(image.local?.runtime).toBe('ready'); expect(image.api?.adapter).toBe('comfyui')
  expect(image.api?.workflowName).toBe('Qwen Image 2.1 text-to-image')
  expect(f.coordinator.executor.capabilities).toEqual([])
  expect((await f.coordinator.executor.readHeartbeat()).freeSlots).toBe(0)
  const ownedOrigin = f.owned()!.handle.handle.origin; const { token } = await f.credential()
  expect((await fetch(ownedOrigin + '/healthz', { headers: { Authorization: 'Bearer ' + token } })).status).toBe(200)
  await f.authorize('pause'); expect(f.owned()).toBeUndefined()
  await expect(fetch(ownedOrigin + '/healthz')).rejects.toThrow()
  await f.authorize('resume'); await vi.waitFor(() => { expect(f.owned()).toBeDefined() })
  expect((await f.credential()).token).toBe(token)
  expect((await fetch(f.origin + '/system_stats')).status).toBe(200)
  expect(f.calls.every(call => call.method === 'GET')).toBe(true)
})

it('preserves an existing Qwen API while adding the real durable fixed-workflow task API from the same models', async () => {
  const f = await fixture(200); await f.authorize(); await f.coordinator.refreshConnection()
  const image = (await f.coordinator.snapshot()).modes.find(mode => mode.mode === 'image')!
  expect(f.owned()).toBeDefined(); expect(image.api?.adapter).toBe('comfyui'); expect(image.local?.runtime).toBe('ready')
  expect((await fetch(f.origin + '/healthz')).status).toBe(200)
  await f.authorize('revoke'); expect(f.owned()).toBeUndefined()
  expect((await fetch(f.origin + '/healthz')).status).toBe(200)
  expect(f.calls.every(call => call.method === 'GET')).toBe(true)
})

it('a new enable on an already granted device forces fresh model reads and reuses the original API identity', async () => {
  const f = await fixture(200); await f.authorize()
  await vi.waitFor(() => { expect(f.owned()).toBeDefined() })
  const original = await f.credential(); const ownedOrigin = f.owned()!.handle.handle.origin
  const before = f.calls.filter(call => call.path === '/models').length
  await f.authorize('enable')
  await vi.waitFor(() => { expect(f.calls.filter(call => call.path === '/models').length).toBeGreaterThan(before) })
  await vi.waitFor(async () => { expect((await f.coordinator.snapshot()).modes[0]?.api?.status).toBe('ready') })
  expect(f.owned()!.handle.handle.origin).toBe(ownedOrigin); expect(await f.credential()).toEqual(original)
  expect(f.calls.every(call => call.method === 'GET')).toBe(true)
  expect(f.coordinator.executor.capabilities).toEqual([])
})

it('video enable returns the actual missing API blocker without requesting an image wrapper or paid install', async () => {
  const f = await fixture(200); await f.coordinator.refreshConnection()
  const initial = await f.coordinator.snapshot()
  await f.coordinator.command('video', 'enable', randomUUID(), initial.scopeId!, {
    version: 'qianshou.media-sharing-consent.v1', connection: true, execution: 'idle_only',
  })
  await vi.waitFor(async () => { expect((await f.coordinator.snapshot()).modes[1]).toMatchObject({
    phase: 'blocked', reason: 'runtime_unavailable', api: { status: 'unavailable', probeStatus: 'unknown' },
    authorization: { connection: 'granted', execution: 'idle_only' },
  }) })
  expect(f.owned()).toBeUndefined(); expect(f.calls.every(call => call.method === 'GET')).toBe(true)
  expect(f.coordinator.executor.capabilities).toEqual([])
})

it('an exact committed UUID does not force model preparation or resurrect permission after explicit revocation', async () => {
  const f = await fixture(200); const initial = await f.coordinator.snapshot(); const id = randomUUID()
  const consent = { version: 'qianshou.media-sharing-consent.v1' as const, connection: true as const,
    execution: 'idle_only' as const }
  await f.coordinator.command('image', 'enable', id, initial.scopeId!, consent)
  await f.coordinator.refreshConnection(); expect(f.owned()).toBeDefined()
  const count = () => f.calls.filter(call => call.path === '/models').length
  const before = count()
  await f.coordinator.command('image', 'enable', id, initial.scopeId!, consent)
  expect(count()).toBe(before)
  await f.authorize('revoke'); expect(f.owned()).toBeUndefined()
  const afterRevoke = count()
  const duplicate = await f.coordinator.command('image', 'enable', id, initial.scopeId!, consent)
  expect(duplicate.modes[0]?.authorization?.connection).toBe('revoked'); expect(f.owned()).toBeUndefined()
  expect(count()).toBe(afterRevoke); expect(f.calls.every(call => call.method === 'GET')).toBe(true)
})

it('never wraps around an existing API authentication refusal', async () => {
  const f = await fixture(401); await f.authorize(); await f.coordinator.refreshConnection()
  const image = (await f.coordinator.snapshot()).modes.find(mode => mode.mode === 'image')!
  expect(f.owned()).toBeUndefined(); expect(image.local?.runtime).toBe('authentication_required')
  expect(f.calls.every(call => call.method === 'GET')).toBe(true)
})

it('never upgrades an old desired record into an API listener, and independently refuses execution while deployment is OFF', async () => {
  const f = await fixture(); const store = await SharingStore.open(f.directory); cleanup.push(async () => { store.close() })
  store.command('21', 'image', 'enable', randomUUID())
  await f.coordinator.refreshConnection(); expect(f.owned()).toBeUndefined()
  f.execution = 'disabled'; await f.authorize(); await f.coordinator.refreshConnection()
  const ownedOrigin = f.owned()!.handle.handle.origin; const { token } = await f.credential()
  const result = await fetch(ownedOrigin + '/v1/jobs', { method: 'POST', headers: { Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(),
    workflowId: 'comfy-pilot-image-154f7d6133fe0276', prompt: 'CPU fixture, must not execute' }) })
  expect(result.status).toBe(403); expect(f.calls.every(call => call.method === 'GET')).toBe(true)
  expect(f.coordinator.executor.capabilities).toEqual([])
})

it('closes the original private API on account change and never copies its consent or metadata to the new owner', async () => {
  const f = await fixture(); await f.authorize(); await f.coordinator.refreshConnection()
  const ownedOrigin = f.owned()!.handle.handle.origin
  f.owner = '22'; await f.coordinator.refreshConnection()
  const state = await f.coordinator.snapshot(); expect(f.owned()).toBeUndefined()
  expect(state.modes.every(mode => mode.authorization?.connection !== 'granted')).toBe(true)
  expect(state.modes.find(mode => mode.mode === 'image')!.api?.registration).toBe('unknown')
  await expect(fetch(ownedOrigin + '/healthz')).rejects.toThrow()
  expect((await fetch(f.origin + '/system_stats')).status).toBe(200)
})

it('drops an opening fixed-workflow API when the real account changes during its metadata GET', async () => {
  const f = await fixture(); const oldScope = (await f.coordinator.snapshot()).scopeId!; f.holdWorkflow()
  const opening = f.authorize()
  await vi.waitFor(() => { expect(f.calls.some(call => call.path === '/object_info/UNETLoader')).toBe(true) })
  f.owner = '22'; f.releaseWorkflow(); await opening
  const snapshot = await f.coordinator.snapshot()
  expect(f.owned()).toBeUndefined(); expect(snapshot.modes.every(mode => mode.authorization?.connection !== 'granted')).toBe(true)
  await expect(f.coordinator.command('image', 'enable', randomUUID(), oldScope, {
    version: 'qianshou.media-sharing-consent.v1', connection: true, execution: 'idle_only',
  })).rejects.toMatchObject({ code: 'SHARING_SCOPE_CHANGED' })
  expect(f.owned()).toBeUndefined(); expect((await f.coordinator.snapshot()).modes[0]?.api?.registration).toBe('unknown')
  expect(f.calls.every(call => call.method === 'GET')).toBe(true)
})
