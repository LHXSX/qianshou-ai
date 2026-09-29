/** Real Guangzhou HTTP/SQLite and fixed Comfy CPU output; no account, model or GPU execution. */
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import { afterEach, expect, it, vi } from 'vitest'
import { MediaNodeChannel } from '../src/media-node-channel.ts'
import { ResearchConsumer, type ResearchConsumerOptions, type ResearchSession } from '../src/research-consumer.ts'
import { parseTask, type ResearchLease, type ResearchTask } from '../src/research-contract.ts'
import { SharingPilot } from '../src/sharing-pilot.ts'
import { SharingCoordinator } from '../src/sharing-coordinator.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const workflowSha = '154f7d6133fe0276e7cefc97a17ea2bde1febe397f3963bd0ea8be8c624ee7be'
const workflowId = 'comfy-pilot-image-154f7d6133fe0276'
function png(): Buffer {
  const chunk = (type: string, bytes: Buffer): Buffer => {
    const output = Buffer.alloc(bytes.length + 12); output.writeUInt32BE(bytes.length); output.write(type, 4); bytes.copy(output, 8)
    output.writeUInt32BE(crc32(output.subarray(4, -4)), output.length - 4); return output
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(2048); header.writeUInt32BE(1152, 4); header[8] = 8; header[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(1152 * (1 + 2048 * 3)))), chunk('IEND', Buffer.alloc(0))])
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'research-consumer-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const child = spawn(process.execPath, ['--import', 'tsx/esm', fileURLToPath(new URL('./fixtures/research-node-gateway.mjs', import.meta.url))], {
    env: { PATH: process.env.PATH ?? '', MEDIA_NODE_TEST_ROOT: root }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  let number = 0; const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const rpc = (method: string, value?: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    const id = ++number; pending.set(id, { resolve, reject }); child.send({ id, method, value })
  })
  let diagnostic = ''
  child.stderr?.on('data', (bytes: Buffer) => { diagnostic += bytes.toString() })
  const origin = await new Promise<string>((resolve, reject) => {
    child.on('message', (message: unknown) => {
      const row = message as { ready?: boolean; origin?: string; id?: number; result?: unknown; error?: string }
      if (row.ready && row.origin) { resolve(row.origin); return }
      const reply = pending.get(row.id ?? -1); if (reply === undefined) return
      pending.delete(row.id!); if (row.error) reply.reject(new Error(row.error)); else reply.resolve(row.result)
    })
    child.once('exit', () => { reject(new Error('CPU gateway ended: ' + diagnostic)) })
  })
  cleanup.push(async () => { await rpc('close'); if (child.exitCode === null) await once(child, 'exit') })
  const output = png(); let droppedPost = false; let postHold: Promise<unknown> | undefined
  const posts: { prompt_id: string; prompt: Record<string, { inputs: Record<string, unknown> }> }[] = []
  const calls: string[] = []; const history: Record<string, unknown> = {}; const externalId = randomUUID()
  const classes = JSON.parse(await readFile(new URL('./fixtures/comfy-pilot-metadata.json', import.meta.url), 'utf8')) as Record<string, unknown>
  const files: Record<string, string> = { diffusion_models: 'qwen_image_2.1_int8_convrot.safetensors',
    text_encoders: 'qwen3vl_8b_int8_convrot.safetensors', vae: 'qwen_image_2.1_vae_bf16.safetensors' }
  const server = createServer((request, response) => { void (async () => {
    const url = new URL(request.url!, 'http://127.0.0.1'); calls.push(String(request.method) + ' ' + url.pathname)
    let value: unknown
    if (url.pathname === '/prompt') {
      const chunks: Buffer[] = []; for await (const bytes of request) chunks.push(Buffer.from(bytes as Uint8Array))
      posts.push(JSON.parse(Buffer.concat(chunks).toString()) as typeof posts[number]); await postHold
      if (droppedPost) { request.socket.destroy(); return }
      value = { prompt_id: externalId, node_errors: {} }
    } else if (url.pathname === '/view') {
      response.writeHead(200, { 'content-type': 'image/png', 'content-length': output.length }).end(output); return
    } else if (url.pathname === '/system_stats') value = { devices: [{ name: 'CPU fixture', type: 'cpu', vram_total: 0, vram_free: 0 }] }
    else if (url.pathname === '/queue') value = { queue_running: [], queue_pending: [] }
    else if (url.pathname === '/models') value = Object.keys(files)
    else if (url.pathname.startsWith('/models/')) value = [files[url.pathname.slice('/models/'.length)]]
    else if (url.pathname.startsWith('/object_info/')) { const name = url.pathname.slice('/object_info/'.length); value = { [name]: classes[name] } }
    else if (url.pathname.startsWith('/history/')) value = history[url.pathname.slice('/history/'.length)] ?? {}
    else { response.writeHead(404).end(); return }
    const bytes = Buffer.from(JSON.stringify(value)); response.writeHead(200, { 'content-type': 'application/json', 'content-length': bytes.length }).end(bytes)
  })().catch(() => response.destroy()) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => { resolve() })) })
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('fixture listener missing')
  const comfyOrigin = 'http://127.0.0.1:' + String(address.port)
  const revision = 'e'.repeat(64); let owner = true; let idle = true; let foreignLease = false
  let coordinator: SharingCoordinator | undefined
  const observation = { mode: 'image', adapter: 'comfyui', status: 'ready',
    model: { id: 'qwen-image-2.1-int8-convrot', sha256: null, version: '2.1' },
    workflow: { id: workflowId, sha256: workflowSha, version: '1' }, observedAt: new Date().toISOString() }
  let channel: MediaNodeChannel
  const connect = async () => {
    channel = new MediaNodeChannel({ origin, directory: join(root, 'channel'), ownerId: '21', adapterVersion: 'fixture',
      capabilityRevision: 'no-formal-profiles', capabilities: [], maxConcurrency: 1, requestTimeoutMs: 2000, waitMs: 100,
      maxResponseBytes: 1048576, readAccessToken: async () => 'owner-access-token-fixture',
      assertOwner: async () => { if (!owner) throw new Error('OWNER_CHANGED') },
      readHeartbeat: async () => ({ freeSlots: 0, runningAttemptIds: [], freeVramMb: 0, availableSeconds: 0 }),
      onTask: async () => { throw new Error('formal tasks forbidden') },
      onApiProbe: async (probe, signal, session) => {
        if (coordinator !== undefined) { await coordinator.executor.onApiProbe?.(probe, signal, session); return }
        await session.post('api-probe-result', { requestId: probe.requestId, observation: { ...observation, observedAt: new Date().toISOString() } }, signal)
      } })
    cleanup.push(() => channel.close()); void channel.run().catch(() => undefined)
    await vi.waitFor(() => { expect(channel.status().state).toBe('connected') })
    await channel.session().post('api-observations', { observationRevision: revision, observations: [observation] }, AbortSignal.timeout(2000))
    await vi.waitFor(async () => {
      const directory = await rpc('adminList') as { nodes: { localServices?: { probe: { state: string } }[] }[] }
      expect(directory.nodes[0]?.localServices?.[0]?.probe.state).toBe('confirmed')
    })
    await channel.session().post('research/execution', { observationRevision: revision, mode: 'image', idle: true,
      resourceAllowed: true }, AbortSignal.timeout(2000))
  }
  await connect()
  const openPilot = async (recoveryOnly = false) => {
    const handle = await SharingPilot.open({ directory: join(root, 'pilot'), comfyOrigin, timeoutMs: 500,
      maximumResultBytes: 67108864, recoveryOnly, authorize: async action => owner && (action !== 'execute' || idle) })
    cleanup.push(() => handle.close()); return handle
  }
  let pilot = await openPilot()
  const session = async (): Promise<ResearchSession | null> => {
    if (!owner) return null
    const saved = channel.session()
    return { accountId: 21, deviceId: saved.deviceId, connectionEpoch: saved.connectionEpoch,
      post: async (path, body, signal) => {
        const reply = await saved.post(path, body as Readonly<Record<string, unknown>>, signal)
        if (!foreignLease || path !== 'research/channel' || !Array.isArray(reply.tasks)) return reply
        return { ...reply, tasks: reply.tasks.map((value: unknown) => { const task = parseTask(value)
          return { ...task, lease: { ...task.lease, accountId: 222222 } } }) }
      },
      upload: (tuple, sha256, bytes, signal) => saved.uploadResearch!(tuple, sha256, bytes, signal) }
  }
  const options: ResearchConsumerOptions = { directory: join(root, 'consumer'), waitMs: 0, maximumRecords: 32, session,
    pilot: async (_lease, action) => owner && (action === 'recover' || idle) ? pilot : null,
    admission: async (_lease, operation) => operation(), occupancyChanged: () => {} }
  let consumer = await ResearchConsumer.open(options); cleanup.push(() => consumer.close())
  const dispatch = async (): Promise<ResearchTask> => {
    const reply = await rpc('researchDispatch', { schema: 'qianshou.research-media-lease.v1', requestId: randomUUID(),
      taskId: randomUUID(), attemptId: randomUUID(), accountId: 21, deviceId: channel.status().deviceId,
      connectionEpoch: channel.status().connectionEpoch, leaseEpoch: 1, leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
      mode: 'image', adapter: 'comfyui', modelId: 'qwen-image-2.1-int8-convrot', workflowId, input: { prompt: 'CPU solid image' } }) as { task: unknown }
    return parseTask(reply.task)
  }
  const status = async (lease: ResearchLease): Promise<ResearchTask> => {
    const reply = await rpc('researchTask', { taskId: lease.taskId, attemptId: lease.attemptId }) as { task: unknown }
    return parseTask(reply.task)
  }
  const complete = (lease: ResearchLease, backend: string = externalId): void => {
    history[backend] = { [backend]: { status: { completed: true, status_str: 'success' }, outputs: {
      '8': { images: [{ filename: 'qianshou_pilot_' + lease.attemptId + '_00001_.png', subfolder: '', type: 'output' }] } } } }
  }
  return { root, consumer: () => consumer, pilot: () => pilot, posts, calls, output, externalId, dispatch, status, complete, rpc,
    async coordinate() {
      await consumer.close(); await pilot.close()
      const control = { ownerId: () => owner ? '21' : '22', prepare: async () => channel.status().deviceId!,
        connect: async () => {}, disconnect: async () => channel.close(), session: () => channel.session(), status: () => channel.status(),
        connectOwned: async () => ({ current: () => channel.status(), disconnect: async () => { await channel.close(); return true } }) }
      coordinator = new SharingCoordinator({ directory: join(root, 'sharing'), gatewayOrigin: origin,
        metadataPublicKey: '', metadataKeyId: '', guangzhouPublicKey: '', guangzhouKeyId: '', uploadPublicKey: '', uploadKeyId: '',
        authorizationPublicKey: '', authorizationKeyId: '', orderPublicKey: '', orderKeyId: '', downloadOrigins: [],
        owner: async () => owner ? '21' : '22', token: async () => 'owner-access-token-fixture', workerId: () => null, coreOrigin: () => null,
        occupancyChanged: () => {}, admission: async operation => operation(), legacyBusy: () => false, channel: () => control,
        executionState: async () => idle ? 'idle' : 'busy', localDiscovery: {
          comfyOrigin, imageOrigin: comfyOrigin, videoOrigin: '', timeoutMs: 1000 },
        pilot: { timeoutMs: 1000, maximumResultBytes: 67108864 }, research: {
          waitMs: 0, maximumRecords: 32, executionIntervalMs: 1000 } })
      cleanup.push(() => coordinator!.close())
      const initial = await coordinator.snapshot()
      await coordinator.command('image', 'enable', randomUUID(), initial.scopeId!, {
        version: 'qianshou.media-sharing-consent.v1', connection: true, execution: 'idle_only' })
      coordinator.start()
      await vi.waitFor(async () => {
        await coordinator!.refreshConnection()
        expect((await coordinator!.snapshot()).modes[0]?.api?.probeStatus).toBe('passed')
        const rows = await rpc('researchDirectory') as { nodes: { execution?: { idle: boolean; resourceAllowed: boolean } }[] }
        expect(rows.nodes[0]?.execution).toMatchObject({ idle: true, resourceAllowed: true })
      }, { timeout: 10000 })
      return coordinator
    },
    async restart() { await consumer.close(); await pilot.close(); await channel.close(); await connect()
      pilot = await openPilot(true); consumer = await ResearchConsumer.open(options) },
    async cycle() { await consumer.tick(AbortSignal.timeout(3000)) },
    set idle(value: boolean) { idle = value }, set owner(value: boolean) { owner = value },
    set foreignLease(value: boolean) { foreignLease = value },
    set dropPost(value: boolean) { droppedPost = value }, set holdPost(value: Promise<unknown> | undefined) { postHold = value } }
}

it('persists the actual backend ID, cold-recovers the old epoch with GET only and uploads one independently checked PNG', async () => {
  const f = await fixture(); const { lease } = await f.dispatch(); await Promise.all([f.cycle(), f.cycle()])
  expect(f.posts).toHaveLength(1)
  expect(Object.values(f.posts[0]!.prompt).some(node => node.inputs.steps === 8)).toBe(true)
  expect((await f.status(lease)).backendJobId).toBe(f.externalId); expect(f.consumer().busy()).toBe(true)
  const start = f.calls.length; await f.restart(); f.complete(lease); await f.cycle()
  expect(f.calls.slice(start).every(path => path.startsWith('GET '))).toBe(true)
  expect(f.posts).toHaveLength(1); expect(f.consumer().busy()).toBe(false)
  const accepted = await f.status(lease); expect(accepted.stage).toBe('completed')
  expect(accepted.artifact?.sha256).toBe(createHash('sha256').update(f.output).digest('hex'))
  expect(accepted.artifact?.size_bytes).toBe(f.output.length)
})

it('never repeats an outcome-unknown GPU POST and recovers only the original UUID', async () => {
  const f = await fixture(); f.dropPost = true; const { lease } = await f.dispatch(); await f.cycle(); await f.cycle()
  expect(f.posts).toHaveLength(1); expect((await f.status(lease)).stage).toBe('outcome_unknown')
  expect(f.consumer().busy()).toBe(true); await f.restart(); f.complete(lease, lease.attemptId); await f.cycle()
  expect(f.posts).toHaveLength(1); expect((await f.status(lease)).stage).toBe('completed')
})

it('does not submit after a lost claim ACK or obtain a new permission from duplicate reconciliation', async () => {
  const f = await fixture(); const { lease } = await f.dispatch(); await f.rpc('dropClaim'); await f.cycle(); await f.cycle(); await f.restart(); await f.cycle()
  expect(f.posts).toHaveLength(0); expect((await f.status(lease)).submission).toBe('claimed')
  expect((await f.rpc('paths') as string[]).filter(path => path.endsWith('/research/claim'))).toHaveLength(1)
})

it('reconciles a lost upload ACK with original status and never uploads or generates again', async () => {
  const f = await fixture(); const { lease } = await f.dispatch(); await f.cycle(); f.complete(lease)
  await f.rpc('dropUpload'); await f.cycle(); await f.cycle()
  expect(f.posts).toHaveLength(1); expect((await f.status(lease)).stage).toBe('completed')
  expect(f.consumer().busy()).toBe(false)
  expect((await f.rpc('paths') as string[]).filter(path => path.endsWith('/research/results/upload'))).toHaveLength(1)
})

it('requires current idle permission before claiming and keeps a queued lease outside GPU occupancy', async () => {
  const f = await fixture(); f.idle = false; await f.dispatch(); await f.cycle()
  expect(f.posts).toHaveLength(0); expect(f.consumer().busy()).toBe(false)
  expect((await f.rpc('paths') as string[]).filter(path => path.endsWith('/research/claim'))).toHaveLength(0)
  f.owner = false; await f.cycle(); expect(f.posts).toHaveLength(0)
})

it('rejects a different account lease before persisting it, claiming it or submitting to the local API', async () => {
  const f = await fixture(); await f.dispatch(); f.foreignLease = true
  await expect(f.cycle()).rejects.toMatchObject({ code: 'RESEARCH_SCOPE_CHANGED' })
  expect(f.posts).toHaveLength(0); expect(f.consumer().busy()).toBe(false)
  expect((await f.rpc('paths') as string[]).filter(path => path.endsWith('/research/claim'))).toHaveLength(0)
})

it('retains an accepted backend ID privately when the owner changes during the sole POST, without sending a new-owner event', async () => {
  const f = await fixture(); const { lease } = await f.dispatch()
  const hold = Promise.withResolvers<undefined>(); f.holdPost = hold.promise
  const work = f.cycle(); await vi.waitFor(() => { expect(f.posts).toHaveLength(1) })
  f.owner = false; hold.resolve(undefined); await work
  expect((await f.rpc('paths') as string[]).filter(path => path.endsWith('/research/events'))).toHaveLength(0)
  expect(f.consumer().busy()).toBe(true)
  f.owner = true; await f.restart(); f.complete(lease); await f.cycle()
  expect((await f.status(lease)).backendJobId).toBe(f.externalId); expect(f.posts).toHaveLength(1)
})

it('keeps status responsive and blocks updates until original paused delivery completes', { timeout: 30000 }, async () => {
  const f = await fixture(); const coordinator = await f.coordinate()
  const hold = Promise.withResolvers<undefined>(); f.holdPost = hold.promise
  const { lease } = await f.dispatch()
  await vi.waitFor(() => { expect(f.posts).toHaveLength(1) }, { timeout: 10000 })
  const snapshot = await Promise.race([coordinator.snapshot(), new Promise<never>((_resolve, reject) => {
    setTimeout(() => { reject(new Error('status blocked by GPU POST')) }, 1000)
  })])
  expect(snapshot.authenticated).toBe(true); expect(await coordinator.updateState()).toBe('busy')
  coordinator.setUpdateLocked(true); hold.resolve(undefined)
  await vi.waitFor(async () => { expect((await f.status(lease)).backendJobId).toBe(f.externalId) })
  await coordinator.command('image', 'pause', randomUUID(), snapshot.scopeId!)
  f.complete(lease)
  await vi.waitFor(async () => { expect((await f.status(lease)).stage).toBe('completed') }, { timeout: 10000 })
  expect(f.posts).toHaveLength(1); expect(await coordinator.updateState()).toBe('idle')
  expect(coordinator.executor.capabilities).toEqual([])
})
