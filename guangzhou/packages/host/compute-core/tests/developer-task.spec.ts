import { describe, expect, it } from 'vitest'
import { ComputeCapabilityId } from '../src/protocol.ts'
import {
  DEVELOPER_TASK_CREATE_PATH,
  DEVELOPER_TASK_TIMEOUT_S,
  developerTaskCreateBody,
  developerTaskIntentRequest,
  yuanFromFen,
} from '../src/developer-task.ts'

const request = {
  capabilityId: ComputeCapabilityId('image.batch'),
  goal: '清理这批图片并保持原图尺寸。',
  budgetMinor: 50,
  currency: 'CNY' as const,
  maxNodes: 2,
}

const taskType = {
  taskType: 'image.batch',
  acceptedInputKinds: ['inline', 'single_file'],
  defaultInputKind: 'inline',
}

describe('developer task create body', () => {
  it('pins observed DeveloperTaskCreateIn fields and integer fen as a yuan decimal string', () => {
    const fields = developerTaskIntentRequest(request, taskType)
    expect(fields).toEqual({
      task_type: 'image.batch',
      input_kind: 'inline',
      input_ref: '',
      input_refs: [],
      inline_input: request.goal,
      params: {},
      name: '',
      budget: '0.50',
      timeout_s: DEVELOPER_TASK_TIMEOUT_S,
      max_shards: 2,
      auto_shard: true,
      callback_url: '',
      callback_secret: '',
    })
    expect(JSON.stringify(fields)).not.toContain('/api/v8/workloads')
    expect(developerTaskCreateBody(fields, 'a'.repeat(64)).idempotency_key).toHaveLength(64)
    expect(DEVELOPER_TASK_CREATE_PATH).toBe('/api/v8/developer/tasks')
  })

  it('uses one shard and disables auto-shard when concurrency is automatic', () => {
    expect(developerTaskIntentRequest({ ...request, maxNodes: null }, taskType)).toMatchObject({
      max_shards: 1, auto_shard: false, budget: '0.50',
    })
  })

  it.each([0, 1, 100, 101, 199])('keeps exact fen as two decimal digits: %s', (budgetMinor) => {
    expect(yuanFromFen(budgetMinor)).toBe(`${Math.trunc(budgetMinor / 100)}.${String(budgetMinor % 100).padStart(2, '0')}`)
  })

  it('refuses a catalogue row that does not accept inline conversation input', () => {
    expect(() => developerTaskIntentRequest(request, {
      taskType: 'image.batch', acceptedInputKinds: ['single_file'], defaultInputKind: 'single_file',
    })).toThrow('COMPUTE_INPUT_KIND_UNSUPPORTED')
  })

  it('refuses a catalogue row whose task type does not match the local capability', () => {
    expect(() => developerTaskIntentRequest(request, {
      ...taskType, taskType: 'video.batch',
    })).toThrow('COMPUTE_CAPABILITY_UNAVAILABLE')
  })

  it('rejects unsafe or negative fen', () => {
    expect(() => yuanFromFen(-1)).toThrow('INVALID_COMPUTE_FIELD')
    expect(() => yuanFromFen(1.5)).toThrow('INVALID_COMPUTE_FIELD')
  })

  it.each(['', 'x'.repeat(129)])('rejects an idempotency key outside 1–128 characters: %s', (key) => {
    const fields = developerTaskIntentRequest(request, taskType)
    expect(() => developerTaskCreateBody(fields, key)).toThrow('COMPUTE_SUBMISSION_INTENT_INVALID')
  })
})
