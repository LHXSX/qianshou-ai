import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComputeCapabilityId, ComputeTaskId } from '../../src/protocol.ts'
import {
  createInlineSessionConsumer,
  unavailableIsolatedInlineRunner,
} from '../../src/resident/inline-session-consumer.ts'
import type { ComputeResidentAttemptExecution, ComputeResidentWorkspace } from '../../src/resident/types.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function envelope(inlineInput: string, maxOutputBytes = 4096) {
  return {
    version: 'qianshou.task.v1' as const,
    taskId: ComputeTaskId('workload-1.shard-1'),
    capabilityId: ComputeCapabilityId('word_count'),
    capabilityVersion: '1.0.0',
    inputRefs: [],
    parameters: { taskType: 'word_count', inlineInput, runtime: 'node' },
    deadlineAt: '2026-09-17T04:01:00.000Z',
    maxOutputBytes,
    idempotencyKey: 'a'.repeat(64),
  }
}

async function workspace(): Promise<ComputeResidentWorkspace> {
  const path = await mkdtemp(join(tmpdir(), 'qianshou-inline-session-'))
  roots.push(path)
  return { path, outputs: Object.freeze([]), close: async () => undefined }
}

function execution(inlineInput: string, maxOutputBytes?: number): ComputeResidentAttemptExecution {
  return {
    task: envelope(inlineInput, maxOutputBytes),
    attempt: {
      taskId: 'workload-1.shard-1',
      attempt: 1,
      leaseId: 'lease-1',
      leaseExpiresAt: '2026-09-17T04:01:00.000Z',
      idempotencyKey: 'a'.repeat(64),
      envelopeFingerprint: 'b'.repeat(64),
      capabilityId: 'word_count',
      capabilityVersion: '1.0.0',
      capabilityPluginDigest: 'c'.repeat(64),
    },
    signal: new AbortController().signal,
    reportProgress: async () => undefined,
    source: { open: async () => new ReadableStream() },
    dataSource: {},
  }
}

describe('inline isolated session consumer', () => {
  it('writes result.txt, remembers UTF-8 bytes and does not call a model', async () => {
    const remembered: { taskId: string; text: string; elapsedMs: number }[] = []
    const consumer = createInlineSessionConsumer({
      run: async ({ inlineInput }) => ({ text: `echo:${inlineInput}` }),
      rememberResult: (taskId, text, elapsedMs) => { remembered.push({ taskId, text, elapsedMs }) },
      clock: (() => {
        let value = 1_000
        return () => {
          const current = value
          value += 12
          return current
        }
      })(),
    })
    const dir = await workspace()
    const receipt = await consumer.consume({
      execution: execution('hello'),
      workspace: dir,
      signal: new AbortController().signal,
    })
    expect(await readFile(join(dir.path, 'result.txt'), 'utf8')).toBe('echo:hello')
    expect(receipt.outputs).toEqual([{
      name: 'result.txt',
      bytes: Buffer.byteLength('echo:hello'),
      sha256: createHash('sha256').update('echo:hello', 'utf8').digest('hex'),
    }])
    expect(remembered).toEqual([{ taskId: 'workload-1.shard-1', text: 'echo:hello', elapsedMs: 12 }])
  })

  it('refuses aborted signals, invalid parameters, invalid runner output and oversized text', async () => {
    const consumer = createInlineSessionConsumer({
      run: async () => ({ text: 'too-big' }),
      rememberResult: () => undefined,
    })
    const aborted = new AbortController()
    aborted.abort()
    await expect(consumer.consume({
      execution: execution('hello'),
      workspace: await workspace(),
      signal: aborted.signal,
    })).rejects.toMatchObject({ code: 'COMPUTE_INLINE_SESSION_ABORTED' })
    const attemptAborted = new AbortController()
    attemptAborted.abort()
    await expect(consumer.consume({
      execution: { ...execution('hello'), signal: attemptAborted.signal },
      workspace: await workspace(),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'COMPUTE_INLINE_SESSION_ABORTED' })
    await expect(consumer.consume({
      execution: { ...execution('hello'), task: { ...envelope('hello'), parameters: [] } },
      workspace: await workspace(),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'COMPUTE_INLINE_PARAMETERS_INVALID' })
    await expect(consumer.consume({
      execution: { ...execution('hello'), task: { ...envelope('hello'), parameters: null } },
      workspace: await workspace(),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'COMPUTE_INLINE_PARAMETERS_INVALID' })
    await expect(consumer.consume({
      execution: { ...execution('hello'), task: { ...envelope('hello'), parameters: { runtime: 'node' } } },
      workspace: await workspace(),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'COMPUTE_INLINE_PARAMETERS_INVALID' })
    const invalidResult = createInlineSessionConsumer({
      run: async () => ({ text: 1 } as unknown as { text: string }),
      rememberResult: () => undefined,
    })
    await expect(invalidResult.consume({
      execution: execution('hello'),
      workspace: await workspace(),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'COMPUTE_INLINE_RESULT_INVALID' })
    const nullResult = createInlineSessionConsumer({
      run: async () => null as unknown as { text: string },
      rememberResult: () => undefined,
    })
    await expect(nullResult.consume({
      execution: execution('hello'),
      workspace: await workspace(),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'COMPUTE_INLINE_RESULT_INVALID' })
    const rewind = createInlineSessionConsumer({
      run: async () => ({ text: 'ok' }),
      rememberResult: () => undefined,
      clock: (() => {
        let value = 50
        return () => {
          const current = value
          value -= 10
          return current
        }
      })(),
    })
    const receipt = await rewind.consume({
      execution: execution('hello'),
      workspace: await workspace(),
      signal: new AbortController().signal,
    })
    expect(receipt.outputs[0]?.name).toBe('result.txt')
    await expect(consumer.consume({
      execution: execution('hello', 3),
      workspace: await workspace(),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'COMPUTE_OUTPUT_LIMIT_EXCEEDED' })
  })

  it('reports start, repeats zero while the runner is still working, then reports done', async () => {
    const frames: { progress: number; phase: string }[] = []
    let release: (value: { text: string }) => void = () => undefined
    const consumer = createInlineSessionConsumer({
      run: () => new Promise(resolve => { release = resolve }),
      rememberResult: () => undefined,
      progressIntervalMs: 15,
      clock: () => 1_000,
    })
    const pending = consumer.consume({
      execution: {
        ...execution('hello'),
        reportProgress: async (progress, phase) => { frames.push({ progress, phase }) },
      },
      workspace: await workspace(),
      signal: new AbortController().signal,
    })
    await vi.waitFor(() => { expect(frames.some(frame => frame.phase === 'working')).toBe(true) })
    release({ text: 'done-text' })
    await pending
    expect(frames[0]).toEqual({ progress: 0, phase: 'started' })
    expect(frames.filter(frame => frame.phase === 'working').every(frame => frame.progress === 0)).toBe(true)
    expect(frames.at(-1)).toEqual({ progress: 1, phase: 'done' })
  })

  it('refuses without inventing output when the isolated runner is unbound', async () => {
    const consumer = createInlineSessionConsumer({
      run: unavailableIsolatedInlineRunner(),
      rememberResult: () => {
        throw new Error('must not remember a missing result')
      },
    })
    await expect(consumer.consume({
      execution: execution('hello'),
      workspace: await workspace(),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'COMPUTE_ISOLATED_SESSION_UNAVAILABLE' })
  })
})
