/** Sandboxed Electron companion: all filesystem/network effects stay behind a finite local IPC interface. */
import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, Menu } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { hostname, platform, arch } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { realpath } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { record, textField, type WorkspaceId } from '@deepseek-ai/dsh-host-remote-devices/protocol'
import { CompanionPeer, deviceEndpoint, type PeerCredential, type PeerState } from './peer.ts'
import { LocalStore, type LocalPreferences } from './local-store.ts'
import { openRustDesk } from './executor.ts'
import { companionUpdates } from './updates.ts'

app.setName('千手协作端')
let window: BrowserWindow | undefined
let peer: CompanionPeer | undefined
let preferences: LocalPreferences
let storage: LocalStore
let view: PeerState = { connected: false, connecting: false, error: null, jobs: [] }
const location = dirname(fileURLToPath(import.meta.url))
const updates = await companionUpdates(location)
let updateLease: { leaseId: string; expiresAt: number; committed: boolean; timer: NodeJS.Timeout } | undefined
let localActions = 0

function snapshot(): unknown {
  return { ...view, endpoint: preferences.endpoint, name: preferences.name, workspaces: preferences.workspaces, hasCredential: Boolean(preferences.connections[preferences.endpoint]?.encryptedCredential), platform: platform() }
}
function publish(): void { window?.webContents.send('qianshou:state', snapshot()) }
function trusted(event: IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== pathToFileURL(join(location, 'index.html')).href) throw new Error('UNTRUSTED_RENDERER')
}
function encryptionReady(): void {
  if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) throw new Error('SYSTEM_KEYCHAIN_UNAVAILABLE')
}

async function connect(value: unknown): Promise<void> {
  if (view.jobs.some(job => job.status === 'running')) throw new Error('CANCEL_RUNNING_JOB_FIRST')
  const input = record(value)
  const endpoint = deviceEndpoint(textField(input.endpoint, 2048))
  const name = textField(input.name, 200)
  const code = typeof input.code === 'string' && input.code.trim() ? textField(input.code.trim(), 100) : undefined
  if (preferences.workspaces.length === 0) throw new Error('CHOOSE_WORKSPACE_FIRST')
  encryptionReady()
  let credential: PeerCredential | undefined
  const existing = preferences.connections[endpoint]
  if (!code && existing?.encryptedCredential) credential = JSON.parse(safeStorage.decryptString(Buffer.from(existing.encryptedCredential, 'base64'))) as PeerCredential
  if (!credential && !code) throw new Error('PAIR_CODE_REQUIRED')
  peer?.stop()
  preferences.endpoint = endpoint; preferences.name = name
  await storage.save(preferences)
  const next = new CompanionPeer({
    endpoint, ...(code ? { code } : {}), ...(credential ? { credential } : {}),
    hello: { name, platform: platform(), arch: arch(), workspaces: preferences.workspaces },
    jobs: credential ? existing?.jobs ?? [] : [],
    saveCredential: async received => {
      encryptionReady()
      const encryptedCredential = safeStorage.encryptString(JSON.stringify(received)).toString('base64')
      preferences.connections[endpoint] = { encryptedCredential, jobs: [] }
      await storage.save(preferences)
    },
    saveJobs: async jobs => {
      const connection = preferences.connections[endpoint]
      if (!connection) throw new Error('CREDENTIAL_NOT_SAVED')
      connection.jobs = jobs.slice(-500)
      await storage.save(preferences)
    },
    changed: state => { if (peer === next) { view = state; publish() } },
  })
  peer = next
  next.connect()
}

async function run(): Promise<void> {
  await updates?.beforeDataAccess()
  storage = new LocalStore(join(app.getPath('userData'), 'devices.json'))
  preferences = await storage.read({ version: 1, endpoint: 'ws://127.0.0.1:3081/qianshou-device', name: hostname(), workspaces: [], connections: {} })
  const cancelUpdate = async (lease: { leaseId: string }): Promise<void> => {
    if (lease.leaseId !== updateLease?.leaseId) return
    clearTimeout(updateLease.timer); updateLease = undefined; peer?.cancelUpdate()
  }
  updates?.configure({
    readiness: async () => ({ ready: !updateLease && localActions === 0 && !(peer?.updateBusy() ?? false) }),
    prepareRestart: async () => {
      if (updateLease) throw Object.assign(new Error('UPDATE_PREPARING'), { code: 'UPDATE_PREPARING' })
      if (localActions > 0 || peer?.updateBusy()) throw Object.assign(new Error('UPDATE_BUSY'), { code: 'UPDATE_BUSY' })
      peer?.prepareUpdate()
      const leaseId = randomUUID()
      const timer = setTimeout(() => { void cancelUpdate({ leaseId }) }, 30_000); timer.unref()
      updateLease = { leaseId, expiresAt: Date.now() + 30_000, committed: false, timer }
      try { await storage.flush() } catch (error) { await cancelUpdate({ leaseId }); throw error }
      return { leaseId }
    },
    commitRestart: async lease => {
      if (!updateLease || updateLease.leaseId !== lease.leaseId || Date.now() >= updateLease.expiresAt) throw Object.assign(new Error('UPDATE_LEASE_EXPIRED'), { code: 'UPDATE_LEASE_EXPIRED' })
      if (localActions > 0 || peer?.updateBusy()) throw Object.assign(new Error('UPDATE_BUSY'), { code: 'UPDATE_BUSY' })
      if (!updateLease.committed) {
        updateLease.committed = true
        updateLease.expiresAt = Math.max(updateLease.expiresAt, Date.now() + 15_000)
        clearTimeout(updateLease.timer)
        updateLease.timer = setTimeout(() => { void cancelUpdate(lease) }, updateLease.expiresAt - Date.now()); updateLease.timer.unref()
      }
    },
    cancelRestart: cancelUpdate,
  })
  window = new BrowserWindow({
    title: '千手协作端', width: 1140, height: 820, minWidth: 760, minHeight: 560, backgroundColor: '#151719',
    webPreferences: { preload: join(location, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: app.name, submenu: [{ role: 'about' as const }, { type: 'separator' as const }, { role: 'quit' as const }] }] : [{ role: 'fileMenu' as const }]),
    { label: app.getLocale().startsWith('zh') ? '帮助' : 'Help', submenu: [{ label: app.getLocale().startsWith('zh') ? '检查软件更新…' : 'Check for updates…', click: () => { void updates?.open() } }] },
  ]))
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  const handlers: Record<string, (payload: unknown) => unknown | Promise<unknown>> = {
    snapshot: () => snapshot(),
    'application-ready': () => updates?.ready(),
    updates: () => updates?.open(),
    connect,
    disconnect: () => { peer?.stop() },
    approve: payload => peer?.approve(textField(payload, 100)),
    reject: payload => peer?.reject(textField(payload, 100)),
    cancel: payload => peer?.cancel(textField(payload, 100)),
    rustdesk: () => openRustDesk(),
    copy: payload => { clipboard.writeText(textField(payload, 10_000)) },
    'choose-folder': async () => {
      if (view.connected || view.connecting || view.jobs.some(job => job.status === 'running')) throw new Error('DISCONNECT_TO_EDIT_WORKSPACES')
      const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory'] })
      if (result.canceled || !result.filePaths[0]) return
      const path = await realpath(result.filePaths[0])
      if (!preferences.workspaces.some(item => item.path === path)) preferences.workspaces.push({ id: randomUUID() as WorkspaceId, name: basename(path) || path, path })
      await storage.save(preferences); publish()
    },
    'remove-folder': async payload => {
      if (view.connected || view.connecting || view.jobs.some(job => job.status === 'running')) throw new Error('DISCONNECT_TO_EDIT_WORKSPACES')
      const id = textField(payload, 100)
      preferences.workspaces = preferences.workspaces.filter(item => item.id !== id)
      await storage.save(preferences); publish()
    },
    'forget-pairing': async () => {
      if (view.jobs.some(job => job.status === 'running')) throw new Error('CANCEL_RUNNING_JOB_FIRST')
      peer?.stop(); peer = undefined
      delete preferences.connections[preferences.endpoint]
      view = { connected: false, connecting: false, error: null, jobs: [] }
      await storage.save(preferences); publish()
    },
  }
  for (const [action, handler] of Object.entries(handlers)) ipcMain.handle(`qianshou:${action}`, async (event, payload) => {
    trusted(event)
    const work = !['snapshot', 'application-ready', 'updates', 'copy'].includes(action)
    if (work && updateLease) return { ok: false, error: 'UPDATE_PREPARING' }
    if (work) localActions++
    try { return { ok: true, value: await handler(payload) } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'LOCAL_ACTION_FAILED' } }
    finally { if (work) localActions-- }
  })
  await window.loadFile(join(location, 'index.html'))
}

if (updates?.forwarded || !app.requestSingleInstanceLock()) app.quit()
else {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { app.quit() })
  app.on('second-instance', () => { window?.show(); window?.focus() })
  app.whenReady().then(run).catch(error => {
    dialog.showErrorBox('千手协作端无法启动', error instanceof Error ? error.message : String(error)); app.quit()
  })
  app.on('before-quit', () => { updates?.dispose(); clearTimeout(updateLease?.timer); peer?.stop() })
  app.on('window-all-closed', () => { app.quit() })
}
