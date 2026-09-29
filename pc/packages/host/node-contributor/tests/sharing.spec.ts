/** Real temporary HTTP, SQLite and subprocess checks; fixture receipts grant no production qualification. */
import { generateKeyPairSync, sign, createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile, symlink, realpath, cp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { sharingBundleDigest, sharingCanonical, sharingCurrentOrder, sharingDigest, parseSharingManifest,
  sharingVerify } from '../src/sharing-protocol.ts'
import { SharingRuntime, sharingDownload } from '../src/sharing-runtime.ts'
import { SharingStore } from '../src/sharing-store.ts'
import { SharingProvider } from '../src/sharing-provider.ts'
import { sharingExecutionAdmission } from '../src/sharing-admission.ts'
import { discoverSharingLocal, observeSharingLocal } from '../src/sharing-local.ts'
import { SharingCoordinator, registerSharingRoutes, type SharingCoordinatorOptions } from '../src/sharing-coordinator.ts'
import type { SharingManifest, SharingAttempt, SharingNodeSession, SharingMode, SharingSnapshot } from '../src/sharing-types.ts'
import type { MediaNodeDelivery } from '../src/media-node-channel.ts'

interface ActualUISharingTransport {
  read(signal: AbortSignal, requestId?: string): Promise<SharingSnapshot>
  command(command: {
    mode: SharingMode
    action: 'enable' | 'pause' | 'resume' | 'revoke'
    requestId: string
    scopeId: string
    consent?: { version: 'qianshou.media-sharing-consent.v1'; connection: true; execution: 'idle_only' | 'disabled' }
  }, signal: AbortSignal): Promise<SharingSnapshot>
}
interface ActualUISharingModule {
  readonly createSharingTransport: (request: typeof fetch) => ActualUISharingTransport
  readonly parseSharingSnapshot: (value: unknown) => SharingSnapshot
}
async function uiConfirmed(transport: ActualUISharingTransport, mode: SharingMode, action: 'enable' | 'pause' | 'resume',
  requestId: string, signal: AbortSignal) {
  const snapshot = await transport.read(signal)
  if (snapshot.scopeId == null) throw new Error('scope unavailable')
  return transport.command({ mode, action, requestId, scopeId: snapshot.scopeId,
    ...(action === 'pause' ? {} : { consent: { version: 'qianshou.media-sharing-consent.v1' as const,
      connection: true as const, execution: 'idle_only' as const } }) }, signal)
}
async function sharingUI(): Promise<ActualUISharingModule> {
  // Exercise the actual renderer parser at runtime without adding client source to the Host compilation graph.
  const modulePath = '../../../client/ui-qianshou/src/client/help/sharing-transport.ts'
  return await import(modulePath) as ActualUISharingModule
}

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const pair = generateKeyPairSync('ed25519'); const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const signed = (payload: Record<string, unknown>) => ({ key_id: 'fixture-key', payload, signature: sign(null,
  sharingCanonical(payload), pair.privateKey).toString('base64url') })
const metadataPair = generateKeyPairSync('ed25519')
const metadataPublicKey = metadataPair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const metadataSigned = (payload: Record<string, unknown>) => ({ key_id: 'metadata-fixture-key', payload,
  signature: sign(null, sharingCanonical(payload), metadataPair.privateKey).toString('base64url') })
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const cap = { profile_id: 'fixture-image', profile_version: 1, model_sha256: 'a'.repeat(64), workflow_sha256: 'b'.repeat(
  64), validation_receipt_sha256: 'c'.repeat(64) }
const deviceId = randomUUID(); const workerId = randomUUID()
const hardware = { platform: process.platform as 'darwin', arch: process.arch, gpuName: 'Fixture GPU', vramMb: 8192,
  freeVramMb: 8192, memoryMb: 32768 }
async function scratch() { const root = await realpath(await mkdtemp(join(tmpdir(), 'qianshou-sharing-'))); cleanup.push((
) => rm(root, { recursive: true, force: true })); return root }
async function http(handler: (req: IncomingMessage, res: import('node:http').ServerResponse) => void) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('fixture server failed')
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() =>{  resolve() })) })
  return 'http://127.0.0.1:' + String(address.port)
}
async function json(req: IncomingMessage) { let bytes = ''; for await (const chunk of req) bytes += String(chunk)
  return JSON.parse(bytes) as Record<string, unknown> }
function coordinatorOptions(directory: string, patch: Partial<SharingCoordinatorOptions> = {}): SharingCoordinatorOptions {
  return { directory, gatewayOrigin: '', metadataPublicKey: '', metadataKeyId: '', guangzhouPublicKey: '', guangzhouKeyId: '', uploadPublicKey: '', uploadKeyId: '',
    authorizationPublicKey: '', authorizationKeyId: '', orderPublicKey: '', orderKeyId: '', downloadOrigins: [],
    executionState: async () => 'idle', owner: async () => '21', presenceAllowed: async () => true, token: async () => undefined, workerId: () => null, coreOrigin: () => null,
    channel: () => ({ disconnect: async () => {}, connect: async () => {}, prepare: async () => deviceId,
      session: () => undefined, status: () => undefined, ownerId: () => '21' }), occupancyChanged: () => {}, legacyBusy: () => false,
    admission: async action => action(), ...patch }
}
async function sharingHTTP(coordinator: SharingCoordinator) {
  type Route = { path: string; methods: readonly string[]; fetch: (request: Request) => Promise<Response> }
  const routes = new Map<string, Route>()
  const ctx = { effect: (action: () => unknown) => action(), connection: { fetch: { register: (route: Route) => {
    routes.set(route.path, route); return () => routes.delete(route.path)
  } } } } as unknown as Context
  registerSharingRoutes(ctx, coordinator)
  const origin = await http((req, res) => { void (async () => {
    const route = routes.get(req.url!.split('?')[0]!)
    if (route === undefined || !route.methods.includes(req.method!)) { res.writeHead(404).end(); return }
    let bytes = ''; for await (const chunk of req) bytes += String(chunk)
    const response = await route.fetch(new Request('http://127.0.0.1' + req.url!, { ...(req.method === undefined ? {} : { method: req.method }),
      headers: req.headers as Record<string, string>, ...(bytes === '' ? {} : { body: bytes }) }))
    response.headers.forEach((value, name) => res.setHeader(name, value)); res.statusCode = response.status
    res.end(Buffer.from(await response.arrayBuffer()))
  })().catch((error: unknown) => res.destroy(error as Error)) })
  const { createSharingTransport } = await sharingUI()
  return { origin, transport: createSharingTransport((input, init) => fetch(origin
    + (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url), init)) }
}
async function packageFixture(drop = false) {
  const root = await scratch()
  const runner = await readFile(new URL('./fixtures/sharing-runtime.mjs', import.meta.url))
  const launcher = Buffer.from('#!/bin/sh\nexec ' + JSON.stringify(process.execPath) + ' "$(dirname "$0")/runner.mjs" "$@"\n')
  const files = new Map([['entry', launcher], ['runner.mjs', runner]])
  const downloadRequests: string[] = []
  const origin = await http((req, res) => { downloadRequests.push(req.url!); const bytes = files.get(req.url!.slice(1))
    if (bytes === undefined) {
      res.writeHead(404).end(); return }
    res.writeHead(200, { 'Content-Length': bytes.length, ETag: '"fixture-etag"' }); res.end(bytes) })
  const now = Math.floor(Date.now() / 1000)
  const manifest: SharingManifest = { schema: 'qianshou.media-install-manifest.v1', purpose: 'qianshou:media-install-manifest',
    nonce: randomUUID(), accountId: 21, deviceId, workerId, mode: 'image', platform: hardware.platform, arch: hardware.arch,
    bundle_id: '', display_name: 'CPU fixture', min_vram_mb: 1, min_memory_mb: 1, supported_gpu_names: ['Fixture GPU'], profiles: [cap],
    executor_sha256: hash(launcher), files: [...files].map(([path, data]) => ({ path, sha256: hash(data), size_bytes: data.length,
      url: origin + '/' + path, etag: '"fixture-etag"', executable: path === 'entry' })), entrypoint: 'entry',
    args: ['127.0.0.1', '{PORT}', '{AUTH_TOKEN_FILE}', '{INSTANCE_ID}', drop ? 'drop-submit' : 'return-submit'],
    health_path: '/health', storage_bytes: 10 * 1024 * 1024, abi: 'qianshou.media-runtime.v1', issued_at: now, expires_at: now + 300 }
  const final = { ...manifest, bundle_id: sharingBundleDigest(manifest) }
  const envelope = metadataSigned(final)
  const parsed = parseSharingManifest(envelope, { nonce: manifest.nonce, owner: 21, deviceId, workerId, mode: 'image', hardware,
    keyId: 'metadata-fixture-key', publicKey: metadataPublicKey, downloadOrigins: [origin] })
  const runtime = new SharingRuntime(join(root, 'bundle'), parsed)
  cleanup.push(() => runtime.close()); await runtime.install(new AbortController().signal, () => {}); await runtime.start(
    new AbortController().signal)
  return { root, runtime, manifest: parsed, envelope, origin, downloadRequests }
}
function delivery(): MediaNodeDelivery {
  const now = Math.floor(Date.now() / 1000); const taskId = randomUUID(); const attemptId = randomUUID()
  const quoteId = 'e'.repeat(64); const authorizationId = randomUUID(); const leaseExpiresAt = new Date((
    now + 120) * 1000).toISOString().replace('.000Z', 'Z')
  const plan = { ...cap, capability: 'image', mode: 'text_to_image', quality: 'fast', orientation: 'square', seconds: null,
    asset_manifest_sha256: sharingDigest([]), price_version: 'fixture.v1', price_unit: 'image', units: 1, timeout_s: 60 }
  const plan_sha256 = sharingDigest(plan); const { price_version: _pv, price_unit: _pu, units: _units, ...execution } = {
    ...plan, plan_sha256 }
  const authorization = signed({ schema: 'qianshou.formal-media-authorization.v1',
    purpose: 'qianshou:formal-media-authorization', taskId, attemptId,
    deviceId, ownerId: '21', accountId: 7, leaseEpoch: 1, leaseExpiresAt, quoteId, authorizationId, plan_sha256,
    price: { price_version: 'fixture.v1', price_unit: 'image', units: 1 }, issued_at: now, expires_at: now + 120 })
  return { taskId, attemptId, quoteId, authorizationId, leaseEpoch: 1, leaseExpiresAt, expired: false, sequence: 1,
    envelope: { schema: 'qianshou.formal-media-order.v1', accountId: 7, plan_sha256, authorization, plan: execution,
      outputPolicy: { object_prefix: `v8/account-7/workload-${taskId}/shard-${attemptId}/result/`, max_bytes: 64 * 1024 * 1024 },
      spec: { task_type: 'image_generate', input_kind: 'params_only', media_input: { capability: 'image',
        mode: 'text_to_image', quality: 'fast',
        orientation: 'square', seconds: null, profile_id: cap.profile_id, profile_version: 1, prompt: 'CPU fixture',
        negative_prompt: '', assets: [] } } } }
}
function order(task: MediaNodeDelivery) {
  const now = Math.floor(Date.now() / 1000); const e = task.envelope; const price = (e.authorization as { payload: {
    price: object } }).payload.price
  return signed({ schema: 'qianshou.formal-media-current-order.v1', purpose: 'qianshou:formal-media-order-current',
    taskId: task.taskId, attemptId: task.attemptId, deviceId, ownerId: '21', accountId: 7, leaseEpoch: 1,
    leaseExpiresAt: task.leaseExpiresAt,
    plan_sha256: e.plan_sha256, quoteId: task.quoteId, authorizationId: task.authorizationId,
    plan: { ...(e.plan as object), ...price }, spec: e.spec, status: 'running', issued_at: now, expires_at: now + 60 })
}

async function confirmed(coordinator: SharingCoordinator, mode: 'image' | 'video', action: 'enable' | 'pause' | 'resume' | 'revoke', requestId: string) {
  const snapshot = await coordinator.snapshot()
  return coordinator.command(mode, action, requestId, snapshot.scopeId ?? undefined,
    action === 'enable' || action === 'resume' ? { version: 'qianshou.media-sharing-consent.v1', connection: true,
      execution: 'idle_only' } : undefined)
}

it('verifies signed official install challenges and refuses purpose, hardware, path and download-origin substitutions', async () => {
  const f = await packageFixture(); const p = f.manifest
  const request = { nonce: p.nonce, owner: 21, deviceId, workerId, mode: 'image' as const, hardware, keyId: 'metadata-fixture-key',
    publicKey: metadataPublicKey, downloadOrigins: [f.origin] }
  expect(parseSharingManifest(f.envelope, request).bundle_id).toBe(p.bundle_id)
  for (const changed of [{ purpose: 'qianshou:formal-media-result' }, { nonce: randomUUID() }, { files: [{ ...p.files[0],
    path: '../escape' }] },
  { files: [{ ...p.files[0], url: 'https://unapproved.invalid/file' }] }, { executor_sha256: '0'.repeat(64) }]) {
    expect(() => parseSharingManifest(metadataSigned({ ...p, ...changed }), request)).toThrow()
  }
  expect(() => parseSharingManifest(f.envelope, { ...request, hardware: { ...hardware, vramMb: 0 } })).toThrow('HARDWARE_UNSUPPORTED')
  expect(() => sharingVerify(f.envelope, { keyId: 'other', publicKey, schema: p.schema, purpose: p.purpose, ttl: 300 })).toThrow()
})
it('resumes an interrupted range at persisted bytes with immutable ETag and validates the complete file hash', async () => {
  const root = await scratch(); const bytes = Buffer.alloc(8192, 7); let first = true; const ranges: (string | undefined)[] = []
  const origin = await http((req, res) => {
    ranges.push(req.headers.range)
    const start = req.headers.range === undefined ? 0 : Number(req.headers.range.slice(6).split('-')[0])
    res.writeHead(start === 0 ? 200 : 206, { 'Content-Length': bytes.length - start, ETag: '"same"',
      ...(start === 0 ? {} : { 'Content-Range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` }) })
    if (first) { first = false; res.write(bytes.subarray(0, 1024)); setTimeout(() => res.destroy(), 30) }
    else res.end(bytes.subarray(start))
  })
  const file = { path: 'model.bin', sha256: hash(bytes), size_bytes: bytes.length, etag: '"same"', executable: false,
    url: origin + '/file' }
  await expect(sharingDownload(root, file, new AbortController().signal, () => {})).rejects.toThrow()
  expect((await readFile(join(root, 'model.bin.part'))).length).toBe(1024)
  await sharingDownload(root, file, new AbortController().signal, () => {})
  expect(ranges).toEqual([undefined, 'bytes=1024-']); expect(await readFile(join(root, 'model.bin'))).toEqual(bytes)
})
it('rejects redirects and linked partial files without starting a package', async () => {
  const root = await scratch(); const victim = join(root, 'victim'); await writeFile(victim, 'secret', { mode: 0o600 })
  await symlink(victim, join(root, 'bad.part'))
  const origin = await http((_req, res) => res.writeHead(302, { Location: 'https://unapproved.invalid' }).end())
  const file = { path: 'bad', sha256: 'a'.repeat(64), size_bytes: 6, etag: '"same"', executable: false, url: origin }
  await expect(sharingDownload(root, file, new AbortController().signal, () => {})).rejects.toThrow()
  expect(await readFile(victim, 'utf8')).toBe('secret')
  await expect(sharingDownload(root, { ...file, path: 'redirect' }, new AbortController().signal, () => {})).rejects.toThrow()
})
it('restores an authenticated child instance, drains actual exit, and restarts the same approved runtime', async () => {
  const f = await packageFixture(); const adopted = new SharingRuntime(f.runtime.root, f.manifest)
  await adopted.start(new AbortController().signal); expect(await adopted.healthy(new AbortController().signal)).toBe(true)
  await f.runtime.close(); expect(await adopted.healthy(new AbortController().signal)).toBe(false)
  const restarted = new SharingRuntime(f.runtime.root, f.manifest); cleanup.push(() => restarted.close())
  await restarted.start(new AbortController().signal); expect(await restarted.healthy(new AbortController().signal)).toBe(true)
})
it('preserves owner UUID commands and globally reserves one SQLite attempt across independent handles and restart', async () => {
  const root = await scratch(); const store = await SharingStore.open(root); const other = await SharingStore.open(root)
  const id = randomUUID(); expect(store.command('21', 'image', 'enable', id)).toBe(true); expect(other.command('21',
    'image', 'enable', id)).toBe(false)
  expect(() => other.command('21', 'video', 'enable', id)).toThrow('REQUEST_CONFLICT')
  const task = delivery(); const a: SharingAttempt = { task, owner: '21', mode: 'image', state: 'admitted',
    assetId: randomUUID(), outputPath: join(root, 'output.png'), eventSequence: 0, result: null }
  store.admit(a); expect(() => other.admit({ ...a, task: delivery(), owner: '22' })).toThrow('BUSY')
  expect(store.claimSubmission(a)).toBe(true); expect(other.claimSubmission(a)).toBe(false)
  const event = store.event(a, 'outcome_unknown'); expect(other.events(task.attemptId)).toEqual([event]); store.close(); other.close()
  const restored = await SharingStore.open(root); expect(restored.active()[0]?.state).toBe('submitting')
  expect(restored.claimSubmission(a)).toBe(false)
  const generated = restored.transition(a, 'generated', { sha256: 'd'.repeat(64), size_bytes: 1, content_type: 'image/png' })
  const competitor = await SharingStore.open(root)
  expect(restored.claimUpload(generated)).toBe(true); expect(competitor.claimUpload(generated)).toBe(false); competitor.close()
  restored.close(); await rm(join(root, 'control.sqlite')); await expect(SharingStore.open(root)).rejects.toThrow('STORE_INVALID')
})
it('normalizes retained legacy hardware/match steps without changing durable intent or inventing completed stages', async () => {
  const { parseSharingSnapshot } = await sharingUI()
  const root = await scratch(); const store = await SharingStore.open(root); const requestId = randomUUID()
  store.command('21', 'image', 'enable', requestId)
  const saved = { ...store.mode('21', 'image').state, completedSteps: ['hardware', 'match', 'hardware', 'download'] }
  store.close()
  const db = new DatabaseSync(join(root, 'control.sqlite'))
  db.prepare('UPDATE modes SET state_json=? WHERE owner=? AND mode=?').run(JSON.stringify(saved), '21', 'image'); db.close()
  const restored = await SharingStore.open(root); cleanup.push(async () => { restored.close() })
  expect(restored.mode('21', 'image')).toMatchObject({ desired: true, state: { operationId: requestId,
    completedSteps: ['detect', 'download'] } })
  expect(restored.command('21', 'image', 'enable', requestId)).toBe(false)
  restored.updateMode('21', 'image', { phase: 'starting', completedSteps: ['install'] })
  restored.updateMode('21', 'image', { completedCalls: 7, settledYuan: '1.2500', completedSteps: ['earnings'] })
  restored.updateMode('21', 'image', { phase: 'blocked', reason: 'runtime_unavailable', completedSteps: [] })
  expect(restored.mode('21', 'image').state.completedSteps).toEqual(['detect', 'download', 'install', 'earnings'])
  expect(parseSharingSnapshot({ schema: 'qianshou.compute-sharing.v1', authenticated: true, hardware: null,
    modes: ['image', 'video'].map(mode => restored.mode('21', mode as 'image' | 'video').state) }).modes[0]?.reason)
    .toBe('runtime_unavailable')
})
it('refuses a changed full prompt even if the relay keeps the original frozen plan authorization', () => {
  const task = delivery(); const receipt = order(task)
  sharingCurrentOrder(receipt, task, { owner: '21', deviceId, keyId: 'fixture-key', publicKey })
  const spec = task.envelope.spec as { media_input: object }
  const changed = { ...task, envelope: { ...task.envelope, spec: { ...spec, media_input: { ...spec.media_input, prompt: 'modified' } } } }
  expect(() => sharingCurrentOrder(receipt, changed, { owner: '21', deviceId, keyId: 'fixture-key', publicKey })).toThrow('LEASE_INVALID')
})

it('executes a real CPU child once, recovers unknown POST/PUT through exact HTTP status, and settles only the matching receipt', { timeout: 20000 }, async () => {
  const f = await packageFixture(true); const store = await SharingStore.open(join(f.root, 'journal')); cleanup.push(async () => { store.close() })
  const task = delivery(); let uploadCalls = 0; let uploaded: Record<string, unknown> | null = null; let settled = false
  let verdict: ReturnType<typeof signed> | null = null; let verdictPayload: Record<string, unknown> | null = null
  let wrongSignerReads = 0; const events: number[] = []; const paths: string[] = []
  const origin = await http((req, res) => { void (async () => {
    const path = req.url!; paths.push(path); const send = (value: unknown) => { res.setHeader('Content-Type',
      'application/json'); res.end(JSON.stringify(value)) }
    if (path === '/v1/media/results/upload') {
      uploadCalls++; const ticket = JSON.parse(Buffer.from(req.headers.authorization!.slice(7), 'base64url').toString()) as ReturnType<typeof signed>
      const p = ticket.payload; const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(
        c as Uint8Array)); const bytes = Buffer.concat(chunks)
      expect(hash(bytes)).toBe(p.sha256)
      uploaded = { object_key: p.object_key, object_version_id: 'locked-version', sha256: p.sha256,
        size_bytes: p.size_bytes, content_type: p.content_type }
      const now = Math.floor(Date.now() / 1000)
      verdictPayload = { schema: 'qianshou.formal-media-result.v1', purpose: 'qianshou:formal-media-result',
        taskId: task.taskId, attemptId: task.attemptId,
        deviceId, ownerId: '7', leaseEpoch: 1, plan_sha256: task.envelope.plan_sha256, profile_id: cap.profile_id, profile_version: 1,
        status: 'verified', resultRevision: 'f'.repeat(64), billableResultRevision: 'f'.repeat(64), assetId: p.assetId,
        file: { ...uploaded, width: 1, height: 1, fps_num: null, fps_den: null, seconds_ms: null }, reason: null,
        issued_at: now, expires_at: now + 60 }
      verdict = { ...metadataSigned(verdictPayload), key_id: 'fixture-key' } // Matching key ID cannot substitute a metadata signer.
      req.socket.destroy(); return
    }
    const b = await json(req)
    if (path.endsWith('order-current')) { send({ ok: true, order: order(task) }); return }
    if (path.endsWith('events')) { events.push(Number(b.sequence)); send({ ok: true, sequence: b.sequence }); return }
    if (path.endsWith('result-ticket')) {
      const now = Math.floor(Date.now() / 1000); const { connectionEpoch: _ce, ...tuple } = b
      send({ ok: true, assetId: b.assetId, upload_path: '/v1/media/results/upload', ticket: signed({ ...tuple,
        schema: 'qianshou.formal-media-result-upload.v1',
        purpose: 'qianshou:formal-media-result-upload', accountId: 7, nonce: randomUUID(), issued_at: now, expires_at: now + 300,
        object_key: `v8/account-7/workload-${task.taskId}/shard-${task.attemptId}/result/${String(b.assetId)}/result.png` }) }); return
    }
    if (path.endsWith('result-status')) { if (uploaded !== null) wrongSignerReads++; send({ ok: true, status: uploaded === null ? 'pending' : 'verified',
      artifact: uploaded, verdict }); return }
    if (path.endsWith('task-status')) { send({ ok: true, task: { taskId: task.taskId, attemptId: task.attemptId, leaseEpoch: 1,
      stage: settled ? 'completed' : uploaded === null ? 'leased' : 'awaiting_settlement', verdict,
      settlement: settled ? { taskId: task.taskId, attemptId: task.attemptId, leaseEpoch: 1, settled: true,
        resultRevision: 'f'.repeat(64), billableResultRevision: 'f'.repeat(64), ledgerReceiptId: randomUUID() } : null } }); return }
    res.writeHead(404).end()
  })().catch((error: unknown) => { res.destroy(error as Error) }) })
  let owner: string | null = '21'; let enabled = true
  const provider = new SharingProvider({ store, directory: join(f.root, 'attempts'), origin, owner: async () => owner,
    admission: async action => action(), enabled: () => enabled, occupancyChanged: () => {},
    guangzhouKeyId: 'fixture-key', guangzhouPublicKey: publicKey, uploadKeyId: 'fixture-key', uploadPublicKey: publicKey,
    authorizationKeyId: 'fixture-key', authorizationPublicKey: publicKey, orderKeyId: 'fixture-key', orderPublicKey: publicKey })
  cleanup.push(() => provider.close()); provider.bind(f.manifest, f.runtime)
  const session: SharingNodeSession = { deviceId, connectionEpoch: 1, post: async (path, body, signal) => {
    const response = await fetch(origin + '/v1/nodes/' + path, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, deviceId, connectionEpoch: 1 }) }); return await response.json() as Record<string, unknown>
  } }
  await provider.onTask(task, new AbortController().signal, session)
  await vi.waitFor(() => { expect(store.active()[0]?.state).toBe('unknown') }, { timeout: 4000 })
  enabled = false; provider.unbind('image') // Original job binding outlives new-intake qualification.
  await vi.waitFor(() => { expect(wrongSignerReads).toBeGreaterThan(0) }, { timeout: 6000 })
  expect(store.active()[0]?.state).toBe('uploading')
  if (verdictPayload === null) throw new Error('fixture result was not uploaded')
  verdict = signed(verdictPayload) // Only the separately pinned formal result root permits settlement.
  await vi.waitFor(() =>{  expect(store.active()[0]?.state).toBe('awaiting_settlement') }, { timeout: 12000 })
  await provider.onTask({ ...task, expired: true }, new AbortController().signal, session)
  expect(uploadCalls).toBe(1); expect(paths.some(p => p.endsWith('result-status'))).toBe(true)
  const db = new DatabaseSync(join(f.runtime.root, 'fixture-jobs.sqlite')); expect(db.prepare(
    "SELECT COUNT(*) AS n FROM calls WHERE method='POST'").get()?.n).toBe(1); db.close()
  expect(events).toEqual([...new Set(events)].sort((a, b) => a - b)); expect(store.active()).toHaveLength(1)
  owner = '22'; settled = true; await new Promise(resolve => setTimeout(resolve, 1200)); expect(store.active()).toHaveLength(1)
  owner = '21'; provider.recover(session); await vi.waitFor(() =>{  expect(store.active()).toHaveLength(0) }, { timeout: 4000 })
  expect(uploadCalls).toBe(1)
  provider.bind(f.manifest, f.runtime)
  await expect(provider.onTask(delivery(), new AbortController().signal, session)).rejects.toThrow('PAUSED')
})

it('releases a late private start after pause and never claims a manual replacement or an unowned compatibility port', async () => {
  const root = await scratch(); let finish: ((lease: import('../src/media-node-routes.ts').MediaNodePresenceLease) => void) | undefined
  let epoch = 2; let owned = true; const epochs: number[] = []; let genericStarts = 0
  const status = () => ({ state: 'connected' as const, deviceId, connectionEpoch: epoch, sequence: 0, authorized: true,
    heartbeatAt: Date.now(), errorCode: null, withdrawalConfirmed: null })
  const coordinator = new SharingCoordinator(coordinatorOptions(root, { gatewayOrigin: 'http://127.0.0.1:9',
    presenceConnectTimeoutMs: 50, channel: () => ({ connect: async () => { genericStarts++ }, disconnect: async () => {},
      prepare: async () => deviceId, session: () => undefined, status, ownerId: () => '21',
      connectOwned: () => new Promise((resolve) => { finish = resolve }) }) }))
  cleanup.push(() => coordinator.close())
  const started = Date.now(); await confirmed(coordinator, 'image', 'enable', randomUUID())
  await vi.waitFor(() => { expect(finish).toBeTypeOf('function') })
  expect(Date.now() - started).toBeLessThan(1500)
  await confirmed(coordinator, 'image', 'pause', randomUUID())
  finish!({ current: () => owned ? status() : undefined, disconnect: async (observed) => {
    epochs.push(observed); if (observed !== epoch) return false; owned = false; return true
  } })
  await vi.waitFor(() => { expect(epochs).toEqual([2]); expect(owned).toBe(false) })
  expect(genericStarts).toBe(0)
  const unowned = new SharingCoordinator(coordinatorOptions(await scratch(), { gatewayOrigin: 'http://127.0.0.1:9',
    channel: () => ({ connect: async () => { genericStarts++ }, disconnect: async () => {}, prepare: async () => deviceId,
      status, ownerId: () => '21', session: () => undefined }) }))
  cleanup.push(() => unowned.close())
  await confirmed(unowned, 'image', 'enable', randomUUID()); expect(genericStarts).toBe(0)
  epoch = 3; expect((await unowned.snapshot()).connection?.deviceAuthorization).toBe('authorized')
})
it('persists explicit pause/resume while a missing official catalog remains blocked and redacts account switching', async () => {
  const root = await scratch(); let owner: string | null = '21'
  const coordinator = new SharingCoordinator({ directory: root, gatewayOrigin: '', metadataPublicKey: '', metadataKeyId: '', guangzhouPublicKey: '', guangzhouKeyId: '',
    uploadPublicKey: '', uploadKeyId: '', authorizationPublicKey: '', authorizationKeyId: '', orderPublicKey: '', orderKeyId: '',
    downloadOrigins: [], executionState: async () => 'idle', owner: async () => owner, presenceAllowed: async () => true, token: async () => undefined,
    workerId: () => null, coreOrigin: () => null,
    channel: () => ({ disconnect: async () => {}, connect: async () => {}, prepare: async () => deviceId, session: (
    ) => undefined, status: () => undefined, ownerId: () => owner }),
    occupancyChanged: () => {}, legacyBusy: () => false, admission: async action => action() })
  cleanup.push(() => coordinator.close())
  const id = randomUUID(); await confirmed(coordinator, 'image', 'enable', id)
  await vi.waitFor(async () =>{  expect((await coordinator.snapshot()).modes[0]).toMatchObject({ phase: 'blocked',
    reason: 'catalog_unavailable', completedCalls: null, settledYuan: null }) })
  await confirmed(coordinator, 'image', 'pause', randomUUID()); expect((await coordinator.snapshot()).modes[0]?.phase).toBe('paused')
  owner = '22'; expect((await coordinator.snapshot()).modes.every(m => m.phase === 'idle')).toBe(true)
  owner = null; const status = await coordinator.snapshot(); expect(status.authenticated).toBe(false)
  expect(JSON.stringify(status)).not.toMatch(/token|endpoint|deviceId|workerId|directory|origin|fixture-key/u)
})

it('uses distinct mode totals from the authenticated actual-settled ledger response', async () => {
  const { parseSharingSnapshot } = await sharingUI()
  const root = await scratch()
  let available = false
  const origin = await http((req, res) => {
    expect(req.url).toBe('/api/v8/media/provider/summary'); expect(req.headers.authorization).toBe('Bearer summary-fixture')
    if (!available) { res.writeHead(503).end(); return }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, currency: 'CNY', basis: 'actual_settled_ledger',
      modes: { image: { completedCalls: 17, settledEarnings: '2.5000' }, video: { completedCalls: 23, settledEarnings: '7.1200' } } }))
  })
  const coordinator = new SharingCoordinator({ directory: root, gatewayOrigin: '', metadataPublicKey: '', metadataKeyId: '', guangzhouPublicKey: '', guangzhouKeyId: '',
    uploadPublicKey: '', uploadKeyId: '', authorizationPublicKey: '', authorizationKeyId: '', orderPublicKey: '', orderKeyId: '',
    downloadOrigins: [], executionState: async () => 'idle', owner: async () => '21', presenceAllowed: async () => true, token: async () => 'summary-fixture', workerId: () => null, coreOrigin: () => origin,
    channel: () => ({ disconnect: async () => {}, connect: async () => {}, prepare: async () => deviceId,
      session: () => undefined, status: () => undefined, ownerId: () => '21' }),
    occupancyChanged: () => {}, legacyBusy: () => false, admission: async action => action() })
  cleanup.push(() => coordinator.close()); await confirmed(coordinator, 'image', 'enable', randomUUID())
  expect((await coordinator.snapshot()).modes.every(m => m.completedCalls === null && m.settledYuan === null
    && !m.completedSteps.includes('earnings'))).toBe(true)
  available = true; await confirmed(coordinator, 'video', 'enable', randomUUID())
  const snapshot = await coordinator.snapshot()
  expect(snapshot.modes.map(m => [m.completedCalls, m.settledYuan])).toEqual([[17, '2.5000'], [23, '7.1200']])
  expect(snapshot.modes.every(m => m.completedSteps.includes('earnings'))).toBe(true)
  expect(parseSharingSnapshot(snapshot).modes.map(m => [m.completedCalls, m.settledYuan])).toEqual([[17, '2.5000'], [23, '7.1200']])
})

it('serves authenticated, anonymous and owner-switch snapshots over real HTTP accepted by the actual UI transport', async () => {
  let owner: string | null = null
  const coordinator = new SharingCoordinator(coordinatorOptions(await scratch(), { owner: async () => owner }))
  cleanup.push(() => coordinator.close()); const { origin, transport } = await sharingHTTP(coordinator)
  const signal = new AbortController().signal; const anonymous = await transport.read(signal)
  expect(anonymous.authenticated).toBe(false); expect(anonymous.modes.every(m => m.reason === 'login_required')).toBe(true)
  expect((await fetch(origin + '/api/qianshou/node/sharing/enable', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'image', requestId: randomUUID(), scopeId: randomUUID(),
      consent: { version: 'qianshou.media-sharing-consent.v1', connection: true, execution: 'idle_only' } }) })).status).toBe(403)
  owner = '21'; const requestId = randomUUID(); await uiConfirmed(transport, 'image', 'enable', requestId, signal)
  await vi.waitFor(async () => { expect((await transport.read(signal)).modes[0]).toMatchObject({ phase: 'blocked',
    reason: 'catalog_unavailable', operationId: requestId, completedCalls: null, settledYuan: null, completedSteps: ['detect'] }) })
  await uiConfirmed(transport, 'image', 'enable', requestId, signal)
  await uiConfirmed(transport, 'image', 'pause', randomUUID(), signal)
  expect((await transport.read(signal)).modes[0]?.phase).toBe('paused')
  owner = '22'; const next = await transport.read(signal); expect(next.authenticated).toBe(true)
  expect(next.modes.every(m => m.phase === 'idle' && m.operationId === null && m.completedCalls === null)).toBe(true)
  owner = null; const loggedOut = await transport.read(signal)
  expect(loggedOut.authenticated).toBe(false)
  expect(JSON.stringify(loggedOut)).not.toMatch(/token|endpoint|deviceId|workerId|directory|origin|https?:\/\/|127\.0\.0\.1/u)
})

it('preserves the finite catalog reason after real hardware detection and a real Guangzhou 503', async () => {
  let requests = 0
  const gateway = await http((req, res) => { void (async () => {
    if (req.url?.startsWith('/v1/nodes/probe?')) {
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ schema: 'qianshou.media-gateway-probe.v1',
        service: 'qianshou-guangzhou-media', nonce: new URL(req.url, 'http://127.0.0.1').searchParams.get('nonce'),
        time: Math.floor(Date.now() / 1000) })); return
    }
    requests++; expect(req.url).toBe('/v1/media/install-manifest'); expect(req.headers.authorization).toBe('Bearer account-fixture')
    const body = await json(req); expect(Object.keys(body).sort()).toEqual(['arch', 'deviceId', 'hardware', 'mode', 'nonce',
      'platform', 'workerId']); expect(body.workerId).toBe(workerId)
    res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'catalog_unavailable' }))
  })().catch((error: unknown) => res.destroy(error as Error)) })
  const coordinator = new SharingCoordinator(coordinatorOptions(await scratch(), { gatewayOrigin: gateway,
    metadataPublicKey, metadataKeyId: 'metadata-fixture-key', token: async () => 'account-fixture', workerId: () => workerId }))
  cleanup.push(() => coordinator.close()); const { transport } = await sharingHTTP(coordinator); const signal = new AbortController().signal
  await uiConfirmed(transport, 'image', 'enable', randomUUID(), signal)
  await vi.waitFor(async () => { const row = (await transport.read(signal)).modes[0]
    expect(row).toMatchObject({ phase: 'blocked', reason: 'catalog_unavailable', completedSteps: ['detect'],
      completedCalls: null, settledYuan: null, modelName: null }) }, { timeout: 10000 })
  expect(requests).toBe(1)
})

it('keeps an unbound worker verification-pending before any model download or claimed installation', async () => {
  let requests = 0; const gateway = await http((req, res) => {
    if (!req.url?.startsWith('/v1/nodes/probe?')) requests++
    res.writeHead(503).end()
  })
  const coordinator = new SharingCoordinator(coordinatorOptions(await scratch(), { gatewayOrigin: gateway,
    metadataPublicKey, metadataKeyId: 'metadata-fixture-key', token: async () => 'account-fixture' }))
  cleanup.push(() => coordinator.close()); const { transport } = await sharingHTTP(coordinator); const signal = new AbortController().signal
  await uiConfirmed(transport, 'video', 'enable', randomUUID(), signal)
  await vi.waitFor(async () => { expect((await transport.read(signal)).modes[1]).toMatchObject({ phase: 'blocked',
    reason: 'verification_pending', completedSteps: ['detect'], modelName: null }) })
  expect(requests).toBe(0)
})

it('probes at anonymous cold start and every real HTTP refresh without treating 401, 503, stale nonce or timeout as authorization', async () => {
  const nonces: string[] = []; let status = 200; let badNonce = false; let staleTime = false; let stalled = false
  const token = vi.fn(async () => 'never-send-this-account-token')
  const gateway = await http((req, res) => {
    expect(req.method).toBe('GET'); expect(req.headers.authorization).toBeUndefined(); expect(req.headers.cookie).toBeUndefined()
    const url = new URL(req.url!, 'http://127.0.0.1'); expect(url.pathname).toBe('/v1/nodes/probe')
    const nonce = url.searchParams.get('nonce')!; expect(nonce).toMatch(/^[0-9a-f-]{36}$/u); nonces.push(nonce)
    if (stalled) return
    if (status !== 200) { res.writeHead(status).end(); return }
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify({ schema: 'qianshou.media-gateway-probe.v1', service: 'qianshou-guangzhou-media',
      nonce: badNonce ? randomUUID() : nonce, time: Math.floor(Date.now() / 1000) - (staleTime ? 120 : 0) }))
  })
  const root = await scratch(); const options = coordinatorOptions(root, { gatewayOrigin: gateway,
    owner: async () => null, token, probeTimeoutMs: 150 })
  const coordinator = new SharingCoordinator(options); cleanup.push(() => coordinator.close()); coordinator.start()
  await vi.waitFor(async () => { expect((await coordinator.snapshot()).connection?.gateway).toBe('reachable') })
  const { transport } = await sharingHTTP(coordinator); const signal = new AbortController().signal
  let value = await transport.read(signal)
  expect(value.connection).toMatchObject({ gateway: 'reachable', deviceAuthorization: 'unknown', channel: 'idle',
    heartbeat: 'unknown', heartbeatAt: null })
  for (const code of [401, 503]) { status = code
    await vi.waitFor(async () => { value = await transport.read(signal)
      expect(value.connection).toMatchObject({ gateway: 'unavailable', deviceAuthorization: 'unknown', heartbeat: 'unknown' }) }) }
  status = 200; badNonce = true; expect((await transport.read(signal)).connection?.gateway).toBe('unavailable')
  badNonce = false; staleTime = true; expect((await transport.read(signal)).connection?.gateway).toBe('unavailable')
  staleTime = false; stalled = true; const before = Date.now(); value = await transport.read(signal)
  expect(value.connection?.gateway).toBe('unavailable'); expect(Date.now() - before).toBeLessThan(1000)
  stalled = false; await vi.waitFor(async () => { expect((await transport.read(signal)).connection?.gateway).toBe('reachable') })
  expect(new Set(nonces).size).toBe(nonces.length); expect(token).not.toHaveBeenCalled()
  expect(JSON.stringify(value)).not.toMatch(/token|deviceId|workerId|https?:\/\/|127\.0\.0\.1/u)
  await coordinator.close()
  const restarted = new SharingCoordinator(options); cleanup.push(() => restarted.close())
  expect((await restarted.snapshot()).connection).toMatchObject({ gateway: 'unknown', deviceAuthorization: 'unknown', heartbeat: 'unknown' })
  restarted.start(); await vi.waitFor(async () => { expect((await restarted.snapshot()).connection?.gateway).toBe('reachable') })
})

it('aborts an old-account probe and observes a new nonce without restoring previous device authorization', async () => {
  let owner: string | null = '21'; let first = true; const nonces: string[] = []
  const gateway = await http((req, res) => {
    const nonce = new URL(req.url!, 'http://127.0.0.1').searchParams.get('nonce')!; nonces.push(nonce)
    if (first) { first = false; return }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ schema: 'qianshou.media-gateway-probe.v1',
      service: 'qianshou-guangzhou-media', nonce, time: Math.floor(Date.now() / 1000) }))
  })
  const coordinator = new SharingCoordinator(coordinatorOptions(await scratch(), { gatewayOrigin: gateway,
    owner: async () => owner, probeTimeoutMs: 1000 })); cleanup.push(() => coordinator.close())
  const old = coordinator.refreshConnection(); await vi.waitFor(() => { expect(nonces).toHaveLength(1) })
  owner = '22'; await coordinator.refreshConnection(); await old
  expect((await coordinator.snapshot()).connection).toMatchObject({ gateway: 'reachable', deviceAuthorization: 'unknown',
    channel: 'idle', heartbeat: 'unknown', heartbeatAt: null })
  expect(new Set(nonces).size).toBe(2)
  owner = null; await coordinator.refreshConnection()
  expect((await coordinator.snapshot()).authenticated).toBe(false); expect(new Set(nonces).size).toBe(3)
})


async function localFixture() {
  let unavailable = false; let healthyModel = true; let requiredClass = true
  const requests: { method: string | undefined; path: string; authorization: string | undefined }[] = []
  const models: Record<string, string[]> = { diffusion_models: ['qwen_image_2.1_int8_convrot.safetensors'],
    text_encoders: ['qwen3vl_8b_int8_convrot.safetensors'], vae: ['qwen_image_2.1_vae_bf16.safetensors'] }
  const origin = await http((req, res) => {
    requests.push({ method: req.method, path: req.url!, authorization: req.headers.authorization })
    res.setHeader('content-type', 'application/json')
    if (unavailable) { res.writeHead(503).end('{}'); return }
    if (req.url === '/system_stats') { res.end(JSON.stringify({ devices: [{ name: 'Fixture GPU', type: 'mps',
      vram_total: 8 * 1048576, vram_free: 4 * 1048576 }] })); return }
    if (req.url === '/models') { res.end(JSON.stringify(Object.keys(models))); return }
    if (req.url?.startsWith('/models/')) { res.end(JSON.stringify(models[req.url.slice(8)] ?? [])); return }
    if (req.url === '/healthz') { res.end(JSON.stringify({ status: 'ok', model: healthyModel
      ? 'qwen-image-2.1-int8-convrot' : 'unidentified', comfy_reachable: true, busy: false })); return }
    if (req.url?.startsWith('/object_info/')) { const name = req.url.slice(13)
      res.end(JSON.stringify(requiredClass ? { [name]: { input: { required: {} }, output: ['fixture'] } } : {})); return }
    if (req.url === '/v1/workflows') { res.writeHead(401).end('{}'); return }
    res.writeHead(404).end('{}')
  })
  return { origin, models, requests, fail: () => { unavailable = true }, unknownModel: () => { healthyModel = false },
    missingClass: () => { requiredClass = false } }
}
it('observes existing local model files and a supported image API without registering, downloading or executing any job', async () => {
  const f = await localFixture()
  const options = { comfyOrigin: f.origin, imageOrigin: f.origin, videoOrigin: f.origin, timeoutMs: 1000 }
  const value = await observeSharingLocal(options, new AbortController().signal)
  expect(value.image).toMatchObject({ inventory: 'detected', modelCount: 3, runtime: 'ready',
    adapter: 'qianshou_image', adoption: 'verification_required' })
  expect(value.video).toMatchObject({ inventory: 'detected', modelCount: 3, runtime: 'authentication_required', adoption: 'unmatched' })
  expect(f.requests.every(req => req.method === 'GET' && req.authorization === undefined)).toBe(true)
  expect(JSON.stringify(value)).not.toMatch(/safetensors|https?:|127\.0|token|directory|Fixture GPU/u)
  f.unknownModel()
  expect((await observeSharingLocal(options, new AbortController().signal)).image.runtime).toBe('unsupported')
})
it('finds a running Qwen workflow on a nondefault loopback port without reading or publishing private filenames', async () => {
  const f = await localFixture()
  const selected = new URL(f.origin)
  const options = { comfyOrigin: 'http://127.0.0.1:9', imageOrigin: 'http://127.0.0.1:9',
    videoOrigin: 'http://127.0.0.1:9', timeoutMs: 2000, autoDiscover: true }
  const result = await discoverSharingLocal(options, new AbortController().signal, async () => [Number(selected.port)])
  expect(result.comfyOrigin).toBe(f.origin)
  expect(result.imageOrigin).toBe(f.origin)
  expect(result.states.image).toMatchObject({ inventory: 'detected', modelCount: 3, runtime: 'ready',
    adapter: 'qianshou_image', adoption: 'verification_required' })
  expect(result.states.video.runtime).not.toBe('ready')
  expect(f.requests.every(request => request.method === 'GET' && request.authorization === undefined)).toBe(true)
  expect(JSON.stringify(result.states)).not.toMatch(/safetensors|127\.0|token|Fixture GPU/u)
  const withoutScan = await discoverSharingLocal({ ...options, autoDiscover: false }, new AbortController().signal)
  expect(withoutScan.states.image.runtime).toBe('unavailable')
})
it('downgrades expired model and gateway observations before the renderer parses a status response', async () => {
  const coordinator = new SharingCoordinator(coordinatorOptions(await scratch(), { owner: async () => null,
    gatewayOrigin: 'http://127.0.0.1:9' })); cleanup.push(() => coordinator.close())
  await coordinator.snapshot()
  Reflect.set(coordinator, 'gateway', 'reachable')
  Reflect.set(coordinator, 'probeCheckedAt', Math.floor(Date.now() / 1000) - 61)
  const stale = { inventory: 'detected', modelCount: 3, runtime: 'ready', adapter: 'qianshou_image',
    adoption: 'verification_required', checkedAt: Math.floor(Date.now() / 1000) - 61 }
  Reflect.set(coordinator, 'localState', { image: stale, video: stale })
  const snapshot = (await sharingUI()).parseSharingSnapshot(await coordinator.snapshot())
  expect(snapshot.connection).toMatchObject({ gateway: 'checking', checkedAt: null })
  expect(snapshot.modes.map(mode => mode.local)).toEqual([expect.objectContaining({ runtime: 'unknown', checkedAt: null }),
    expect.objectContaining({ runtime: 'unknown', checkedAt: null })])
  expect(snapshot.modes[0]?.api?.status).toBe('unknown')
})
it('does not turn a healthy port, missing workflow class or failed inventory read into model absence or formal supply', async () => {
  const f = await localFixture()
  const options = { comfyOrigin: f.origin, imageOrigin: f.origin, videoOrigin: '', timeoutMs: 1000 }
  f.missingClass()
  expect((await observeSharingLocal(options, new AbortController().signal)).image).toMatchObject({ inventory: 'detected',
    runtime: 'unsupported', adoption: 'unmatched' })
  f.fail()
  expect((await observeSharingLocal(options, new AbortController().signal)).image).toMatchObject({ inventory: 'unavailable',
    modelCount: null, runtime: 'unavailable' })
  await expect(observeSharingLocal({ ...options, comfyOrigin: 'https://outside.fixture.invalid' },
    new AbortController().signal)).rejects.toThrow('ORIGIN_INVALID')
})
it('preserves discovered files for both modes while refused connections and HTTP failures remain unavailable', async () => {
  const f = await localFixture(); let code = 503; let mime = 'application/json'
  const api = await http((req, res) => {
    expect(req.method).toBe('GET'); expect(req.headers.authorization).toBeUndefined()
    res.writeHead(code, { 'Content-Type': mime }).end('{}')
  })
  const options = { comfyOrigin: f.origin, imageOrigin: api, videoOrigin: api, timeoutMs: 1000 }
  const signal = new AbortController().signal
  for (const [status, runtime] of [[503, 'unavailable'], [401, 'authentication_required'], [200, 'unsupported']] as const) {
    code = status; const value = await observeSharingLocal(options, signal)
    for (const mode of ['image', 'video'] as const) expect(value[mode]).toMatchObject({ inventory: 'detected',
      modelCount: 3, runtime })
  }
  mime = 'text/plain'
  for (const value of Object.values(await observeSharingLocal(options, signal))) expect(value).toMatchObject({
    inventory: 'detected', modelCount: 3, runtime: 'unsupported' })
  const stopped = createServer(); stopped.listen(0, '127.0.0.1'); await once(stopped, 'listening')
  const address = stopped.address(); if (address === null || typeof address === 'string') throw new Error('fixture port unavailable')
  const refused = 'http://127.0.0.1:' + String(address.port)
  await new Promise<void>(resolve => stopped.close(() => { resolve() }))
  const value = await observeSharingLocal({ ...options, imageOrigin: refused, videoOrigin: refused }, signal)
  for (const mode of ['image', 'video'] as const) expect(value[mode]).toMatchObject({ inventory: 'detected',
    modelCount: 3, runtime: 'unavailable' })
  expect(f.requests.every(request => request.method === 'GET')).toBe(true)
})
it('detects hardware and existing models before enable and reports missing free connectivity instead of a paid catalog blocker', async () => {
  const f = await localFixture(); let owner: string | null = null; let connections = 0
  const coordinator = new SharingCoordinator(coordinatorOptions(await scratch(), { owner: async () => owner,
    localDiscovery: { comfyOrigin: f.origin, imageOrigin: f.origin, videoOrigin: '', timeoutMs: 1000 },
    channel: () => ({ disconnect: async () => {}, connect: async () => { connections++ }, prepare: async () => deviceId,
      session: () => undefined, status: () => undefined, ownerId: () => owner }) }))
  cleanup.push(() => coordinator.close()); const { transport } = await sharingHTTP(coordinator); const signal = new AbortController().signal
  let cold = await transport.read(signal)
  await vi.waitFor(async () => { cold = await transport.read(signal)
    expect(cold.hardware?.memoryMb).toBeGreaterThan(0)
    expect(cold.modes[0]?.local?.inventory).toBe('detected') })
  expect(cold.hardware?.memoryMb).toBeGreaterThan(0)
  expect(cold.authenticated).toBe(false)
  expect(cold.modes[0]?.local).toMatchObject({ inventory: 'detected', modelCount: 3, runtime: 'ready', adoption: 'verification_required' })
  expect(connections).toBe(0); expect(coordinator.executor.capabilities).toEqual([])
  owner = '21'; await uiConfirmed(transport, 'image', 'enable', randomUUID(), signal)
  await vi.waitFor(async () => { expect((await transport.read(signal)).modes[0]).toMatchObject({ phase: 'blocked',
    reason: 'connection_unavailable', local: { inventory: 'detected', runtime: 'ready', adoption: 'verification_required' } }) })
  expect(connections).toBe(0); expect(coordinator.executor.capabilities).toEqual([])
  f.fail(); await vi.waitFor(async () => {
    const next = await transport.read(signal)
    expect(next.modes[0]?.local).toMatchObject({ inventory: 'unavailable', modelCount: null, runtime: 'unavailable' }) })
})
it('reuses an existing hash-verified bundle and its authenticated running instance with zero download requests or process replacement', async () => {
  const f = await packageFixture(); const before = await readFile(join(f.runtime.root, 'process.json'))
  const downloads = f.downloadRequests.length; const progress: [number, number][] = []
  expect(await f.runtime.installed(new AbortController().signal)).toBe(true)
  await f.runtime.install(new AbortController().signal, (bytes, total) => { progress.push([bytes, total]) })
  await f.runtime.start(new AbortController().signal)
  expect(f.downloadRequests).toHaveLength(downloads); expect(progress).toEqual([[0, 0]])
  expect(await readFile(join(f.runtime.root, 'process.json'))).toEqual(before)
  expect(await f.runtime.healthy(new AbortController().signal)).toBe(true)
  const file = f.manifest.files[0]!
  const bytes = Buffer.from(await readFile(join(f.runtime.root, file.path))); bytes[0] = bytes[0]! ^ 1
  await writeFile(join(f.runtime.root, file.path), bytes, { mode: 0o700 })
  await expect(f.runtime.installed(new AbortController().signal)).rejects.toThrow('HASH_INVALID')
  expect(f.downloadRequests).toHaveLength(downloads)
})

it('migrates the actual v1 SQLite schema without turning old desired records into connection or execution permission', async () => {
  const root = await scratch(); const store = await SharingStore.open(root)
  const legacyId = randomUUID(); store.command('21', 'image', 'enable', legacyId); store.close()
  const old = new DatabaseSync(join(root, 'control.sqlite'))
  old.exec('DROP TABLE operation_details; DROP TABLE permissions; PRAGMA user_version=1'); old.close()
  await writeFile(join(root, 'established.v1'), sharingCanonical({ schema: 'qianshou.compute-sharing-store.v1', version: 1 }), { mode: 0o600 })
  const restored = await SharingStore.open(root); cleanup.push(async () => { restored.close() })
  expect(restored.mode('21', 'image').desired).toBe(true)
  expect(restored.authorization('21', deviceId, 'image')).toEqual({ connection: 'required', execution: 'disabled', deviceBound: false })
  const scope = randomUUID(); const consent = { version: 'qianshou.media-sharing-consent.v1' as const, connection: true as const, execution: 'idle_only' as const }
  expect(() => restored.authorizedCommand('21', deviceId, 'image', 'enable', legacyId, scope, consent)).toThrow('REQUEST_CONFLICT')
  const id = randomUUID(); expect(restored.authorizedCommand('21', deviceId, 'image', 'enable', id, scope, consent)).toBe(true)
  expect(restored.authorizedCommand('21', deviceId, 'image', 'enable', id, scope, consent)).toBe(false)
  expect(() => restored.authorizedCommand('21', deviceId, 'image', 'enable', id, scope, { ...consent, execution: 'disabled' })).toThrow('REQUEST_CONFLICT')
  expect(restored.authorization('21', randomUUID(), 'image').connection).toBe('required')
  expect(restored.authorization('22', deviceId, 'image').connection).toBe('required')
  expect(restored.authorization('21', deviceId, 'video').connection).toBe('required')
  restored.authorizedCommand('21', deviceId, 'image', 'pause', randomUUID(), scope)
  expect(restored.authorization('21', deviceId, 'image').connection).toBe('granted')
  restored.authorizedCommand('21', deviceId, 'image', 'revoke', randomUUID(), scope)
  expect(restored.authorization('21', deviceId, 'image')).toEqual({ connection: 'revoked', execution: 'disabled', deviceBound: true })
})
it('requires explicit HTTP consent, reconciles unknown request UUID by owner-only GET, and revokes authorization at account exit', async () => {
  let owner: string | null = '21'; let starts = 0; let stops = 0
  const control = { prepare: async () => deviceId, ownerId: () => owner, status: () => undefined, session: () => undefined,
    connect: async () => {}, disconnect: async () => {}, connectOwned: async () => { starts++; return {
      current: () => ({ state: 'offline' as const, deviceId, connectionEpoch: 1, sequence: 0, errorCode: null,
        authorized: false, heartbeatAt: null, withdrawalConfirmed: null }), disconnect: async () => { stops++; return true } } } }
  const coordinator = new SharingCoordinator(coordinatorOptions(await scratch(), { owner: async () => owner,
    gatewayOrigin: 'http://127.0.0.1:9', executionState: async () => 'disabled', channel: () => control }))
  cleanup.push(() => coordinator.close()); const { origin, transport } = await sharingHTTP(coordinator)
  const signal = new AbortController().signal; const first = await transport.read(signal)
  const id = randomUUID(); const body = { mode: 'image', requestId: id, scopeId: first.scopeId }
  const post = (b: object) => fetch(origin + '/api/qianshou/node/sharing/enable', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
  const missing = await post(body); expect(missing.status).toBe(409)
  expect(await missing.json()).toEqual({ error: { code: 'SHARING_CONSENT_REQUIRED' } }); expect(starts).toBe(0)
  const consent = { version: 'qianshou.media-sharing-consent.v1', connection: true, execution: 'disabled' }
  expect((await post({ ...body, consent })).status).toBe(200)
  const recorded = await transport.read(signal, id)
  expect(recorded.operation).toEqual({ requestId: id, mode: 'image', action: 'enable', status: 'applied' })
  expect(recorded.modes[0]).toMatchObject({ reason: 'execution_disabled', authorization: { connection: 'granted', execution: 'disabled', deviceBound: true } })
  expect(coordinator.executor.capabilities).toEqual([]); expect(await coordinator.executor.readHeartbeat()).toMatchObject({ freeSlots: 0 })
  const startsBefore = starts
  expect((await transport.read(signal, randomUUID())).operation?.status).toBe('not_found')
  expect(starts).toBe(startsBefore) // Status reconciliation cannot replay the command or register a new device.
  owner = '22'; const second = await transport.read(signal, id)
  expect(second.scopeId).not.toBe(first.scopeId); expect(second.operation).toMatchObject({ status: 'not_found', mode: null, action: null })
  expect((await post({ ...body, requestId: randomUUID(), consent })).status).toBe(409)
  expect(stops).toBe(1)
  owner = '21'; const returned = await transport.read(signal)
  expect(returned.modes[0]?.phase).toBe('paused')
  expect(returned.modes[0]?.authorization?.connection).not.toBe('granted')
  expect(JSON.stringify(returned)).not.toMatch(/deviceId|ownerId|token|127\.0\.0\.1|directory/u)
})
it('keeps old desired intent disconnected and unknown measured execution at zero slots after explicit connection confirmation', async () => {
  const root = await scratch(); const store = await SharingStore.open(root)
  store.command('21', 'image', 'enable', randomUUID()); let connections = 0
  const coordinator = new SharingCoordinator(coordinatorOptions(root, { gatewayOrigin: 'http://127.0.0.1:9',
    executionState: async () => 'unknown', channel: () => ({ prepare: async () => deviceId, ownerId: () => '21',
      status: () => undefined, session: () => undefined, connect: async () => {}, disconnect: async () => {},
      connectOwned: async () => { connections++; return null } }) }))
  cleanup.push(async () => { await coordinator.close(); store.close() }); coordinator.start()
  await vi.waitFor(async () => { expect((await coordinator.snapshot()).modes[0]?.reason).toBe('consent_required') })
  expect(connections).toBe(0)
  await confirmed(coordinator, 'image', 'enable', randomUUID())
  await vi.waitFor(() => { expect(connections).toBeGreaterThan(0) })
  expect((await coordinator.snapshot()).modes[0]?.reason).toBe('resource_unavailable')
  expect(coordinator.executor.capabilities).toEqual([])
  expect(await coordinator.executor.readHeartbeat()).toMatchObject({ freeSlots: 0, availableSeconds: 0 })
})
it('uses measured idle, voice, foreground, memory and owner limits independently of the old OFF/node service policy', () => {
  const deployment = { mode: 'BACKGROUND_ONLY' as const, maxConcurrency: 2, maxCpuPercent: 50, maxGpuPercent: 50,
    maxTemperatureC: 70, minDiskFreeBytes: 1024, allowWhileUserActive: true }
  const owner = { mode: 'off' as const, maxConcurrency: 1, minFreeMemoryBytes: 4096, minIdleSeconds: 60, enabledServiceIds: [], nodeRates: [] }
  const facts = { activity: { userActive: false, idleSeconds: 120, unavailable: null }, voiceActive: false,
    foregroundTaskActive: false, freeMemoryBytes: 8192, runningTasks: 0 }
  expect(sharingExecutionAdmission(deployment, owner, facts, false)).toBe('idle')
  expect(owner).toEqual({ mode: 'off', maxConcurrency: 1, minFreeMemoryBytes: 4096, minIdleSeconds: 60, enabledServiceIds: [], nodeRates: [] })
  for (const change of [{ voiceActive: null }, { foregroundTaskActive: null }, { freeMemoryBytes: null },
    { activity: { ...facts.activity, idleSeconds: null } }, { activity: { ...facts.activity, userActive: null } }]) {
    expect(sharingExecutionAdmission(deployment, owner, { ...facts, ...change }, false)).toBe('unknown')
  }
  for (const change of [{ voiceActive: true }, { foregroundTaskActive: true }, { freeMemoryBytes: 2048 }, { runningTasks: 1 },
    { activity: { ...facts.activity, idleSeconds: 59 } }, { activity: { ...facts.activity, userActive: true } }]) {
    expect(sharingExecutionAdmission(deployment, owner, { ...facts, ...change }, false)).toBe('busy')
  }
  expect(sharingExecutionAdmission({ ...deployment, mode: 'OFF' }, owner, facts, false)).toBe('disabled')
  expect(sharingExecutionAdmission(deployment, null, facts, false)).toBe('unknown')
  expect(sharingExecutionAdmission(deployment, owner, facts, true)).toBe('busy')
})

it('adopts an exact already-running original runtime for GET only without download, spawn, POST or shutdown authority', async () => {
  const f = await packageFixture(); const originalRecord = await readFile(join(f.runtime.root, 'process.json'))
  const adopted = new SharingRuntime(f.runtime.root, f.manifest)
  expect(await adopted.adoptOriginal(new AbortController().signal)).toBe(true)
  expect(adopted.recoveryOnly).toBe(true)
  await expect(adopted.request('POST', '/v1/media/jobs', {}, new AbortController().signal)).rejects.toThrow('RECOVERY_READ_ONLY')
  await expect(adopted.start(new AbortController().signal)).rejects.toThrow('RUNTIME_UNAVAILABLE')
  await adopted.close()
  expect(await f.runtime.healthy(new AbortController().signal)).toBe(true) // Read-only restoration never shuts down that process.
  expect(await readFile(join(f.runtime.root, 'process.json'))).toEqual(originalRecord)
  const token = await readFile(join(f.runtime.root, 'runtime-token'))
  await writeFile(join(f.runtime.root, 'runtime-token'), '0'.repeat(64), { mode: 0o600 })
  const wrongCredential = new SharingRuntime(f.runtime.root, f.manifest)
  expect(await wrongCredential.adoptOriginal(new AbortController().signal)).toBe(false)
  await writeFile(join(f.runtime.root, 'runtime-token'), token, { mode: 0o600 })
  await writeFile(join(f.runtime.root, 'runner.mjs'), 'changed-package', { mode: 0o600 })
  const changed = new SharingRuntime(f.runtime.root, f.manifest)
  expect(await changed.adoptOriginal(new AbortController().signal)).toBe(false)
  expect(await readFile(join(f.runtime.root, 'process.json'))).toEqual(originalRecord)
})
it('keeps a missing original runtime unknown without creating private credentials or spawning a replacement', async () => {
  const f = await packageFixture(); await f.runtime.close()
  const record = await readFile(join(f.runtime.root, 'process.json')); const token = await readFile(join(f.runtime.root, 'runtime-token'))
  const adopted = new SharingRuntime(f.runtime.root, f.manifest)
  expect(await adopted.adoptOriginal(new AbortController().signal)).toBe(false)
  expect(await readFile(join(f.runtime.root, 'process.json'))).toEqual(record)
  expect(await readFile(join(f.runtime.root, 'runtime-token'))).toEqual(token)
  expect(await adopted.healthy(new AbortController().signal)).toBe(false)
})
it('restores a cold paused original attempt from an expired signed receipt and installed SHA using GET-only adoption', async () => {
  const f = await packageFixture(true); const root = await scratch(); const now = Math.floor(Date.now() / 1000)
  const original = metadataSigned({ ...f.manifest, issued_at: now - 600, expires_at: now - 300 })
  const bundleRoot = join(root, 'accounts', sharingDigest('21'), 'bundles', f.manifest.bundle_id)
  await mkdir(join(root, 'accounts', sharingDigest('21'), 'bundles'), { recursive: true, mode: 0o700 })
  await cp(f.runtime.root, bundleRoot, { recursive: true })
  const store = await SharingStore.open(root); const task = delivery(); const assetId = randomUUID()
  const outputPath = join(root, 'accounts', sharingDigest('21'), 'attempts', task.attemptId, 'result', assetId, 'result.png')
  await mkdir(join(outputPath, '..'), { recursive: true, mode: 0o700 })
  await expect(f.runtime.request('POST', '/v1/media/jobs', { taskId: task.taskId, attemptId: task.attemptId,
    leaseEpoch: 1, assetId, outputPath }, new AbortController().signal)).rejects.toThrow()
  store.updateMode('21', 'image', { phase: 'paused' }, original)
  store.admit({ task, owner: '21', mode: 'image', state: 'unknown', assetId, outputPath, eventSequence: 0, result: null })
  store.close() // A fresh coordinator has no runtime or new-intake binding.
  const calls: string[] = []; const session: SharingNodeSession = { deviceId, connectionEpoch: 1,
    post: async (path, body) => { calls.push(path)
      if (path === 'media/task-status') return { ok: true, task: { taskId: task.taskId, attemptId: task.attemptId, leaseEpoch: 1,
        stage: 'leased', verdict: null, settlement: null } }
      if (path === 'media/order-current') return { ok: true, order: order(task) }
      if (path === 'events') return { ok: true, sequence: body.sequence }
      throw new Error('fixture deliberately leaves original result delivery pending')
    } }
  const status = () => ({ state: 'connected' as const, deviceId, connectionEpoch: 1, sequence: 0, errorCode: null,
    authorized: true, heartbeatAt: Date.now(), withdrawalConfirmed: null })
  const coordinator = new SharingCoordinator(coordinatorOptions(root, { gatewayOrigin: f.origin,
    metadataPublicKey, metadataKeyId: 'metadata-fixture-key', workerId: () => workerId, downloadOrigins: [f.origin],
    executionState: async () => 'disabled', orderKeyId: 'fixture-key', orderPublicKey: publicKey,
    channel: () => ({ prepare: async () => deviceId, ownerId: () => '21', status, session: () => session,
      connect: async () => {}, disconnect: async () => {}, connectOwned: async () => null }) }))
  cleanup.push(() => coordinator.close()); coordinator.start()
  const observed = await SharingStore.open(root); cleanup.push(async () => { observed.close() })
  await vi.waitFor(() => { expect(observed.active()[0]?.state).toBe('generated') }, { timeout: 7000 })
  expect(calls).toContain('media/task-status'); expect(coordinator.executor.capabilities).toEqual([])
  expect(await coordinator.executor.readHeartbeat()).toMatchObject({ freeSlots: 0, runningAttemptIds: [task.attemptId] })
  const db = new DatabaseSync(join(f.runtime.root, 'fixture-jobs.sqlite'))
  expect(db.prepare("SELECT COUNT(*) AS n FROM calls WHERE method='POST'").get()?.n).toBe(1)
  expect(Number(db.prepare("SELECT COUNT(*) AS n FROM calls WHERE method='GET'").get()?.n)).toBeGreaterThan(0); db.close()
  expect(f.downloadRequests.filter(path => ['/entry', '/runner.mjs'].includes(path))).toHaveLength(2)
  // Public GET probes are separate; package URLs are read only during the initial CPU fixture install.
})

it('never substitutes the configured formal result root when metadata trust is missing', async () => {
  let metadataPosts = 0
  const gateway = await http((req, res) => { if (req.method === 'POST') metadataPosts++
    res.writeHead(503).end() })
  const coordinator = new SharingCoordinator(coordinatorOptions(await scratch(), { gatewayOrigin: gateway,
    guangzhouPublicKey: publicKey, guangzhouKeyId: 'fixture-key', token: async () => 'fixture-owner', workerId: () => workerId }))
  cleanup.push(() => coordinator.close())
  await confirmed(coordinator, 'image', 'enable', randomUUID())
  await vi.waitFor(async () => { expect((await coordinator.snapshot()).modes[0]?.reason).toBe('catalog_unavailable') })
  expect(metadataPosts).toBe(0); expect(coordinator.executor.capabilities).toEqual([])
})

async function apiCoordinatorFixture() {
  const local = await localFixture(); const bodies: { path: string; body: Record<string, unknown> }[] = []
  let owner: string | null = '21'; let epoch = 3; let loseResult = false; let rejectReports = false; let holdResult = false; let releaseResult: (() => void) | undefined
  const gateway = await http((req, res) => { void (async () => {
    res.setHeader('content-type', 'application/json')
    if (req.url?.startsWith('/v1/nodes/probe?')) { const nonce = new URL(req.url, 'http://fixture').searchParams.get('nonce')
      res.end(JSON.stringify({ schema: 'qianshou.media-gateway-probe.v1', service: 'qianshou-guangzhou-media', nonce,
        time: Math.floor(Date.now() / 1000) })); return }
    const body = await json(req); bodies.push({ path: req.url!, body })
    if (req.url === '/v1/nodes/api-observations') { if (rejectReports) { res.writeHead(503).end('{}'); return }; res.end(JSON.stringify({ ok: true, deviceId, connectionEpoch: body.connectionEpoch,
      observationRevision: body.observationRevision })); return }
    if (req.url === '/v1/nodes/api-probe-result') {
      if (loseResult) { loseResult = false; res.destroy(); return }
      const observation = body.observation as { status: string }
      if (holdResult) await new Promise<void>((resolve) => { releaseResult = resolve })
      res.end(JSON.stringify({ ok: true, deviceId, connectionEpoch: body.connectionEpoch, requestId: body.requestId,
        status: observation.status === 'ready' ? 'confirmed' : 'failed', confirmedAt: observation.status === 'ready' ? new Date().toISOString() : null })); return }
    res.writeHead(404).end('{}')
  })().catch((error: unknown) => res.destroy(error as Error)) })
  const status = () => ({ state: 'connected' as const, deviceId, connectionEpoch: epoch, sequence: 0, errorCode: null,
    authorized: true, heartbeatAt: Date.now(), withdrawalConfirmed: null })
  const session = (): SharingNodeSession => ({ deviceId, connectionEpoch: epoch, post: async (path, body, signal) => {
    const response = await fetch(gateway + '/v1/nodes/' + path, { method: 'POST', signal, headers: { 'content-type': 'application/json',
      authorization: 'Bearer fixture-private-device' }, body: JSON.stringify({ ...body, deviceId, connectionEpoch: epoch }) })
    return await response.json() as Record<string, unknown>
  } })
  const coordinator = new SharingCoordinator(coordinatorOptions(await scratch(), { gatewayOrigin: gateway, owner: async () => owner,
    executionState: async () => 'disabled', localDiscovery: { comfyOrigin: local.origin, imageOrigin: local.origin, videoOrigin: '', timeoutMs: 1000 },
    channel: () => ({ ownerId: () => '21', status, session, prepare: async () => deviceId, connect: async () => {}, disconnect: async () => {},
      connectOwned: async () => ({ current: status, disconnect: async () => true }) }) }))
  cleanup.push(() => coordinator.close()); await coordinator.refreshConnection()
  const probe = () => ({ requestId: randomUUID(), mode: 'image' as const, epoch, kind: 'metadata' as const,
    expiresAt: new Date(Date.now() + 90000).toISOString() })
  return { coordinator, local, bodies, probe, session, loseResult: () => { loseResult = true },
    changeOwner: () => { owner = '22' }, nextEpoch: () => { epoch++ }, rejectReports: () => { rejectReports = true }, allowReports: () => { rejectReports = false }, holdResult: () => { holdResult = true }, releaseResult: () => releaseResult?.() }
}
it('reports the real fixed image API only after current mode consent, with no catalog, GPU capability or fee authority', async () => {
  const f = await apiCoordinatorFixture()
  expect(f.bodies).toEqual([]) // A manual channel without sharing intent is not mutated.
  await confirmed(f.coordinator, 'image', 'enable', randomUUID()); await f.coordinator.refreshConnection()
  const reports = f.bodies.filter(p => p.path.endsWith('api-observations'))
  expect(reports).toHaveLength(1)
  const observations = reports[0]!.body.observations as Record<string, unknown>[]
  expect(observations).toEqual([{ mode: 'image', adapter: 'qianshou_image', status: 'ready',
    model: { id: 'qwen-image-2.1-int8-convrot', sha256: null, version: '2.1' },
    workflow: { id: 'qianshou-qwen-image21-text-to-image', sha256: null, version: null }, observedAt: expect.any(String) as unknown }])
  expect((await f.coordinator.snapshot()).modes[0]?.api).toMatchObject({ registration: 'registered', probeStatus: 'pending',
    modelName: 'Qwen Image 2.1 (INT8 ConvRot)', lastProbedAt: null })
  await vi.waitFor(async () => { expect((await f.coordinator.snapshot()).modes[0]).toMatchObject({
    phase: 'connecting', reason: null }) })
  expect(f.bodies.some(p => p.path.endsWith('install-manifest'))).toBe(false)
  expect(f.coordinator.executor.capabilities).toEqual([])
  expect(await f.coordinator.executor.readHeartbeat()).toMatchObject({ freeSlots: 0 })
  expect(f.local.requests.every(p => p.method === 'GET')).toBe(true)
  expect(JSON.stringify(reports)).not.toMatch(/127\.0|safetensors|fixture-private|validation_receipt|unit_price/u)
})
it('checks a real 90-second metadata challenge and persists its original response across an unknown HTTP outcome', async () => {
  const f = await apiCoordinatorFixture(); await confirmed(f.coordinator, 'image', 'enable', randomUUID())
  await f.coordinator.refreshConnection(); const probe = f.probe(); f.loseResult()
  await f.coordinator.executor.onApiProbe!(probe, new AbortController().signal, f.session())
  expect((await f.coordinator.snapshot()).modes[0]?.api?.probeStatus).toBe('pending')
  f.local.unknownModel() // Re-delivery must POST the original durable body, not silently change its UUID response.
  await f.coordinator.executor.onApiProbe!(probe, new AbortController().signal, f.session())
  const replies = f.bodies.filter(p => p.path.endsWith('api-probe-result'))
  expect(replies).toHaveLength(2); expect(replies[0]!.body).toEqual(replies[1]!.body)
  expect((await f.coordinator.snapshot()).modes[0]?.api).toMatchObject({ status: 'unsupported', lastProbedAt: null, probeStatus: 'unknown' })
  expect(f.local.requests.every(p => p.method === 'GET')).toBe(true); expect(f.coordinator.executor.capabilities).toEqual([])
})
it('publishes successful Guangzhou confirmation only for the current owner, epoch and still-authorized API', async () => {
  const f = await apiCoordinatorFixture(); await confirmed(f.coordinator, 'image', 'enable', randomUUID()); await f.coordinator.refreshConnection()
  await f.coordinator.executor.onApiProbe!(f.probe(), new AbortController().signal, f.session())
  expect((await f.coordinator.snapshot()).modes[0]?.api).toMatchObject({ registration: 'registered', probeStatus: 'passed',
    lastProbedAt: expect.any(String) as unknown })
  f.nextEpoch()
  expect((await f.coordinator.snapshot()).modes[0]?.api?.lastProbedAt).toBeNull()
  f.changeOwner(); const calls = f.bodies.length; await f.coordinator.refreshConnection()
  expect((await f.coordinator.snapshot()).modes[0]?.api).toMatchObject({ registration: 'unknown', probeStatus: 'unknown', lastProbedAt: null })
  expect(f.bodies).toHaveLength(calls)
})
it('restores the exact SQLite metadata receipt and refuses UUID reuse across device or epoch', async () => {
  const { sharingAPIObservation } = await import('../src/sharing-api-observations.ts')
  const root = await scratch(); let store = await SharingStore.open(root)
  const probe = { requestId: randomUUID(), mode: 'image' as const, epoch: 3, kind: 'metadata' as const,
    expiresAt: new Date(Date.now() + 90000).toISOString() }
  const observation = sharingAPIObservation('image', { inventory: 'detected', modelCount: 3, runtime: 'ready',
    adapter: 'qianshou_image', adoption: 'verification_required', checkedAt: Math.floor(Date.now() / 1000) })
  store.apiProbeReceipt('21', deviceId, probe, observation); store.close(); store = await SharingStore.open(root)
  cleanup.push(async () => { store.close() })
  const changed = { ...observation, status: 'unavailable' as const, model: null, workflow: null }
  expect(store.apiProbeReceipt('21', deviceId, probe, changed).observation).toEqual(observation)
  expect(() => store.apiProbeReceipt('21', deviceId, { ...probe, epoch: 4 }, observation)).toThrow('REQUEST_CONFLICT')
  expect(() => store.apiProbeReceipt('21', randomUUID(), probe, observation)).toThrow('REQUEST_CONFLICT')
})
it('rejects expired, wrong-epoch and arbitrary metadata operations while accepting the real 90-second gateway TTL', async () => {
  const { parseSharingAPIProbe } = await import('../src/sharing-api-observations.ts')
  const p = { requestId: randomUUID(), mode: 'image', epoch: 3, kind: 'metadata', expiresAt: new Date(Date.now() + 90000).toISOString() }
  expect(parseSharingAPIProbe(p, 3)).toEqual(p)
  for (const changed of [{ epoch: 2 }, { kind: 'generate' }, { url: 'http://127.0.0.1/prompt' },
    { expiresAt: new Date(Date.now() - 1).toISOString() }, { expiresAt: new Date(Date.now() + 120000).toISOString() }]) {
    expect(() => parseSharingAPIProbe({ ...p, ...changed }, 3)).toThrow('RESPONSE_INVALID')
  }
})

it('rotates only expired unacknowledged metadata after a disconnected gateway and preserves acknowledged revisions', async () => {
  const f = await apiCoordinatorFixture(); f.rejectReports()
  await confirmed(f.coordinator, 'image', 'enable', randomUUID()); await f.coordinator.refreshConnection()
  const first = f.bodies.filter(b => b.path.endsWith('api-observations'))
  expect(first.length).toBeGreaterThan(1); expect(first[0]!.body).toEqual(first[1]!.body)
  const originalNow = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(originalNow + 70000)
  try {
    f.allowReports(); await f.coordinator.refreshConnection()
    const last = f.bodies.at(-1)!
    expect(last.path).toBe('/v1/nodes/api-observations'); expect(last.body.observationRevision).not.toBe(first[0]!.body.observationRevision)
    expect((await f.coordinator.snapshot()).modes[0]?.api?.registration).toBe('registered')
    const count = f.bodies.length; await f.coordinator.refreshConnection(); expect(f.bodies).toHaveLength(count)
  } finally { clock.mockRestore() }
})

it('discards a late API confirmation after the account changes without authorizing the new owner', async () => {
  const f = await apiCoordinatorFixture(); await confirmed(f.coordinator, 'image', 'enable', randomUUID()); await f.coordinator.refreshConnection()
  f.holdResult(); const work = f.coordinator.executor.onApiProbe!(f.probe(), new AbortController().signal, f.session())
  await vi.waitFor(() => { expect(f.bodies.some(b => b.path.endsWith('api-probe-result'))).toBe(true) })
  f.changeOwner(); f.releaseResult(); await work
  const value = await f.coordinator.snapshot()
  expect(value.modes[0]?.authorization?.connection).toBe('required')
  expect(value.modes[0]?.api).toMatchObject({ registration: 'unknown', probeStatus: 'unknown', lastProbedAt: null })
})
