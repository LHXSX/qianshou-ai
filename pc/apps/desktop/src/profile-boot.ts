/** Restore the packaged client profile before any shell module reads it. */

import { mkdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { app } from 'electron'
import { readDesktopUpdateSelection } from './update-channel.ts'

/**
 * Only a profile embedded by the packager can override the ambient value.
 * Development and older packages without this field keep their prior behavior.
 */
export function embeddedDesktopBuildProfile(
  isPackaged: boolean,
  appPath: string,
  readText: (path: string) => string = path => readFileSync(path, 'utf8'),
): string | null | undefined {
  if (!isPackaged) return undefined
  try {
    const manifest: unknown = JSON.parse(readText(join(appPath, 'package.json')))
    if (typeof manifest !== 'object' || manifest === null || !('dshClientBuildProfile' in manifest)) return undefined
    const profile = manifest.dshClientBuildProfile
    return profile === 'qianshou' || profile === 'official' || profile === null ? profile : undefined
  } catch { return undefined }
}

/** The internal identity is immutable package metadata, never an ambient switch. */
export function embeddedInternalDesktopBuild(
  isPackaged: boolean,
  platform: NodeJS.Platform,
  profile: string | null | undefined,
  appPath: string,
  readText: (path: string) => string = path => readFileSync(path, 'utf8'),
): boolean {
  if (!isPackaged || (platform !== 'darwin' && platform !== 'win32') || profile !== 'qianshou') return false
  try {
    const manifest: unknown = JSON.parse(readText(join(appPath, 'package.json')))
    if (typeof manifest !== 'object' || manifest === null) return false
    return 'dshDesktopInternalBuild' in manifest && manifest.dshDesktopInternalBuild === true
      && 'dshDesktopAppId' in manifest && manifest.dshDesktopAppId === 'com.qianshou.desktop.internal'
      && 'dshClientBuildProfile' in manifest && manifest.dshClientBuildProfile === 'qianshou'
  } catch { return false }
}

/** Only internal unsigned builds can choose a distinct absolute test profile directory. */
export function internalDesktopUserData(appData: string, testOverride: string | undefined): string {
  const defaultPath = join(appData, 'Qianshou PC Internal')
  if (testOverride === undefined) return defaultPath
  if (!isAbsolute(testOverride) || resolve(testOverride) !== testOverride || testOverride === defaultPath) {
    throw new Error('DSH_DESKTOP_INTERNAL_TEST_USER_DATA must be a distinct absolute normalized path')
  }
  return testOverride
}

const embeddedProfile = embeddedDesktopBuildProfile(app.isPackaged, app.getAppPath())
if (embeddedProfile === null) delete process.env.DSH_CLIENT_BUILD_PROFILE
else if (embeddedProfile !== undefined) process.env.DSH_CLIENT_BUILD_PROFILE = embeddedProfile

if (embeddedInternalDesktopBuild(app.isPackaged, process.platform, embeddedProfile, app.getAppPath())) {
  try {
    const userData = internalDesktopUserData(app.getPath('appData'), process.env.DSH_DESKTOP_INTERNAL_TEST_USER_DATA)
    mkdirSync(userData, { recursive: true, mode: 0o700 })
    app.setPath('userData', userData)
    process.env.DSH_HOME ??= join(userData, 'dsh-home')
  } catch (error) {
    throw new Error('Internal desktop profile isolation failed', { cause: error })
  }
}

if (app.isPackaged && readDesktopUpdateSelection(true, app.getAppPath()).distribution === 'internal-beta') {
  const userData = join(app.getPath('appData'), 'Qianshou PC Internal')
  mkdirSync(userData, { recursive: true, mode: 0o700 })
  app.setPath('userData', userData)
  process.env.DSH_HOME ??= join(userData, 'dsh-home')
}
