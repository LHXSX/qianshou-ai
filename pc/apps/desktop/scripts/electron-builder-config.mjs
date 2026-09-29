import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  resolveDesktopAppId,
  resolveMacOSNotarizationEnvironment,
  resolveMacOSSigningEnvironment,
} from './desktop-release-environment.mjs'
import { notarizeMacOSDiskImageArtifact } from './notarize-macos-disk-images.mjs'
import { verifyMacOSSignatureAfterSign } from './verify-macos-signature.mjs'
import {
  createWindowsTokenSigner,
  installWindowsNsisBootstrapSigner,
  resolveWindowsUpdatePublisher,
  scrubWindowsSigningEnvironment,
} from './windows-sign.mjs'
import { desktopUpdateProduct, resolveDesktopAutoUpdateConfig } from './desktop-auto-update-environment.mjs'
import { resolveDesktopPolicyEnvironment } from './desktop-policy-environment.mjs'
import { desktopTargetBuildPaths, resolveDesktopBuildTarget } from './desktop-build-paths.mjs'
import { installWindowsDirectoryInstaller } from './windows-directory-installer.mjs'
import { preserveWindowsRuntimeSignature } from './windows-runtime-signature.mjs'
import {
  resolveMacOSAppUpdateFeed,
  verifyMacOSAppUpdateConfig,
  writeMacOSAppUpdateConfig,
} from './macos-app-update-config.mjs'

/**
 * Create electron-builder configuration from one release environment.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @param {NodeJS.Platform} hostPlatform - Build-host platform used when no explicit target is present.
 * @param {string} hostArch - Build-host architecture used when no explicit target is present.
 * @param {string | undefined} preparedRuntime - Verified private dsh tree for installed-update qualification; ordinary releases use the target tree.
 * @returns {object} electron-builder configuration.
 */
export function createElectronBuilderConfig(
  env = process.env,
  hostPlatform = process.platform,
  hostArch = process.arch,
  preparedRuntime = undefined,
) {
  const appId = resolveDesktopAppId(env)
  const targetPlatform = env.DSH_DESKTOP_TARGET_PLATFORM
  const resolvedPlatform = targetPlatform ?? hostPlatform
  const resolvedArch = env.DSH_DESKTOP_TARGET_ARCH ?? hostArch
  if (env.DSH_DESKTOP_UNSIGNED !== undefined && !['0', '1'].includes(env.DSH_DESKTOP_UNSIGNED)) {
    throw new Error('desktop package: DSH_DESKTOP_UNSIGNED must be 0 or 1')
  }
  const distribution = env.QIANSHOU_DESKTOP_DISTRIBUTION ?? 'production'
  if (!['production', 'internal-beta'].includes(distribution)) throw new Error('desktop package: invalid QIANSHOU_DESKTOP_DISTRIBUTION')
  const unsigned = env.DSH_DESKTOP_UNSIGNED === '1'
  const policy = unsigned ? undefined : resolveDesktopPolicyEnvironment(env)
  const qianshou = env.DSH_CLIENT_BUILD_PROFILE === 'qianshou'
  if (qianshou && unsigned && appId !== 'com.qianshou.desktop.internal') {
    throw new Error('desktop package: unsigned Qianshou builds require the internal identity')
  }
  if (unsigned && !['win32', 'darwin'].includes(resolvedPlatform)) {
    throw new Error('desktop package: unsigned builds require Windows or macOS')
  }
  const packagesMacOS = targetPlatform === 'darwin' || (targetPlatform === undefined && hostPlatform === 'darwin')
  const packagesWindows = resolvedPlatform === 'win32'
  if (resolvedPlatform === 'win32') installWindowsDirectoryInstaller()
  const macOSSigning = packagesMacOS && !unsigned ? resolveMacOSSigningEnvironment(env) : undefined
  if (packagesMacOS && !unsigned) resolveMacOSNotarizationEnvironment(env)
  const buildPaths = desktopTargetBuildPaths(resolveDesktopBuildTarget(env, hostPlatform, hostArch), env)
  let primaryRuntimeDestination
  const windowsSigner = packagesWindows && !unsigned
    ? createWindowsTokenSigner({
        certificateFile: env.DSH_DESKTOP_WINDOWS_CER_FILE,
        signTool: env.DSH_DESKTOP_WINDOWS_SIGNTOOL,
        tokenPin: env.DSH_DESKTOP_WINDOWS_TOKEN_PIN,
        keyContainer: env.DSH_DESKTOP_WINDOWS_KEY_CONTAINER,
        preserveSignature: async path => primaryRuntimeDestination === undefined ? false : preserveWindowsRuntimeSignature(path, {
          sourceRoot: join(buildPaths.runtime, 'primary-runtime'),
          destinationRoot: primaryRuntimeDestination,
          runDirectory: env.DSH_DESKTOP_PACKAGING_RUN_DIR,
        }),
      })
    : undefined
  if (windowsSigner !== undefined) {
    installWindowsNsisBootstrapSigner({ sign: windowsSigner })
  }
  const update = unsigned ? undefined : resolveDesktopAutoUpdateConfig(env, resolvedPlatform, resolvedArch)
  if (distribution === 'internal-beta' && (!qianshou || unsigned || appId !== 'com.qianshou.desktop.internal' || update.channel !== 'beta')) {
    throw new Error('desktop package: internal beta requires signing, the internal app ID and beta channel')
  }
  if (qianshou && !unsigned && appId === 'com.qianshou.desktop.internal' && distribution !== 'internal-beta') {
    throw new Error('desktop package: signed internal identity requires explicit internal-beta distribution')
  }
  if (preparedRuntime !== undefined) buildPaths.dsh = preparedRuntime
  return {
    appId,
    // Keep both package metadata keys while installed clients move to the strict profile reader.
    extraMetadata: {
      dshDesktopAppId: appId,
      dshMandatoryUpdatePolicy: policy,
      dshClientBuildProfile: env.DSH_CLIENT_BUILD_PROFILE ?? null,
      dshClientProfile: qianshou ? 'qianshou' : 'official',
      dshDesktopInternalBuild: qianshou && unsigned,
      dshDesktopDistribution: distribution,
      dshDesktopUpdateChannel: update?.channel ?? 'nightly',
      dshDesktopUpdateFeedUrl: update === undefined || !qianshou ? undefined : update.publicUrl + (update.channel === 'stable' ? 'latest' : update.channel) + (resolvedPlatform === 'darwin' ? '-mac' : '') + '.yml',
    },
    productName: qianshou ? unsigned || distribution === 'internal-beta' ? '千手 PC 内测' : '千手' : 'DeepSeek Harness',
    artifactName: `${desktopUpdateProduct(env).artifactPrefix}-\${version}-\${os}-\${arch}.\${ext}`,
    directories: { output: unsigned ? join(buildPaths.root, 'unsigned-artifacts') : buildPaths.artifacts },
    asar: true,
    electronDist: buildPaths.electron,
    electronFuses: { runAsNode: true },
    beforeBuild: async () => {
      if (resolvedPlatform !== 'win32') return true
      await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        fileURLToPath(new URL('./prepare-windows-installer.ps1', import.meta.url)),
        '-OutputDirectory', join(buildPaths.root, 'installer-ui'),
        '-BrandProfile', env.DSH_CLIENT_BUILD_PROFILE === 'qianshou' ? 'qianshou' : 'official'], {
        env: scrubWindowsSigningEnvironment(env), windowsHide: true,
      })
      if (windowsSigner !== undefined) {
        await windowsSigner({ path: join(buildPaths.root, 'installer-ui', 'window-frame.dll'), hash: 'sha256', isNest: false })
      }
      // A falsy result tells electron-builder to omit its production node_modules collection.
      return true
    },
    files: [
      'lib/main.js',
      'lib/preload-app.cjs',
      'lib/preload-mandatory.cjs',
      'lib/preload-update-dialog.cjs',
      'renderer/**/*',
      'package.json',
      { from: buildPaths.dsh, to: 'dsh', filter: ['**/*'] },
      // electron-builder excludes a source directory's root node_modules.
      { from: join(buildPaths.dsh, 'node_modules'), to: 'dsh/node_modules', filter: ['**/*'] },
    ],
    asarUnpack: [
      '**/*.{node,dylib,dll,so,exe}',
      '**/*.so.*',
      '**/spawn-helper',
      '**/@vscode/ripgrep/bin/rg',
      // The byte-pinned H3 programs are executed by the owner's external Python.
      '**/@deepseek-ai/dsh-host-node-contributor/runtime/h3/*.py',
      '**/@deepseek-ai/dsh-host-node-contributor/runtime/h3-v2/*.py',
    ],
    extraResources: [
      { from: buildPaths.runtime, to: 'runtime' },
      { from: fileURLToPath(new URL(qianshou ? '../resources/icon-windows.png' : '../resources/deepseek/icon-windows.png', import.meta.url)), to: 'icon.png' },
      ...(qianshou ? [
        { from: fileURLToPath(new URL('../resources/qianshou-tray-macosTemplate.png', import.meta.url)), to: 'qianshou-tray-macosTemplate.png' },
        { from: fileURLToPath(new URL('../resources/qianshou-tray-macosTemplate@2x.png', import.meta.url)), to: 'qianshou-tray-macosTemplate@2x.png' },
        { from: fileURLToPath(new URL('../resources/qianshou-tray-windows.png', import.meta.url)), to: 'qianshou-tray-windows.png' },
        { from: fileURLToPath(new URL('../../../qianshou/settings.yaml', import.meta.url)), to: 'qianshou/settings.yaml' },
        { from: fileURLToPath(new URL('../../../qianshou/cordis.patch.yml', import.meta.url)), to: 'qianshou/cordis.patch.yml' },
        { from: fileURLToPath(new URL('../../../qianshou/presets', import.meta.url)), to: 'qianshou/presets' },
      ] : []),
      // The Qianshou capability Host reads the fixed contract copy from disk at
      // plugin load; main.ts points QIANSHOU_CONTRACTS_DIR at this destination.
      { from: fileURLToPath(new URL('../../../contracts/v1', import.meta.url)), to: 'contracts/v1' },
      { from: fileURLToPath(new URL('../../../contracts/v2', import.meta.url)), to: 'contracts/v2' },
      ...(env.DSH_CLIENT_BUILD_PROFILE === 'qianshou' ? [
        { from: fileURLToPath(new URL('../resources/tray-icon.png', import.meta.url)), to: 'tray-icon.png' },
        { from: fileURLToPath(new URL('../resources/tray-icon-color.png', import.meta.url)), to: 'tray-icon-color.png' },
        { from: fileURLToPath(new URL('../../../qianshou/presets/qianshou-ceo', import.meta.url)),
          to: 'qianshou-presets/qianshou-ceo' },
        { from: fileURLToPath(new URL('../../../qianshou/presets/qianshou-skill-creator', import.meta.url)),
          to: 'qianshou-presets/qianshou-skill-creator' },
        { from: fileURLToPath(new URL('../../../qianshou/presets/qianshou-call', import.meta.url)),
          to: 'qianshou-presets/qianshou-call' },
      ] : []),
    ],
    mac: {
      ...(qianshou ? {
        extendInfo: { NSMicrophoneUsageDescription: '千手仅在你主动按住语音按钮时使用麦克风，将声音转为文字。' },
        entitlements: fileURLToPath(new URL('./qianshou-entitlements.plist', import.meta.url)),
        entitlementsInherit: fileURLToPath(new URL('./qianshou-entitlements.plist', import.meta.url)),
      } : {}),
      icon: fileURLToPath(new URL(env.DSH_CLIENT_BUILD_PROFILE === 'qianshou'
        ? '../resources/icon-macos.png' : '../resources/deepseek/icon-macos.png', import.meta.url)),
      category: 'public.app-category.developer-tools',
      identity: unsigned ? null : macOSSigning?.signingIdentity,
      forceCodeSigning: !unsigned,
      hardenedRuntime: true,
      // ASAR-unpacked native runtime files are pre-signed; PAK resources are sealed by their enclosing bundle.
      signIgnore: ['/Contents/Resources/app\\.asar\\.unpacked/dsh(?:/|$)', '/Contents/Resources/runtime/primary-runtime(?:/|$)', '\\.pak$'],
      notarize: !unsigned,
      target: unsigned ? ['dmg'] : ['dmg', 'zip'],
    },
    dmg: {
      sign: !unsigned,
      writeUpdateInfo: false,
    },
    beforePack: async context => {
      if (windowsSigner !== undefined) primaryRuntimeDestination = join(context.appOutDir, 'resources', 'runtime', 'primary-runtime')
      if (policy === undefined) return
      const { resolveDesktopPolicyConfig } = await import('../lib/types/mandatory-update-policy.js')
      resolveDesktopPolicyConfig(policy)
    },
    afterPack: async context => {
      const { verifyDesktopRuntime, writeDesktopRuntime } = await import('../lib/types/runtime-tree.js')
      const resourcesDir = context.packager.getResourcesDir(context.appOutDir)
      if (resolvedPlatform === 'darwin' && update !== undefined) {
        await writeMacOSAppUpdateConfig(resourcesDir, resolveMacOSAppUpdateFeed(context.packager.config.publish),
          context.packager.appInfo.updaterCacheDirName)
      }
      if (resolvedPlatform === 'win32' && !unsigned) {
        // Windows signs copied executable resources before afterPack runs.
        const prepared = await verifyDesktopRuntime(buildPaths.dsh,
          context.packager.appInfo.version, { platform: resolvedPlatform, arch: resolvedArch })
        writeDesktopRuntime(buildPaths.dsh, prepared.release, prepared.sharedPackages.map(entry => entry.name),
          { platform: resolvedPlatform, arch: resolvedArch })
      }
      await verifyDesktopRuntime(buildPaths.dsh,
        context.packager.appInfo.version, { platform: resolvedPlatform, arch: resolvedArch })
    },
    afterSign: async context => {
      if (context.electronPlatformName !== 'darwin' || unsigned) return
      const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
      if (update !== undefined) {
        await verifyMacOSAppUpdateConfig(appPath, resolveMacOSAppUpdateFeed(context.packager.config.publish),
          context.packager.appInfo.updaterCacheDirName)
      }
      verifyMacOSSignatureAfterSign(context, macOSSigning ?? resolveMacOSSigningEnvironment(env))
    },
    artifactBuildCompleted: artifact => {
      if (unsigned || !artifact.file.endsWith('.dmg')) return
      return notarizeMacOSDiskImageArtifact(
        artifact,
        env,
        macOSSigning ?? resolveMacOSSigningEnvironment(env),
      )
    },
    win: {
      icon: fileURLToPath(new URL(env.DSH_CLIENT_BUILD_PROFILE === 'qianshou'
        ? '../resources/icon-windows.png' : '../resources/deepseek/icon-windows.png', import.meta.url)),
      forceCodeSigning: !unsigned,
      signtoolOptions: {
        sign: windowsSigner,
        publisherName: windowsSigner === undefined ? undefined : resolveWindowsUpdatePublisher(env.DSH_DESKTOP_WINDOWS_CER_FILE),
        signingHashAlgorithms: ['sha256'],
      },
      target: ['nsis'],
    },
    linux: {
      category: 'Development',
      target: ['AppImage'],
    },
    nsis: {
      installerSidebar: join(buildPaths.root, 'installer-ui', 'uninstaller-sidebar.bmp'),
      uninstallerSidebar: join(buildPaths.root, 'installer-ui', 'uninstaller-sidebar.bmp'),
      include: fileURLToPath(new URL('./installer.nsh', import.meta.url)),
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      allowToChangeInstallationDirectory: false,
      installerLanguages: ['en_US', 'zh_CN'],
      differentialPackage: true,
    },
    detectUpdateChannel: false,
    publish: update === undefined ? null : [{ provider: 'generic', url: update.publicUrl, channel: update.channel === 'stable' ? 'latest' : update.channel }],
  }
}
