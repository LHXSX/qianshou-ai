/** Natural-conversation tools for the bundled CSV seed's offline, private trial only. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CSV_SEED_IDENTITY, installPrivateOfficialCsvSeed, runPrivateOfficialCsvSeed } from './official-seed-csv.ts'
import { registerInstalledCsvProfileSampleAdapter } from './private-csv-draft-sample.ts'
import type { HostPluginSampleAdapter } from '@deepseek-ai/dsh-compute-core'

export const name = 'qianshou-official-seed-csv-tools'
export const inject = ['tools', 'qianshouPluginCatalog']

const BUNDLED_ARTIFACT = fileURLToPath(new URL('../seed/csv-profile/qianshou.csv-profile-1.0.0.qspkg', import.meta.url))
const output = { schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] }

function privateDir(home: string): string { return join(home, 'qianshou', 'private-seed-csv') }

async function installed(home: string, signal: AbortSignal): Promise<boolean> {
  try {
    await runPrivateOfficialCsvSeed(privateDir(home), { csv: 'column\nvalue' }, signal)
    return true
  } catch (error) {
    if (signal.aborted) throw error
    return false
  }
}

/** Register a discoverable offline seed without routing ordinary chat into a plugin flow. */
export function registerOfficialSeedCsvTools(ctx: Context, home: string,
  onInstalled?: () => Promise<void>): void {
  ctx.tools.register(defineTool({
    name: 'plugin_csv_profile_status',
    description: 'When the user asks whether this PC can inspect a CSV or what the example plugin does, read the exact bundled CSV profile plugin identity and current PRIVATE LOCAL installation state. This is one optional capability alongside ordinary conversation and distributed tasks; it does not install, buy, upload, publish, execute user CSV, or enable orders.',
    parameters: {}, output, isConcurrencySafe: () => true,
    async execute(_args, exec) {
      exec.signal.throwIfAborted()
      return JSON.stringify({ pluginId: CSV_SEED_IDENTITY.pluginId,
        operationId: CSV_SEED_IDENTITY.operationId, version: CSV_SEED_IDENTITY.version,
        packageSha256: CSV_SEED_IDENTITY.packageSha256,
        installedForOfflinePrivateTrial: await installed(home, exec.signal),
        marketAcquired: false, buyerLicenseVerified: false, dispatchable: false,
        scope: 'offline-private-trial',
        description: '本机可体检 CSV 的列、空值、数字/文本类型并预览前几行；仅使用本次提供的 CSV 文本。' })
    },
    presentCall: () => ({ card: 'generic', title: '查看本机 CSV 插件 · 只读', kind: 'read' }),
  }))
  ctx.tools.register(defineTool({
    name: 'plugin_csv_profile_install_private',
    description: 'Only when the owner explicitly asks to install the exact bundled qianshou.csv-profile@1.0.0 seed for OFFLINE PRIVATE self-use. No path, package URL, version, license, switch or approval result is accepted from the model. The Host rechecks the package and sample, then asks the real owner for one fresh one-shot approval. This is not a Guangzhou market acquisition, purchase, public plugin, Shanghai order executor or paid capability.',
    parameters: {}, output, timeoutMs: 60_000,
    async execute(_args, exec) {
      exec.signal.throwIfAborted()
      if (!exec.agent) throw new Error('QIANSHOU_CSV_SEED_AGENT_REQUIRED')
      if (await installed(home, exec.signal)) {
        return JSON.stringify({ installedForOfflinePrivateTrial: true, alreadyInstalled: true,
          marketAcquired: false, buyerLicenseVerified: false, dispatchable: false })
      }
      const approval = (ctx as unknown as { get(name: string): unknown }).get('approval') as
        { request(value: { agent: unknown; toolName: string; callId: unknown;
          reason: string; signal: AbortSignal }): Promise<string> } | undefined
      if (!approval || typeof approval.request !== 'function') {
        throw new Error('QIANSHOU_CSV_SEED_OWNER_APPROVAL_UNAVAILABLE')
      }
      await mkdir(privateDir(home), { recursive: true, mode: 0o700 })
      const installedPackage = await installPrivateOfficialCsvSeed({
        sourceArchivePath: BUNDLED_ARTIFACT, privateDir: privateDir(home), signal: exec.signal,
        approveOwner: async packageSha256 => (await approval.request({ agent: exec.agent,
          toolName: 'plugin_csv_profile_install_private', callId: exec.callId,
          signal: exec.signal,
          reason: `把千手官方 CSV 结构体检插件 ${CSV_SEED_IDENTITY.version}（包 SHA-256 ${packageSha256}）安装到这台电脑，仅供本机离线私有试用吗？它只处理你随后提供的 CSV 文本，不访问网络/工作区、不购买、不发布、不接上海订单。此授权仅限这一次安装。` })) === 'allowed-once',
      })
      await onInstalled?.()
      return JSON.stringify({ pluginId: installedPackage.identity.pluginId,
        operationId: installedPackage.identity.operationId,
        installedForOfflinePrivateTrial: true, samplePassed: installedPackage.samplePassed,
        marketAcquired: false, buyerLicenseVerified: false, dispatchable: false })
    },
    presentCall: () => ({ card: 'generic', title: '安装 CSV 插件 · 等待本次机主授权', kind: 'execute' }),
  }))
  ctx.tools.register(defineTool({
    name: 'plugin_csv_profile_run_private',
    description: 'Profile a CSV pasted by the owner using the already installed OFFLINE PRIVATE seed plugin. Use this only when the user asks to inspect the supplied CSV; do not install automatically. Returns column names, empty counts, numeric/text kinds and a small preview. No file scan, upload, market license, purchase, public order, model call or charge occurs.',
    parameters: {
      csv: { type: 'string', required: true, description: 'CSV text supplied in this conversation; at most 1 MiB.' },
      delimiter: { type: 'string', description: 'Optional comma, semicolon or tab; default comma.' },
      header: { type: 'boolean', description: 'Whether the first row contains column names; default true.' },
      sampleRows: { type: 'number', description: 'Preview 1 to 20 data rows; default 5.' },
    }, output,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const result = await runPrivateOfficialCsvSeed(privateDir(home), args, exec.signal)
      return JSON.stringify({ result, pluginId: CSV_SEED_IDENTITY.pluginId,
        operationId: CSV_SEED_IDENTITY.operationId, scope: 'offline-private-trial',
        marketAcquired: false, buyerLicenseVerified: false, dispatchable: false })
    },
    presentCall: () => ({ card: 'generic', title: '本机体检 CSV · 不上传', kind: 'execute' }),
  }))
}

/** Only the CEO and plugin creator presets mount this tool scope. */
export function apply(ctx: Context): void {
  const home = ctx.qianshouPluginCatalog.offlineCsvSeedHome()
  let refresh: (() => Promise<void>) | undefined
  ctx.inject(['computeCore'], scope => {
    const compute = scope.get('computeCore') as {
      registerHostPluginSampleAdapter(adapter: HostPluginSampleAdapter): () => void
    } | undefined
    if (!compute || typeof compute.registerHostPluginSampleAdapter !== 'function') return
    scope.effect(() => {
      const stopped = new AbortController()
      let released: (() => void) | undefined
      let disposed = false
      let queue = Promise.resolve()
      const refreshCurrent = (): Promise<void> => {
        queue = queue.then(async () => {
          if (disposed) return
          released?.()
          released = undefined
          try {
            const next = await registerInstalledCsvProfileSampleAdapter({
              workbench: { register: adapter => compute.registerHostPluginSampleAdapter(adapter) },
              privateDir: privateDir(home), signal: stopped.signal,
            })
            if (disposed) next()
            else released = next
          } catch {
            // Missing, damaged or expired private installation stays unavailable.
          }
        })
        return queue
      }
      refresh = refreshCurrent
      void refreshCurrent()
      const interval = setInterval(() => { void refreshCurrent() }, 20 * 60 * 1000)
      interval.unref()
      return async () => {
        disposed = true
        stopped.abort()
        clearInterval(interval)
        await queue
        released?.()
        if (refresh === refreshCurrent) refresh = undefined
      }
    }, 'qianshou-csv-sample-adapter: verify private install and revoke on disposal')
  })
  registerOfficialSeedCsvTools(ctx, home, async () => { await refresh?.() })
}
