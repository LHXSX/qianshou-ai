/** Bounded owner-local listener discovery; ports only select fixed read-only media probes. */
import { execFile } from 'node:child_process'

const MAX_LISTENERS = 48
const MAX_OUTPUT = 256 * 1024
let cached: { at: number; ports: readonly number[] } | undefined

/** Extract TCP listener ports without retaining process names, PIDs or private addresses.
 * @param output - Bounded native netstat, lsof or ss stdout.
 * @returns Unique local ports; media defaults are prioritized, and no remote address is returned.
 */
export function parseLocalListeningPorts(output: string): number[] {
  const found = new Set<number>()
  for (const line of output.slice(0, MAX_OUTPUT).split(/\r?\n/u)) {
    if (!/\bLISTEN(?:ING)?\b/u.test(line)) continue
    const columns = line.trim().split(/\s+/u)
    const endpoint = process.platform === 'win32' || /^(?:TCP|tcp)\b/u.test(columns[0] ?? '')
      ? columns[1] : columns.find(column => /^(?:\*|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?|\[?::\]?):\d+$/u.test(column))
    if (endpoint === undefined || !/^(?:\*|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?|\[?::\]?):\d+$/u.test(endpoint)) continue
    const port = Number(endpoint.slice(endpoint.lastIndexOf(':') + 1))
    if (Number.isSafeInteger(port) && port >= 1024 && port <= 65535) found.add(port)
  }
  const priority = (port: number): number => port >= 8000 && port <= 8999 ? 0
    : port >= 5000 && port <= 5999 ? 1 : port >= 3000 && port <= 3999 ? 2 : 3
  return [...found].sort((a, b) => priority(a) - priority(b) || a - b).slice(0, MAX_LISTENERS)
}

/** Read listeners through a fixed OS tool with no shell, caller input or inherited credentials.
 * @param signal - Owner or Host shutdown cancellation.
 * @returns Local TCP ports only; unavailable tools produce an empty candidate list.
 */
export async function localListeningPorts(signal: AbortSignal): Promise<readonly number[]> {
  if (signal.aborted) return []
  if (cached !== undefined && Date.now() - cached.at < 30000) return cached.ports
  const platform = process.platform
  const command = platform === 'win32' ? 'C:\\Windows\\System32\\netstat.exe'
    : platform === 'darwin' ? '/usr/sbin/lsof' : '/usr/bin/ss'
  const args = platform === 'win32' ? ['-ano', '-p', 'tcp']
    : platform === 'darwin' ? ['-nP', '-iTCP', '-sTCP:LISTEN'] : ['-ltnH']
  return new Promise(resolve => {
    execFile(command, args, { signal, timeout: 1200, maxBuffer: MAX_OUTPUT, windowsHide: true,
      env: { PATH: platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin:/bin',
        ...(platform === 'win32' ? { SystemRoot: 'C:\\Windows' } : {}), LANG: 'C' } },
    (error, stdout) => {
      const ports = error ? [] : parseLocalListeningPorts(stdout)
      if (!signal.aborted) cached = { at: Date.now(), ports }
      resolve(ports)
    })
  })
}
