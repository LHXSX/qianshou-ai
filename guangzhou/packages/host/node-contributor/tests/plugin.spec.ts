/**
 * Real-Loader coverage for the resident contributor plugin entry.
 *
 * The audit that motivated this entry found `ResidentNodeRuntime` had no
 * non-test construction point and `node-contributor` had no importer at all.
 * These cases mount the row through the vendored Loader and observe the facts an
 * operator reads: the runtime exists, it is idle until driven, one tick advances
 * it, and the status names the transport and every deployment seam that is still
 * absent. Nothing here claims a task was accepted — the bound transport is the
 * in-memory conformance double.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import {
  apply,
  Config,
  NODE_CONTRIBUTOR_SERVICE,
  resolvePolicy,
  type NodeContributorService,
} from '../src/index.ts'

/** One registered exact Fetch route captured from the stubbed carrier. */
interface RegisteredRoute { path: string; methods: readonly string[]; fetch: ConnectionFetchRoute['fetch'] }

const roots: string[] = []
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function connectionStub(routes: RegisteredRoute[]): Plugin.Object {
  return {
    name: 'connection-stub',
    apply(ctx) {
      ctx.provide('connection', {
        fetch: {
          register: (route: ConnectionFetchRoute) => {
            routes.push({ path: route.path, methods: route.methods, fetch: route.fetch })
            return async () => { routes.length = 0 }
          },
        },
      })
    },
  }
}

/** Mount the row through the real Loader, passing the row's own config through. */
async function mountContributor(routes: RegisteredRoute[], config: Config = {}): Promise<Context> {
  const root = await scratch('qianshou-contributor-plugin-')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: connection-stub',
    "  name: 'connection-stub'",
    '- id: qianshou-node-contributor',
    "  name: '@deepseek-ai/dsh-host-node-contributor'",
    '  config:',
    `    storePath: '${join(root, 'node-tasks.json')}'`,
    `    workspaceRoot: '${join(root, 'attempts')}'`,
    ...(config.autoStart === true ? ['    autoStart: true'] : []),
    ...(config.mode === undefined ? [] : [`    mode: '${config.mode}'`]),
    '',
  ].join('\n'))
  const modules = new Map<string, unknown>([
    ['connection-stub', connectionStub(routes)],
    ['@deepseek-ai/dsh-host-node-contributor', { name: 'qianshou-node-contributor', inject: ['connection'], apply, Config }],
  ])
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  return context
}

describe('node-contributor Cordis entry', () => {
  it('constructs the resident loop in the host and reports it idle', { timeout: 60_000 }, async () => {
    const ctx = await mountContributor([])
    const unloaded = [...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)
    expect(unloaded.map(entry => entry.options.name)).toEqual([])

    const service = ctx.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService | undefined
    expect(service, 'the row must provide nodeContributor').toBeDefined()
    const status = service?.status()
    expect(status).toMatchObject({
      source: 'node-contributor',
      constructed: true,
      mode: 'OFF',
      driver: 'idle',
      transport: 'memory',
    })
    // A constructed loop that was never driven: the projection must not imply progress.
    expect(status?.resident?.state).toBe('IDLE')
    expect(status?.resident?.runs).toBe(0)
    expect(status?.resident?.lastOutcome).toBeNull()
    // The transport bound today opens no socket, so the gaps must say so.
    expect(status?.productionGaps).toContain('transport')
    expect(status?.productionGaps).toContain('dispatchVerifier')
    expect(status?.productionGaps).not.toContain('workspaceRoot')
  })

  it('drives exactly one tick and records the outcome, not a task acceptance', { timeout: 60_000 }, async () => {
    const ctx = await mountContributor([])
    const service = ctx.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService
    const after = await service.tick()
    expect(after.driver).toBe('running')
    expect(after.resident?.state).toBe('RUNNING')
    expect(after.resident?.runs).toBe(1)
    expect(after.resident?.lastOutcome).toMatchObject({ sentHeartbeat: true, runningTasks: 0, outcomes: [] })
    // The runtime is the real resident loop: stopping it drains to a terminal
    // state rather than leaving a half-open session behind.
    const stopped = await service.stop('case teardown')
    expect(stopped.driver).toBe('idle')
    expect(stopped.resident?.state).toBe('STOPPED')
  })

  it('serves the read-only status route and never drives the loop from it', { timeout: 60_000 }, async () => {
    const routes: RegisteredRoute[] = []
    const ctx = await mountContributor(routes)
    expect(routes.map(route => route.path)).toEqual(['/api/qianshou/node/status'])
    expect(routes[0]?.methods).toEqual(['GET'])
    const response = await routes[0]?.fetch(new Request('http://127.0.0.1/api/qianshou/node/status'))
    expect(response?.status).toBe(200)
    expect(await response?.json()).toMatchObject({ source: 'node-contributor', constructed: true, transport: 'memory' })
    const service = ctx.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService
    expect(service.status().resident?.runs).toBe(0)
  })

  it('starts the loop only when the row explicitly asks for it', { timeout: 60_000 }, async () => {
    const ctx = await mountContributor([], { autoStart: true })
    // `ctx.effect` runs asynchronously with the fiber; the loop's state settles
    // after the start promise resolves, so poll the projection it writes.
    const service = ctx.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService
    // `autoStart` runs on the fiber's activation, so the driver flag settles
    // asynchronously; poll the projection instead of racing the start.
    await expect.poll(() => service.status().driver, { timeout: 5_000 }).toBe('running')
    expect(service.status().resident?.state).toBe('RUNNING')
  })

  it('defaults policy to OFF, forces allowWhileUserActive off, and rejects an impossible policy', () => {
    const defaults = Config({}) as Config
    expect(defaults).toMatchObject({ mode: 'OFF', autoStart: false, maxConcurrency: 1 })
    expect(resolvePolicy({ mode: 'OFF', allowWhileUserActive: true }).allowWhileUserActive).toBe(false)
    expect(resolvePolicy({ mode: 'BACKGROUND_ONLY', allowWhileUserActive: true }).allowWhileUserActive).toBe(true)
    // Out-of-range limits cross the schema boundary, never a silent clamp.
    expect(() => Config({ maxConcurrency: 0 })).toThrow()
    expect(() => Config({ maxTemperatureC: 0 })).toThrow()
    expect(() => resolvePolicy({ maxConcurrency: 999 })).toThrow()
  })
})
