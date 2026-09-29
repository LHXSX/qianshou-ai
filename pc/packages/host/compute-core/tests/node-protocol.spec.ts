import { describe, expect, it } from 'vitest'
import { ComputeCapabilityId, ComputeTaskId, type ComputeTaskEnvelope } from '../src/protocol.ts'
import { ComputeNodeId, parseNodeHeartbeat, parseNodeTaskOffer, parseNodeTaskProgress, parseNodeTaskReturn } from '../src/node-protocol.ts'

const envelope: ComputeTaskEnvelope = { version: 'qianshou.task.v1', taskId: ComputeTaskId('task-node'), capabilityId: ComputeCapabilityId('image'), capabilityVersion: '1.0.0', inputRefs: [], parameters: { prompt: 'x' }, deadlineAt: '2026-09-14T12:10:00.000Z', maxOutputBytes: 1000, idempotencyKey: 'idem-node' }
describe('node control-plane protocol', () => {
  it('freezes a bounded heartbeat and capability advertisement', () => {
    const heartbeat = parseNodeHeartbeat({ version: 'qianshou.node.v1', nodeId: ComputeNodeId('node-1'), agentVersion: '1.0.0', sentAt: '2026-09-14T12:00:00.000Z', capabilities: [{ capabilityId: ComputeCapabilityId('image'), version: '1.0.0', pluginDigest: 'a'.repeat(64) }], maxConcurrency: 2, runningTasks: 0 })
    expect(Object.isFrozen(heartbeat)).toBe(true)
    expect(Object.isFrozen(heartbeat.capabilities)).toBe(true)
  })
  it('validates and freezes task offers without verifying the external signature', () => {
    const offer = parseNodeTaskOffer({ type: 'task.offer', envelope, attempt: 1, leaseExpiresAt: '2026-09-14T12:05:00.000Z', receivedAt: '2026-09-14T12:00:00.000Z', signature: 'sig-' + 'a'.repeat(20) })
    expect(offer.envelope.taskId).toBe('task-node')
    expect(Object.isFrozen(offer.envelope)).toBe(true)
  })
  it('fails closed for missing facts, invalid signatures, and malformed offers', () => {
    expect(() => parseNodeHeartbeat({ version: 'qianshou.node.v1', nodeId: 'node-1', agentVersion: '1.0.0', sentAt: '2026-09-14T12:00:00.000Z', capabilities: [], maxConcurrency: 1, runningTasks: 2 })).toThrow('COMPUTE_NODE_HEARTBEAT_INVALID')
    expect(() => parseNodeTaskOffer({ type: 'task.offer', envelope, attempt: 1, leaseExpiresAt: '2026-09-14T12:05:00.000Z', receivedAt: '2026-09-14T12:00:00.000Z', signature: 'short' })).toThrow('COMPUTE_NODE_TASK_OFFER_INVALID')
    expect(() => parseNodeHeartbeat({ version: 'qianshou.node.v1', nodeId: 'node-1', agentVersion: '1.0.0', sentAt: '2026-99-99T12:00:00.000Z', capabilities: [], maxConcurrency: 1, runningTasks: 0 })).toThrow('COMPUTE_NODE_TIMESTAMP_INVALID')
  })

  it('parses shared progress and return observations before a PC adapter forwards them', () => {
    const progress = parseNodeTaskProgress({ type: 'task.progress', taskId: 'task-node', attempt: 1, sequence: 2, progress: 0.5, phase: 'render' })
    expect(progress).toEqual({ type: 'task.progress', taskId: 'task-node', attempt: 1, sequence: 2, progress: 0.5, phase: 'render' })
    expect(Object.isFrozen(progress)).toBe(true)
    const returned = parseNodeTaskReturn({ type: 'task.return', taskId: 'task-node', attempt: 1, outputs: [{ name: 'result.png', bytes: 10, sha256: 'b'.repeat(64) }] })
    expect(returned.outputs[0]).toEqual({ name: 'result.png', bytes: 10, sha256: 'b'.repeat(64) })
    expect(Object.isFrozen(returned.outputs)).toBe(true)
    expect(() => parseNodeTaskProgress({ taskId: 'task-node', attempt: 1, sequence: 1, progress: 0, phase: 'x' })).toThrow('COMPUTE_NODE_PROGRESS_INVALID')
    expect(() => parseNodeTaskReturn({ type: 'task.return', taskId: 'task-node', attempt: 1, outputs: [{ name: 'x', bytes: -1, sha256: 'b'.repeat(64) }] })).toThrow('COMPUTE_NODE_RETURN_INVALID')
  })
})
