/** Install this local shell using the already downloaded Electron runtime; no daemon or original service changes. */
import { execFileSync } from 'node:child_process'
import { accessSync, constants, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { resolveConfig } from '../config.mjs'

if (process.platform !== 'darwin') throw new Error('This installer requires macOS. main.mjs supports separately configured Windows and Linux Electron runtimes.')
const appSource = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = process.env.QIANSHOU_SOURCE ?? resolve(appSource, '../..')
const requireDesktop = createRequire(join(sourcePath, 'apps/desktop/package.json'))
const electronBinary = process.env.QIANSHOU_ELECTRON ?? requireDesktop('electron')
const electronApp = resolve(dirname(electronBinary), '../..')
if (!electronApp.endsWith('.app') || !existsSync(join(electronApp, 'Contents/Info.plist'))) throw new Error('Downloaded Electron.app is missing')
accessSync(electronBinary, constants.X_OK)
const config = resolveConfig({ sourcePath, nodePath: process.execPath })
accessSync(join(sourcePath, 'apps/cli/lib/bin.js'), constants.R_OK)
const target = resolve(process.env.QIANSHOU_APP_DEST ?? join(homedir(), 'Applications', '千手智能体.app'))
if (!target.endsWith('.app')) throw new Error('QIANSHOU_APP_DEST must end in .app')
mkdirSync(dirname(target), { recursive: true })
const stage = `${target}.install-${randomUUID()}.app`
try {
  execFileSync('/usr/bin/ditto', [electronApp, stage], { stdio: 'pipe' })
  const resources = join(stage, 'Contents/Resources')
  const destination = join(resources, 'app')
  mkdirSync(destination, { recursive: true })
  for (const file of ['main.mjs', 'config.mjs', 'security.mjs', 'backend.mjs', 'native.mjs', 'preload.cjs', 'voice-config.mjs']) cpSync(join(appSource, file), join(destination, file))
  /**
   * **生成壳的 package.json，而不是拷源码那份**。
   *
   * 源码的 `apps/qianshou-desktop/package.json` 是给工具链看的
   * （`name: @deepseek-ai/dsh-qianshou-desktop`、`private: true`、带 `scripts`），
   * Electron 会按它去找入口与产品名。`package-mac.ts` 的做法是**写一份新的**
   * （`name: qianshou-agent` + `productName` + `distribution: bundled`），
   * 安装器原本却把源码那份直接拷进去——结果 app 的 `Resources/app/package.json`
   * 与正式产物不一致。
   *
   * 实测症状：这样装出来的应用**双击毫无反应、连进程都不留**
   * （Electron 读到的 `name` 是 `@deepseek-ai/dsh-qianshou-desktop`，
   * 与 `CFBundleName` 千手智能体 对不上，启动阶段就退出、且不打印任何东西）。
   * 与 `package-mac.ts:38` 对齐后即可正常启动。
   */
  writeFileSync(join(destination, 'package.json'), `${JSON.stringify({
    name: 'qianshou-agent',
    productName: '千手智能体',
    version: JSON.parse(readFileSync(join(appSource, 'package.json'), 'utf8')).version,
    channel: JSON.parse(readFileSync(join(appSource, 'package.json'), 'utf8')).channel,
    distribution: 'local',
    type: 'module',
    main: 'main.mjs',
  }, null, 2)}\n`)
  writeFileSync(join(destination, 'runtime-config.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  cpSync(join(appSource, 'assets/icon.icns'), join(resources, 'Qianshou.icns'))
  const plist = join(stage, 'Contents/Info.plist')
  const set = (key, value, type = 'string') => {
    try { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist], { stdio: 'pipe' }) }
    catch { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} ${type} ${value}`, plist], { stdio: 'pipe' }) }
  }
  set('CFBundleIdentifier', 'com.qianshou.agent.workbench')
  set('CFBundleName', '千手智能体'); set('CFBundleDisplayName', '千手智能体')
  set('CFBundleIconFile', 'Qianshou.icns')
  const metadata = JSON.parse(readFileSync(join(appSource, 'package.json'), 'utf8'))
  set('CFBundleShortVersionString', metadata.version); set('CFBundleVersion', metadata.version)
  set('NSMicrophoneUsageDescription', '用于你主动开启的连续语音对话与语音输入，音频在本机识别。')
  set('NSHumanReadableCopyright', '千手智能体 · Local developer workbench')
  // Electron's helper resources are intact; only the outer local application seal changed.
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', stage], { stdio: 'pipe' })
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', stage], { stdio: 'pipe' })
  if (existsSync(target)) renameSync(target, `${target}.backup-${Date.now()}`)
  renameSync(stage, target)
  const manifest = { installedAt: new Date().toISOString(), app: target, source: sourcePath, node: config.nodePath, home: config.home, port: config.port, electron: JSON.parse(readFileSync(requireDesktop.resolve('electron/package.json'), 'utf8')).version }
  const receipt = join(homedir(), '.local/share/qianshou-agent/desktop/install-receipt.json')
  mkdirSync(dirname(receipt), { recursive: true, mode: 0o700 })
  writeFileSync(receipt, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(`${target}\n${receipt}\n`)
} catch (error) {
  // This unique directory was created by this installation attempt only.
  rmSync(stage, { recursive: true, force: true })
  throw error
}
