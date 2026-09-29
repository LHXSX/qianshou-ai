/**
 * Real-Loader coverage for the Cordis plugin entry.
 *
 * Before this entry existed, `CordisLoaderDeployment` was only ever constructed
 * against `class FakeLoader implements CordisLoaderLike` in `lifecycle.spec.ts`,
 * and `LocalPluginInstaller` had no registry that reached a real Loader. These
 * cases drive the vendored Loader instead: the plugin is mounted by name through
 * the include path a profile uses, the registration seam creates real Loader
 * entries, and the read-only status route answers over the injected carrier.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import {
  apply,
  Config,
  CordisPluginLoaderRegistry,
  PLUGIN_LIFECYCLE_SERVICE,
  type PluginLifecycleService,
} from '../src/index.ts'
import type { ComputeCapabilityPluginManifest } from '@deepseek-ai/dsh-compute-core/capability-manifest'
import { cleanupTempRoots, expectRejection, pluginFixture } from './market-fixture.ts'

/** One registered exact Fetch route captured from the stubbed carrier. */
interface RegisteredRoute { path: string; methods: readonly string[]; fetch: ConnectionFetchRoute['fetch'] }

const roots: string[] = []
let context: Context | undefined

/**
 * Whether a loader import may read a real file: only inside this suite's scratch
 * dirs. Both sides go through `realpathSync.native`, so a host whose temp root is
 * a symlink (macOS `/var` → `/private/var`) compares on the same canonical form
 * the registry produced.
 */
function insideScratch(specifier: string): boolean {
  if (!specifier.startsWith('file:')) return false
  const real = (path: string): string => {
    try { return realpathSync.native(path) } catch { return path }
  }
  const path = real(fileURLToPath(specifier))
  return roots.some(root => path.startsWith(real(root) + sep))
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  await cleanupTempRoots()
})

/** Create a temporary directory this suite removes after the case. */
async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

/** Carrier stub: records registrations so a case can invoke the route handler directly. */
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

/** Mount the plugin through the vendored Loader, exactly as a profile row does. */
async function mountLifecycle(routes: RegisteredRoute[]): Promise<Context> {
  const root = await scratch('qianshou-lifecycle-plugin-')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: connection-stub',
    "  name: 'connection-stub'",
    '- id: qianshou-plugin-lifecycle',
    "  name: '@deepseek-ai/dsh-host-plugin-lifecycle'",
    '',
  ].join('\n'))
  const modules = new Map<string, unknown>([
    ['connection-stub', connectionStub(routes)],
    ['@deepseek-ai/dsh-host-plugin-lifecycle', { name: 'qianshou-plugin-lifecycle', inject: ['loader', 'connection'], apply, Config }],
  ])
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (modules.has(specifier)) return modules.get(specifier)
      // A generation entry is registered as a file URL under a verified
      // directory; the Loader imports exactly that path from disk, the same way
      // a host does. An import outside this suite's scratch dirs is unexpected.
      if (insideScratch(specifier)) return await import(/* @vite-ignore */ specifier)
      throw new Error(`unexpected Loader import: ${specifier}`)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  return context
}

/**
 * A real validated manifest for the registration cases.
 *
 * It comes from the shared fixture, whose plan is produced by
 * `planCapabilityPluginInstall`, so the object crossing `register()` is the same
 * parsed shape the installer passes in production — not a hand-written literal
 * that could drift from `ComputeCapabilityPluginManifest`.
 */
async function manifestFixture(): Promise<ComputeCapabilityPluginManifest> {
  return (await pluginFixture()).plan.manifest
}

describe('plugin-lifecycle Cordis entry', () => {
  it('activates under the real Loader, provides its service and serves the status route', { timeout: 60_000 }, async () => {
    const routes: RegisteredRoute[] = []
    const ctx = await mountLifecycle(routes)

    const unloaded = [...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)
    expect(unloaded.map(entry => entry.options.name)).toEqual([])

    const service = ctx.get(PLUGIN_LIFECYCLE_SERVICE) as PluginLifecycleService | undefined
    expect(service).toBeDefined()
    const status = service?.status()
    expect(status).toMatchObject({ source: 'plugin-lifecycle', registryKind: 'cordis-loader' })
    // The default root lives under the Harness home, never beside the process cwd.
    expect(status?.root).toContain('qianshou')
    expect(ctx.get('pluginLifecycleRegistry')).toBeInstanceOf(CordisPluginLoaderRegistry)

    expect(routes.map(route => route.path)).toEqual(['/api/qianshou/plugins/status'])
    expect(routes[0]?.methods).toEqual(['GET'])
    const response = await routes[0]?.fetch(new Request('http://127.0.0.1/api/qianshou/plugins/status'))
    expect(response?.status).toBe(200)
    expect(await response?.json()).toMatchObject({ source: 'plugin-lifecycle', registryKind: 'cordis-loader' })
  })

  it('defaults every deployment value and rejects an impossible budget', () => {
    const defaults = Config({}) as Config
    expect(defaults).toMatchObject({ root: '', retainGenerations: 1, maxFileCount: 256 })
    expect(defaults.maxFileBytes).toBeLessThanOrEqual(defaults.maxPackageBytes as number)
    // The schema is the runtime boundary a profile row crosses: an out-of-range
    // budget must be rejected there, not at the first install.
    expect(() => Config({ maxPackageBytes: 0 })).toThrow()
    expect(() => Config({ maxFileCount: 0 })).toThrow()
  })

  it('registers a verified generation directory as a real Loader entry and withdraws it', { timeout: 60_000 }, async () => {
    const ctx = await mountLifecycle([])
    const registry = new CordisPluginLoaderRegistry(ctx.loader)
    const directory = await scratch('qianshou-generation-')
    await mkdir(join(directory, 'assets'), { recursive: true })
    // The generation payload is whatever the installer verified: here a real
    // Cordis function plugin, so the Loader's own import path is exercised.
    await writeFile(join(directory, 'image-local.js'), 'export const name = "image-local"\nexport function apply() {}\n')
    await writeFile(join(directory, 'assets', 'spec.json'), '{"kind":"spec"}')

    const identity = { pluginId: 'image.local', version: '1.0.0' }
    const specifier = await registry.register({ identity, directory, manifest: await manifestFixture(), entryId: 'image-local' })
    // A canonical file: URL is the one absolute form the loader may import; the
    // generation directory is immutable, so the URL cannot drift from the bytes
    // the installer hashed.
    expect(specifier).toBe(pathToFileURL(realpathSync.native(join(directory, 'image-local.js'))).href)
    expect([...ctx.loader.entries()].map(entry => entry.options.name)).toContain(specifier)

    await registry.unregister(identity)
    expect([...ctx.loader.entries()].map(entry => entry.options.name)).not.toContain(specifier)
  })

  it('refuses a generation whose declared entry file is absent or traversal-shaped', async () => {
    const ctx = await mountLifecycle([])
    const registry = new CordisPluginLoaderRegistry(ctx.loader)
    const directory = await scratch('qianshou-generation-')
    const identity = { pluginId: 'image.local', version: '1.0.0' }
    await expectRejection(
      registry.register({ identity, directory, manifest: await manifestFixture(), entryId: 'image-local' }),
      'PLUGIN_ENTRY_FILE_ABSENT',
    )
    // A traversal-shaped entry id never reaches the filesystem.
    await expectRejection(
      registry.register({ identity, directory, manifest: await manifestFixture(), entryId: '../escape' }),
      'PLUGIN_ENTRY_SPECIFIER_INVALID',
    )
    expect([...ctx.loader.entries()].map(entry => entry.options.name)).not.toContain('image-local')
  })

  it('registers an installed generation through the real Loader and reports the receipt', { timeout: 60_000 }, async () => {
    const ctx = await mountLifecycle([])
    const fixture = await pluginFixture({
      payload: [
        { path: 'image-local.js', bytes: Buffer.from('export const name = "image-local"\nexport function apply() {}\n') },
        { path: 'assets/spec.json', bytes: Buffer.from('{"kind":"spec"}') },
      ],
    })
    const { createPluginLifecycle, StaticPluginPackageSource } = await import('../src/index.ts')
    const root = await scratch('qianshou-installer-root-')
    const { service } = createPluginLifecycle({
      loader: ctx.loader,
      root,
      limits: { maxFileCount: 8, maxFileBytes: 4096, maxPackageBytes: 16_384 },
      retainGenerations: 1,
    })
    const { receipt, reused } = await service.install(fixture.plan, new StaticPluginPackageSource(fixture.payload))
    expect(reused).toBe(false)
    expect(receipt.registryKind).toBe('cordis-loader')
    // The registered specifier names the immutable generation directory, and the
    // Loader now holds one entry for it. The temp root may be a symlink, so the
    // expectation is built by canonicalizing the same path the registry resolved.
    expect(receipt.loaderSpecifier).toBe(pathToFileURL(
      realpathSync.native(join(root, 'generations', fixture.identityKey, fixture.generation, 'image-local.js')),
    ).href)
    expect([...ctx.loader.entries()].map(entry => entry.options.name)).toContain(receipt.loaderSpecifier)
    expect(await service.list()).toHaveLength(1)
    expect(service.status().installations).toBe(1)

    const result = await service.uninstall({ pluginId: 'image.local', version: '1.0.0' })
    expect(result).toMatchObject({ removed: true, revoked: true })
    expect(await service.list()).toHaveLength(0)
    expect(service.status().installations).toBe(0)
    expect([...ctx.loader.entries()].map(entry => entry.options.name)).not.toContain(receipt.loaderSpecifier)
  })
})

describe('shipped package manifest', () => {
  it('declares the Cordis loader entry the patch row mounts', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      exports?: Record<string, { default?: string }>
      peerDependencies?: Record<string, string>
    }
    expect(manifest.exports?.['.']?.default).toBe('./lib/index.js')
    expect(manifest.peerDependencies).toHaveProperty('@deepseek-ai/cordis')
  })
})
