/** Real Loader + owner routes + real metadata GETs; never a GPU request or live account. */
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { afterEach, expect, it, vi } from 'vitest'
import { apply, Config } from '../src/plugin.ts'
import type { SharingSnapshot } from '../src/sharing-types.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs() })

it.each([false, true])('automatically wraps through the real Loader; research=%s retains explicit consent and no GPU POST', { timeout: 60_000 }, async (research) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'qianshou-pilot-loader-')))
  cleanup.push(() => rm(root, { recursive: true, force: true })); vi.stubEnv('DSH_HOME', root)
  const child = spawn(process.execPath, ['--import', 'tsx/esm', fileURLToPath(new URL('./fixtures/research-node-gateway.mjs', import.meta.url))], {
    env: { PATH: process.env.PATH ?? '', MEDIA_NODE_TEST_ROOT: root }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  let sequence = 0
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const rpc = (method: string): Promise<unknown> => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); child.send({ id, method })
  })
  const gatewayOrigin = await new Promise<string>((resolve, reject) => {
    child.on('message', (message: unknown) => {
      const row = message as { ready?: boolean; origin?: string; id?: number; result?: unknown; error?: string }
      if (row.ready && row.origin) { resolve(row.origin); return }
      const reply = pending.get(row.id ?? -1); if (reply === undefined) return
      pending.delete(row.id!); if (row.error) reply.reject(new Error(row.error)); else reply.resolve(row.result)
    })
    child.once('exit', () => { reject(new Error('CPU gateway exited')) })
  })
  cleanup.push(async () => { await rpc('close'); if (child.exitCode === null) await once(child, 'exit') })
  const classes = JSON.parse(await readFile(new URL('./fixtures/comfy-pilot-metadata.json', import.meta.url), 'utf8')) as Record<string, unknown>
  const files: Record<string, string> = { diffusion_models: 'qwen_image_2.1_int8_convrot.safetensors',
    text_encoders: 'qwen3vl_8b_int8_convrot.safetensors', vae: 'qwen_image_2.1_vae_bf16.safetensors' }
  const calls: { method: string; path: string }[] = []
  let holdInventory = true; const releases: (() => void)[] = []
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://127.0.0.1'); calls.push({ method: request.method!, path: url.pathname })
    let value: unknown
    if (url.pathname === '/healthz') value = { status: 'ok', model: 'qwen-image-2.1-int8-convrot', comfy_reachable: true, busy: false }
    else if (url.pathname === '/system_stats') value = { devices: [{ name: 'CPU fixture', type: 'cpu', vram_total: 0, vram_free: 0 }] }
    else if (url.pathname === '/models') value = Object.keys(files)
    else if (url.pathname.startsWith('/models/')) value = [files[url.pathname.slice('/models/'.length)]]
    else if (url.pathname.startsWith('/object_info/')) { const name = url.pathname.slice('/object_info/'.length); value = { [name]: classes[name] } }
    else if (url.pathname === '/v1/nodes/probe') value = { schema: 'qianshou.media-gateway-probe.v1',
      service: 'qianshou-guangzhou-media', nonce: url.searchParams.get('nonce'), time: Math.floor(Date.now() / 1000) }
    else { response.writeHead(401).end(); return }
    const bytes = Buffer.from(JSON.stringify(value))
    const send = (): void => { response.writeHead(200, { 'content-type': 'application/json', 'content-length': bytes.length }).end(bytes) }
    if (holdInventory && url.pathname === '/models') releases.push(send)
    else send()
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => { resolve() })) })
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('fixture listener missing')
  const origin = 'http://127.0.0.1:' + String(address.port)
  const routes: ConnectionFetchRoute[] = []
  const stub: Plugin.Object = { name: 'pilot-owner-fixture', apply(ctx) {
    ctx.provide('connection', { fetch: { register: (route: ConnectionFetchRoute) => { routes.push(route); return async () => {} } } })
    ctx.provide('qianshouAccount', { state: async () => ({ phase: 'authenticated', account: { id: '21' } }) })
    ctx.provide('accountSession', { ensureAccessToken: async () => 'owner-access-token-fixture' })
    ctx.provide('profileContext', { dir: root })
  } }
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([{ name: 'pilot-owner-fixture' }, {
    name: '@deepseek-ai/dsh-host-node-contributor', config: { autoStart: false, mediaGatewayOrigin: gatewayOrigin,
      storePath: join(root, 'tasks.json'), workspaceRoot: join(root, 'attempts'),
      mediaLocalComfyOrigin: origin, mediaLocalImageOrigin: origin, mediaLocalVideoOrigin: '',
      ...(research ? { mediaResearchEnabled: true } : {}), mediaChannelWaitMs: 100, mediaRequestTimeoutMs: 2000,
      mediaPilotTimeoutMs: 1000, mediaPilotMaximumResultBytes: 67108864 } }]))
  const modules = new Map<string, unknown>([['pilot-owner-fixture', stub],
    ['@deepseek-ai/dsh-host-node-contributor', { name: 'qianshou-node-contributor', inject: ['connection'], apply, Config }]])
  const context = new Context(); cleanup.push(async () => { await context.fiber?.dispose() })
  context.baseUrl = pathToFileURL(root).href + '/'; await context.plugin(Loader); context.loader.builtins.include = Include
  context.loader.internal = { version: 'v2', async import(specifier: string) {
    if (!modules.has(specifier)) throw new Error('unexpected fixture import'); return modules.get(specifier)
  } } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } }); await context.loader.await()
  async function fetchRoute(action: string, body?: unknown): Promise<SharingSnapshot> {
    const route = routes.find(row => row.path === '/api/qianshou/node/sharing/' + action)
    if (route === undefined) throw new Error('sharing route missing')
    const response = await route.fetch(new Request(origin + route.path, body === undefined ? undefined : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))
    expect(response.status).toBe(200); return await response.json() as SharingSnapshot
  }
  const before = Date.now(); const first = await fetchRoute('status')
  expect(Date.now() - before).toBeLessThan(1500)
  expect(first.modes[0]?.local?.inventory).toBe('unknown')
  await vi.waitFor(() => { expect(releases.length).toBeGreaterThan(0) })
  holdInventory = false; for (const release of releases) release()
  await vi.waitFor(async () => {
    expect((await fetchRoute('status')).modes.find(mode => mode.mode === 'image')?.api?.adapter).toBe('qianshou_image')
  })
  const initial = await fetchRoute('status')
  expect(initial.authenticated).toBe(true)
  expect(initial.modes.find(mode => mode.mode === 'image')?.authorization?.connection).toBe('required')
  expect(initial.modes.find(mode => mode.mode === 'image')?.api?.adapter).toBe('qianshou_image')
  expect((await rpc('paths') as string[]).some(path => path.startsWith('/v1/nodes/research/'))).toBe(false)
  await fetchRoute('enable', { mode: 'image', requestId: randomUUID(), scopeId: initial.scopeId,
    consent: { version: 'qianshou.media-sharing-consent.v1', connection: true, execution: 'idle_only' } })
  await vi.waitFor(async () => {
    expect((await fetchRoute('status')).modes.find(mode => mode.mode === 'image')?.api?.adapter).toBe('comfyui')
  }, { timeout: 10000 })
  const current = await fetchRoute('status'), image = current.modes.find(mode => mode.mode === 'image')!
  expect(image.api?.adapter).toBe('comfyui'); expect(image.api?.status).toBe('ready')
  expect(image.api?.workflowName).toBe('Qwen Image 2.1 text-to-image')
  expect(image.authorization?.connection).toBe('granted'); expect(image.phase).not.toBe('sharing')
  expect(calls.some(call => call.path.startsWith('/object_info/'))).toBe(true)
  expect(calls.filter(call => call.path === '/prompt')).toEqual([])
  await vi.waitFor(async () => {
    const currentState = await fetchRoute('status')
    expect(currentState.connection).toMatchObject({ channel: 'connected', heartbeat: 'accepted' })
    expect(currentState.modes.find(mode => mode.mode === 'image')?.api).toMatchObject({
      status: 'ready', registration: 'registered', probeStatus: 'passed',
    })
  }, { timeout: 10000 })
  const connected = await fetchRoute('status')
  expect(connected.modes[0]).toMatchObject({ phase: 'connecting', reason: null })
  expect((await rpc('paths') as string[]).some(path => path.includes('install-manifest'))).toBe(false)
  if (research) await vi.waitFor(async () => {
    expect((await rpc('paths') as string[]).includes('/v1/nodes/research/channel')).toBe(true)
    expect((await rpc('paths') as string[]).includes('/v1/nodes/research/execution')).toBe(true)
  }, { timeout: 10000 })
  else expect((await rpc('paths') as string[]).some(path => path.startsWith('/v1/nodes/research/'))).toBe(false)
  const paused = await fetchRoute('pause', { mode: 'image', requestId: randomUUID(), scopeId: current.scopeId })
  expect(paused.modes.find(mode => mode.mode === 'image')?.phase).toBe('paused')
  expect((await fetch(origin + '/healthz')).status).toBe(200)
})
