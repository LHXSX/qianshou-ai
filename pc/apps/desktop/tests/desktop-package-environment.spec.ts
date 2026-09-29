import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadDesktopInternalMacEnvironment, loadDesktopInternalWindowsEnvironment, loadDesktopPackageEnvironment, validateDesktopPackageEnvironment } from '../scripts/desktop-package-environment.mjs'

const WINDOWS = { platform: 'win32', arch: 'x64' } as const
const MACOS = { platform: 'darwin', arch: 'arm64' } as const
const POLICY = { DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com' }
const RELEASE = { ...POLICY, DSH_DESKTOP_APP_ID: 'com.example.desktop', DOWNLOAD_TEST_ORIGIN: 'https://updates.example.com' }
const MAC_IDENTITY = { DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)', DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234' }

async function withDirectory(action: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-env-'))
  try {
    await action(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('Desktop local packaging configuration', () => {
  it('isolates unsigned Mac diagnostics from ambient release settings and formal identity', () => {
    expect(() => loadDesktopInternalMacEnvironment({})).toThrow(/requires the Qianshou profile/u)
    const diagnostic = loadDesktopInternalMacEnvironment({
      DSH_CLIENT_BUILD_PROFILE: 'qianshou', DSH_DESKTOP_APP_ID: 'com.example.production',
      CSC_LINK: '/private/signing.p12', APPLE_ID: 'private@example.com',
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'production', PATH: '/usr/bin',
    })
    expect(diagnostic).toEqual({ DSH_CLIENT_BUILD_PROFILE: 'qianshou', DSH_CLIENT_TITLE: '千手 PC · 开发版',
      DSH_DESKTOP_APP_ID: 'com.qianshou.desktop.internal', DSH_DESKTOP_UNSIGNED: '1', PATH: '/usr/bin' })
    expect(() => validateDesktopPackageEnvironment(diagnostic, MACOS, { unsigned: true })).not.toThrow()
    expect(() => validateDesktopPackageEnvironment(diagnostic, MACOS)).toThrow(/internal Qianshou identity/u)
  })
  it('isolates unsigned Windows diagnostics from release credentials', () => {
    expect(() => loadDesktopInternalWindowsEnvironment({})).toThrow(/Qianshou profile/u)
    const diagnostic = loadDesktopInternalWindowsEnvironment({
      DSH_CLIENT_BUILD_PROFILE: 'qianshou', DSH_DESKTOP_WINDOWS_TOKEN_PIN: 'private',
      WIN_CSC_LINK: 'private.pfx', PATH: 'build-tools',
    })
    expect(diagnostic).toEqual({ DSH_CLIENT_BUILD_PROFILE: 'qianshou',
      DSH_CLIENT_TITLE: '千手 PC · 开发版', DSH_DESKTOP_APP_ID: 'com.qianshou.desktop.internal',
      DSH_DESKTOP_UNSIGNED: '1', PATH: 'build-tools' })
    expect(() => validateDesktopPackageEnvironment(diagnostic, WINDOWS, { unsigned: true })).not.toThrow()
  })
  it('accepts file-owned Qianshou settings and ignores ambient Qianshou credentials', async () => {
    await withDirectory(async (directory) => {
      await writeFile(join(directory, '.env.windows'), [
        'DSH_DESKTOP_APP_ID=com.qianshou.desktop',
        'QIANSHOU_DESKTOP_UPDATE_TEST_ORIGIN=https://qianshousuanli.com',
        'QIANSHOU_DESKTOP_UPDATE_TEST_COS_BUCKET=qianshou-test',
      ].join('\n'))
      const loaded = loadDesktopPackageEnvironment('win32', {
        DSH_CLIENT_BUILD_PROFILE: 'qianshou',
        QIANSHOU_DESKTOP_UPDATE_TEST_ORIGIN: 'https://stale.example',
        QIANSHOU_DESKTOP_UPDATE_TEST_COS_SECRET_KEY: 'ambient-secret',
      }, directory)
      expect(loaded).toMatchObject({ DSH_CLIENT_BUILD_PROFILE: 'qianshou',
        DSH_DESKTOP_APP_ID: 'com.qianshou.desktop',
        QIANSHOU_DESKTOP_UPDATE_TEST_ORIGIN: 'https://qianshousuanli.com' })
      expect(loaded.QIANSHOU_DESKTOP_UPDATE_TEST_COS_SECRET_KEY).toBeUndefined()
    })
  })

  it('selects the platform file, preserves literal secrets, and excludes stale ambient release settings', async () => {
    await withDirectory(async (directory) => {
      await writeFile(join(directory, '.env.windows'), '\uFEFFDSH_DESKTOP_APP_ID=com.example.windows\r\nDSH_DESKTOP_WINDOWS_TOKEN_PIN=" #!$%&literal "\r\nDSH_DESKTOP_WINDOWS_CER_FILE="keys/public certificate.cer"\r\n')
      await writeFile(join(directory, '.env.macos'), 'DSH_DESKTOP_APP_ID=com.example.mac\nAPPLE_KEYCHAIN_PROFILE=release\nCSC_LINK=keys/signing.p12\nCSC_KEY_PASSWORD=" # literal "\n')
      const parent = {
        PATH: 'build-tools', DSH_DESKTOP_APP_ID: 'com.stale.desktop',
        DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: '{"origin":"https://stale.example.com"}',
        dsh_desktop_mandatory_update_config: 'stale-policy',
        DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://stale.example.com',
        dsh_desktop_mandatory_update_prod_origin: 'https://stale.example.com',
        DSH_DESKTOP_WINDOWS_TOKEN_PIN: 'stale-pin', APPLE_ID: 'stale-apple-id',
        CSC_LINK: 'stale-certificate', DOWNLOAD_TEST_ORIGIN: 'https://stale.example.com',
        dsh_desktop_windows_key_container: 'case-insensitive-stale-container',
      }
      expect(loadDesktopPackageEnvironment('win32', parent, directory)).toEqual({
        PATH: 'build-tools', DSH_DESKTOP_APP_ID: 'com.example.windows',
        DSH_DESKTOP_WINDOWS_TOKEN_PIN: ' #!$%&literal ',
        DSH_DESKTOP_WINDOWS_CER_FILE: join(directory, 'keys', 'public certificate.cer'),
      })
      expect(loadDesktopPackageEnvironment('darwin', parent, directory)).toEqual({
        PATH: 'build-tools', DSH_DESKTOP_APP_ID: 'com.example.mac', APPLE_KEYCHAIN_PROFILE: 'release',
        CSC_LINK: join(directory, 'keys/signing.p12'), CSC_KEY_PASSWORD: ' # literal ',
      })
      expect(parent.DSH_DESKTOP_WINDOWS_TOKEN_PIN).toBe('stale-pin')
      expect(parent.dsh_desktop_mandatory_update_config).toBe('stale-policy')
    })
  })

  it('loads mandatory update origins and options only from the platform file without changing its parent', async () => {
    await withDirectory(async (directory) => {
      const windowsPolicy = JSON.stringify({ intervalMs: 5000, allowedPageOrigins: ['https://download.example.invalid'] })
      const macPolicy = JSON.stringify({ intervalMs: 6000, allowedPageOrigins: ['https://download.example.invalid'] })
      const origins = { DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://test.example.invalid',
        DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: 'https://prod.example.invalid' }
      const lines = Object.entries(origins).map(([key, value]) => `${key}=${value}\n`).join('')
      await writeFile(join(directory, '.env.windows'), `${lines}DSH_DESKTOP_MANDATORY_UPDATE_CONFIG='${windowsPolicy}'\n`)
      await writeFile(join(directory, '.env.macos'), `${lines}DSH_DESKTOP_MANDATORY_UPDATE_CONFIG='${macPolicy}'\n`)
      const parent = { DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: 'stale-policy' }
      expect(loadDesktopPackageEnvironment('win32', parent, directory)).toEqual({ ...origins, DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: windowsPolicy })
      expect(loadDesktopPackageEnvironment('darwin', parent, directory)).toEqual({ ...origins, DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: macPolicy })
      expect(parent).toEqual({ DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: 'stale-policy' })
    })
  })

  it('requires the local file even when ambient configuration exists and rejects other-platform fields', async () => {
    await withDirectory(async (directory) => {
      expect(() => loadDesktopPackageEnvironment('win32', RELEASE, directory)).toThrow(/copy .*\.env.windows.example/u)
      await writeFile(join(directory, '.env.windows'), 'APPLE_APP_SPECIFIC_PASSWORD=secret-sentinel\n')
      expect(() => loadDesktopPackageEnvironment('win32', {}, directory)).toThrow(/unsupported setting APPLE_APP_SPECIFIC_PASSWORD/u)
      expect(() => loadDesktopPackageEnvironment('win32', {}, directory)).not.toThrow(/secret-sentinel/u)
    })
  })

  it('checks application and update configuration before Windows credentials while preserving unsigned and preparation modes', () => {
    expect(() => {
      validateDesktopPackageEnvironment({}, WINDOWS, { unsigned: true })
    }).toThrow(/DSH_DESKTOP_APP_ID/u)
    expect(() => {
      validateDesktopPackageEnvironment({ DSH_DESKTOP_APP_ID: 'invalid' }, WINDOWS)
    }).toThrow(/reverse-DNS/u)
    expect(() => {
      validateDesktopPackageEnvironment({ DSH_DESKTOP_APP_ID: 'com.qianshou.desktop.internal' }, WINDOWS)
    }).toThrow(/reserved for unsigned/u)
    expect(() => {
      validateDesktopPackageEnvironment({ ...POLICY, DSH_DESKTOP_APP_ID: RELEASE.DSH_DESKTOP_APP_ID }, WINDOWS)
    }).toThrow(/DOWNLOAD_TEST_ORIGIN/u)
    expect(() => {
      validateDesktopPackageEnvironment(RELEASE, WINDOWS)
    }).toThrow(/DSH_DESKTOP_WINDOWS_CER_FILE/u)
    expect(() => {
      validateDesktopPackageEnvironment({ ...POLICY, DSH_DESKTOP_APP_ID: RELEASE.DSH_DESKTOP_APP_ID }, WINDOWS, { unsigned: true })
    }).toThrow(/internal Qianshou identity/u)
    expect(() => {
      validateDesktopPackageEnvironment(loadDesktopInternalWindowsEnvironment({ DSH_CLIENT_BUILD_PROFILE: 'qianshou' }), WINDOWS, { unsigned: true })
    }).not.toThrow()
    expect(() => {
      validateDesktopPackageEnvironment({ ...POLICY, DSH_DESKTOP_APP_ID: RELEASE.DSH_DESKTOP_APP_ID }, WINDOWS, { prepareOnly: true })
    }).not.toThrow()
  })

  it('allows only signed internal beta through actual package preflight without skipping credentials', async () => {
    const base = { ...POLICY, DSH_CLIENT_BUILD_PROFILE: 'qianshou', DSH_DESKTOP_APP_ID: 'com.qianshou.desktop.internal',
      QIANSHOU_DESKTOP_DISTRIBUTION: 'internal-beta', QIANSHOU_DESKTOP_UPDATE_CHANNEL: 'beta',
      QIANSHOU_DESKTOP_UPDATE_TEST_ORIGIN: 'https://qianshousuanli.com', DSH_DESKTOP_UNSIGNED: '0' }
    expect(() => validateDesktopPackageEnvironment(base, WINDOWS)).toThrow(/DSH_DESKTOP_WINDOWS_CER_FILE/u)
    for (const patch of [{ DSH_CLIENT_BUILD_PROFILE: 'dsh' }, { QIANSHOU_DESKTOP_DISTRIBUTION: 'production' },
      { QIANSHOU_DESKTOP_UPDATE_CHANNEL: 'stable' }, { DSH_DESKTOP_UNSIGNED: '1' }]) {
      expect(() => validateDesktopPackageEnvironment({ ...base, ...patch }, MACOS)).toThrow(/reserved for unsigned/u)
    }
    await withDirectory(async (directory) => {
      const key = join(directory, 'fixture-only.p12'); await writeFile(key, 'fixture-not-a-certificate')
      const signed = { ...base, ...MAC_IDENTITY, CSC_LINK: key, CSC_KEY_PASSWORD: '', APPLE_KEYCHAIN_PROFILE: 'fixture-profile' }
      expect(() => validateDesktopPackageEnvironment(signed, MACOS)).not.toThrow()
      expect(() => validateDesktopPackageEnvironment({ ...signed, CSC_LINK: 'missing.p12' }, MACOS)).toThrow(/CSC_LINK/u)
      expect(() => validateDesktopPackageEnvironment({ ...signed, APPLE_KEYCHAIN_PROFILE: undefined }, MACOS))
        .toThrow(/macOS packaging requires/u)
    })
  })

  it('rejects incomplete macOS identity and credentials and checks referenced files without contacting Apple', async () => {
    expect(() => {
      validateDesktopPackageEnvironment(RELEASE, MACOS)
    }).toThrow(/DSH_DESKTOP_MACOS_SIGNING_IDENTITY/u)
    expect(() => {
      validateDesktopPackageEnvironment({ ...RELEASE, ...MAC_IDENTITY }, MACOS)
    }).toThrow(/macOS packaging requires/u)
    expect(() => {
      validateDesktopPackageEnvironment({ ...RELEASE, ...MAC_IDENTITY, APPLE_API_KEY: 'missing.p8' }, MACOS)
    }).toThrow(/APPLE_API_KEY_ID/u)
    expect(() => {
      validateDesktopPackageEnvironment({ ...RELEASE, ...MAC_IDENTITY, APPLE_KEYCHAIN_PROFILE: 'release' }, MACOS)
    }).toThrow(/CSC_LINK/u)
    expect(() => {
      validateDesktopPackageEnvironment({ ...RELEASE, ...MAC_IDENTITY, APPLE_KEYCHAIN_PROFILE: 'release', APPLE_API_KEY: '' }, MACOS)
    }).toThrow(/exactly one macOS notarization strategy/u)
    expect(() => {
      validateDesktopPackageEnvironment({ ...RELEASE, ...MAC_IDENTITY, APPLE_ID: 'user@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'fixture', APPLE_TEAM_ID: 'TEAMID1234' }, MACOS)
    }).toThrow(/CSC_LINK/u)
    await withDirectory(async (directory) => {
      const appleApiKey = join(directory, 'AuthKey.p8')
      const environment = { ...RELEASE, ...MAC_IDENTITY, CSC_LINK: appleApiKey, CSC_KEY_PASSWORD: '', APPLE_API_KEY: appleApiKey, APPLE_API_KEY_ID: 'TEST123456', APPLE_API_ISSUER: '11111111-2222-3333-4444-555555555555' }
      expect(() => {
        validateDesktopPackageEnvironment(environment, MACOS)
      }).toThrow(/APPLE_API_KEY must identify a readable local file/u)
      await writeFile(appleApiKey, 'local-file-fixture')
      expect(() => {
        validateDesktopPackageEnvironment(environment, MACOS)
      }).not.toThrow()
      expect(() => {
        validateDesktopPackageEnvironment({ ...environment, CSC_KEY_PASSWORD: undefined }, MACOS)
      }).toThrow(/CSC_KEY_PASSWORD/u)
      expect(() => { validateDesktopPackageEnvironment({ ...environment, CSC_LINK: directory }, MACOS) }).toThrow(/CSC_LINK/u)
      expect(() => { validateDesktopPackageEnvironment({ ...environment, CSC_LINK: 'missing.p12' }, MACOS, { prepareOnly: true }) }).toThrow(/CSC_LINK/u)
      expect(() => {
        validateDesktopPackageEnvironment({ ...RELEASE, ...MAC_IDENTITY, APPLE_KEYCHAIN_PROFILE: 'release', APPLE_KEYCHAIN: directory }, MACOS)
      }).toThrow(/APPLE_KEYCHAIN/u)
    })
  })
})
