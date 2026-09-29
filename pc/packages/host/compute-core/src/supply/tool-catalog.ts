/**
 * The one trusted local-tool catalogue this deployment probes.
 *
 * ## Why this file exists (measured divergence, fixed 2026-09-17)
 *
 * Two lists used to describe the same machine. The supply page's default probe list
 * (`supply-host.ts`, `SupplyHostConfig.tools`) was `node, git, ffmpeg`, while the node's own
 * `hello` capability advertisement (`node-contributor/src/edge-binding.ts`, `DEFAULT_HELLO_TOOLS`)
 * was `node, git, python3` — carrying a comment that claimed both were "the same three tools".
 * They were not, and the comment is exactly why nobody noticed: the difference was asserted
 * away in prose instead of being made impossible in code.
 *
 * ## The consequence that was actually observed
 *
 * This Mac (Apple M4, ffmpeg **and** ffprobe installed) registered on the dispatcher as
 * `software: ["node","git","python3"]`. Every task type whose `required_software` contains
 * `ffmpeg` (`video_compress`, `video_info`, `video_thumbnail`, `audio_extract`,
 * `audio_transcode`, `video_repurpose`, `video_analyze`, …) therefore can never match this
 * machine, however idle it is: the matching side reads the advertised `software` list, which
 * was missing the very tool those tasks need.
 *
 * ## The fix, in one sentence
 *
 * One catalogue, two readers: `createHostSupply` and the Edge `hello` probe both read
 * `HOST_SUPPLY_TOOLS`, so "the supply page shows it" and "the node advertises it" are the same
 * fact rather than two copies that have to be kept in sync by hand.
 */
import { statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'

/** How many ancestor directories the bundled-runtime anchor below is allowed to walk up. */
const MAX_ANCESTOR_DEPTH = 4

/** One catalogue row: what to measure, and whether its executable has to be located first. */
interface SupplyToolCatalogEntry {
  /** Stable lower-case probe key; this is what lands in the advertised `software` list. */
  readonly id: string
  /** Owner-visible display name for the probed tool. */
  readonly name: string
  /** Absolute path when the running runtime already names one, otherwise a bare external command name. */
  readonly command: string
  /** Literal version-probe argument vector; never taken from HTTP input. */
  readonly args: readonly string[]
  /** True only for an external binary that `resolveSupplyCommand` must locate before use. */
  readonly external: boolean
}

/** Unresolved catalogue row: ids and version-probe args before path search. */
export interface HostSupplyToolSpec {
  /** Stable lower-case probe key reported in the capability facts. */
  readonly id: string
  /** Owner-visible display name for the probed tool. */
  readonly name: string
  /** Bare command name (`node` for the in-process runtime). Never a resolved path. */
  readonly command: string
  /** Literal version-probe argument vector. */
  readonly args: readonly string[]
  /** True only for an external binary that must be located before use. */
  readonly external: boolean
}

/** A resolved catalogue row, in the shape `probeLocalSupply` consumes. */
export interface SupplyToolProbe {
  /** Stable lower-case probe key reported in the capability facts. */
  readonly id: string
  /** Owner-visible display name for the probed tool. */
  readonly name: string
  /** Absolute path, or the bare command name when no known install directory held it. */
  readonly command: string
  /** Literal version-probe argument vector. */
  readonly args: string[]
}

/**
 * The catalogue itself — the complete list of tools this deployment self-tests.
 *
 * `ffprobe` is listed beside `ffmpeg` on purpose: `ffmpeg -i` prints stream metadata to stderr
 * rather than emitting a machine-readable record, so stream-inspection tasks (`video_info` and
 * relatives) need `ffprobe`. A node advertising only `ffmpeg` still cannot be matched to a task
 * whose `required_software` is `('ffprobe',)`.
 *
 * `node` is the runtime already executing this host, so its executable is absolute by
 * construction and needs no search. The other four are external binaries that are frequently
 * installed outside the process PATH — see `resolveSupplyCommand`.
 */
const SUPPLY_TOOL_CATALOG: readonly SupplyToolCatalogEntry[] = [
  { id: 'node', name: 'Node.js', command: process.execPath, args: ['--version'], external: false },
  { id: 'git', name: 'Git', command: 'git', args: ['--version'], external: true },
  { id: 'python3', name: 'Python 3', command: 'python3', args: ['--version'], external: true },
  { id: 'ffmpeg', name: 'FFmpeg', command: 'ffmpeg', args: ['-version'], external: true },
  { id: 'ffprobe', name: 'FFprobe', command: 'ffprobe', args: ['-version'], external: true },
]

/**
 * The catalogue as portable specs: same ids and version-probe args as
 * {@link HOST_SUPPLY_TOOLS}, without resolving paths at import time.
 * Desktop self-check generates a shell copy from this list so it cannot grow a
 * third handwritten probe table.
 */
export const HOST_SUPPLY_TOOL_SPECS: readonly HostSupplyToolSpec[] = Object.freeze(
  SUPPLY_TOOL_CATALOG.map(entry => Object.freeze({
    id: entry.id,
    name: entry.name,
    command: entry.external ? entry.command : 'node',
    args: Object.freeze([...entry.args]),
    external: entry.external,
  })),
)

/**
 * Directories searched for external tools, in the order the probe tries them.
 *
 * Apple-silicon Homebrew first, then Intel Homebrew, then the app's own bundled runtime — the
 * three places a tool can exist on this product's machines without being on the process PATH.
 * A desktop-App process is started by Finder, so its PATH is the login PATH the OS hands to a
 * GUI app; `/opt/homebrew/bin` is typically absent there even though ffmpeg lives in it.
 * @param execPath - Runtime executable used to recognise the packaged app's layout; defaults to
 * this process's own. Injected so the bundled-runtime candidate is testable without a packaged build.
 * @returns Candidate directories; whether one actually holds a given command is decided per command.
 */
export function supplyToolSearchDirectories(execPath: string = process.execPath): readonly string[] {
  const directories: string[] = []
  if (process.platform !== 'win32') directories.push('/opt/homebrew/bin', '/usr/local/bin')
  const resources = packagedResourcesDirectory(execPath)
  if (resources !== null) directories.push(join(resources, 'runtime', 'bin'))
  return directories
}

/**
 * Resolve one external command to a real absolute path; never throws.
 *
 * Two rules, both deliberate:
 *  - **Known directories first, bare name last.** A tool that exists at a known absolute path is
 *    addressed by that path, so the advertisement does not depend on the PATH of whichever
 *    process happens to run the probe.
 *  - **The bare name is a fallback, not a failure.** This runs while assembling a capability
 *    advertisement; a tool that cannot be located anywhere must end up `unavailable` in the probe
 *    result — the existing `LOCAL_PROBE_UNAVAILABLE` semantics — instead of throwing away the
 *    whole `hello` frame. `execFile` changes the bare name through PATH, and if PATH has it too,
 *    the tool simply works.
 * @param command - External command name, or an already-absolute path (returned unchanged).
 * @param directories - Candidate directories; defaults to `supplyToolSearchDirectories()`.
 * @returns An absolute path when one was found, otherwise `command` unchanged.
 */
export function resolveSupplyCommand(
  command: string,
  directories: readonly string[] = supplyToolSearchDirectories(),
): string {
  if (isAbsolute(command)) return command
  for (const directory of directories) {
    for (const name of executableNames(command)) {
      const candidate = join(directory, name)
      if (isExecutableFile(candidate)) return candidate
    }
  }
  return command
}

/**
 * The resolved probe list both readers use — one constant, so the supply page and the node
 * `hello` cannot advertise different tool sets.
 *
 * Resolved once at module load: it describes the install this process started with, which is the
 * same lifetime rule the rest of the probe follows. A tool installed later is picked up on the
 * next start, not mid-session; nothing here re-reads the filesystem behind the caller's back.
 */
export const HOST_SUPPLY_TOOLS: readonly SupplyToolProbe[] = Object.freeze(
  SUPPLY_TOOL_CATALOG.map(entry => Object.freeze({
    id: entry.id,
    name: entry.name,
    command: entry.external ? resolveSupplyCommand(entry.command) : entry.command,
    args: [...entry.args],
  })),
)

/**
 * Directory of the packaged app's `Resources`, when this process is one of its children.
 *
 * Two real anchors, no guessing:
 *  - A packaged host exposes `process.resourcesPath` and builds every bundled path from it.
 *  - Its runtime executable is `<resources>/runtime/node/node`, so an ancestor directory
 *    literally named `runtime` names its parent as `<resources>`.
 *
 * With neither anchor — a plain repository `node`, or a dev checkout — no bundled-runtime
 * directory is searched. Inventing one would put a path nobody verified into the search order,
 * and the bare-name fallback already covers that case honestly.
 * @param execPath - Runtime executable to derive the layout from.
 * @returns The absolute resources directory, or `null` when this process is not visibly packaged.
 */
function packagedResourcesDirectory(execPath: string): string | null {
  const electronResources: unknown = Reflect.get(process, 'resourcesPath')
  if (typeof electronResources === 'string' && electronResources.length > 0) return electronResources
  let current = dirname(execPath)
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    if (basename(current) === 'runtime') return dirname(current)
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
  return null
}

/** Windows ships external tools as `<name>.exe`; POSIX command names carry no suffix. */
function executableNames(command: string): readonly string[] {
  return process.platform === 'win32' ? [`${command}.exe`, command] : [command]
}

/**
 * Whether a candidate path is really a runnable file.
 *
 * A directory named like the command is not an executable, and on POSIX a file without any
 * execute bit would fail inside `execFile` with `EACCES` — the probe would then report the tool
 * as unavailable after a wasted subprocess attempt, which is worse than not choosing it.
 * @param candidate - Absolute path to test.
 * @returns True only for an executable regular file; any read error means "not here".
 */
function isExecutableFile(candidate: string): boolean {
  try {
    const stats = statSync(candidate)
    return stats.isFile() && (process.platform === 'win32' || (stats.mode & 0o111) !== 0)
  } catch {
    // Absent, unreadable, a dangling symlink or a permissions error: this candidate does not exist.
    return false
  }
}
