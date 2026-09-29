/** Session-only money recovery survives route remounts; it never retains an apply token or resubmits a write. */
import { watch } from 'vue'
import { session } from '@/session/store'
import type { WorkbenchAction, WorkbenchPreview } from './workbench'
interface Recovery {
  readonly ref: string
  readonly diff: WorkbenchPreview['diff']
}
const pending = new Map<WorkbenchAction, Recovery>()
watch(() => session.admin?.accountId, () => { pending.clear() }, { flush: 'sync' })
/** Copy only the normalized business payload and owner preview; deliberately omit token and expiry. */
export function rememberWorkbenchOperation(action: WorkbenchAction, preview: WorkbenchPreview): void {
  if (!session.admin) return
  pending.set(action, { ref: String(preview.diff.after.ref), diff: JSON.parse(JSON.stringify(preview.diff)) as WorkbenchPreview['diff'] })
}
export function workbenchRecovery(action: WorkbenchAction): Recovery | undefined {
  const value = pending.get(action)
  return value === undefined ? undefined : structuredClone(value)
}
/** An old response cannot clear a later operation or an operation belonging to a replacement identity. */
export function completeWorkbenchRecovery(action: WorkbenchAction, ref: string, operator: string): void {
  if (session.admin?.accountId === operator && pending.get(action)?.ref === ref) pending.delete(action)
}
