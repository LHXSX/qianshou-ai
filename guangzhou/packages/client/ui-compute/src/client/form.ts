import type { ComputeCapability, ComputePlanRequest } from '@deepseek-ai/dsh-compute-core/protocol'

/** Page-owned strings preserve a user's unsaved budget and node entry. */
export interface PlanForm { capabilityId: string; goal: string; budget: string; nodeMode: 'auto' | 'manual'; nodes: string }
/** Convert decimal yuan exactly to integer minor units and bind only a current available capability. */
export function planRequest(form: PlanForm, capabilities: ComputeCapability[]): ComputePlanRequest | null {
  const capability = capabilities.find(item => item.id === form.capabilityId && item.available)
  if (!capability || !form.goal.trim() || form.goal.length > 8000 || form.goal.includes('\0') || !/^\d+(?:\.\d{1,2})?$/.test(form.budget)) return null
  const [whole = '', fraction = ''] = form.budget.split('.')
  const budgetMinor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  const maxNodes = form.nodeMode === 'auto' ? null : Number(form.nodes)
  if (!Number.isSafeInteger(budgetMinor) || budgetMinor < 0
    || (maxNodes !== null && (!/^\d+$/.test(form.nodes) || !Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 64))) return null
  return { capabilityId: capability.id, goal: form.goal.trim(), budgetMinor, currency: 'CNY', maxNodes }
}
