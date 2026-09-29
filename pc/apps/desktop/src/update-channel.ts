/** Immutable release distribution; renderer, login state and ambient environment cannot select a feed. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Public policy names; electron-updater uses latest for the stable channel. */
export type DesktopUpdateChannel = 'nightly' | 'beta' | 'stable'

/** Package-owned channel and distribution, with no credentials or update URL supplied by the UI. */
export interface DesktopUpdateSelection {
  readonly channel: DesktopUpdateChannel
  readonly distribution: 'production' | 'internal-beta'
  readonly feedUrl: string | undefined
}

/**
 * Resolve package metadata; legacy packages keep Nightly and unsigned packages remain disabled by Main.
 * @param manifest - Installed package metadata, read before the updater is constructed.
 * @returns Fixed release selection; malformed new metadata refuses startup.
 */
export function parseDesktopUpdateSelection(manifest: unknown): DesktopUpdateSelection {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) throw new Error('desktop update: invalid package metadata')
  const value = manifest as Record<string, unknown>
  const channel = value.dshDesktopUpdateChannel ?? 'nightly'
  if (channel !== 'nightly' && channel !== 'beta' && channel !== 'stable') throw new Error('desktop update: invalid package channel')
  const distribution = value.dshDesktopDistribution ?? 'production'
  if (distribution !== 'production' && distribution !== 'internal-beta') throw new Error('desktop update: invalid package distribution')
  if (distribution === 'internal-beta' && (channel !== 'beta' || value.dshClientBuildProfile !== 'qianshou'
    || value.dshDesktopAppId !== 'com.qianshou.desktop.internal' || value.dshDesktopInternalBuild !== false)) {
    throw new Error('desktop update: internal beta requires the signed internal product identity')
  }
  let feedUrl: string | undefined
  if (value.dshDesktopUpdateFeedUrl !== undefined) {
    if (typeof value.dshDesktopUpdateFeedUrl !== 'string') throw new Error('desktop update: invalid package feed')
    const url = new URL(value.dshDesktopUpdateFeedUrl)
    const file = channel === 'stable' ? 'latest' : channel
    if (url.origin !== 'https://qianshousuanli.com' || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || !new RegExp('^/qianshou-desktop/feeds/(?:mac-(?:arm64|x64)/' + file + '-mac|win-x64/' + file + ')\\.yml$').test(url.pathname)) {
      throw new Error('desktop update: package feed does not match its Qianshou channel and target')
    }
    feedUrl = url.href
  }
  return { channel, distribution, feedUrl }
}

/**
 * Read immutable packaged settings. Development keeps its legacy test coordinator and no public feed.
 * @param packaged - Electron packaging state.
 * @param appPath - Installed application root.
 * @returns Fixed release selection without reading an environment override.
 */
export function readDesktopUpdateSelection(packaged: boolean, appPath: string): DesktopUpdateSelection {
  return packaged ? parseDesktopUpdateSelection(JSON.parse(readFileSync(join(appPath, 'package.json'), 'utf8')) as unknown)
    : { channel: 'nightly', distribution: 'production', feedUrl: undefined }
}

/**
 * Map the public channel to the exact electron-updater metadata prefix.
 * @param channel - Immutable package channel.
 * @returns Existing generic provider channel name.
 */
export function electronDesktopUpdateChannel(channel: DesktopUpdateChannel): 'nightly' | 'beta' | 'latest' {
  return channel === 'stable' ? 'latest' : channel
}
