import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { Arch, Platform } from 'electron-builder'
import { Packager } from 'app-builder-lib'
import { FileMatcher } from 'app-builder-lib/out/fileMatcher'
import { describe, expect, it, vi } from 'vitest'

const { execute } = vi.hoisted(() => ({ execute: vi.fn(async () => undefined) }))
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  return { ...original, execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }) }
})

describe('installer preparation preserves application dependencies', () => {
  it('keeps the internal Windows NSIS identity, payload, and output separate from release', async () => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const config = createElectronBuilderConfig({
      DSH_CLIENT_BUILD_PROFILE: 'qianshou', DSH_DESKTOP_APP_ID: 'com.qianshou.desktop.internal',
      DSH_DESKTOP_TARGET_PLATFORM: 'win32', DSH_DESKTOP_TARGET_ARCH: 'x64', DSH_DESKTOP_UNSIGNED: '1',
    }, 'win32', 'x64')
    expect(config.appId).toBe('com.qianshou.desktop.internal')
    expect(config.productName).toBe('千手 PC 内测')
    expect(config.extraMetadata).toMatchObject({ dshClientBuildProfile: 'qianshou', dshDesktopInternalBuild: true })
    expect(config.directories.output).toContain(join('win-x64-internal-unsigned', 'unsigned-artifacts'))
    expect(config.win.target).toEqual(['nsis'])
    expect(config.win.forceCodeSigning).toBe(false)
    expect(config.win.signtoolOptions.sign).toBeUndefined()
    expect(config.publish).toBeNull()
    expect(config.extraResources.find(resource => resource.to === 'qianshou-tray-windows.png')).toBeDefined()
    const installerInclude = readFileSync(new URL('../scripts/installer.nsh', import.meta.url), 'utf8')
    expect(installerInclude).toContain('win-x64-internal-unsigned\\installer-ui')
  })

  it('makes an unsigned Mac diagnostic DMG without notarization or update publishing', async () => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const config = createElectronBuilderConfig({ DSH_CLIENT_BUILD_PROFILE: 'qianshou',
      DSH_DESKTOP_APP_ID: 'com.qianshou.desktop.internal', DSH_DESKTOP_UNSIGNED: '1',
      DSH_DESKTOP_TARGET_PLATFORM: 'darwin', DSH_DESKTOP_TARGET_ARCH: 'arm64' }, 'darwin', 'arm64')
    expect(config.productName).toBe('千手 PC 内测')
    expect(config.mac).toMatchObject({ identity: null, forceCodeSigning: false, notarize: false, target: ['dmg'] })
    expect(config.dmg.sign).toBe(false)
    expect(config.publish).toBeNull()
    expect(config.directories.output).toContain('mac-arm64-internal-unsigned')
    expect(config.extraMetadata).toMatchObject({ dshClientProfile: 'qianshou', dshDesktopInternalBuild: true })
  })
  it.each(['win32', 'darwin'] as const)('rejects a missing production policy before signing on %s', async (platform) => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    expect(() => createElectronBuilderConfig({ DSH_DESKTOP_APP_ID: 'com.example.installer',
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://harness-test.deepseek.com',
    }, platform, 'x64')).toThrow('DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN')
  })
  it.each(['win32', 'darwin'] as const)('keeps electron-builder responsible for node_modules on %s', async (platform) => {
    execute.mockClear()
    const env = {
      DSH_DESKTOP_APP_ID: 'com.example.installer',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
      DSH_DESKTOP_TARGET_PLATFORM: platform,
      DSH_DESKTOP_TARGET_ARCH: 'x64',
      DSH_DESKTOP_UNSIGNED: platform === 'win32' ? '1' : '0',
      DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)',
      DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
      APPLE_KEYCHAIN_PROFILE: 'installer-test',
      DOWNLOAD_TEST_ORIGIN: 'https://desktop-updates.example.com',
    }
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
    try {
      const { createElectronBuilderConfig } = await import('../electron-builder.config.mjs')
      const config = createElectronBuilderConfig(env, platform, 'x64')
      expect(config.mac).not.toHaveProperty('extendInfo.NSMicrophoneUsageDescription')
      expect(() => createElectronBuilderConfig({ ...env, DSH_CLIENT_BUILD_PROFILE: 'qianshou',
        DSH_DESKTOP_APP_ID: 'com.deepseek.harness',
        QIANSHOU_DESKTOP_UPDATE_TEST_ORIGIN: 'https://updates.qianshou.example' }, platform, 'x64'))
        .toThrow(/must identify Qianshou/u)
      const voiceConfig = createElectronBuilderConfig({ ...env, DSH_CLIENT_BUILD_PROFILE: 'qianshou',
        DSH_DESKTOP_APP_ID: platform === 'win32' ? 'com.qianshou.desktop.internal' : 'com.qianshou.desktop',
        QIANSHOU_DESKTOP_UPDATE_TEST_ORIGIN: 'https://updates.qianshou.example' }, platform, 'x64')
      expect(voiceConfig.artifactName).toBe('qianshou-${version}-${os}-${arch}.${ext}')
      expect(voiceConfig.productName).toBe(platform === 'win32' ? '千手 PC 内测' : '千手')
      expect(voiceConfig.extraMetadata.dshClientBuildProfile).toBe('qianshou')
      expect(config.extraMetadata.dshClientBuildProfile).toBeNull()
      expect(voiceConfig.mac.icon).toContain('icon-macos.png')
      expect(voiceConfig.win.icon).toContain('icon-windows.png')
      expect(voiceConfig.extraResources.find(resource => resource.to === 'icon.png')?.from).toContain('icon-windows.png')
      for (const name of ['qianshou-tray-macosTemplate.png', 'qianshou-tray-macosTemplate@2x.png', 'qianshou-tray-windows.png']) {
        const resource = voiceConfig.extraResources.find(entry => entry.to === name)
        expect(resource).toBeDefined()
        expect(readFileSync(resource!.from).length).toBeGreaterThan(100)
      }
      for (const name of ['settings.yaml', 'cordis.patch.yml']) {
        const resource = voiceConfig.extraResources.find(entry => entry.to === `qianshou/${name}`)
        expect(resource).toBeDefined()
        expect(readFileSync(resource!.from, 'utf8').length).toBeGreaterThan(100)
      }
      const presets = voiceConfig.extraResources.find(entry => entry.to === 'qianshou/presets')
      expect(presets).toBeDefined()
      expect(readdirSync(presets!.from).sort()).toEqual(['qianshou-call', 'qianshou-ceo', 'qianshou-plugin-creator', 'qianshou-skill-creator'])
      expect(config.extraResources.find(entry => entry.to === 'qianshou/settings.yaml')).toBeUndefined()
      expect(voiceConfig.extraMetadata.dshClientProfile).toBe('qianshou')
      expect(config.extraMetadata.dshClientProfile).toBe('official')
      const ceoPreset = voiceConfig.extraResources.find(resource => resource.to === 'qianshou-presets/qianshou-ceo')
      const creatorPreset = voiceConfig.extraResources.find(resource => resource.to === 'qianshou-presets/qianshou-skill-creator')
      const callingPreset = voiceConfig.extraResources.find(resource => resource.to === 'qianshou-presets/qianshou-call')
      expect(ceoPreset).toBeDefined()
      expect(creatorPreset).toBeDefined()
      expect(callingPreset).toBeDefined()
      expect(readFileSync(join(ceoPreset!.from, 'preset.yml'), 'utf8'))
        .toContain('CEO 模式')
      expect(readFileSync(join(creatorPreset!.from, 'preset.yml'), 'utf8'))
        .toContain('name: 技能助手')
      expect(readFileSync(join(callingPreset!.from, 'preset.yml'), 'utf8'))
        .toContain('name: 调用模式')
      expect(config.extraResources.some(resource => resource.to.startsWith('qianshou-presets/'))).toBe(false)
      const trayIcon = voiceConfig.extraResources.find(resource => resource.to === 'tray-icon.png')
      expect(trayIcon).toBeDefined()
      expect(readFileSync(trayIcon!.from)).toEqual(readFileSync(new URL('../resources/tray-icon.png', import.meta.url)))
      expect(config.extraResources.some(resource => resource.to === 'tray-icon.png')).toBe(false)
      const trayColorIcon = voiceConfig.extraResources.find(resource => resource.to === 'tray-icon-color.png')
      expect(trayColorIcon).toBeDefined()
      expect(readFileSync(trayColorIcon!.from)).toEqual(readFileSync(new URL('../resources/tray-icon-color.png', import.meta.url)))
      expect(config.extraResources.some(resource => resource.to === 'tray-icon-color.png')).toBe(false)
      const favicon = voiceConfig.extraResources.find(resource => resource.to === 'favicon.svg')
      expect(favicon).toBeUndefined()
      expect(config.extraResources.some(resource => resource.to === 'favicon.svg')).toBe(false)
      if (platform === 'darwin') expect(voiceConfig.publish?.[0]?.url).toBe('https://updates.qianshou.example/qianshou-desktop/feeds/mac-x64/')
      expect(voiceConfig.mac.extendInfo?.NSMicrophoneUsageDescription).toContain('麦克风')
      const entitlements = readFileSync(voiceConfig.mac.entitlements!, 'utf8')
      expect(entitlements).toContain('com.apple.security.device.audio-input')
      expect(entitlements).toContain('com.apple.security.cs.allow-jit')
      expect(entitlements).not.toContain('com.apple.security.device.camera')
      expect(voiceConfig.mac.entitlementsInherit).toBe(voiceConfig.mac.entitlements)
      const aboutIcon = config.extraResources.find(resource => resource.to === 'icon.png')
      expect(aboutIcon).toBeDefined()
      expect(readFileSync(aboutIcon!.from)).toEqual(readFileSync(new URL('../resources/deepseek/icon-windows.png', import.meta.url)))
      const qianshouAboutIcon = voiceConfig.extraResources.find(resource => resource.to === 'icon.png')
      expect(readFileSync(qianshouAboutIcon!.from)).toEqual(readFileSync(new URL('../resources/icon-windows.png', import.meta.url)))
      expect(readFileSync((config.mac as unknown as { icon: string }).icon))
        .toEqual(readFileSync(new URL('../resources/deepseek/icon-macos.png', import.meta.url)))
      expect(readFileSync((voiceConfig.mac as unknown as { icon: string }).icon))
        .toEqual(readFileSync(new URL('../resources/icon-macos.png', import.meta.url)))
      const contracts = config.extraResources.find(resource => resource.to === 'contracts/v1')
      expect(contracts).toBeDefined()
      for (const contract of ['capabilities.registry.json', 'intent.schema.json']) {
        expect(readFileSync(join(contracts!.from, contract))).toEqual(
          readFileSync(new URL(`../../../contracts/v1/${contract}`, import.meta.url)))
      }
      const nativeContracts = config.extraResources.find(resource => resource.to === 'contracts/v2')
      expect(nativeContracts).toBeDefined()
      expect(readFileSync(join(nativeContracts!.from, 'native-h3-binding.schema.json')))
        .toEqual(readFileSync(new URL('../../../contracts/v2/native-h3-binding.schema.json', import.meta.url)))
      // Use the packager's real matcher: externally executed pinned programs must
      // survive ASAR sealing, while private configuration and other Python stay sealed.
      const appRoot = join(tmpdir(), 'h3-packager-app')
      const filter = new FileMatcher(appRoot, appRoot, pattern => pattern, [...config.asarUnpack]).createFilter()
      for (const generation of ['h3', 'h3-v2']) {
        for (const filename of ['video_generate.py', 'h3_runtime.py', 'owner_self_test.py']) {
          const source = new URL(`../../../packages/host/node-contributor/runtime/${generation}/${filename}`, import.meta.url)
          const target = join(appRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-host-node-contributor', 'runtime', generation, filename)
          expect(filter(target, statSync(source))).toBe(true)
        }
        const regularFile = statSync(new URL('../../../packages/host/node-contributor/package.json', import.meta.url))
        expect(filter(join(appRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-host-node-contributor',
          'runtime', generation, 'owner.config.json'), regularFile)).toBe(false)
      }
      expect(filter(join(appRoot, 'dsh', 'node_modules', 'other-plugin', 'runtime', 'execute.py'),
        statSync(new URL('../../../packages/host/node-contributor/runtime/h3-v2/video_generate.py', import.meta.url)))).toBe(false)
      const packager = new Packager({ projectDir: tmpdir() })
      // A foreign source-build target avoids rebuilding modules; the real dependency ownership decision still runs.
      Object.defineProperties(packager, {
        config: { value: { beforeBuild: config.beforeBuild, buildDependenciesFromSource: true } },
        framework: { value: { isNpmRebuildRequired: true, version: '42.0.0' } },
        appInfo: { value: { type: 'module' } },
      })
      vi.spyOn(packager, 'getWorkspaceRoot').mockResolvedValue(tmpdir())
      await packager.installAppDependencies(process.platform === 'win32' ? Platform.LINUX : Platform.WINDOWS, Arch.x64)
      expect(packager.areNodeModulesHandledExternally).toBe(false)
      expect(execute).toHaveBeenCalledTimes(platform === 'win32' ? 1 : 0)
    } finally {
      vi.unstubAllEnvs()
      vi.restoreAllMocks()
    }
  }, 20_000)
})
