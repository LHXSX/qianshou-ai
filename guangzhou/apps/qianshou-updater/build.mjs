/** Bundle the shared updater without shipping workspace paths, development dependencies or signing credentials. */
import { createHash } from 'node:crypto'
import { builtinModules, createRequire } from 'node:module'
import { copyFile, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RELEASE_PUBLIC_KEY_SPKI_SHA256, TRUST_KEY_FILE, loadInstalledReleasePublicKey } from './trust-key.mjs'

const source = dirname(fileURLToPath(import.meta.url))
const repo = resolve(source, '../..')
const webRequire = createRequire(join(repo, 'apps/web/package.json'))
const buildRequire = createRequire(webRequire.resolve('vite'))
const desktopRequire = createRequire(join(repo, 'apps/desktop/package.json'))
const assets = ['public-key.pem', 'window.html', 'style.css', 'renderer.js', 'preload.cjs']
const builtins = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)])

/** The destination must be a fresh, caller-owned release directory. */
export async function buildUpdater(destination, { trustKey = loadInstalledReleasePublicKey } = {}) {
  // Trust gate first, before anything is written: a build without the pinned verification key
  // would produce an updater that can never verify an update (D-01 in the 2026-09-16 review).
  trustKey()
  const output = resolve(destination)
  if (output === source || output.startsWith(`${source}/`) && !output.startsWith(`${source}/dist/`)) throw new Error('Updater output must not replace source')
  await mkdir(output, { recursive: false })
  const { build } = buildRequire('esbuild')
  const dependencies = new Map()
  const yauzl = desktopRequire.resolve('yauzl')
  if (desktopRequire('yauzl/package.json').version !== '3.4.0') throw new Error('Updater requires the locked yauzl 3.4.0 stream implementation')
  // Use the maintained raw entry so bundled dependencies remain visible to the license inventory.
  const alias = { yauzl, tar: desktopRequire.resolve('tar/raw') }
  for (const name of ['entry', 'runner']) {
    const result = await build({ absWorkingDir: repo, entryPoints: [join(source, `${name}.mjs`)], outfile: join(output, `${name}.mjs`),
      bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['electron', 'original-fs'], alias,
      sourcemap: false, minify: true, metafile: true, legalComments: 'inline', logLevel: 'silent',
      banner: { js: "import { createRequire as updaterCreateRequire } from 'node:module'; const require = updaterCreateRequire(import.meta.url);" },
    })
    for (const generated of Object.values(result.metafile.outputs)) for (const imported of generated.imports) {
      if (imported.external && !builtins.has(imported.path) && imported.path !== 'original-fs' && !(name === 'entry' && imported.path === 'electron')) throw new Error('Updater bundle has an unresolved dependency')
    }
    for (const input of Object.keys(result.metafile.inputs)) {
      let directory = dirname(await realpath(resolve(repo, input)))
      while (directory !== dirname(directory)) {
        try {
          const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
          if (metadata.name) {
            if (directory.includes('node_modules')) dependencies.set(metadata.name, { directory, metadata })
            break
          }
        } catch (error) { if (error.code !== 'ENOENT') throw error }
        directory = dirname(directory)
      }
    }
  }
  for (const name of assets) await copyFile(join(source, name), join(output, name))
  const notices = []
  for (const [name, { directory, metadata }] of [...dependencies].sort(([a], [b]) => a.localeCompare(b))) {
    let license
    for (const candidate of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE-MIT', 'LICENCE', 'license']) {
      try { license = await readFile(join(directory, candidate), 'utf8'); break }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    if (!license) throw new Error(`Bundled dependency is missing its license: ${name}`)
    notices.push(`${name} ${metadata.version}\n${license.trim()}\n`)
  }
  await writeFile(join(output, 'THIRD_PARTY_NOTICES.txt'), `${notices.join('\n')}\n`)
  const files = []
  for (const name of ['entry.mjs', 'runner.mjs', ...assets, 'THIRD_PARTY_NOTICES.txt']) {
    const file = join(output, name)
    files.push({ path: name, size: (await stat(file)).size, sha256: createHash('sha256').update(await readFile(file)).digest('hex') })
  }
  await writeFile(join(output, 'BUILD_MANIFEST.json'), `${JSON.stringify({ schemaVersion: 1, source: relative(repo, source), runtime: 'bundled-node22', external: ['electron', 'original-fs (Electron only)', 'node builtins'], trustKey: { file: TRUST_KEY_FILE, spkiSha256: RELEASE_PUBLIC_KEY_SPKI_SHA256 }, files }, null, 2)}\n`)
  return files
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) throw new Error('Usage: node apps/qianshou-updater/build.mjs [fresh-output-directory]')
  // `pnpm --filter qianshou-updater build` passes no directory: build inside a fresh directory
  // outside the repository, so repeated builds never leave build output in the working tree and
  // never collide. `buildUpdater` owns creating the destination, hence the parent/child pair.
  const destination = process.argv[2] ?? join(await mkdtemp(join(tmpdir(), 'qianshou-updater-build-')), 'updater')
  const files = await buildUpdater(destination)
  console.log(`Updater build output: ${resolve(destination)}`)
  console.log(JSON.stringify(files, null, 2))
}
