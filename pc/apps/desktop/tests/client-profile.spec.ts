import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { desktopClientProfile, desktopHostProfileEnvironment } from '../src/client-profile.ts'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function packagedApp(profile: string | undefined): string {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-profile-'))
  directories.push(directory)
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ dshClientProfile: profile }))
  return directory
}

describe('packaged Desktop client identity', () => {
  it('uses build-owned metadata even when the launching shell has another profile', () => {
    expect(desktopClientProfile(packagedApp('qianshou'), { DSH_CLIENT_BUILD_PROFILE: 'official' }, true))
      .toBe('qianshou')
    expect(desktopClientProfile(packagedApp('official'), { DSH_CLIENT_BUILD_PROFILE: 'qianshou' }, true))
      .toBe('official')
  })

  it('fails a packaged app with no profile identity before creating a session', () => {
    expect(() => desktopClientProfile(packagedApp(undefined), {}, true)).toThrow('dshClientProfile')
  })

  it('points only the packaged Qianshou Host at its immutable preset copy', () => {
    const environment = { PATH: '/usr/bin', QIANSHOU_PRESET_ROOT: '/stale/source/tree' }
    const host = desktopHostProfileEnvironment(environment, 'qianshou', '/app/resources')
    expect(host).toEqual({ PATH: '/usr/bin', DSH_CLIENT_BUILD_PROFILE: 'qianshou',
      QIANSHOU_PRESET_ROOT: join('/app/resources', 'qianshou-presets') })
    expect(environment.QIANSHOU_PRESET_ROOT).toBe('/stale/source/tree')
    expect(desktopHostProfileEnvironment(environment, 'official', '/app/resources')).toBe(environment)
    expect(desktopHostProfileEnvironment(environment, 'qianshou', undefined).QIANSHOU_PRESET_ROOT)
      .toBe('/stale/source/tree')
  })
})
