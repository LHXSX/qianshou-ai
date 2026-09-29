import { describe, expect, it, vi } from 'vitest'
import { QianshouCoreClient } from '../src/core-client.ts'
import type { DeveloperTaskCreateBody } from '../src/developer-task.ts'

const body: DeveloperTaskCreateBody = {
  task_type: 'case_digest', input_kind: 'multi_file', input_ref: '', input_refs: ['v8/account-167/developer/test/input/sample.pptx'],
  inline_input: null, params: {}, name: '', budget: '0.00', quote_token: null,
  timeout_s: 300, max_shards: 1, auto_shard: false, idempotency_key: 'a'.repeat(64), callback_url: '', callback_secret: '',
}

function client(response: Response) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response)
  return { fetcher, core: new QianshouCoreClient({ baseUrl: 'https://core.example.test', timeoutMs: 500,
    maxResponseBytes: 32000 }, () => 'test-access', fetcher) }
}

describe('estimate tariff failures', () => {
  it.each([
    ['当前任务尚未配置服务端价目，暂不能报价', 'COMPUTE_TASK_PRICING_UNAVAILABLE'],
    ['已审核任务缺少人民币价目，不能报价', 'COMPUTE_TASK_PRICING_UNAVAILABLE'],
    ['官方能力缺少人民币价目，不能报价', 'COMPUTE_TASK_PRICING_UNAVAILABLE'],
    ['当前任务没有有效的正数服务端价格，暂不能报价', 'COMPUTE_TASK_PRICING_INVALID'],
    ['官方能力人民币价目必须为正数', 'COMPUTE_TASK_PRICING_INVALID'],
    ['人民币任务价目重复', 'COMPUTE_TASK_PRICING_INVALID'],
  ])('classifies the exact admitted server message %s without issuing a task', async (message, code) => {
    const { core, fetcher } = client(new Response(JSON.stringify({ ok: false, code: 'BAD_REQUEST', message,
      trace_id: 'discard', credentials: 'discard' }), { status: 400 }))
    await expect(core.estimateDeveloperTask(body)).rejects.toMatchObject({ code, message: code, status: 400 })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[0]).toEqual(new URL('https://core.example.test/api/v8/developer/tasks/estimate'))
    await core.close()
  })

  it.each([
    JSON.stringify({ message: 'credential=test-access; private backend detail' }),
    JSON.stringify({ message: '当前任务尚未配置服务端价目，暂不能报价 extra' }),
    JSON.stringify({ message: 'x'.repeat(4097) }),
    'not-json',
  ])('retains a safe HTTP failure for arbitrary or oversized bodies', async (text) => {
    const { core } = client(new Response(text, { status: 400 }))
    await expect(core.estimateDeveloperTask(body)).rejects.toMatchObject({
      code: 'CORE_HTTP_400', message: 'CORE_HTTP_400', status: 502,
    })
    await core.close()
  })

  it('keeps task-create HTTP400 separate from an estimate-only classification', async () => {
    const { core } = client(new Response(JSON.stringify({ message: '当前任务尚未配置服务端价目，暂不能报价' }), { status: 400 }))
    await expect(core.createDeveloperTask(body)).rejects.toMatchObject({ code: 'CORE_HTTP_400', status: 502 })
    await core.close()
  })
})
