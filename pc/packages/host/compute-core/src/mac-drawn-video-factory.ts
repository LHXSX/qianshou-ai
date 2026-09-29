/** Host-owned bridge for one reviewed Mac video plugin. Package code cannot choose tools or capability identity. */
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { ComputeError } from './errors.ts'
import type { ComputeExecutor } from './executor.ts'
import { ComputeCapabilityId } from './protocol.ts'
import { createMacDrawnVideoExecutor } from './executors/drawn-video-mac.ts'

const TOOL_PAIRS = [
  ['/opt/homebrew/bin/ffmpeg', '/opt/homebrew/bin/ffprobe'],
  ['/usr/local/bin/ffmpeg', '/usr/local/bin/ffprobe'],
  ['/usr/bin/ffmpeg', '/usr/bin/ffprobe'],
] as const

function executable(path: string): string | null {
  try {
    const resolved = realpathSync(path)
    if (!statSync(resolved).isFile()) return null
    accessSync(resolved, constants.X_OK)
    return resolved
  } catch { return null }
}

/** A package gets no path, model, network, or task parameters when activating this fixed capability. */
export interface MacDrawnVideoFactory {
  readonly available: boolean
  /**
   * Create only the fixed reviewed Mac video capability using checked local tools.
   * @returns The fixed five-second Mac video executor; unavailable local tools cause an error.
   */
  create(): ComputeExecutor
}

declare module '@deepseek-ai/cordis' {
  interface Context { macDrawnVideoFactory: MacDrawnVideoFactory }
}

/** Construct the trusted Host service; it never registers or advertises the capability on its own. */
export function createMacDrawnVideoFactory(): MacDrawnVideoFactory {
  const swiftPath = process.platform === 'darwin' ? executable('/usr/bin/swift') : null
  const pair = process.platform === 'darwin'
    ? TOOL_PAIRS.map(([ffmpeg, ffprobe]) => [executable(ffmpeg), executable(ffprobe)] as const)
      .find(([ffmpeg, ffprobe]) => ffmpeg !== null && ffprobe !== null)
    : undefined
  const available = swiftPath !== null && pair !== undefined
  return Object.freeze({
    available,
    create(): ComputeExecutor {
      if (!available || swiftPath === null || pair === undefined || pair[0] === null || pair[1] === null) {
        throw new ComputeError('COMPUTE_DRAWN_VIDEO_TOOL_UNAVAILABLE', 409)
      }
      return createMacDrawnVideoExecutor({
        capabilityId: ComputeCapabilityId('video.drawn-mac-5s'), version: '0.1.0',
        swiftPath, ffmpegPath: pair[0], ffprobePath: pair[1], maxRuntimeMs: 180_000,
      })
    },
  })
}
