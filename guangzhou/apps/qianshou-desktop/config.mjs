/** Local desktop installation settings. The Harness still boots through dsh web. */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

const pathsFor = platform => platform === 'win32' ? win32 : posix
const environmentPath = env => env.PATH ?? Object.entries(env).find(([name]) => name.toUpperCase() === 'PATH')?.[1] ?? ''

/** Read a JSON installation override, allowing a missing file only. */
export function readOptionalConfig(filename) {
  try { return JSON.parse(readFileSync(filename, 'utf8')) }
  catch (error) { if (error?.code === 'ENOENT') return {}; throw error }
}

/** Resolve local config paths and reject public hosts or the existing 3080 service. */
export function resolveConfig(raw = {}, env = process.env, userHome = homedir(), platform = process.platform) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INVALID_CONFIG')
  const { isAbsolute, join } = pathsFor(platform)
  const base = join(userHome, '.local', 'share', 'qianshou-agent')
  const config = {
    sourcePath: env.QIANSHOU_SOURCE ?? raw.sourcePath ?? join(base, 'source'),
    nodePath: env.QIANSHOU_NODE ?? raw.nodePath ?? (platform === 'win32' ? 'node.exe' : 'node'),
    path: env.QIANSHOU_PATH ?? raw.path ?? environmentPath(env),
    home: env.QIANSHOU_HOME ?? raw.home ?? join(base, 'home'),
    host: env.QIANSHOU_HOST ?? raw.host ?? '127.0.0.1',
    port: Number(env.QIANSHOU_PORT ?? raw.port ?? 3081),
    startupTimeoutMs: Number(raw.startupTimeoutMs ?? 120000),
    rustDeskPath: env.QIANSHOU_RUSTDESK ?? raw.rustDeskPath ?? '',
  }
  for (const key of ['sourcePath', 'home']) if (typeof config[key] !== 'string' || !isAbsolute(config[key])) throw new Error('INVALID_CONFIG')
  if (typeof config.nodePath !== 'string' || config.nodePath.length === 0) throw new Error('INVALID_CONFIG')
  if (typeof config.path !== 'string') throw new Error('INVALID_CONFIG')
  for (const value of Object.values(config)) if (typeof value === 'string' && value.includes('\0')) throw new Error('INVALID_CONFIG')
  if (typeof config.rustDeskPath !== 'string' || (config.rustDeskPath !== '' && !isAbsolute(config.rustDeskPath))) throw new Error('INVALID_CONFIG')
  // The web profile announces 127.0.0.1 as its canonical auth origin.
  if (config.host !== '127.0.0.1') throw new Error('LOOPBACK_REQUIRED')
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 || config.port === 3080) throw new Error('INVALID_PORT')
  if (!Number.isFinite(config.startupTimeoutMs) || config.startupTimeoutMs < 1000 || config.startupTimeoutMs > 300000) throw new Error('INVALID_CONFIG')
  return Object.freeze(config)
}

/** Resolve relocatable release resources; legacy source/Node overrides never escape the bundle. */
export function resolvePackagedConfig(resourcesPath, raw = {}, env = process.env, userHome = homedir(), platform = process.platform) {
  const { delimiter, isAbsolute, join } = pathsFor(platform)
  if (!isAbsolute(resourcesPath)) throw new Error('INVALID_CONFIG')
  const sourcePath = join(resourcesPath, 'dsh')
  const nodePath = join(resourcesPath, 'runtime', 'node', platform === 'win32' ? 'node.exe' : 'node')
  const inheritedPath = environmentPath(env) || (platform === 'win32'
    ? join(env.SystemRoot ?? 'C:\\Windows', 'System32') : '/usr/bin:/bin:/usr/sbin:/sbin')
  const config = resolveConfig({ ...raw, sourcePath, nodePath }, {
    ...env, QIANSHOU_SOURCE: sourcePath, QIANSHOU_NODE: nodePath,
    QIANSHOU_PATH: [join(resourcesPath, 'runtime', 'bin'), join(resourcesPath, 'runtime', 'node'), inheritedPath].join(delimiter),
  }, userHome, platform)
  return Object.freeze({ ...config, cliPath: join(sourcePath, 'lib', 'bin.js'), workingDirectory: userHome, packaged: true })
}

/** Canonical origin shared by process readiness, navigation and microphone policy. */
export function localOrigin(config) { return `http://${config.host}:${config.port}` }

/** Never forward Electron Node mode or inherited credentials to the backend process. */
export function backendEnvironment(config, env = process.env, platform = process.platform) {
  const clean = Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined
    && !/KEY|SECRET|TOKEN|PASSWORD/i.test(key)
    && !['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_REPL_EXTERNAL_MODULE'].includes(key.toUpperCase())
    && !(platform === 'win32' && config.path && key.toUpperCase() === 'PATH')))
  return { ...clean, ...(config.path ? { PATH: config.path } : {}), DSH_HOME: config.home, DSH_CLIENT_BUILD_PROFILE: 'forge', DSH_CLIENT_TITLE: '千手智能体' }
}
