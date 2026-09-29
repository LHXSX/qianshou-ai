/** Account-owned records and reference; other provider credentials remain untouched. */
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { AccountFailure } from './protocol.ts'
import type { AccountStore } from './session.ts'

/** Dedicated reference used only by explicit account-backed Qianshou routes. */
export const ACCOUNT_ACCESS_REF = 'QIANSHOU_ACCOUNT_ACCESS_TOKEN'
const KEY = credentialKey('qianshou-account', 'session')
const REF = credentialRef(ACCOUNT_ACCESS_REF)

/**
 * Adapt the existing permission-protected development credential file.
 * @param credentials - Host credential provider owning its durable records.
 * @returns Storage operations restricted to this account plugin.
 */
export function accountStore(credentials: CredentialProvider): AccountStore {
  const writable = async (): Promise<void> => {
    if (!(await credentials.describe(REF)).writable) throw new AccountFailure('storage-failed')
  }
  return {
    async readRefresh() {
      const record = await credentials.readRecord(KEY)
      if (record === undefined) return null
      if (record.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null) throw new AccountFailure('storage-failed')
      const payload = record.payload as { version?: unknown; refresh?: unknown }
      if (payload.version !== 1 || (payload.refresh !== null && typeof payload.refresh !== 'string')) throw new AccountFailure('storage-failed')
      return payload.refresh
    },
    async write(refresh, access) {
      await writable()
      await credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: { version: 1, refresh } }))
      await credentials.set(REF, access)
    },
    async clear() {
      await credentials.deleteRecord(KEY)
      await writable()
      await credentials.unset(REF)
    },
  }
}
