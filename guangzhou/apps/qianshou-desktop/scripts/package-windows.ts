/** Assemble a Windows x64 preview from verified target runtimes, without installing into the source workspace. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { copyRuntimeTree, snapshotRuntimeClosure } from './runtime-closure.mjs'
import { brandWindowsExecutable, requireWindowsX64 } from './windows-binary.mjs'
import { finalizeWindowsArchive } from './finalize-windows.mjs'
import { desktopRuntimeFileExclusion } from '../../desktop/scripts/runtime-file-policy.ts'
import { desktopTargetBuildPaths } from '../../desktop/scripts/desktop-build-paths.mjs'
import { buildUpdater } from '../../qianshou-updater/build.mjs'
import { stageDesktopRelay } from './relay-resources.mjs'

const appRoot = resolve(import.meta.dirname, '..')
const repoRoot = resolve(appRoot, '../..')
const metadata = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'))
if (!/^\d+\.\d+\.\d+$/u.test(metadata.version) || metadata.channel !== 'preview') throw new Error('Invalid preview version')
const release = resolve(process.env.QIANSHOU_RELEASE_OUTPUT ?? join(appRoot, 'dist', `${metadata.version}-win32-x64`))
const webDist = process.env.QIANSHOU_WEB_DIST
const overridesPath = process.env.QIANSHOU_WINDOWS_NATIVE_OVERRIDES
if (!webDist || !existsSync(join(webDist, 'index.html')) || !existsSync(join(webDist, 'preview.html'))) throw new Error('A clean branded QIANSHOU_WEB_DIST is required')
if (!overridesPath) throw new Error('QIANSHOU_WINDOWS_NATIVE_OVERRIDES must name verified target package directories')
if (existsSync(release)) throw new Error('Release output already exists; refusing to replace a published artifact')
const disk = statfsSync(appRoot)
if (disk.bavail * disk.bsize < 6 * 1024 ** 3) throw new Error('Packaging needs 6 GiB free to retain a 4 GiB reserve')
const runtimePaths = desktopTargetBuildPaths('win-x64')
const runtime = runtimePaths.runtime
const versions = JSON.parse(readFileSync(join(runtime, 'versions.json'), 'utf8'))
const nodeBytes = readFileSync(join(runtime, 'node/node.exe'))
requireWindowsX64(nodeBytes, 'Node.exe')
const require = createRequire(join(repoRoot, 'apps/desktop/package.json'))
const extractZip = require('extract-zip') as (path: string, options: { dir: string }) => Promise<void>
const electronVersion = JSON.parse(readFileSync(require.resolve('electron/package.json'), 'utf8')).version
const electronArchiveName = `electron-v${electronVersion}-win32-x64.zip`
const electronCache = join(repoRoot, 'apps/qianshou-companion/dist/portable/runtime-cache')
const electronArchive = join(electronCache, electronArchiveName)
const expectedElectron = readFileSync(join(electronCache, 'SHASUMS256.txt'), 'utf8').split(/\r?\n/u).find(line => line.trim().endsWith(electronArchiveName))?.trim().split(/\s+/u)[0]
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const actualElectron = digest(readFileSync(electronArchive))
if (!expectedElectron || actualElectron !== expectedElectron) throw new Error('Official Electron archive checksum mismatch')
mkdirSync(release, { recursive: true })
const folderName = `qianshou-agent-${metadata.version}-win32-x64`
const output = join(release, folderName)
await extractZip(electronArchive, { dir: output })
rmSync(join(output, 'resources/default_app.asar'), { force: true })
const resources = join(output, 'resources')
const shell = join(resources, 'app')
mkdirSync(shell, { recursive: true })
for (const file of ['main.mjs', 'config.mjs', 'backend.mjs', 'native.mjs', 'security.mjs', 'preload.cjs', 'voice-config.mjs', 'update-integration.mjs']) copyRuntimeTree(join(appRoot, file), join(shell, file))
await buildUpdater(join(shell, 'updater'))
await stageDesktopRelay({ appRoot, destination: join(shell, 'relay'), platform: 'win32', arch: 'x64', cacheRoot: process.env.QIANSHOU_FRPC_CACHE ?? join(appRoot, 'dist/relay-cache') })
mkdirSync(join(shell, 'assets'))
copyRuntimeTree(join(appRoot, 'assets/icon.png'), join(shell, 'assets/icon.png'))
writeFileSync(join(shell, 'package.json'), `${JSON.stringify({ name: 'qianshou-agent', productName: '千手智能体', version: metadata.version, channel: 'preview', distribution: 'bundled', type: 'module', main: 'main.mjs' }, null, 2)}\n`)
for (const suffix of ['md', 'zh.md']) {
  const quick = readFileSync(join(appRoot, `QUICK_START.windows.${suffix}`), 'utf8').replaceAll('QUICK_START.windows', 'QUICK_START').replaceAll('README.windows', 'README')
  const voice = readFileSync(join(appRoot, `voice/README.windows.${suffix}`), 'utf8').replaceAll('QUICK_START.windows', 'QUICK_START').replaceAll('README.windows', 'README')
  for (const target of [output, shell]) {
    writeFileSync(join(target, `QUICK_START.${suffix}`), quick)
    mkdirSync(join(target, 'voice'), { recursive: true })
    writeFileSync(join(target, `voice/README.${suffix}`), voice)
  }
}
copyRuntimeTree(join(repoRoot, 'LICENSE'), join(resources, 'LICENSE-DeepSeek-MIT.txt'))
// pnpm's universal archive contains optional native packages for several platforms.
copyRuntimeTree(runtime, join(resources, 'runtime'), { target: { platform: 'win32', arch: 'x64' } })
const nodeArchive = join(runtimePaths.downloads, `node-v${versions.node}-win-x64.zip`)
execFileSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); open(sys.argv[3],"wb").write(z.read(sys.argv[2]))', nodeArchive, `node-v${versions.node}-win-x64/LICENSE`, join(resources, 'runtime/LICENSE-Node.txt')])
mkdirSync(join(resources, 'runtime/bin'), { recursive: true })
writeFileSync(join(resources, 'runtime/bin/pnpm.cmd'), '@echo off\r\n"%~dp0..\\node\\node.exe" "%~dp0..\\pnpm\\bin\\pnpm.mjs" %*\r\n')
const packages = snapshotRuntimeClosure({ entry: join(repoRoot, 'apps/cli'), destination: join(resources, 'dsh'), repoRoot, webDist,
  target: { platform: 'win32', arch: 'x64' }, layout: 'hoisted', dependencyOverrides: JSON.parse(readFileSync(overridesPath, 'utf8')),
  exclude: (path: string) => desktopRuntimeFileExclusion(path, { platform: 'win32', arch: 'x64' }) || (path.includes('/third_party/conpty/') && path.includes('/win10-arm64/')) })
console.log(`Runtime closure copied and resolved: ${packages.length} packages`)
writeFileSync(join(resources, 'RUNTIME_PACKAGES.json'), `${JSON.stringify(packages, null, 2)}\n`)
copyRuntimeTree(join(dirname(overridesPath), 'NATIVE_PROVENANCE.json'), join(resources, 'NATIVE_PROVENANCE.json'))
const executable = join(output, 'QianshouAgent.exe')
renameSync(join(output, 'electron.exe'), executable)
const branding = await brandWindowsExecutable(executable, join(appRoot, 'assets/icon.png'), join(output, 'qianshou.ico'), metadata.version)
const helper = 'resources/runtime/pnpm/dist/vendor/fastlist-0.3.0-x86.exe'
const allowedI386Executables = { [helper]: digest(readFileSync(join(runtime, 'pnpm/dist/vendor/fastlist-0.3.0-x86.exe'))) }
finalizeWindowsArchive({ output, release, metadata, versions, packages, electronVersion, actualElectron,
  electronArchiveName, branding, allowedI386Executables })
