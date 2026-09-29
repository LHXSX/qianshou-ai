import { describe, expect, it } from 'vitest'
import {
  createIsolatedInlineRunner,
  hasIsolatedInlineRunner,
  runnerOwnedCapabilityIds,
  ISOLATED_INLINE_TASK_TYPES,
} from '../../src/resident/isolated-inline-runner.ts'

/** Parse the JSON document the runner returns (it becomes `result.txt` and the Edge inline output). */
function wordCountOf(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>
}

/** The document that carries a specialist reply back through this landing. */
function carry(reply: string): string {
  return JSON.stringify({
    status: 'ok',
    schema_version: 'v1',
    task_type: 'word_count',
    summary_text: reply,
    result_lines: [reply],
  })
}

describe('isolated inline runners', () => {
  /**
   * 判据来源（都是实测，不是猜）：
   * - `GET /api/v8/scripts/word_count.py/source`（只读，2026-09-17）：平台自己的执行器输出
   *   `{status, schema_version, task_type, elapsed_ms, summary{input_bytes,total_tokens,
   *   unique_tokens,top_n_returned,jieba_enabled}, result_lines:["token\tcount",…]}`；
   * - AT-01 记录的期望值：`alpha beta alpha gamma beta alpha` → alpha 3 / beta 2 / gamma 1（共 6）；
   * - AT-15/AT-02 的平台原始 `output_ref`：同一形状，`result_lines` 逐行 `token\tcount`。
   */
  it('returns the scheduler-shaped word_count document instead of a bare number', async () => {
    const run = createIsolatedInlineRunner()
    expect(ISOLATED_INLINE_TASK_TYPES).toEqual(['word_count'])
    expect(hasIsolatedInlineRunner('word_count')).toBe(true)
    expect(hasIsolatedInlineRunner('text.transform')).toBe(true)
    expect(hasIsolatedInlineRunner('base64_decode')).toBe(false)
    expect(hasIsolatedInlineRunner('ocr_image')).toBe(false)
    const output = wordCountOf((await run({
      taskType: 'word_count',
      inlineInput: 'alpha beta alpha gamma beta alpha',
      signal: new AbortController().signal,
    })).text)
    expect(output).toMatchObject({
      status: 'ok',
      schema_version: 'v1',
      task_type: 'word_count',
      summary: {
        input_bytes: 33,
        total_tokens: 6,
        unique_tokens: 3,
        top_n_returned: 3,
        jieba_enabled: false,
      },
      result_lines: ['alpha\t3', 'beta\t2', 'gamma\t1'],
    })
    expect(Number.isSafeInteger(output.elapsed_ms)).toBe(true)
    expect(output.elapsed_ms as number).toBeGreaterThanOrEqual(0)
  })

  it('keeps first-seen order for equal counts and treats blank input as an empty result', async () => {
    const run = createIsolatedInlineRunner()
    expect(wordCountOf((await run({
      taskType: 'word_count', inlineInput: 'count these words', signal: new AbortController().signal,
    })).text).result_lines).toEqual(['count\t1', 'these\t1', 'words\t1'])
    // 没有 jieba：中文串整段算一个词，与平台脚本在 HAS_JIEBA=False 时的行为一致。
    expect(wordCountOf((await run({
      taskType: 'word_count', inlineInput: '  一个 两个  ', signal: new AbortController().signal,
    })).text)).toMatchObject({
      summary: { total_tokens: 2, unique_tokens: 2, jieba_enabled: false },
      result_lines: ['一个\t1', '两个\t1'],
    })
    expect(wordCountOf((await run({
      taskType: 'word_count', inlineInput: '   ', signal: new AbortController().signal,
    })).text)).toMatchObject({
      summary: { total_tokens: 0, unique_tokens: 0, top_n_returned: 0 },
      result_lines: [],
    })
  })

  it('lowercases like the platform script, so Alpha and alpha are one token', async () => {
    const run = createIsolatedInlineRunner()
    expect(wordCountOf((await run({
      taskType: 'word_count', inlineInput: 'Alpha alpha ALPHA beta', signal: new AbortController().signal,
    })).text)).toMatchObject({
      summary: { total_tokens: 4, unique_tokens: 2 },
      result_lines: ['alpha\t3', 'beta\t1'],
    })
  })

  it('refuses aborted signals and types this process cannot run', async () => {
    const run = createIsolatedInlineRunner()
    const aborted = new AbortController()
    aborted.abort()
    await expect(run({
      taskType: 'word_count',
      inlineInput: 'hello',
      signal: aborted.signal,
    })).rejects.toMatchObject({ code: 'COMPUTE_INLINE_SESSION_ABORTED' })
    await expect(run({
      taskType: 'ocr_image',
      inlineInput: 'hello',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'COMPUTE_ISOLATED_SESSION_UNAVAILABLE' })
    await expect(run({
      taskType: 'base64_decode',
      inlineInput: 'hello',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'COMPUTE_ISOLATED_SESSION_UNAVAILABLE' })
  })

  it('runs the semantic id through the word_count landing and keeps the scheduler task_type', async () => {
    const run = createIsolatedInlineRunner()
    const output = wordCountOf((await run({
      taskType: 'text.transform',
      inlineInput: 'alpha beta alpha',
      signal: new AbortController().signal,
    })).text)
    expect(output).toMatchObject({
      task_type: 'word_count',
      summary: { total_tokens: 3, unique_tokens: 2 },
      result_lines: ['alpha\t2', 'beta\t1'],
    })
  })

  it('dispatches listed agent types through the injected session', async () => {
    const agent = {
      run: async (input: { taskType: string; inlineInput: string; signal: AbortSignal }) => {
        expect(input.taskType).toBe('ocr_image')
        expect(input.inlineInput).toBe('read this')
        return { text: 'no files' }
      },
    }
    expect(hasIsolatedInlineRunner('ocr_image', ['ocr_image'])).toBe(true)
    expect(runnerOwnedCapabilityIds(['word_count'])).toEqual(['text.transform'])
    expect(runnerOwnedCapabilityIds(['text.transform'])).toEqual(['text.transform'])
    expect(runnerOwnedCapabilityIds(['word_count', 'base64_decode'])).toEqual(['text.transform'])
    expect(runnerOwnedCapabilityIds(['ocr_image'])).toEqual([])
    expect(runnerOwnedCapabilityIds(['ocr_image'], ['ocr_image'])).toEqual([])
    expect(runnerOwnedCapabilityIds([])).toEqual([])
    const published = await import('../../src/index.ts')
    expect(published.runnerOwnedCapabilityIds(['word_count'])).toEqual(['text.transform'])
    const run = createIsolatedInlineRunner({ agent, agentTaskTypes: ['ocr_image'] })
    expect(await run({
      taskType: 'ocr_image',
      inlineInput: 'read this',
      signal: new AbortController().signal,
    })).toEqual({ text: 'no files' })
    await expect(run({
      taskType: 'media.transcode',
      inlineInput: 'x',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'COMPUTE_ISOLATED_SESSION_UNAVAILABLE' })
  })

  it('returns the agent reply for a listed word_count assignment', async () => {
    let seen = ''
    const run = createIsolatedInlineRunner({
      agent: {
        run: async (input: { inlineInput: string }) => {
          seen = input.inlineInput
          return { text: 'four words' }
        },
      },
      agentTaskTypes: ['word_count'],
    })
    await expect(run({
      taskType: 'word_count', inlineInput: '给我出一个图片', signal: new AbortController().signal,
    })).resolves.toEqual({ text: carry('four words') })
    expect(seen).toBe('给我出一个图片')
  })

  it('sends the semantic id to the listed word_count agent instead of the local counter', async () => {
    let seen = ''
    const run = createIsolatedInlineRunner({
      agent: {
        run: async (input: { taskType: string }) => {
          seen = input.taskType
          return { text: '画好了' }
        },
      },
      agentTaskTypes: ['word_count'],
    })
    await expect(run({
      taskType: 'text.transform', inlineInput: 'alpha beta alpha', signal: new AbortController().signal,
    })).resolves.toEqual({ text: carry('画好了') })
    expect(seen).toBe('text.transform')
  })
})
