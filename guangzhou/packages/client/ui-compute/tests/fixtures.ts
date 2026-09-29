import type { ComputeCapability, ComputeConnectionState, ComputePlanDraft } from '@deepseek-ai/dsh-compute-core/protocol'
export const capability = {
  id: 'image-process', name: '图片批处理', description: '根据已注册能力处理图片', delivery: 'remote', available: true,
} as ComputeCapability
export const status: ComputeConnectionState = {
  configured: true, capabilities: { workloadRead: true, quoting: false, submission: true }, message: '仅任务查询已接入',
}
export const draft = {
  id: 'draft-1', request: { capabilityId: capability.id, goal: '处理五张图片', budgetMinor: 150, currency: 'CNY', maxNodes: null },
  status: 'draft', createdAt: '2026-09-14T08:00:00.000Z', quote: null, authorization: 'pending', workloadId: null, reason: '报价与执行尚未接入',
} as ComputePlanDraft
export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
