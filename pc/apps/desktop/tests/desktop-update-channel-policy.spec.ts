import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'
import { parseDesktopUpdateSelection } from '../src/update-channel.ts'
import { resolveDesktopAutoUpdateConfig, desktopUpdateMetadataFilename } from '../scripts/desktop-auto-update-environment.mjs'
import { createMacOSAppUpdateConfig, resolveMacOSAppUpdateFeed } from '../scripts/macos-app-update-config.mjs'
import { parseDesktopUpdatePolicy, resolveDesktopPolicyConfig } from '../src/mandatory-update-policy.ts'

describe('sealed beta and stable update selection', () => {
  it.each(['nightly', 'beta', 'stable'] as const)('retains the exact %s platform feed through packaging', (channel) => {
    const update = resolveDesktopAutoUpdateConfig({ DSH_CLIENT_BUILD_PROFILE: 'qianshou', QIANSHOU_DESKTOP_UPDATE_CHANNEL: channel,
      QIANSHOU_DESKTOP_UPDATE_TEST_ORIGIN: 'https://qianshousuanli.com' }, 'darwin', 'arm64')
    const filename = desktopUpdateMetadataFilename('0.1.7-beta.1', 'darwin', channel)
    expect(filename).toBe((channel === 'stable' ? 'latest' : channel) + '-mac.yml')
    const feed = resolveMacOSAppUpdateFeed([{ provider: 'generic', url: update.publicUrl, channel: channel === 'stable' ? 'latest' : channel }])
    expect(createMacOSAppUpdateConfig(feed, 'fixture-cache').channel).toBe(channel === 'stable' ? 'latest' : channel)
    const selection = parseDesktopUpdateSelection({ dshDesktopUpdateChannel: channel,
      dshDesktopUpdateFeedUrl: update.publicUrl + filename })
    expect(selection.channel).toBe(channel)
  })
  it.each(['https://www.qianshousuanli.com', 'https://foreign.example', 'https://qianshousuanli.com:8443'])('rejects the initial foreign package or packaging origin %s', (origin) => {
    expect(() => resolveDesktopAutoUpdateConfig({ DSH_CLIENT_BUILD_PROFILE: 'qianshou',
      QIANSHOU_DESKTOP_UPDATE_TEST_ORIGIN: origin }, 'darwin', 'arm64')).toThrow(/fixed official origin/u)
    expect(() => parseDesktopUpdateSelection({ dshDesktopUpdateChannel: 'beta',
      dshDesktopUpdateFeedUrl: origin + '/qianshou-desktop/feeds/mac-arm64/beta-mac.yml' })).toThrow(/package feed/u)
  })
  it('requires a signed beta marker while retaining the internal product identity', () => {
    const manifest = { dshDesktopDistribution: 'internal-beta', dshDesktopUpdateChannel: 'beta', dshClientBuildProfile: 'qianshou',
      dshDesktopAppId: 'com.qianshou.desktop.internal', dshDesktopInternalBuild: false }
    expect(parseDesktopUpdateSelection(manifest).distribution).toBe('internal-beta')
    expect(() => parseDesktopUpdateSelection({ ...manifest, dshDesktopInternalBuild: true })).toThrow(/signed internal/u)
    expect(() => parseDesktopUpdateSelection({ ...manifest, dshDesktopUpdateChannel: 'stable' })).toThrow(/signed internal/u)
    expect(() => parseDesktopUpdateSelection({ ...manifest, dshDesktopUpdateFeedUrl: 'http://127.0.0.1/beta.yml' })).toThrow(/package feed/u)
  })
  it('builds a signed internal beta configuration with the retained application identity and a sealed feed', () => {
    const env = { DSH_CLIENT_BUILD_PROFILE: 'qianshou', DSH_DESKTOP_APP_ID: 'com.qianshou.desktop.internal',
      DSH_DESKTOP_UNSIGNED: '0', QIANSHOU_DESKTOP_DISTRIBUTION: 'internal-beta', QIANSHOU_DESKTOP_UPDATE_CHANNEL: 'beta',
      QIANSHOU_DESKTOP_UPDATE_TEST_ORIGIN: 'https://qianshousuanli.com', DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://qianshousuanli.com',
      DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Fixture Only (ABCDEFGHIJ)', DSH_DESKTOP_MACOS_TEAM_ID: 'ABCDEFGHIJ',
      APPLE_ID: 'fixture@example.invalid', APPLE_APP_SPECIFIC_PASSWORD: 'fixture-only-not-a-credential', APPLE_TEAM_ID: 'ABCDEFGHIJ' }
    const config = createElectronBuilderConfig(env, 'darwin', 'arm64')
    expect(config.extraMetadata.dshDesktopInternalBuild).toBe(false)
    expect(config.productName).toBe('千手 PC 内测')
    expect(config.mac.forceCodeSigning).toBe(true)
    expect(config.publish?.[0].channel).toBe('beta')
    expect(config.extraMetadata.dshDesktopUpdateFeedUrl).toBe('https://qianshousuanli.com/qianshou-desktop/feeds/mac-arm64/beta-mac.yml')
    expect(parseDesktopUpdateSelection(config.extraMetadata).distribution).toBe('internal-beta')
    expect(() => createElectronBuilderConfig({ ...env, DSH_DESKTOP_UNSIGNED: '1' }, 'darwin', 'arm64')).toThrow(/requires signing/u)
  })
  it('parses the actual Shanghai exact eight-field required fixture and rejects cross-product or stale policy', async () => {
    const fixture = JSON.parse(await readFile(new URL('./fixtures/desktop-update-sh-required.json', import.meta.url), 'utf8'))
    const identity = { platform: 'desktop-mac' as const, arch: 'arm64' as const, version: '0.1.6-alpha.2', bundledDshVersion: '0.1.6-alpha.2',
      bundleId: 'com.qianshou.fixture.desktop', locale: 'zh', channel: 'beta' as const,
      feedUrl: 'https://qianshousuanli.com/qianshou-desktop/feeds/mac-arm64/beta-mac.yml' }
    const config = resolveDesktopPolicyConfig({ origin: 'https://qianshousuanli.com', allowedPageOrigins: ['https://qianshousuanli.com'] })!
    expect(parseDesktopUpdatePolicy(fixture, true, config, identity).blocking).toBe(true)
    for (const patch of [{ bundleId: 'com.deepseek.desktop' }, { currentVersion: '0.1.5' }, { channel: 'stable' },
      { targetVersion: '0.1.6-alpha.2' }, { feedUrl: 'https://evil.example/beta-mac.yml' }, { extra: true }]) {
      const wrong = { ...fixture, data: { ...fixture.data, policy: { ...fixture.data.policy, ...patch } } }
      expect(() => parseDesktopUpdatePolicy(wrong, true, config, identity)).toThrow(/installed release/u)
    }
    expect(() => parseDesktopUpdatePolicy(fixture, false, config, identity)).toThrow(/installed release/u)
  })
})
