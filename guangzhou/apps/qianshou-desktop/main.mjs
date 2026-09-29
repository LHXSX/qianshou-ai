/** Independent local 千手智能体 shell; the existing Harness desktop and 3080 service are untouched. */
import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, systemPreferences, safeStorage } from 'electron'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { localOrigin, readOptionalConfig, resolveConfig, resolvePackagedConfig } from './config.mjs'
import { startBackend } from './backend.mjs'
import { externalUrl, microphoneRequest, trustedUrl } from './security.mjs'
import { openRustDesk } from './native.mjs'
import { RelayService } from './relay/service.mjs'
import { registerRelayIpc } from './relay/ipc.mjs'
import { controllerUpdateHooks, waitForApplicationReady } from './update-integration.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = join(homedir(), '.local', 'share', 'qianshou-agent', 'desktop')
mkdirSync(dataDir, { recursive: true, mode: 0o700 })
app.setName('千手智能体')
app.setPath('userData', dataDir)
if (process.platform === 'win32') app.setAppUserModelId('com.qianshou.agent.workbench')
const metadata = readOptionalConfig(join(here, 'package.json'))
const updatesDirectory = join(dataDir, 'updates')
const updateTarget = { role: 'controller', platform: process.platform, arch: process.arch }
let updateRuntime
let updateForwarded = false
let updatePending = false
let updateAttempt = { attemptId: process.env.QIANSHOU_UPDATE_ATTEMPT, token: process.env.QIANSHOU_UPDATE_TOKEN }
if (metadata.distribution === 'bundled') {
  updateRuntime = await import(pathToFileURL(join(here, 'updater', 'entry.mjs')).href)
  const result = await updateRuntime.bootstrapUpdate({ updatesDirectory, target: updateTarget, currentVersion: metadata.version, currentExecutable: process.execPath })
  updatePending = result.pending === true
  if (result.attemptId && result.token) updateAttempt = { attemptId: result.attemptId, token: result.token }
  if (result.action === 'forward') await updateRuntime.launchActivation(result.activation, {
    helperExecutable: join(process.resourcesPath, 'runtime', 'node', process.platform === 'win32' ? 'node.exe' : 'node'),
    helperScript: join(here, 'updater', 'runner.mjs'), electronRunAsNode: false,
  })
  updateForwarded = result.action !== 'continue'
}

const copy = {
  zh: {
    loading: '正在启动本机工作台', subtitle: '连接你的项目、任务与协作设备。',
    failed: '工作台未能启动', exited: '本机服务已退出', exitedBody: '当前服务已停止。请退出并重新打开千手智能体。',
    PORT_IN_USE: '配置的端口已被其他程序占用。应用没有接管或关闭该程序。请先关闭占用此端口的千手服务，或修改 desktop/config.json 的 port。',
    RUNTIME_MISSING: '应用运行时不完整。请重新下载完整安装包；本地源码启动请先完成构建。',
    START_FAILED: '本机 Harness 启动失败。详细信息已写入仅本机用户可读的脱敏日志。',
    START_TIMEOUT: '本机 Harness 启动超时，已停止本次启动的进程。',
    INVALID_CONFIG: '桌面运行配置无效。请检查 desktop/config.json 的本机绝对路径及端口。',
    INVALID_PORT: '端口必须在 1024–65535 之间，且不能使用保留给原服务的 3080。',
    LOOPBACK_REQUIRED: '本机主控只允许绑定 127.0.0.1。',
    SHUTDOWN_FAILED: '无法确认本次后台任务已全部退出。请检查任务管理器中的千手 Node 进程；详细信息已写入本地日志。',
    log: '日志：', help: '帮助', guide: '安装与使用', voiceGuide: '安装本地语音资源', relayGuide: '连接协作中转', relayImport: '导入专属中转注册配置',
  },
  en: {
    loading: 'Starting your local workbench', subtitle: 'Connecting your projects, tasks and team devices.',
    failed: 'Workbench could not start', exited: 'The local service stopped', exitedBody: 'Quit and reopen 千手智能体 to restart its local service.',
    PORT_IN_USE: 'The configured port is occupied. No other process was taken over or stopped. Close the other Qianshou service or change port in desktop/config.json.',
    RUNTIME_MISSING: 'The application runtime is incomplete. Download the complete package again; source launchers require a completed build.',
    START_FAILED: 'The local Harness failed to start. Details are saved in a private redacted log.',
    START_TIMEOUT: 'The local Harness timed out. Its owned startup process has been stopped.',
    INVALID_CONFIG: 'Desktop runtime settings are invalid. Check absolute paths and port in desktop/config.json.',
    INVALID_PORT: 'Port must be 1024–65535. Port 3080 is reserved for the original service.',
    LOOPBACK_REQUIRED: 'The local controller must bind to 127.0.0.1.', log: 'Log:', help: 'Help', guide: 'Installation and usage', voiceGuide: 'Install local voice resources', relayGuide: 'Connect a collaboration relay', relayImport: 'Import a dedicated relay registration',
    SHUTDOWN_FAILED: 'Could not confirm that all owned background tasks exited. Check the Qianshou Node processes in Task Manager; details are in the local log.',
  },
}
let window
let backend
let relay
let disposeRelayIpc
let backendReady = false
let quitting = false
let startup
let config
let t = copy.zh
let updateCenter

async function shutdown() {
  quitting = true
  // A Quit during the preflight probe still owns the child that probe may create.
  try { await startup } catch { /* Startup failures already show a localized error. */ }
  backendReady = false
  updateCenter?.dispose()
  disposeRelayIpc?.()
  try { await relay?.close() } finally { await backend?.stop() }
}

if (updateForwarded || !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!window || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show(); window.focus()
  })
  app.on('window-all-closed', () => { app.quit() })
  app.on('before-quit', event => {
    event.preventDefault()
    if (quitting) return
    void shutdown().catch(() => { dialog.showErrorBox(t.exited, t.SHUTDOWN_FAILED) }).finally(() => { app.exit(0) })
  })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { app.quit() })
  // Electron emits ready after loading the ESM entry; awaiting it at module scope deadlocks startup.
  void app.whenReady().then(boot).catch(() => {
    if (!quitting) { dialog.showErrorBox(t.failed, t.START_FAILED); app.quit() }
  })
}

async function boot() {
  if (quitting) return
  t = app.getLocale().startsWith('zh') ? copy.zh : copy.en
  app.setAboutPanelOptions({ applicationName: '千手智能体', applicationVersion: metadata.version, version: metadata.channel ?? 'Local workbench' })
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : [{ role: 'fileMenu' }]),
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    ...(metadata.distribution === 'bundled' ? [{ label: t.help, submenu: [
      { label: t === copy.zh ? '检查软件更新…' : 'Check for updates…', click: () => { void updateCenter?.open() } },
      { type: 'separator' },
      { label: t.guide, click: () => { void shell.openPath(join(here, t === copy.zh ? 'QUICK_START.zh.md' : 'QUICK_START.md')) } },
      { label: t.voiceGuide, click: () => { void shell.openPath(join(here, 'voice', t === copy.zh ? 'README.zh.md' : 'README.md')) } },
      { label: t.relayGuide, click: () => { void shell.openPath(join(here, 'relay', t === copy.zh ? 'README.zh.md' : 'README.md')) } },
    ] }] : []),
  ]))
  try {
    const raw = { ...readOptionalConfig(join(here, 'runtime-config.json')), ...readOptionalConfig(join(dataDir, 'config.json')) }
    config = metadata.distribution === 'bundled'
      ? resolvePackagedConfig(process.resourcesPath, raw)
      : resolveConfig(raw)
    const origin = localOrigin(config)
    relay = new RelayService({ directory: join(dataDir, 'relay'), resourcesDirectory: join(here, 'relay', 'resources'), backendPort: config.port, secureStorage: safeStorage })
    const webSession = session.fromPartition('persist:qianshou-workbench')
    if (updateRuntime) {
      const updateHooks = controllerUpdateHooks({ origin, webSession, ready: () => backendReady && !quitting })
      updateCenter = new updateRuntime.UpdateCenter({
        ...updateTarget, currentVersion: metadata.version, locale: t === copy.zh ? 'zh' : 'en', packaged: true, updatesDirectory,
        ...updateHooks,
        prepareInstallation: staged => updateRuntime.prepareActivation(staged, { updatesDirectory, target: updateTarget, currentVersion: metadata.version, currentExecutable: process.execPath, currentPid: process.pid }),
        discardInstallation: activation => updateRuntime.cancelActivation(activation),
        restart: async (_staged, lease, activation) => {
          await updateHooks.commitRestart(lease)
          await updateRuntime.launchActivation(activation, { helperExecutable: config.nodePath, helperScript: join(here, 'updater', 'runner.mjs'), electronRunAsNode: false })
          await updateHooks.commitRestart(lease)
          app.quit()
        },
      })
    }
    webSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
      if (!window || contents !== window.webContents || details.isMainFrame !== true || !trustedUrl(requestingOrigin, origin)) return false
      if (permission === 'media') return details.mediaType === 'audio'
      return permission === 'clipboard-sanitized-write'
    })
    webSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      if (!window || contents !== window.webContents || !trustedUrl(contents.getURL(), origin)) { callback(false); return }
      if (permission === 'media' && microphoneRequest(details, origin)) {
        if (process.platform === 'darwin') {
          void systemPreferences.askForMediaAccess('microphone').then(granted => {
            callback(granted && !contents.isDestroyed() && trustedUrl(contents.getURL(), origin))
          }, () => callback(false))
        } else callback(true)
        return
      }
      callback(permission === 'clipboard-sanitized-write' && details.isMainFrame && trustedUrl(details.requestingUrl, origin))
    })
    window = new BrowserWindow({
      width: 1440, height: 960, minWidth: 880, minHeight: 640, title: '千手智能体', show: false,
      ...(process.platform === 'win32' ? { icon: join(here, 'assets', 'icon.png') } : {}),
      webPreferences: { preload: join(here, 'preload.cjs'), session: webSession,
        nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false,
        webviewTag: false, safeDialogs: true },
    })
    window.once('ready-to-show', () => { if (!quitting) window.show() })
    const outside = value => { if (externalUrl(value, origin)) void shell.openExternal(value).catch(() => {}) }
    window.webContents.setWindowOpenHandler(({ url }) => { outside(url); return { action: 'deny' } })
    window.webContents.on('will-navigate', (event, url) => {
      if (!trustedUrl(url, origin)) { event.preventDefault(); outside(url) }
    })
    window.webContents.on('will-redirect', (event, url) => { if (!trustedUrl(url, origin)) event.preventDefault() })
    window.webContents.on('will-attach-webview', event => { event.preventDefault() })
    window.webContents.on('page-title-updated', event => { event.preventDefault(); window.setTitle('千手智能体') })
    ipcMain.handle('qianshou:open-rustdesk', async (event, id) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !trustedUrl(event.senderFrame.url, origin)) return { ok: false, error: 'UNTRUSTED_SENDER' }
      return openRustDesk(id, config.rustDeskPath)
    })
    disposeRelayIpc = registerRelayIpc({ ipcMain, dialog, window, relay, importTitle: t.relayImport,
      ready: () => backendReady && !quitting,
      trusted: event => Boolean(window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && trustedUrl(event.senderFrame.url, origin)),
    })
    const splash = `<!doctype html><html lang="${t === copy.zh ? 'zh' : 'en'}"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>千手智能体</title><style>body{margin:0;min-height:100vh;display:grid;place-content:center;font:15px -apple-system,sans-serif;background:Canvas;color:CanvasText}h1{font-size:36px;letter-spacing:-1.2px;margin:0 0 32px}p{opacity:.6;margin:8px 0}strong{font-weight:500}</style><h1>千手智能体</h1><strong>${t.loading}</strong><p>${t.subtitle}</p></html>`
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splash)}`)
    if (quitting) throw new Error('START_CANCELLED')
    // Opening the real user home can migrate data before the UI mounts; never roll back past this boundary.
    if (updatePending) await updateRuntime.acknowledgeDataAccess({ updatesDirectory, target: updateTarget, currentVersion: metadata.version, currentExecutable: process.execPath, ...updateAttempt })
    startup = startBackend(config, () => {
      backendReady = false
      void relay.close().catch(() => { if (!quitting) dialog.showErrorBox(t.exited, t.SHUTDOWN_FAILED) })
      if (!quitting) dialog.showErrorBox(t.exited, t.exitedBody)
    })
    backend = await startup
    if (quitting) { await backend.stop() } else {
      const url = await backend.url
      backendReady = !quitting
      if (!quitting) {
        const applicationReady = updateRuntime ? waitForApplicationReady({ window, ipcMain, origin }) : undefined
        // Handle a timeout even when navigation itself fails before the await below.
        void applicationReady?.catch(() => {})
        await window.loadURL(url)
        if (updateRuntime) {
          await applicationReady
          if (updatePending) await updateRuntime.acknowledgeReady({ updatesDirectory, target: updateTarget, currentVersion: metadata.version, currentExecutable: process.execPath, ...updateAttempt })
          updateCenter.start()
        }
      }
    }
  } catch (error) {
    await backend?.stop()
    if (!quitting) {
      const message = Object.hasOwn(t, error?.message) ? t[error.message] : t.START_FAILED
      dialog.showErrorBox(t.failed, `${message}${backend?.logPath ? `\n\n${t.log} ${backend.logPath}` : ''}`)
      app.quit()
    }
  }
}
