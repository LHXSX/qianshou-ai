/** Build a relocatable Qianshou preview without installing, launching or replacing the user's application. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, statfsSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { snapshotRuntimeClosure } from './runtime-closure.mjs'
import { desktopRuntimeFileExclusion } from '../../desktop/scripts/runtime-file-policy.ts'
import { desktopTargetBuildPaths } from '../../desktop/scripts/desktop-build-paths.mjs'
import { stageDesktopRelay } from './relay-resources.mjs'
import { buildUpdater } from '../../qianshou-updater/build.mjs'

const appRoot = resolve(import.meta.dirname, '..')
const repoRoot = resolve(appRoot, '../..')
const metadata = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'))
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This preview packager requires macOS arm64')
if (!/^\d+\.\d+\.\d+$/u.test(metadata.version) || metadata.channel !== 'preview') throw new Error('Invalid preview version')
const release = resolve(process.env.QIANSHOU_RELEASE_OUTPUT ?? join(appRoot, 'dist', metadata.version))
const webDist = process.env.QIANSHOU_WEB_DIST
if (!webDist || !existsSync(join(webDist, 'index.html')) || !existsSync(join(webDist, 'preview.html'))) throw new Error('QIANSHOU_WEB_DIST must name a complete clean branded web build')
if (existsSync(release)) throw new Error('Release output already exists; refusing to replace an artifact')
const disk = statfsSync(appRoot)
if (disk.bavail * disk.bsize < 6 * 1024 ** 3) throw new Error('Packaging needs 6 GiB free to retain a 4 GiB reserve')
const officialRuntime = desktopTargetBuildPaths('mac-arm64').runtime
if (!existsSync(join(officialRuntime, 'versions.json'))) throw new Error('Run apps/desktop/scripts/prepare-runtime.ts first')
const require = createRequire(join(repoRoot, 'apps/desktop/package.json'))
const electron = require('electron') as string
const electronApp = resolve(dirname(electron), '../..')
mkdirSync(release, { recursive: true })
const output = join(release, '千手智能体.app')
execFileSync('/usr/bin/ditto', [electronApp, output])
const resources = join(output, 'Contents/Resources')
const shell = join(resources, 'app')
mkdirSync(shell, { recursive: true })
for (const file of ['main.mjs', 'config.mjs', 'backend.mjs', 'native.mjs', 'security.mjs', 'preload.cjs', 'voice-config.mjs', 'update-integration.mjs']) cpSync(join(appRoot, file), join(shell, file))
await buildUpdater(join(shell, 'updater'))
await stageDesktopRelay({ appRoot, destination: join(shell, 'relay'), platform: 'darwin', arch: 'arm64', cacheRoot: process.env.QIANSHOU_FRPC_CACHE ?? join(appRoot, 'dist/relay-cache') })
writeFileSync(join(shell, 'package.json'), `${JSON.stringify({ name: 'qianshou-agent', productName: '千手智能体', version: metadata.version, channel: metadata.channel, distribution: 'bundled', type: 'module', main: 'main.mjs' }, null, 2)}\n`)
cpSync(join(appRoot, 'voice'), join(shell, 'voice'), { recursive: true, filter: path => !path.includes('__pycache__') && !path.endsWith('.pyc') && !path.endsWith('/test_install.py') })
for (const file of ['QUICK_START.md', 'QUICK_START.zh.md']) cpSync(join(appRoot, file), join(shell, file))
if (process.env.QIANSHOU_RELEASE_NOTES) cpSync(process.env.QIANSHOU_RELEASE_NOTES, join(shell, 'RELEASE_NOTES.md'))
cpSync(join(appRoot, 'assets/icon.icns'), join(resources, 'Qianshou.icns'))
cpSync(join(repoRoot, 'LICENSE'), join(resources, 'LICENSE-DeepSeek-MIT.txt'))
cpSync(join(dirname(electronApp), 'LICENSE'), join(resources, 'LICENSE-Electron.txt'))
cpSync(join(dirname(electronApp), 'LICENSES.chromium.html'), join(resources, 'LICENSES.chromium.html'))
cpSync(officialRuntime, join(resources, 'runtime'), { recursive: true })
const nodeVersion = JSON.parse(readFileSync(join(officialRuntime, 'versions.json'), 'utf8')).node
const nodeArchive = join(desktopTargetBuildPaths('mac-arm64').downloads, `node-v${nodeVersion}-darwin-arm64.tar.gz`)
writeFileSync(join(resources, 'runtime', 'LICENSE-Node.txt'), execFileSync('/usr/bin/tar', ['-xOf', nodeArchive, `node-v${nodeVersion}-darwin-arm64/LICENSE`], { maxBuffer: 8 * 1024 * 1024 }))
const bin = join(resources, 'runtime/bin')
mkdirSync(bin, { recursive: true })
writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\nset -eu\nbase=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec "$base/node/node" "$base/pnpm/bin/pnpm.mjs" "$@"\n', { mode: 0o755 })
const packages = snapshotRuntimeClosure({ entry: join(repoRoot, 'apps/cli'), destination: join(resources, 'dsh'), repoRoot, webDist,
  exclude: (path: string) => desktopRuntimeFileExclusion(path, { platform: 'darwin', arch: 'arm64' }) })
writeFileSync(join(resources, 'RUNTIME_PACKAGES.json'), `${JSON.stringify(packages, null, 2)}\n`)
const plist = join(output, 'Contents/Info.plist')
const set = (key: string, value: string) => {
  try { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist], { stdio: 'pipe' }) }
  catch { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, plist], { stdio: 'pipe' }) }
}
for (const [key, value] of Object.entries({ LSMinimumSystemVersion: '13.5', CFBundleIdentifier: 'com.qianshou.agent.workbench', CFBundleName: '千手智能体', CFBundleDisplayName: '千手智能体', CFBundleShortVersionString: metadata.version, CFBundleVersion: metadata.version, CFBundleIconFile: 'Qianshou.icns', NSMicrophoneUsageDescription: '仅在你主动开启语音后采集音频，用于对话与任务输入。', NSHumanReadableCopyright: `千手智能体 ${metadata.version} Preview · DeepSeek Harness MIT` })) set(key, value)
// Ad-hoc signing is explicitly a local integrity check, not Developer ID or notarization.
execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', output], { stdio: 'inherit' })
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', output], { stdio: 'inherit' })
for (const file of ['QUICK_START.md', 'QUICK_START.zh.md']) cpSync(join(appRoot, file), join(release, file))
const archive = join(release, `qianshou-agent-${metadata.version}-darwin-arm64.zip`)
execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', output, archive])
execFileSync('/usr/bin/unzip', ['-tq', archive], { stdio: 'pipe' })
const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex')
writeFileSync(`${archive}.sha256`, `${sha256}  ${archive.split('/').at(-1)}\n`)
const manifest = { schemaVersion: 1, product: 'qianshou-agent', version: metadata.version, channel: 'preview', platform: 'darwin', arch: 'arm64', signing: 'ad-hoc', notarized: false, runtime: JSON.parse(readFileSync(join(resources, 'runtime/versions.json'), 'utf8')), packageCount: packages.length, includesUserData: false, optionalVoiceResources: 'install separately; see app/voice', validation: 'packaged; fresh-home acceptance recorded separately', archive: { filename: archive.split('/').at(-1), bytes: statSync(archive).size, sha256 } }
writeFileSync(join(release, 'RELEASE_MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(JSON.stringify({ output, ...manifest }, null, 2))
