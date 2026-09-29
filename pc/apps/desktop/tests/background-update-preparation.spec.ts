import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import type { AppUpdater } from 'electron-updater'
import { QianshouDevicePreferences } from '../src/device-preferences.ts'
vi.mock('electron', () => ({ app: { isPackaged: false } }))
vi.mock('electron-updater', () => ({ default: { autoUpdater: { autoDownload: false, autoInstallOnAppQuit: false } } }))
const { DesktopUpdateCoordinator } = await import('../src/update-coordinator.ts')

function fixture(enabled: boolean, sealedFeedUrl?: string) {
  const emitter = new EventEmitter()
  const download = vi.fn(async () => { emitter.emit('update-downloaded', { version: '0.1.7-beta.1' }); return ['fixture'] })
  const install = vi.fn(); const beforeRestart = vi.fn(async () => true)
  const updater = Object.assign(emitter, { checkForUpdates: vi.fn(async () => ({ isUpdateAvailable: true, updateInfo: { version: '0.1.7-beta.1' } })),
    downloadUpdate: download, quitAndInstall: install }) as unknown as AppUpdater
  const coordinator = new DesktopUpdateCoordinator(state => state, beforeRestart, updater, () => true, () => '0.1.6-alpha.2', 'beta', () => enabled, sealedFeedUrl)
  return { coordinator, updater, download, install, beforeRestart }
}

describe('signature-verified background preparation', () => {
  it('uses guarded full-package downloads for the sealed Qianshou feed', () => {
    const f = fixture(true, 'https://qianshousuanli.com/qianshou-desktop/feeds/mac-arm64/beta-mac.yml')
    try { expect(f.updater.disableDifferentialDownload).toBe(true); expect(f.updater.disableWebInstaller).toBe(true) }
    finally { f.coordinator.dispose() }
  })
  it('joins automatic checks, prepares one package and never installs until a separate restart action', async () => {
    const f = fixture(true)
    try {
      await Promise.all([f.coordinator.check(), f.coordinator.check()])
      expect(f.download).toHaveBeenCalledOnce(); expect(f.coordinator.state.phase).toBe('ready')
      expect(f.install).not.toHaveBeenCalled(); expect(f.beforeRestart).not.toHaveBeenCalled()
      expect(f.updater.autoInstallOnAppQuit).toBe(false)
      await f.coordinator.install('0.1.7-beta.1'); expect(f.install).toHaveBeenCalledOnce()
    } finally { f.coordinator.dispose() }
  })
  it('retains an explicit disabled download preference and refuses automatic retries after a failed transfer', async () => {
    const f = fixture(false); const failed = fixture(true)
    try {
      expect((await f.coordinator.check()).phase).toBe('available'); expect(f.download).not.toHaveBeenCalled()
      failed.download.mockRejectedValueOnce(new Error('ERR_UPDATER_INVALID_SIGNATURE'))
      expect((await failed.coordinator.check()).phase).toBe('error')
      await failed.coordinator.check(); expect(failed.download).toHaveBeenCalledOnce(); expect(failed.install).not.toHaveBeenCalled()
    } finally { f.coordinator.dispose(); failed.coordinator.dispose() }
  })
  it('persists the download choice while changing sleep preferences and reloads it after a version restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qianshou-update-choice-'))
    const app = { isPackaged: true, getPath: () => directory, getLoginItemSettings: () => ({ openAtLogin: false, wasOpenedAtLogin: false, status: 'not-found' as const, executableWillLaunchAtLogin: false, launchItems: [] }), setLoginItemSettings: () => {} }
    const blocker = { start: () => 1, stop: () => true }
    const first = new QianshouDevicePreferences(app, blocker, 'darwin')
    const next = new QianshouDevicePreferences(app, blocker, 'darwin')
    try {
      await first.initialize(); await first.set('automaticUpdates', false); await first.set('keepAwake', false)
      expect(JSON.parse(await readFile(join(directory, 'qianshou-device-preferences.json'), 'utf8'))).toMatchObject({ automaticUpdates: false, keepAwake: false })
      await next.initialize(); expect(next.status().automaticUpdates).toBe(false)
      await writeFile(join(directory, 'qianshou-device-preferences.json'), '{bad', 'utf8')
      const invalid = new QianshouDevicePreferences(app, blocker, 'darwin'); await invalid.initialize()
      expect(invalid.status().automaticUpdates).toBe(false); invalid.dispose()
    } finally { first.dispose(); next.dispose(); await rm(directory, { recursive: true, force: true }) }
  })
})
