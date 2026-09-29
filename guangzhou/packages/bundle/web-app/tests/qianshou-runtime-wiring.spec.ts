/**
 * Startup-level wiring coverage for the two P0 rows this bundle registers:
 * `qianshou-plugin-lifecycle` and `qianshou-node-contributor`.
 *
 * The audit that motivated these rows found that both packages existed with
 * passing tests and no runtime assembly: `plugin-lifecycle`'s Cordis Loader
 * adapter was only ever constructed against a test double, and the resident loop
 * had no non-test construction point at all. Unit tests cannot catch a missing
 * patch row, so this file drives the two facts that can:
 *
 * 1. the rows survive the REAL composition (base bundle + this bundle's patch,
 *    through the include's own patch algorithm) and name packages that declare a
 *    bundle entry — delete a row and the composition assertion fails;
 * 2. the mounted plugins really work under the vendored Cordis Loader: each one
 *    provides its service, the resident loop is constructed, it ticks, and the
 *    read-only status projections report the honest boundaries (`transport:
 *    memory`, non-empty `productionGaps`).
 *
 * Nothing here opens a socket or reaches a model.
 */
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'

/** Row id → package name this bundle must register, exactly as the patch file spells them. */
const QIANSHOU_ROWS = new Map([
  ['qianshou-plugin-lifecycle', '@deepseek-ai/dsh-host-plugin-lifecycle'],
  ['qianshou-node-contributor', '@deepseek-ai/dsh-host-node-contributor'],
])

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const BASE = 'dsh-base'
const WEB_APP = 'dsh-web-app'
const LIFECYCLE_PACKAGE = '@deepseek-ai/dsh-host-plugin-lifecycle'
const CONTRIBUTOR_PACKAGE = '@deepseek-ai/dsh-host-node-contributor'
/** Row id and package name of the model-routing admin console (settings section). */
const ROUTING_CONSOLE_ROW = 'ui-settings-routing'
const ROUTING_CONSOLE_PACKAGE = '@deepseek-ai/dsh-client-ui-settings-routing'

/** Absolute path of one bundle's patch file, resolved from its package directory. */
function patchFile(bundleDir: string): string {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/bundle', bundleDir, 'package.json'), 'utf8')) as {
    dsh?: { bundle?: { patch?: string } }
  }
  const patch = manifest.dsh?.bundle?.patch
  if (patch === undefined) throw new Error(`bundle ${bundleDir} declares no dsh.bundle.patch`)
  return resolve(REPO_ROOT, 'packages/bundle', bundleDir, patch)
}

/** The composed row list the shipped web profile mounts: base layer, then this bundle's layer. */
function composedWebProfileRows(): EntryOptions[] {
  const base = loadOverlayPatches(BASE, patchFile('base'))
  const webApp = loadOverlayPatches(WEB_APP, patchFile('web-app'))
  return composeEntries([base, webApp])
}

/**
 * Source module a package's bundle entry maps to, the way the repo's own resolver
 * maps a built `lib/` entry back to the file under test. This keeps the mount
 * specifier equal to the package name real boot uses while executing against the
 * working tree rather than a stale build.
 */
async function sourceModuleOf(packageName: string): Promise<unknown> {
  const packageDir = join(REPO_ROOT, 'packages/host', packageName.replace('@deepseek-ai/dsh-host-', ''))
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
    exports?: Record<string, { default?: string }>
  }
  const entry = manifest.exports?.['.']?.default
  if (entry === undefined || !entry.startsWith('./lib/')) {
    throw new Error(`${packageName} declares no ./lib root entry`)
  }
  const sourcePath = join(packageDir, entry.replace(/^\.\/lib\//, 'src/').replace(/\.js$/, '.ts'))
  return await import(/* @vite-ignore */ pathToFileURL(sourcePath).href)
}

/** One registered exact Fetch route captured from the stubbed Connection carrier. */
interface RegisteredRoute { path: string; methods: readonly string[]; fetch: ConnectionFetchRoute['fetch'] }

/**
 * Minimal authenticated carrier for the two rows under test.
 *
 * The real `connection` service is mounted by a sibling row that needs a bound
 * webserver; a profile-boot test only has to prove the rows register onto the
 * carrier they inject, so this records registrations and nothing else.
 */
function connectionStub(routes: RegisteredRoute[]): Plugin.Object {
  return {
    name: 'connection-stub',
    apply(ctx) {
      ctx.provide('connection', {
        fetch: {
          register: (route: ConnectionFetchRoute) => {
            routes.push({ path: route.path, methods: route.methods, fetch: route.fetch })
            return async () => { routes.splice(routes.indexOf(routes.at(-1) as RegisteredRoute), 1) }
          },
        },
      })
    },
  }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  root = undefined
})

/**
 * Mount the two rows through the real Loader over a two-row `cordis.yml`.
 * @param routes - Receives every exact Fetch route the mounted rows register.
 * @returns The settled root context.
 */
async function mountQianshouRows(routes: RegisteredRoute[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-qianshou-wiring-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: connection-stub',
    '  name: \'connection-stub\'',
    '- id: qianshou-plugin-lifecycle',
    `  name: '${LIFECYCLE_PACKAGE}'`,
    '- id: qianshou-node-contributor',
    `  name: '${CONTRIBUTOR_PACKAGE}'`,
    '',
  ].join('\n'))
  const modules = new Map<string, unknown>([
    ['connection-stub', connectionStub(routes)],
    [LIFECYCLE_PACKAGE, await sourceModuleOf(LIFECYCLE_PACKAGE)],
    [CONTRIBUTOR_PACKAGE, await sourceModuleOf(CONTRIBUTOR_PACKAGE)],
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

describe('qianshou runtime wiring', () => {
  it('keeps both rows enabled in the composed web-profile tree and naming real bundle packages', () => {
    const rows = composedWebProfileRows()
    const byId = new Map(rows.filter(row => row.id !== undefined).map(row => [row.id as string, row]))
    // The composed list must actually be the web profile's tree, not an empty
    // parse: the base layer alone contributes far more than these two rows.
    expect(rows.length).toBeGreaterThan(100)
    for (const [id, packageName] of QIANSHOU_ROWS) {
      const row = byId.get(id)
      expect(row, `web-app cordis.patch.yml must register ${id}`).toBeDefined()
      expect(row?.name, `${id} must name ${packageName}`).toBe(packageName)
      expect(row?.disabled, `${id} must not be disabled in the shipped profile`).not.toBe(true)
      // A row that names a package nothing imports boots to a failed entry; the
      // bundle's own manifest is what makes the name resolvable at runtime.
      const bundleManifest = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/bundle/web-app/package.json'), 'utf8')) as {
        dependencies?: Record<string, string>
      }
      expect(bundleManifest.dependencies?.[packageName], `${packageName} must be a dsh-web-app dependency`).toBeDefined()
    }
  })

  it('mounts both plugins under the real Loader and exposes their status services', { timeout: 60_000 }, async () => {
    const routes: RegisteredRoute[] = []
    const ctx = await mountQianshouRows(routes)

    // Every enabled entry reached an active fiber: no row silently failed to load.
    const unloaded = [...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)
    expect(unloaded.map(entry => entry.options.name)).toEqual([])

    const lifecycle = ctx.get('pluginLifecycle') as {
      status(): { source: string; root: string; registryKind: string }
    } | undefined
    expect(lifecycle, 'qianshou-plugin-lifecycle must provide pluginLifecycle').toBeDefined()
    const lifecycleStatus = lifecycle?.status()
    expect(lifecycleStatus?.source).toBe('plugin-lifecycle')
    expect(lifecycleStatus?.registryKind).toBe('cordis-loader')
    expect(lifecycleStatus?.root).toContain('qianshou')
    // The Loader registration seam is a real service too — this is the object
    // that turns a verified generation directory into a Loader entry.
    expect(ctx.get('pluginLifecycleRegistry')).toBeDefined()

    const contributor = ctx.get('nodeContributor') as {
      status(): {
        constructed: boolean
        mode: string
        driver: string
        transport: string
        productionGaps: readonly string[]
        resident: { runs: number; state: string; lastOutcome: unknown } | null
      }
      tick(): Promise<unknown>
    } | undefined
    expect(contributor, 'qianshou-node-contributor must provide nodeContributor').toBeDefined()
    const before = contributor?.status()
    // Constructed, never running unasked, and honest about the transport.
    expect(before?.constructed, 'the resident runtime must be constructed in the host').toBe(true)
    expect(before?.driver).toBe('idle')
    expect(before?.transport).toBe('memory')
    expect(before?.resident?.state).toBe('IDLE')
    expect(before?.resident?.runs).toBe(0)
    expect(before?.resident?.lastOutcome).toBeNull()
    expect(before?.productionGaps).toContain('transport')
    expect(before?.productionGaps).toContain('workspaceRoot')

    // Drive exactly one tick: the loop must be constructible AND drivable.
    await contributor?.tick()
    const after = contributor?.status()
    expect(after?.resident?.runs).toBe(1)
    expect(after?.resident?.state).toBe('RUNNING')
    expect(after?.resident?.lastOutcome).toMatchObject({ sentHeartbeat: true, runningTasks: 0 })
  })

  it('ships compute-core with the Shanghai control-plane origin', () => {
    const row = composedWebProfileRows().find(entry => entry.id === 'qianshou-compute-core')
    expect(row, 'web-app cordis.patch.yml must register qianshou-compute-core').toBeDefined()
    expect(row?.name).toBe('@deepseek-ai/dsh-compute-core')
    expect(row?.disabled).not.toBe(true)
    expect(row?.config).toMatchObject({ baseUrl: 'https://qianshousuanli.com' })
    const bundleManifest = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/bundle/web-app/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(bundleManifest.dependencies?.['@deepseek-ai/dsh-compute-core']).toBeDefined()
  })

  it('keeps the routing-console row enabled and naming a package that ships a web client face', () => {
    const row = composedWebProfileRows().find(entry => entry.id === ROUTING_CONSOLE_ROW)
    expect(row, 'web-app cordis.patch.yml must register the routing console').toBeDefined()
    expect(row?.name).toBe(ROUTING_CONSOLE_PACKAGE)
    expect(row?.disabled).not.toBe(true)
    // A row may name anything; the client module scan only mounts a package that
    // declares a web client face. Pin the manifest the row depends on.
    const manifest = JSON.parse(readFileSync(
      join(REPO_ROOT, 'packages/client/ui-settings-routing/package.json'), 'utf8',
    )) as { dsh?: { client?: { platform?: string; inject?: string[] } }; exports?: Record<string, unknown> }
    expect(manifest.dsh?.client?.platform).toBe('web')
    expect(manifest.dsh?.client?.inject).toContain('@deepseek-ai/dsh-client-ui-settings')
    expect(manifest.exports?.['./client']).toBeDefined()
  })

  it('serves both read-only status routes over the injected carrier', { timeout: 60_000 }, async () => {
    const routes: RegisteredRoute[] = []
    const ctx = await mountQianshouRows(routes)
    const byPath = new Map(routes.map(route => [route.path, route]))
    expect([...byPath.keys()].sort()).toEqual([
      '/api/qianshou/node/status',
      '/api/qianshou/plugins/status',
    ])
    for (const route of byPath.values()) expect(route.methods).toEqual(['GET'])

    const plugins = await byPath.get('/api/qianshou/plugins/status')?.fetch(new Request('http://127.0.0.1/api/qianshou/plugins/status'))
    expect(plugins?.status).toBe(200)
    expect(await plugins?.json()).toMatchObject({ source: 'plugin-lifecycle', registryKind: 'cordis-loader' })

    const node = await byPath.get('/api/qianshou/node/status')?.fetch(new Request('http://127.0.0.1/api/qianshou/node/status'))
    expect(node?.status).toBe(200)
    const nodeBody = await node?.json() as { constructed: boolean; transport: string; resident: { state: string } }
    expect(nodeBody.constructed).toBe(true)
    expect(nodeBody.transport).toBe('memory')
    expect(nodeBody.resident.state).toBe('IDLE')
    // The status route is a projection, never a driver.
    const contributor = ctx.get('nodeContributor') as { status(): { resident: { runs: number } } }
    expect(contributor.status().resident.runs).toBe(0)
  })
})
