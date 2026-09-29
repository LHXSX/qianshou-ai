/**
 * Real host activity readings — the fact `allowWhileUserActive` is judged on.
 *
 * Why this module exists: the resident node used to answer "is the owner using this
 * machine?" with the constants `() => false`. The policy branch `USER_ACTIVE` was therefore
 * unreachable on every platform, so `allowWhileUserActive: false` had no basis at all
 * (AT-10). These readers replace the constants with a real measurement, and they keep
 * "this platform cannot tell" as a first-class answer instead of rounding it down to
 * `false` — an unknown activity is never reported as an idle machine.
 *
 * Bounds are deliberate: one command per read, a default 1s timeout, and a 5s cache so a
 * resident loop that ticks once a second does not fork a process once a second.
 */
import { execFile } from 'node:child_process'

/** Platform-specific command that prints the idle time in the platform's own unit. */
export interface IdleCommand {
  /** Platform-owned executable path or name; never taken from request input. */
  readonly command: string
  /** Literal argument vector; no shell interpolation. */
  readonly args: readonly string[]
  /** Convert the command's stdout into whole seconds of idle time, or throw when it is unusable. */
  readonly parse: (stdout: string) => number
}

/**
 * macOS: `HIDIdleTime` from the IOHIDSystem registry entry, in nanoseconds.
 *
 * This is the same reading the supply probe already used; it lives here now so the supply
 * page and the resident loop cannot drift apart on how "idle" is defined.
 */
const DARWIN_IDLE: IdleCommand = {
  command: '/usr/sbin/ioreg',
  args: ['-r', '-c', 'IOHIDSystem', '-d', '1'],
  parse: (stdout) => {
    const value = /"HIDIdleTime"\s*=\s*(\d+)/u.exec(stdout)?.[1]
    if (value === undefined) throw new Error('IDLE_NOT_REPORTED')
    const seconds = Math.floor(Number(value) / 1e9)
    if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error('IDLE_NOT_REPORTED')
    return seconds
  },
}

/**
 * Windows: `GetLastInputInfo` through PowerShell, in milliseconds.
 *
 * `GetLastInputInfo` is the documented Win32 source for "time since last user input" and
 * needs no extra dependency; PowerShell ships with every supported Windows version.
 */
const WIN32_IDLE: IdleCommand = {
  command: 'powershell.exe',
  args: ['-NoProfile', '-NonInteractive', '-Command', [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'namespace Qianshou {',
    '  public static class Idle {',
    '    [StructLayout(LayoutKind.Sequential)]',
    '    private struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }',
    '    [DllImport("user32.dll")]',
    '    [return: MarshalAs(UnmanagedType.Bool)]',
    '    private static extern bool GetLastInputInfo(ref LASTINPUTINFO info);',
    '    [DllImport("kernel32.dll")]',
    '    private static extern uint GetTickCount();',
    '    public static uint ReadMilliseconds() {',
    '      var info = new LASTINPUTINFO();',
    '      info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));',
    '      if (!GetLastInputInfo(ref info)) throw new InvalidOperationException("IDLE_NOT_REPORTED");',
    // LASTINPUTINFO.dwTime and GetTickCount both use the same wrapping 32-bit clock.
    '      return unchecked(GetTickCount() - info.dwTime);',
    '    }',
    '  }',
    '}',
    "'@",
    '[Qianshou.Idle]::ReadMilliseconds()',
  ].join('\n')],
  parse: (stdout) => {
    const text = stdout.trim()
    if (!/^\d+$/u.test(text)) throw new Error('IDLE_NOT_REPORTED')
    const milliseconds = Number(text)
    if (!Number.isSafeInteger(milliseconds) || milliseconds > 0xffffffff) throw new Error('IDLE_NOT_REPORTED')
    return Math.floor(milliseconds / 1000)
  },
}

/** The idle command for one platform, or null when this host cannot measure idle time. */
export function idleCommandFor(platform: string): IdleCommand | null {
  if (platform === 'darwin') return DARWIN_IDLE
  if (platform === 'win32') return WIN32_IDLE
  return null
}

/** Why an activity reading is unknown, as a stable code a status reader can branch on. */
export type HostActivityUnavailable = 'IDLE_PROBE_UNSUPPORTED' | 'IDLE_PROBE_FAILED'

/** One activity reading: the measured truth, or an explicit "this host cannot tell". */
export interface HostActivityReading {
  /** True only when the measured idle time is below the threshold; null when unmeasurable. */
  readonly userActive: boolean | null
  /** Measured seconds since the last user input, or null when unmeasurable. */
  readonly idleSeconds: number | null
  /** Set only when {@link userActive} is null. */
  readonly unavailable: HostActivityUnavailable | null
}

/** Construction options; every bound is host configuration, not request input. */
export interface HostIdleReaderOptions {
  /** Seconds of no input that count as "the owner is not using this machine". */
  readonly thresholdSeconds?: number
  /** How long one reading stays fresh. */
  readonly cacheMs?: number
  /** Hard ceiling for the platform command. */
  readonly timeoutMs?: number
  /** Platform id; injectable for tests and for fixtures. */
  readonly platform?: string
  /** Command port; injectable for tests. */
  readonly run?: (command: string, args: readonly string[], signal?: AbortSignal) => Promise<string>
  /** Clock; injectable for tests. */
  readonly clock?: () => number
}

/** Default "not using the machine" threshold, in seconds. */
export const HOST_IDLE_THRESHOLD_SECONDS = 60
/** Default freshness window for one measurement. */
export const HOST_IDLE_CACHE_MS = 5_000
/** Default command ceiling: an activity read must never stall a tick. */
export const HOST_IDLE_TIMEOUT_MS = 1_000

/** Run one command and resolve its stdout, or reject. Bounded by the caller's signal. */
function runCommand(command: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(key)
      && !['NODE_OPTIONS', 'NODE_REPL_EXTERNAL_MODULE', 'ELECTRON_RUN_AS_NODE'].includes(key)))
    execFile(command, [...args], { env, maxBuffer: 4096, killSignal: 'SIGKILL', signal, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error instanceof Error ? error : new Error('IDLE_COMMAND_FAILED'))
        else resolve(stdout)
      })
  })
}

/** A cached, bounded reader for "is the owner using this machine?". */
export interface HostIdleReader {
  /** Read the current activity fact; never throws — unmeasurable is reported, not raised. */
  read(): Promise<HostActivityReading>
}

/**
 * Build the activity reader for one host.
 * @param options - Threshold, cache, timeout, platform and injectable command/clock.
 * @returns A reader whose failure mode is an explicit unknown.
 */
export function createHostIdleReader(options: HostIdleReaderOptions = {}): HostIdleReader {
  const threshold = options.thresholdSeconds ?? HOST_IDLE_THRESHOLD_SECONDS
  const cacheMs = options.cacheMs ?? HOST_IDLE_CACHE_MS
  const timeoutMs = options.timeoutMs ?? HOST_IDLE_TIMEOUT_MS
  const platform = options.platform ?? process.platform
  const clock = options.clock ?? Date.now
  const run = options.run ?? runCommand
  const command = idleCommandFor(platform)
  let cached: { at: number; reading: HostActivityReading } | null = null
  let inFlight: Promise<HostActivityReading> | null = null

  const readOnce = async (): Promise<HostActivityReading> => {
    if (command === null) return { userActive: null, idleSeconds: null, unavailable: 'IDLE_PROBE_UNSUPPORTED' }
    try {
      const stdout = await run(command.command, command.args, AbortSignal.timeout(timeoutMs))
      const idleSeconds = command.parse(stdout)
      return { userActive: idleSeconds < threshold, idleSeconds, unavailable: null }
    } catch {
      // A probe that failed is an unknown fact, never "the owner is away".
      return { userActive: null, idleSeconds: null, unavailable: 'IDLE_PROBE_FAILED' }
    }
  }

  return {
    async read(): Promise<HostActivityReading> {
      const now = clock()
      if (cached !== null && now - cached.at < cacheMs) return cached.reading
      inFlight ??= readOnce().then((reading) => {
        cached = { at: clock(), reading }
        inFlight = null
        return reading
      }, () => {
        inFlight = null
        return { userActive: null, idleSeconds: null, unavailable: 'IDLE_PROBE_FAILED' as const }
      })
      return inFlight
    },
  }
}
