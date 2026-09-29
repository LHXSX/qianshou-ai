/** Typed boundary to the separately bundled updater runtime; no development module path is resolved in production. */
import { app } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

interface UpdateCenterInstance { start(): void; open(): Promise<void>; dispose(): void }
interface UpdateRuntime {
  UpdateCenter: new (options: Record<string, unknown>) => UpdateCenterInstance
  bootstrapUpdate(options: Record<string, unknown>): Promise<{ action: 'continue' | 'forward' | 'wait'; activation?: unknown; attemptId?: string; token?: string; pending?: boolean }>
  prepareActivation(receipt: unknown, options: Record<string, unknown>): Promise<unknown>
  launchActivation(activation: unknown, options: Record<string, unknown>): Promise<unknown>
  cancelActivation(activation: unknown): Promise<void>
  acknowledgeDataAccess(options: Record<string, unknown>): Promise<void>
  acknowledgeReady(options: Record<string, unknown>): Promise<void>
}
export interface CompanionUpdateHooks {
  readiness(): Promise<{ ready: boolean }>
  prepareRestart(): Promise<{ leaseId: string }>
  commitRestart(lease: { leaseId: string }): Promise<void>
  cancelRestart(lease: { leaseId: string }): Promise<void>
}

/** Load only the app's shipped updater before acquiring the application's single-instance lock. */
export async function companionUpdates(location: string) {
  // Electron's filename heuristic treats our shipped macOS entry point as development.
  // Only explicit metadata emitted by our release packagers enables this runtime.
  let metadata: { name?: string; distribution?: string; version?: string }
  try {
    metadata = JSON.parse(await readFile(join(location, '..', 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
  if (metadata?.name !== 'qianshou-companion' || metadata.distribution !== 'bundled'
    || typeof metadata.version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(metadata.version)) return undefined
  const directory = join(location, 'updater')
  const runtime = await import(pathToFileURL(join(directory, 'entry.mjs')).href) as UpdateRuntime
  const updatesDirectory = join(app.getPath('userData'), 'updates')
  const target = { role: 'companion', platform: process.platform, arch: process.arch }
  const currentVersion = metadata.version
  const bootstrap = await runtime.bootstrapUpdate({ updatesDirectory, target, currentVersion, currentExecutable: process.execPath })
  const attempt = { attemptId: bootstrap.attemptId ?? process.env.QIANSHOU_UPDATE_ATTEMPT, token: bootstrap.token ?? process.env.QIANSHOU_UPDATE_TOKEN }
  if (bootstrap.action === 'forward') await runtime.launchActivation(bootstrap.activation, { helperExecutable: process.execPath, helperScript: join(directory, 'runner.mjs'), electronRunAsNode: true })
  let center: UpdateCenterInstance | undefined
  return {
    forwarded: bootstrap.action !== 'continue',
    async beforeDataAccess() {
      if (bootstrap.pending) await runtime.acknowledgeDataAccess({ updatesDirectory, target, currentVersion, currentExecutable: process.execPath, ...attempt })
    },
    configure(hooks: CompanionUpdateHooks) {
      center = new runtime.UpdateCenter({ ...target, ...hooks, currentVersion, locale: app.getLocale().startsWith('zh') ? 'zh' : 'en', packaged: true, updatesDirectory,
        prepareInstallation: (receipt: unknown) => runtime.prepareActivation(receipt, { updatesDirectory, target, currentVersion, currentExecutable: process.execPath, currentPid: process.pid }),
        discardInstallation: (activation: unknown) => runtime.cancelActivation(activation),
        restart: async (_receipt: unknown, lease: { leaseId: string }, activation: unknown) => {
          await hooks.commitRestart(lease)
          await runtime.launchActivation(activation, { helperExecutable: process.execPath, helperScript: join(directory, 'runner.mjs'), electronRunAsNode: true })
          await hooks.commitRestart(lease)
          app.quit()
        },
      })
    },
    async ready() {
      if (bootstrap.pending) await runtime.acknowledgeReady({ updatesDirectory, target, currentVersion, currentExecutable: process.execPath, ...attempt })
      center?.start()
    },
    open: () => center?.open(),
    dispose: () => center?.dispose(),
  }
}
