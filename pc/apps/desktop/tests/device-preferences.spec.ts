import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QianshouDevicePreferences } from '../src/device-preferences.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(packaged = true, platform: NodeJS.Platform = 'darwin') {
  const root = mkdtempSync(join(tmpdir(), 'qianshou-device-preferences-'))
  roots.push(root)
  let launchAtLogin = false
  const app = {
    isPackaged: packaged,
    getPath: () => root,
    getLoginItemSettings: vi.fn(() => ({ openAtLogin: launchAtLogin, wasOpenedAtLogin: false,
      status: 'not-registered' as const, executableWillLaunchAtLogin: launchAtLogin, launchItems: [] })),
    setLoginItemSettings: vi.fn(({ openAtLogin }: { openAtLogin: boolean }) => { launchAtLogin = openAtLogin }),
  }
  const blocker = { start: vi.fn(() => 17), stop: vi.fn(() => true) }
  const preferences = new QianshouDevicePreferences(app, blocker, platform)
  return { root, app, blocker, preferences }
}

describe('Qianshou device preferences', () => {
  it.each(['darwin', 'win32'] as const)('keeps work alive by default on %s, allows display sleep, and releases on exit', async (platform) => {
    const { preferences, blocker } = fixture(true, platform)
    await preferences.initialize()
    expect(blocker.start).toHaveBeenCalledExactlyOnceWith('prevent-app-suspension')
    expect(preferences.status()).toEqual({ launchAtLogin: false, launchAtLoginAvailable: true, keepAwake: true, automaticUpdates: true })
    preferences.dispose()
    expect(blocker.stop).toHaveBeenCalledExactlyOnceWith(17)
  })

  it('persists an owner opt-out and restores the default only when the file is absent', async () => {
    const first = fixture()
    await first.preferences.initialize()
    await first.preferences.set('keepAwake', false)
    expect(first.blocker.stop).toHaveBeenCalledWith(17)
    expect(JSON.parse(readFileSync(join(first.root, 'qianshou-device-preferences.json'), 'utf8'))).toEqual({ version: 1, keepAwake: false, automaticUpdates: true })
    const secondApp = { ...first.app }
    const secondBlocker = { start: vi.fn(() => 18), stop: vi.fn(() => true) }
    const second = new QianshouDevicePreferences(secondApp, secondBlocker, 'darwin')
    await second.initialize()
    expect(second.status().keepAwake).toBe(false)
    expect(secondBlocker.start).not.toHaveBeenCalled()
    await second.set('keepAwake', true)
    expect(secondBlocker.start).toHaveBeenCalledExactlyOnceWith('prevent-app-suspension')
    second.dispose()
  })

  it('reads launch-at-login from the OS and requires an installed application', async () => {
    const installed = fixture(true, 'win32')
    await installed.preferences.initialize()
    expect((await installed.preferences.set('launchAtLogin', true)).launchAtLogin).toBe(true)
    expect(installed.app.setLoginItemSettings).toHaveBeenCalledExactlyOnceWith({ openAtLogin: true })
    const development = fixture(false)
    await development.preferences.initialize()
    await expect(development.preferences.set('launchAtLogin', true)).rejects.toThrow('requires an installed')
    expect(development.app.setLoginItemSettings).not.toHaveBeenCalled()
    installed.preferences.dispose()
    development.preferences.dispose()
  })

  it('honors a previously saved opt-out before requesting a blocker', async () => {
    const { root, preferences, blocker } = fixture()
    writeFileSync(join(root, 'qianshou-device-preferences.json'), JSON.stringify({ version: 1, keepAwake: false, automaticUpdates: true }))
    await preferences.initialize()
    expect(blocker.start).not.toHaveBeenCalled()
  })
})
