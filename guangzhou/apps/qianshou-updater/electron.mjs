/** A finite native update window shared by the controller and companion applications. */
import { BrowserWindow, ipcMain } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkForUpdate } from './manifest.mjs'
import { downloadUpdate } from './download.mjs'
import { stageUpdate } from './stage.mjs'

const location = dirname(fileURLToPath(import.meta.url))
const pageUrl = pathToFileURL(join(location, 'window.html')).href
const CHECK_INTERVAL_MS = 6 * 60 * 60_000

/** Own background downloads; the caller owns its task fence and graceful application restart. */
export class UpdateCenter {
  constructor(options, dependencies = {}) {
    this.options = options
    this.dependencies = { checkForUpdate, downloadUpdate, stageUpdate, ...dependencies }
    this.state = { phase: 'idle', currentVersion: options.currentVersion, locale: options.locale === 'en' ? 'en' : 'zh', notes: [] }
    this.window = undefined
    this.operation = undefined
    this.abort = undefined
    this.staged = undefined
    this.disposed = false
    this.promptedVersion = undefined
    this.readyPoll = undefined
    this.readinessRevision = 0
    this.handler = async (event, action) => {
      if (!this.window || event.sender !== this.window.webContents || event.senderFrame !== this.window.webContents.mainFrame || event.senderFrame.url !== pageUrl) return { ok: false, error: 'UNTRUSTED_SENDER' }
      if (action === 'snapshot') return { ok: true, value: this.state }
      if (action === 'hide') { this.window.hide(); return { ok: true } }
      if (action === 'cancel') { this.abort?.abort(); return { ok: true } }
      if (action === 'check') { void this.check(); return { ok: true } }
      if (action === 'install') { void this.install(); return { ok: true } }
      return { ok: false, error: 'INVALID_ACTION' }
    }
    ipcMain.handle('qianshou:update-center', this.handler)
  }

  /** Start periodic background discovery only after the application has reached real readiness. */
  start() {
    if (this.disposed || this.checkTimer) return
    this.firstCheck = setTimeout(() => { void this.check() }, 15_000)
    this.firstCheck.unref()
    this.checkTimer = setInterval(() => { void this.check() }, CHECK_INTERVAL_MS)
    this.checkTimer.unref()
  }

  publish(next) {
    if (this.disposed) return
    this.state = { ...this.state, ...next }
    if (this.window && !this.window.isDestroyed() && !this.window.webContents.isDestroyed()) {
      try { this.window.webContents.send('qianshou:update-state', this.state) }
      catch { /* A renderer that closes between the checks cannot interrupt the owned update operation. */ }
    }
  }

  /** Open the update center without starting a second download. */
  async open({ inactive = false } = {}) {
    if (this.disposed) return
    if (!this.window || this.window.isDestroyed()) {
      this.window = new BrowserWindow({ title: this.options.locale === 'en' ? 'Qianshou · Software update' : '千手 · 软件更新', width: 580, height: 470, minWidth: 580, minHeight: 430, resizable: false, show: false, autoHideMenuBar: true, backgroundColor: '#15191f', webPreferences: { preload: join(location, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false } })
      this.window.removeMenu()
      this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      this.window.webContents.on('will-navigate', event => event.preventDefault())
      this.window.webContents.on('will-attach-webview', event => event.preventDefault())
      const window = this.window
      window.on('closed', () => { if (this.window === window) this.window = undefined })
      try { await window.loadFile(join(location, 'window.html')) }
      catch {
        if (!window.isDestroyed()) window.destroy()
        this.publish({ phase: 'error', error: 'UPDATE_WINDOW_FAILED' })
        return
      }
    }
    if (this.disposed || !this.window || this.window.isDestroyed()) return
    if (inactive) this.window.showInactive()
    else { this.window.show(); this.window.focus() }
    if (this.state.phase === 'idle') void this.check()
  }

  /** Coalesce checks and downloads. A prepared version waits for the user's restart action. */
  check() {
    if (this.disposed) return Promise.resolve()
    if (this.operation) return this.operation
    if (this.staged) return this.refreshReadiness()
    this.operation = this.runCheck().finally(() => { this.operation = undefined; this.abort = undefined })
    return this.operation
  }

  async runCheck() {
    if (!this.options.packaged) { this.publish({ phase: 'error', error: 'SOURCE_BUILD' }); return }
    const controller = new AbortController()
    this.abort = controller
    this.publish({ phase: 'checking', error: undefined, progress: undefined })
    const target = { role: this.options.role, platform: this.options.platform, arch: this.options.arch, currentVersion: this.options.currentVersion }
    try {
      const release = await this.dependencies.checkForUpdate(target, { signal: controller.signal })
      controller.signal.throwIfAborted()
      if (release.status !== 'available') { this.publish({ phase: release.status, version: undefined, notes: [] }); return }
      this.publish({ phase: 'downloading', version: release.version, notes: release.artifact.notes, progress: 0 })
      const archive = await this.dependencies.downloadUpdate(release, { cacheDirectory: join(this.options.updatesDirectory, 'downloads'), signal: controller.signal, onProgress: ({ fraction }) => { this.publish({ progress: Math.min(100, Math.round(fraction * 100)) }) } })
      controller.signal.throwIfAborted()
      this.publish({ phase: 'staging', progress: 100 })
      const staged = await this.dependencies.stageUpdate(archive, { updatesDirectory: this.options.updatesDirectory, target, signal: controller.signal })
      controller.signal.throwIfAborted()
      this.staged = staged
      await this.refreshReadiness()
      controller.signal.throwIfAborted()
      this.readyPoll = setInterval(() => { if (!this.operation) void this.refreshReadiness() }, 10_000)
      this.readyPoll.unref()
    } catch (error) {
      if (!this.disposed) this.publish({ phase: 'error', error: controller.signal.aborted ? 'CANCELLED' : (error?.code ?? 'UPDATE_FAILED') })
    }
  }

  async refreshReadiness() {
    if (this.disposed || !this.staged || this.state.phase === 'restarting') return
    const revision = ++this.readinessRevision
    const staged = this.staged
    const current = () => !this.disposed && revision === this.readinessRevision && staged === this.staged && this.state.phase !== 'restarting'
    try {
      const state = await this.options.readiness()
      if (!current()) return
      this.publish({ phase: state.ready === true ? 'ready' : 'waiting', error: undefined })
      if (state.ready === true && this.promptedVersion !== this.state.version) {
        this.promptedVersion = this.state.version
        await this.open({ inactive: true })
      }
    } catch { if (current()) this.publish({ phase: 'waiting', error: 'READINESS_UNAVAILABLE' }) }
  }

  /** Acquire an atomic idle lease, then ask the application to perform its ordinary shutdown. */
  async install() {
    if (this.disposed || !this.staged || this.operation || this.state.phase !== 'ready') return
    this.operation = this.runInstall().finally(() => { this.operation = undefined })
    await this.operation
  }

  async runInstall() {
    let lease
    let installation
    this.readinessRevision++
    this.publish({ phase: 'restarting', error: undefined })
    try {
      // Complete expensive archive validation before taking the short work-admission lease.
      installation = await this.options.prepareInstallation?.(this.staged)
      if (this.disposed) throw Object.assign(new Error('Update center was disposed'), { code: 'CANCELLED' })
      lease = await this.options.prepareRestart()
      if (this.disposed) throw Object.assign(new Error('Update center was disposed'), { code: 'CANCELLED' })
      await this.options.restart(this.staged, lease, installation)
    } catch (error) {
      if (installation) { try { await this.options.discardInstallation?.(installation) } catch { /* A helper that has crossed its data boundary cannot be rolled back. */ } }
      if (lease) { try { await this.options.cancelRestart(lease) } catch { /* The bounded Host lease also expires independently. */ } }
      this.publish({ phase: error?.code === 'UPDATE_BUSY' || error?.code === 'UPDATE_PREPARING' ? 'waiting' : 'error', error: error?.code ?? 'UPDATE_RESTART_FAILED' })
    }
  }

  /** Stop only update-owned work and windows; application tasks belong to the caller. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.readinessRevision++
    clearTimeout(this.firstCheck); clearInterval(this.checkTimer); clearInterval(this.readyPoll)
    this.abort?.abort()
    ipcMain.removeHandler('qianshou:update-center')
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
  }
}
