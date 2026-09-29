import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  courierAccepts, leaveOffer, runBoundedWorker, scoutLocalSuggestions, tryEnterOffer, verifyArtifactFile,
  OFFER_CONCURRENCY_LIMIT,
} from '../offer-roles.ts'

const document = JSON.stringify({
  status: 'ok', schema_version: 'v1', task_type: 'word_count', elapsed_ms: 1,
  summary: { input_bytes: 11, total_tokens: 3, unique_tokens: 2, top_n_returned: 2, jieba_enabled: false },
  result_lines: ['hello\t2', 'world\t1'],
})

describe('offer roles', () => {
  it('blocks a worker that claims success when the artifact cannot be read', async () => {
    const worker = { claimedOk: true as const, text: 'success' }
    const missing = await verifyArtifactFile(join(tmpdir(), 'qianshou-missing-artifact.txt'))
    expect(missing.outcome).toBe('undetermined')
    expect(courierAccepts(missing, worker.claimedOk)).toBe(false)
    const dir = await mkdtemp(join(tmpdir(), 'qianshou-artifact-'))
    const path = join(dir, 'result.txt')
    await writeFile(path, 'not-a-document')
    const unread = await verifyArtifactFile(path)
    expect(unread.outcome).toBe('undetermined')
    expect(courierAccepts(unread, true)).toBe(false)
  })

  it('does not treat an undetermined verdict as a pass', async () => {
    expect(courierAccepts({ outcome: 'undetermined' }, true)).toBe(false)
    expect(courierAccepts({ outcome: 'failed' }, true)).toBe(false)
    const dir = await mkdtemp(join(tmpdir(), 'qianshou-artifact-'))
    const path = join(dir, 'result.txt')
    await writeFile(path, document)
    const passed = await verifyArtifactFile(path)
    expect(passed.outcome).toBe('passed')
    expect(courierAccepts(passed, false)).toBe(true)
  })

  it('keeps the process after the worker throws and refuses a second concurrent offer', async () => {
    const crashed = await runBoundedWorker(async () => { throw new Error('worker down') })
    expect(crashed).toEqual({ claimedOk: false, crashed: true })
    expect(scoutLocalSuggestions(['ffmpeg']).mayOpenGate).toBe(false)
    // 钉「有界」，不钉具体数字：恰好上限个能进，第 (上限+1) 个必须被拒，释放后又能进。
    // 这样把上限调高（默认 4，可用 QIANSHOU_NODE_MAX_CONCURRENT 覆盖）不会让这条测试失效。
    const admitted: boolean[] = []
    for (let i = 0; i < OFFER_CONCURRENCY_LIMIT; i += 1) admitted.push(tryEnterOffer())
    expect(admitted.every(Boolean)).toBe(true)
    expect(tryEnterOffer()).toBe(false)
    leaveOffer()
    expect(tryEnterOffer()).toBe(true)
    for (let i = 0; i < OFFER_CONCURRENCY_LIMIT; i += 1) leaveOffer()
  })
})
