import { describe, expect, it } from 'vitest'
import {
  desktopBuildRecordFilename,
  desktopUpdateMetadataFilename,
  desktopUpdateProduct,
  resolveDesktopAutoUpdateConfig,
  resolveDesktopAutoUpdateEnvironment,
  resolveDesktopAutoUpdateTarget,
  resolveDesktopUploadConfig,
} from '../scripts/desktop-auto-update-environment.mjs'

describe('desktop auto-update environment', () => {
  it('separates Qianshou feeds, artifacts, and COS settings from DSH', () => {
    const qianshou = { DSH_CLIENT_BUILD_PROFILE: 'qianshou',
      QIANSHOU_DESKTOP_UPDATE_TEST_ORIGIN: 'https://qianshousuanli.com',
      QIANSHOU_DESKTOP_UPDATE_TEST_COS_BUCKET: 'qianshou-test' }
    expect(desktopUpdateProduct(qianshou)).toEqual({ namespace: 'qianshou-desktop', artifactPrefix: 'qianshou' })
    expect(resolveDesktopAutoUpdateConfig(qianshou, 'darwin', 'arm64')).toEqual({
      environment: 'test', channel: 'nightly', target: 'mac-arm64', origin: 'https://qianshousuanli.com',
      publicUrl: 'https://qianshousuanli.com/qianshou-desktop/feeds/mac-arm64/',
      keyPrefix: 'qianshou-desktop/feeds/mac-arm64',
    })
    expect(resolveDesktopUploadConfig(qianshou, 'darwin', 'arm64')).toMatchObject({
      bucket: 'qianshou-test', secretIdEnvName: 'QIANSHOU_DESKTOP_UPDATE_TEST_COS_SECRET_ID',
      secretKeyEnvName: 'QIANSHOU_DESKTOP_UPDATE_TEST_COS_SECRET_KEY',
    })
    expect(resolveDesktopAutoUpdateConfig({ DSH_CLIENT_BUILD_PROFILE: 'qianshou',
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
      QIANSHOU_DESKTOP_UPDATE_PROD_ORIGIN: 'https://qianshousuanli.com' }, 'win32', 'x64').publicUrl)
      .toBe('https://qianshousuanli.com/qianshou-desktop/feeds/win-x64/')
  })

  it('fails closed when Qianshou has only DSH release settings or a DeepSeek origin', () => {
    expect(() => resolveDesktopAutoUpdateConfig({ DSH_CLIENT_BUILD_PROFILE: 'qianshou',
      DOWNLOAD_TEST_ORIGIN: 'https://download-test.deepseek.com' }, 'darwin', 'arm64'))
      .toThrow(/QIANSHOU_DESKTOP_UPDATE_TEST_ORIGIN/u)
    expect(() => resolveDesktopAutoUpdateConfig({ DSH_CLIENT_BUILD_PROFILE: 'qianshou',
      QIANSHOU_DESKTOP_UPDATE_TEST_ORIGIN: 'https://download.deepseek.com' }, 'darwin', 'arm64'))
      .toThrow(/fixed official origin/u)
    expect(() => resolveDesktopUploadConfig({ DSH_CLIENT_BUILD_PROFILE: 'qianshou',
      QIANSHOU_DESKTOP_UPDATE_TEST_ORIGIN: 'https://qianshousuanli.com',
      DOWNLOAD_TEST_COS_BUCKET: 'dsh-test' }, 'darwin', 'arm64'))
      .toThrow(/QIANSHOU_DESKTOP_UPDATE_TEST_COS_BUCKET/u)
  })

  it('defaults packages and uploads to the test deployment', () => {
    expect(resolveDesktopAutoUpdateEnvironment({})).toBe('test')
    expect(resolveDesktopAutoUpdateConfig({
      DOWNLOAD_TEST_ORIGIN: 'https://desktop-updates.example.com/',
    }, 'darwin', 'arm64')).toEqual({
      environment: 'test', channel: 'nightly',
      target: 'mac-arm64',
      origin: 'https://desktop-updates.example.com',
      publicUrl: 'https://desktop-updates.example.com/dsh-desk/feeds/mac-arm64/',
      keyPrefix: 'dsh-desk/feeds/mac-arm64',
    })
    expect(resolveDesktopUploadConfig({
      DOWNLOAD_TEST_ORIGIN: 'https://desktop-updates.example.com/',
      DOWNLOAD_TEST_COS_BUCKET: 'test-download-bucket',
    }, 'darwin', 'arm64')).toMatchObject({
      bucket: 'test-download-bucket',
      secretIdEnvName: 'DOWNLOAD_TEST_COS_SECRET_ID',
      secretKeyEnvName: 'DOWNLOAD_TEST_COS_SECRET_KEY',
    })
  })

  it('selects the production URL for packages and bucket for uploads', () => {
    expect(resolveDesktopAutoUpdateConfig({
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
    }, 'win32', 'x64')).toMatchObject({
      environment: 'production',
      target: 'win-x64',
      publicUrl: 'https://download.deepseek.com/dsh-desk/feeds/win-x64/',
    })
    expect(resolveDesktopUploadConfig({
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
      DOWNLOAD_PROD_COS_BUCKET: 'production-download-bucket',
    }, 'win32', 'x64')).toMatchObject({
      bucket: 'production-download-bucket',
      secretIdEnvName: 'DOWNLOAD_PROD_COS_SECRET_ID',
      secretKeyEnvName: 'DOWNLOAD_PROD_COS_SECRET_KEY',
    })
  })

  it('requires the selected deployment origin for packages and bucket only for uploads', () => {
    expect(() => resolveDesktopAutoUpdateConfig({}, 'darwin', 'arm64'))
      .toThrow(/DOWNLOAD_TEST_ORIGIN/u)
    expect(resolveDesktopAutoUpdateConfig({
      DOWNLOAD_TEST_ORIGIN: 'https://desktop-updates.example.com',
    }, 'darwin', 'arm64').publicUrl).toContain('/mac-arm64/')
    expect(() => resolveDesktopUploadConfig({
      DOWNLOAD_TEST_ORIGIN: 'https://desktop-updates.example.com',
    }, 'darwin', 'arm64')).toThrow(/DOWNLOAD_TEST_COS_BUCKET/u)
    expect(() => resolveDesktopUploadConfig({
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
    }, 'win32', 'x64')).toThrow(/DOWNLOAD_PROD_COS_BUCKET/u)
  })

  it('rejects a test download URL that is not an HTTPS origin', () => {
    expect(() => resolveDesktopAutoUpdateConfig({
      DOWNLOAD_TEST_ORIGIN: 'https://desktop-updates.example.com/releases',
    }, 'darwin', 'arm64')).toThrow(/HTTPS origin without a path/u)
    expect(() => resolveDesktopAutoUpdateConfig({
      DOWNLOAD_TEST_ORIGIN: 'http://desktop-updates.example.com',
    }, 'darwin', 'arm64')).toThrow(/HTTPS origin/u)
  })

  it('rejects unknown deployments and targets', () => {
    expect(() => resolveDesktopAutoUpdateEnvironment({
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'staging',
    })).toThrow(/test.*production/u)
    expect(() => resolveDesktopAutoUpdateTarget('linux', 'x64')).toThrow(/unsupported target/u)
    expect(() => desktopBuildRecordFilename('linux-x64' as 'mac-arm64')).toThrow(/unsupported target/u)
  })

  it('uses Nightly metadata for stable and prerelease Desktop versions', () => {
    expect(desktopUpdateMetadataFilename('1.2.3', 'darwin')).toBe('nightly-mac.yml')
    expect(desktopUpdateMetadataFilename('1.2.3-alpha.4', 'darwin')).toBe('nightly-mac.yml')
    expect(desktopUpdateMetadataFilename('1.2.3-beta.2', 'win32')).toBe('nightly.yml')
    expect(() => desktopUpdateMetadataFilename('not-semver', 'darwin')).toThrow(/invalid Desktop version/u)
    expect(() => desktopUpdateMetadataFilename('1.2.3', 'linux')).toThrow(/unsupported metadata platform/u)
  })
})
