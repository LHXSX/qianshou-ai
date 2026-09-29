/** Reuse the authenticated account worker directory; a reported URL grants no PC-session access. */
import type { AccountClient, AccountWorker } from '@deepseek-ai/dsh-client-account'
import type { PcWindowPort } from '@deepseek-ai/dsh-client-pc-window-bridge'
import type { AccountPc, AccountPcDirectoryPort } from './mobile-workspace-types.ts'

/** Inputs for converting account-owned workers into selectable PCs. */
export interface AccountPcDirectoryOptions {
  readonly account: Pick<AccountClient, 'listWorkers'>
  readonly now: () => number
  readonly onlineWithinMs: number
  /** Resolve an authenticated transport after verifying ownership; never trust window_origin alone. */
  readonly authorize: (worker: AccountWorker, accountId: string, signal: AbortSignal) => Promise<PcWindowPort>
}

/**
 * Consume the shared account client while keeping relay authorization explicit.
 * @param options - Account API, heartbeat freshness and authorized gateway resolver.
 * @returns Directory whose successful empty result is distinct from a rejected lookup.
 */
export function createAccountPcDirectory(options: AccountPcDirectoryOptions): AccountPcDirectoryPort {
  if (!Number.isFinite(options.onlineWithinMs) || options.onlineWithinMs <= 0) throw new Error('MOBILE_PC_FRESHNESS_INVALID')
  let workers = new Map<string, AccountWorker>()
  let owner: string | null = null
  let latestRequest = 0
  return {
    list: async (accountId, signal) => {
      signal.throwIfAborted()
      const request = ++latestRequest
      const rows = await options.account.listWorkers()
      signal.throwIfAborted()
      if (rows.some(row => row.owner_id === null || String(row.owner_id) !== accountId)) throw new Error('MOBILE_DIRECTORY_ACCOUNT_MISMATCH')
      const pcs: AccountPc[] = []
      const found = new Map<string, AccountWorker>()
      for (const row of rows) {
        const os = row.os?.toLowerCase()
        const platform = os === 'windows' || os === 'win32' ? 'windows' : os === 'darwin' || os === 'macos' ? 'macos' : null
        if (platform === null) continue
        if (found.has(row.id)) throw new Error('MOBILE_DIRECTORY_DUPLICATE_PC')
        const seenAt = Date.parse(row.last_seen ?? '')
        const age = options.now() - seenAt
        pcs.push({ accountId, pcId: row.id, label: row.name ?? row.hostname ?? row.id, platform,
          online: row.status?.toLowerCase() === 'online' && Number.isFinite(age) && age >= 0 && age <= options.onlineWithinMs })
        found.set(row.id, row)
      }
      if (request === latestRequest) { workers = found; owner = accountId }
      return pcs
    },
    connect: async (pc, signal) => {
      signal.throwIfAborted()
      const worker = workers.get(pc.pcId)
      if (owner !== pc.accountId || worker === undefined) throw new Error('MOBILE_PC_NOT_DISCOVERED')
      return options.authorize(worker, pc.accountId, signal)
    },
  }
}
