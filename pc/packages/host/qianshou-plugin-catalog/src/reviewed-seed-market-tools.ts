/** Scoped natural-conversation entry for the exact Guangzhou-reviewed free CSV seed.
 *
 * No tool argument can choose an origin, release, archive, license, approval or order policy.
 * The normal catalog remains read-only; this path writes only an account-bound private receipt.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { lstat, mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { CSV_SEED_IDENTITY } from './official-seed-csv.ts'
import { acquireReviewedSeedCsvFromMarket, reviewedSeedClaimAuthChannel,
  type ReviewedSeedAccountCarrier } from './reviewed-seed-consumer.ts'
import { installReviewedSeedCsvForOwner, runReviewedSeedCsvForOwner } from './reviewed-seed-install.ts'
import type { ReviewedSeedHostConfig } from './index.ts'

export const name = 'qianshou-reviewed-seed-market-tools'
export const inject = ['tools', 'qianshouPluginCatalog']

const output = { schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] }
const RECEIPT_NAME = 'market-qianshou.csv-profile-1.0.0.json'
const SAMPLE = { csv: '列\n样例' }

type HostContext = Context & { get(name: string, strict?: boolean): unknown }
type AccountState = { state(): Promise<{ phase: string; account: { id: string } | null }> }
type AccountSession = { ensureAccessToken(): Promise<string | null> }

function connection(ctx: Context): ReviewedSeedHostConfig {
  const configured = ctx.qianshouPluginCatalog.reviewedSeedHostConfig()
  if (configured === null) throw new Error('QIANSHOU_MARKET_CSV_NOT_CONFIGURED')
  return configured
}

async function checkedChannel(config: ReviewedSeedHostConfig, account: ReviewedSeedAccountCarrier,
  signal: AbortSignal): Promise<void> {
  if (await reviewedSeedClaimAuthChannel({ apiBaseUrl: config.apiBaseUrl,
    account, signal, timeoutMs: config.timeoutMs }) !== 'verified') {
    throw new Error('QIANSHOU_MARKET_CSV_CLAIM_AUTH_UNVERIFIED')
  }
}

function carrier(ctx: Context): ReviewedSeedAccountCarrier {
  const account = (ctx as HostContext).get('qianshouAccount', false) as AccountState | undefined
  const session = (ctx as HostContext).get('accountSession', false) as AccountSession | undefined
  if (account === undefined || typeof account.state !== 'function'
    || session === undefined || typeof session.ensureAccessToken !== 'function') {
    throw new Error('QIANSHOU_MARKET_CSV_ACCOUNT_UNAVAILABLE')
  }
  return { snapshot: () => account.state(), ensureAccessToken: () => session.ensureAccessToken() }
}

function paths(home: string): { stage: string; installed: string } {
  const root = join(home, 'qianshou', 'reviewed-seed-csv')
  return { stage: join(root, 'stage'), installed: join(root, 'private') }
}

async function preparePrivatePaths(home: string): Promise<{ stage: string; installed: string }> {
  const result = paths(home)
  await mkdir(result.stage, { recursive: true, mode: 0o700 })
  await mkdir(result.installed, { recursive: true, mode: 0o700 })
  // The consumer and installer repeat lstat/realpath/mode checks before using either directory.
  return result
}

async function hasReceipt(privateDir: string): Promise<boolean> {
  try { await lstat(join(privateDir, RECEIPT_NAME)); return true }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function license(config: ReviewedSeedHostConfig, account: ReviewedSeedAccountCarrier,
  signal: AbortSignal) {
  return { apiBaseUrl: config.apiBaseUrl, publisherKeys: config.publisherKeys,
    operatorKeys: config.operatorKeys, timeoutMs: config.timeoutMs, account, signal }
}

/** Register only in the CEO and plugin-creator preset realms. */
export function registerReviewedSeedMarketTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'plugin_csv_market_status',
    description: 'When asked about the official Guangzhou CSV plugin, distinguish configured trust roots, signed public release metadata, local account presence and the request-bound free-claim identity carrier. A signed release is not a working claim. This read-only tool does not claim, install, read user CSV or enable orders.',
    parameters: {}, output, isConcurrencySafe: () => true,
    execute: async (_args, exec) => {
      exec.signal.throwIfAborted()
      const status = await ctx.qianshouPluginCatalog.officialCsvSeedStatus()
      const configured = ctx.qianshouPluginCatalog.reviewedSeedHostConfig() !== null
      return JSON.stringify({ pluginId: CSV_SEED_IDENTITY.pluginId,
        operationId: CSV_SEED_IDENTITY.operationId, releaseId: CSV_SEED_IDENTITY.releaseId,
        version: CSV_SEED_IDENTITY.version, packageSha256: CSV_SEED_IDENTITY.packageSha256,
        marketConfigReady: configured,
        accountSignedIn: status.accountSignedIn,
        signedReleaseVerified: status.signedReleaseVerified,
        claimAuthChannelVerified: status.claimAuthChannelVerified, claimStatus: status.phase,
        buyerLicenseVerified: false, installedForCurrentAccount: 'unknown',
        dispatchable: false, scope: 'private-self-use-only' })
    },
    presentCall: () => ({ card: 'generic', title: '查看官方 CSV 插件状态 · 只读', kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'plugin_csv_market_install_free',
    description: 'Only when the signed-in owner explicitly asks to FREE-CLAIM and install the exact Guangzhou-reviewed qianshou.csv-profile@1.0.0. Check plugin_csv_market_status first; Host denies execution until Guangzhou verifies this request Bearer identity. Then Host rechecks the online free claim, signed release and exact package bytes/sample and asks the owner once for the exact account, version and digest. This installs only for private use, never enables orders. No URL, package, token, license or approval argument is accepted.',
    parameters: {}, output, timeoutMs: 300_000,
    async execute(_args, exec) {
      exec.signal.throwIfAborted()
      if (!exec.agent) throw new Error('QIANSHOU_MARKET_CSV_AGENT_REQUIRED')
      const config = connection(ctx)
      const account = carrier(ctx)
      await checkedChannel(config, account, exec.signal)
      const path = await preparePrivatePaths(config.home)
      const liveLicense = license(config, account, exec.signal)
      if (await hasReceipt(path.installed)) {
        // A present but wrong-account, damaged or revoked install is not silently replaced.
        await runReviewedSeedCsvForOwner({ privateDir: path.installed,
          license: liveLicense, input: SAMPLE, signal: exec.signal })
        return JSON.stringify({ pluginId: CSV_SEED_IDENTITY.pluginId,
          operationId: CSV_SEED_IDENTITY.operationId, version: CSV_SEED_IDENTITY.version,
          alreadyInstalled: true, installedForCurrentAccount: true,
          buyerLicenseVerified: true, scope: 'account-bound-private', dispatchable: false })
      }
      const approval = (ctx as HostContext).get('approval', false) as { request(value: {
        agent: unknown; toolName: string; callId: unknown; reason: string;
        signal: AbortSignal }): Promise<string> } | undefined
      if (approval === undefined || typeof approval.request !== 'function') {
        throw new Error('QIANSHOU_MARKET_CSV_OWNER_APPROVAL_UNAVAILABLE')
      }
      const candidate = await acquireReviewedSeedCsvFromMarket({ ...liveLicense,
        stagingDir: path.stage })
      try {
        const installed = await installReviewedSeedCsvForOwner({ candidate,
          license: liveLicense, privateDir: path.installed, signal: exec.signal,
          approveOwner: async (identity, signal) => (await approval.request({
            agent: exec.agent, toolName: 'plugin_csv_market_install_free',
            callId: exec.callId, signal,
            reason: `将广州免费领取的千手官方 CSV 结构体检插件 ${identity.version} 安装到此电脑供账号 ${identity.accountId} 私有自用吗？发布编号 ${identity.releaseId}，包 SHA-256 ${identity.packageSha256}。安装前已核对发布者与广州审核签名、包及样例；安装后每次使用仍会在线核验账号许可和包。不会购买、扣费、发布或开启接单。本次仅授权这一次安装。`,
          })) === 'allowed-once',
        })
        return JSON.stringify({ pluginId: installed.pluginId,
          operationId: CSV_SEED_IDENTITY.operationId, version: installed.version,
          releaseId: installed.releaseId, packageSha256: installed.packageSha256,
          installedForCurrentAccount: true, buyerLicenseVerified: true,
          samplePassed: true, scope: installed.scope, dispatchable: installed.dispatchable })
      } finally { await unlink(candidate.archivePath).catch(() => undefined) }
    },
    presentCall: () => ({ card: 'generic', title: '免费领取并安装 CSV 插件 · 等待机主授权', kind: 'execute' }),
  }))

  ctx.tools.register(defineTool({
    name: 'plugin_csv_market_run_private',
    description: 'Profile CSV text pasted by the owner with the exact reviewed Guangzhou seed already installed for THIS account. Host reclaims the free license online and rechecks receipt plus exact package bytes before each run. No path, URL, token, package choice, publication or external order input; no automatic install. Never present the bundled offline trial as a market license.',
    parameters: {
      csv: { type: 'string', required: true, description: 'CSV text supplied in this conversation; at most 1 MiB.' },
      delimiter: { type: 'string', description: 'Optional comma, semicolon or tab; default comma.' },
      header: { type: 'boolean', description: 'Whether the first row contains column names; default true.' },
      sampleRows: { type: 'number', description: 'Preview 1 to 20 data rows; default 5.' },
    }, output,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const config = connection(ctx)
      const account = carrier(ctx)
      await checkedChannel(config, account, exec.signal)
      const result = await runReviewedSeedCsvForOwner({
        privateDir: paths(config.home).installed,
        license: license(config, account, exec.signal), input: args, signal: exec.signal,
      })
      return JSON.stringify({ result, pluginId: CSV_SEED_IDENTITY.pluginId,
        operationId: CSV_SEED_IDENTITY.operationId, version: CSV_SEED_IDENTITY.version,
        scope: 'account-bound-private', buyerLicenseVerified: true, dispatchable: false })
    },
    presentCall: () => ({ card: 'generic', title: '运行已领取的 CSV 插件 · 本机私用', kind: 'execute' }),
  }))
}

export function apply(ctx: Context): void { registerReviewedSeedMarketTools(ctx) }
