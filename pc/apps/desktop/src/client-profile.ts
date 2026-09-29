/** Product identity and immutable preset location for a packaged Desktop Host. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type DesktopClientProfile = 'official' | 'qianshou'

/** Resolve the product from build-owned package metadata, not the end user's shell. */
export function desktopClientProfile(
  appPath: string,
  environment: NodeJS.ProcessEnv,
  packaged: boolean,
): DesktopClientProfile {
  if (!packaged) return environment.DSH_CLIENT_BUILD_PROFILE === 'qianshou' ? 'qianshou' : 'official'
  const manifest = JSON.parse(readFileSync(join(appPath, 'package.json'), 'utf8')) as {
    dshClientProfile?: unknown
  }
  if (manifest.dshClientProfile === 'qianshou' || manifest.dshClientProfile === 'official') {
    return manifest.dshClientProfile
  }
  throw new Error('desktop product: packaged application has no valid dshClientProfile')
}

/** Give the Host the product's packaged preset root without changing process.env. */
export function desktopHostProfileEnvironment(
  environment: NodeJS.ProcessEnv,
  profile: DesktopClientProfile,
  resourcesPath: string | undefined,
): NodeJS.ProcessEnv {
  if (profile !== 'qianshou') return environment
  if (resourcesPath === undefined) return { ...environment, DSH_CLIENT_BUILD_PROFILE: 'qianshou' }
  return {
    ...environment,
    DSH_CLIENT_BUILD_PROFILE: 'qianshou',
    QIANSHOU_PRESET_ROOT: join(resourcesPath, 'qianshou-presets'),
  }
}
