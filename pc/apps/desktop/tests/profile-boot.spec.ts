import { describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => 'development-app' } }))

import { embeddedDesktopBuildProfile, embeddedInternalDesktopBuild, internalDesktopUserData } from '../src/profile-boot.ts'

describe('packaged desktop build profile', () => {
  it.each(['qianshou', 'official', null] as const)('restores embedded %s', (profile) => {
    expect(embeddedDesktopBuildProfile(true, 'installed-app', () => JSON.stringify({ dshClientBuildProfile: profile })))
      .toBe(profile)
  })

  it('keeps development and pre-metadata packages compatible', () => {
    expect(embeddedDesktopBuildProfile(false, 'development-app', () => { throw new Error('must not read') })).toBeUndefined()
    expect(embeddedDesktopBuildProfile(true, 'old-app', () => '{}')).toBeUndefined()
    expect(embeddedDesktopBuildProfile(true, 'damaged-app', () => '{')).toBeUndefined()
    expect(embeddedDesktopBuildProfile(true, 'unknown-app', () => '{"dshClientBuildProfile":"other"}')).toBeUndefined()
  })

  it.each(['darwin', 'win32'] as const)('isolates only the embedded internal Qianshou identity on %s', (platform) => {
    const manifest = JSON.stringify({ dshClientBuildProfile: 'qianshou',
      dshDesktopAppId: 'com.qianshou.desktop.internal', dshDesktopInternalBuild: true })
    expect(embeddedInternalDesktopBuild(true, platform, 'qianshou', 'installed-app', () => manifest)).toBe(true)
    expect(embeddedInternalDesktopBuild(false, platform, 'qianshou', 'installed-app', () => manifest)).toBe(false)
    expect(embeddedInternalDesktopBuild(true, platform, 'official', 'installed-app', () => manifest)).toBe(false)
    expect(embeddedInternalDesktopBuild(true, platform, 'qianshou', 'installed-app', () => '{}')).toBe(false)
    expect(embeddedInternalDesktopBuild(true, platform, 'qianshou', 'installed-app', () => '{')).toBe(false)
    expect(embeddedInternalDesktopBuild(true, platform, 'qianshou', 'installed-app', () =>
      JSON.stringify({ dshClientBuildProfile: 'qianshou', dshDesktopAppId: 'com.qianshou.desktop', dshDesktopInternalBuild: true }))).toBe(false)
  })

  it('accepts only a distinct absolute test profile path', () => {
    const appData = join(tmpdir(), 'qianshou-profile-test')
    const defaultPath = join(appData, 'Qianshou PC Internal')
    const testPath = join(appData, 'r12-isolated-user-data')
    expect(internalDesktopUserData(appData, undefined)).toBe(defaultPath)
    expect(internalDesktopUserData(appData, testPath)).toBe(testPath)
    expect(() => internalDesktopUserData(appData, 'relative-profile')).toThrow('distinct absolute normalized path')
    expect(() => internalDesktopUserData(appData, defaultPath)).toThrow('distinct absolute normalized path')
    expect(() => internalDesktopUserData(appData, '')).toThrow('distinct absolute normalized path')
  })
})
