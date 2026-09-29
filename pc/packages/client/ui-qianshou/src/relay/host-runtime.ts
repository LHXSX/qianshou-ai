/**
 * 宿主进程绑定。本包按浏览器 tsconfig 编译，不能直接 import Node 模块，
 * 所以 `node:child_process` 与 `node:fs` 在运行时再加载。
 */
import type { NodeSwitchConfig, NodeSwitchSignal } from './node-switch.ts'

/** 把开关交给宿主时用的三个动作。 */
export interface HostNodeProcess {
  readonly spawn: NodeSwitchConfig['spawn']
  readonly kill: NodeSwitchConfig['kill']
  readonly isAlive: NodeSwitchConfig['isAlive']
  readonly exists: (path: string) => boolean
  readonly env: (name: string) => string | undefined
  readonly modulePath: string
  readonly pid: number
  readonly rememberPid: (port: number, pid: number | null) => void
  readonly reclaim: (port: number) => Promise<void>
}

interface SpawnResult { pid?: number, unref(): void }

interface ChildProcessModule {
  spawn(command: string, args: readonly string[], options: {
    cwd: string
    env: Record<string, string | undefined>
    detached: boolean
    stdio: ['ignore', 'ignore', 'ignore' | number]
  }): SpawnResult
  spawnSync(command: string, args: readonly string[], options: { encoding: 'utf8' }): { stdout?: string }
}

interface FsModule {
  existsSync(path: string): boolean
  readFileSync(path: string, encoding: 'utf8'): string
  writeFileSync(path: string, data: string): void
  rmSync(path: string, options?: { force?: boolean }): void
  openSync(path: string, flags: 'a'): number
  closeSync(fd: number): void
}

interface HostProc {
  env: Record<string, string | undefined>
  execPath: string
  pid?: number
  kill(pid: number, signal?: string | number): boolean
}

/**
 * 把开关的 `node_modules/.bin/tsx` 翻译成当前可执行文件 + tsx cli。
 * 令牌只留在环境变量里；argv 里出现令牌就拒绝启动。
 * @param execPath - 当前宿主的可执行文件。
 * @param command - 开关传入的命令。
 * @param args - 开关传入的参数。
 * @param options - 工作目录与环境。
 * @returns 真正要 spawn 的命令、参数与环境。
 */
export function daemonLaunch(
  execPath: string,
  command: string,
  args: readonly string[],
  options: { cwd: string, env: Record<string, string | undefined> },
): { bin: string, argv: readonly string[], env: Record<string, string | undefined> } {
  const launched = command === 'node_modules/.bin/tsx'
    ? {
      bin: execPath,
      argv: [`${options.cwd}/node_modules/tsx/dist/cli.mjs`, ...args],
      env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' },
    }
    : { bin: command, argv: args, env: options.env }
  const token = options.env.QIANSHOU_NODE_TOKEN
  if (token !== undefined && token !== '' && launched.argv.some(arg => arg.includes(token))) {
    throw new Error('NODE_SWITCH_TOKEN_IN_ARGV')
  }
  return launched
}

/**
 * 加载本进程的 Node 绑定。
 * @param modulePath - 宿主入口文件路径，用来向上找仓库。
 * @returns 开关要用的进程动作。
 */
export async function loadHostRuntime(modulePath: string): Promise<HostNodeProcess> {
  const importer = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<Record<string, unknown>>
  const childProcess = await importer('node:child_process') as unknown as ChildProcessModule
  const fs = await importer('node:fs') as unknown as FsModule
  const proc = (globalThis as { process?: HostProc }).process
  if (proc === undefined) throw new Error('NODE_SWITCH_SPAWN_FAILED')
  const alive = (pid: number): boolean => {
    try {
      return proc.kill(pid, 0)
    } catch {
      // ESRCH / EPERM：这个 pid 不是我们还能当作存活的进程。
      return false
    }
  }
  const kill = (pid: number, signal: NodeSwitchSignal): void => {
    proc.kill(pid, signal)
  }
  return {
    modulePath,
    pid: typeof proc.pid === 'number' ? proc.pid : 0,
    exists: path => fs.existsSync(path),
    env: name => proc.env[name],
    kill,
    isAlive: alive,
    rememberPid: (port, pid) => { writePid(fs, proc, port, pid) },
    reclaim: port => reclaim(fs, proc, kill, alive, port),
    spawn: (command, args, options) => {
      const launched = daemonLaunch(proc.execPath, command, args, options)
      const home = proc.env.DSH_HOME
      const errFd = home === undefined || home === '' ? 'ignore' : fs.openSync(`${home}/qianshou-node.log`, 'a')
      const child = childProcess.spawn(launched.bin, launched.argv, {
        cwd: options.cwd,
        env: launched.env,
        detached: true,
        stdio: ['ignore', 'ignore', errFd],
      })
      if (typeof errFd === 'number') fs.closeSync(errFd)
      child.unref()
      if (child.pid === undefined) throw new Error('NODE_SWITCH_SPAWN_FAILED')
      return child.pid
    },
  }
}

/** 宿主入口的文件路径（`file://` URL 或普通路径）。 */
export function modulePathFromUrl(url: string): string {
  if (!url.startsWith('file://')) return url
  const path = decodeURIComponent(url.slice('file://'.length))
  return path.startsWith('/') ? path : `/${path}`
}

function pidFile(home: string, port: number): string {
  return `${home}/qianshou-node-${String(port)}.pid`
}

function writePid(fs: FsModule, proc: HostProc, port: number, pid: number | null): void {
  const home = proc.env.DSH_HOME
  if (home === undefined || home === '') return
  const file = pidFile(home, port)
  if (pid === null) fs.rmSync(file, { force: true })
  else fs.writeFileSync(file, `${String(pid)}\n`)
}

async function reclaim(
  fs: FsModule,
  proc: HostProc,
  kill: (pid: number, signal: NodeSwitchSignal) => void,
  isAlive: (pid: number) => boolean,
  port: number,
): Promise<void> {
  const home = proc.env.DSH_HOME
  if (home === undefined || home === '') return
  const file = pidFile(home, port)
  if (!fs.existsSync(file)) return
  const pid = Number(fs.readFileSync(file, 'utf8').trim())
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    fs.rmSync(file, { force: true })
    return
  }
  if (!isAlive(pid)) {
    fs.rmSync(file, { force: true })
    return
  }
  const importer = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<Record<string, unknown>>
  const childProcess = await importer('node:child_process') as unknown as ChildProcessModule
  const listed = childProcess.spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  const command = String(listed.stdout ?? '')
  if (!command.includes('node-daemon.mts')) return
  kill(pid, 'SIGTERM')
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!isAlive(pid)) break
    await new Promise<void>(resolve => { setTimeout(resolve, 100) })
  }
  if (!isAlive(pid)) fs.rmSync(file, { force: true })
}
