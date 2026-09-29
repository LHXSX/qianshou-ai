/** Loopback-only registry that packages the repository's own inert test bundles with real pnpm. */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cp, mkdir, readFile, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))
const pnpm = fileURLToPath(new URL('../../../../apps/desktop/node_modules/pnpm/bin/pnpm.mjs', import.meta.url))

/** Starts a disposable registry containing only the checked-in fixture packages. */
export async function fixtureRegistry(work: string) {
  const artifacts = new Map<string, Buffer>()
  const packages = new Map<string, { latest: string; versions: Record<string, Record<string, unknown>> }>()
  for (const folder of ['text-tools-v1', 'text-tools-v2', 'not-bundle', 'activation-failure', 'mac-drawn-video-v1']) {
    const staging = join(work, folder)
    await cp(join(fixtures, folder), staging, { recursive: true })
    const output = join(staging, 'packed')
    await mkdir(output)
    await run(process.execPath, ['--expose-internals', pnpm, 'pack', '--pack-destination', output], {
      cwd: staging, timeout: 30_000, env: { ...process.env, npm_config_manage_package_manager_versions: 'false' },
    })
    const archive = (await readdir(output)).find(name => name.endsWith('.tgz'))
    if (archive === undefined) throw new Error('pnpm did not create a fixture tarball')
    const bytes = await readFile(join(output, archive))
    const manifest = JSON.parse(await readFile(join(staging, 'package.json'), 'utf8')) as Record<string, unknown> & { name: string; version: string }
    const tarPath = `/${manifest.name}/-/${archive}`
    artifacts.set(tarPath, bytes)
    let pack = packages.get(manifest.name)
    if (pack === undefined) { pack = { latest: manifest.version, versions: {} }; packages.set(manifest.name, pack) }
    pack.latest = manifest.version
    pack.versions[manifest.version] = { ...manifest, dist: { tarball: tarPath,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, shasum: createHash('sha1').update(bytes).digest('hex') } }
  }
  let origin = ''
  const requests: string[] = []
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    requests.push(path)
    const archive = artifacts.get(path)
    if (archive !== undefined) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': archive.byteLength })
      res.end(archive)
      return
    }
    const pack = packages.get(decodeURIComponent(path.slice(1)))
    if (pack === undefined) { res.writeHead(404); res.end('{"error":"unknown fixture"}'); return }
    const versions = Object.fromEntries(Object.entries(pack.versions).map(([version, metadata]) => {
      const dist = metadata.dist as { tarball: string; integrity: string; shasum: string }
      return [version, { ...metadata, dist: { ...dist, tarball: origin + dist.tarball } }]
    }))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ name: path.slice(1), 'dist-tags': { latest: pack.latest }, versions }))
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('registry did not bind a TCP port')
  origin = `http://127.0.0.1:${address.port}`
  return {
    origin, requests,
    packageManager: { command: process.execPath, args: ['--expose-internals', pnpm, `--config.registry=${origin}`, `--config.store-dir=${join(work, 'pnpm-store')}`],
      env: { npm_config_registry: origin, npm_config_store_dir: join(work, 'pnpm-store'),
        npm_config_manage_package_manager_versions: 'false', npm_config_update_notifier: 'false' } },
    setLatest(name: string, version: string) {
      const pack = packages.get(name)
      if (pack === undefined || pack.versions[version] === undefined) throw new Error('unknown fixture version')
      pack.latest = version
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() })
      server.closeAllConnections()
    }),
  }
}
