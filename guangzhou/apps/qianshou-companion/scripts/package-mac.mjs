/** Package the built companion from the workspace's installed Electron runtime. */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(appRoot, '../..')
const { version, productName } = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'))
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('The macOS product version must contain three numeric components.')
const require = createRequire(join(repoRoot, 'apps/desktop/package.json'))
const binary = require('electron')
const sourceApp = dirname(dirname(dirname(binary)))
const explicitOutput = process.env.QIANSHOU_COMPANION_MAC_OUTPUT
const hasExplicitOutput = explicitOutput !== undefined
if (hasExplicitOutput && explicitOutput.trim() === '') throw new Error('Explicit release output must not be empty or whitespace.')
const output = resolve(explicitOutput ?? join(appRoot, 'dist', '千手协作端.app'))
if (hasExplicitOutput && existsSync(output)) throw new Error('Explicit release output already exists; preserve the existing artifact.')
if (process.platform !== 'darwin') throw new Error('Use the platform-specific Electron packager on this platform; this script builds the local macOS app.')
await readFile(join(appRoot, 'lib/main.js'))
const files = JSON.parse(execFileSync('python3', [join(appRoot, 'scripts/bundle_files.py')], { encoding: 'utf8' }))
if (!hasExplicitOutput) await rm(output, { recursive: true, force: true })
await mkdir(dirname(output), { recursive: true })
await cp(sourceApp, output, { recursive: true, verbatimSymlinks: true })
const resource = join(output, 'Contents/Resources/app')
await mkdir(resource, { recursive: true })
for (const file of files) {
  await mkdir(dirname(join(resource, 'lib', file)), { recursive: true })
  await cp(join(appRoot, 'lib', file), join(resource, 'lib', file))
}
await cp(join(repoRoot, 'apps/qianshou-desktop/assets/icon.icns'), join(output, 'Contents/Resources/qianshou.icns'))
await writeFile(join(resource, 'package.json'), JSON.stringify({ name: 'qianshou-companion', productName, version, distribution: 'bundled', channel: 'preview', type: 'module', main: 'lib/main.js' }, null, 2))
await cp(join(repoRoot, 'LICENSE'), join(resource, 'LICENSE-DeepSeek-MIT.txt'))
await cp(join(appRoot, 'node_modules/ws/LICENSE'), join(resource, 'LICENSE-ws-MIT.txt'))
await cp(join(dirname(sourceApp), 'LICENSE'), join(output, 'Contents/Resources/LICENSE-Electron.txt'))
await cp(join(dirname(sourceApp), 'LICENSES.chromium.html'), join(output, 'Contents/Resources/LICENSES.chromium.html'))
const plist = join(output, 'Contents/Info.plist')
for (const [key, value] of [['CFBundleDisplayName', productName], ['CFBundleName', productName], ['CFBundleIdentifier', 'com.qianshou.companion'], ['CFBundleShortVersionString', version], ['CFBundleVersion', version]]) execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist])
execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleIconFile qianshou.icns', plist])
execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', output], { stdio: 'inherit' })
console.log(output)
