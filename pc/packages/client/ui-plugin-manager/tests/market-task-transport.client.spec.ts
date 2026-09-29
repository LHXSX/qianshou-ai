import { expect, it, vi } from 'vitest'
import { createMarketTaskTransport } from '../src/client/market-task-transport.ts'

it.each([null, 0, 0.25, 1])('preserves exact workload progress %s and a qualified server creation time', async (progress) => {
  const row = { id: 'workload_123', status: 'RUNNING', resultAvailable: false,
    executionStage: 'executing', progress, createdAt: '2026-09-26T14:00:00Z' }
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(row))
  expect(await createMarketTaskTransport(fetcher, 'http://127.0.0.1:3180/')
    .readWorkload(row.id, new AbortController().signal)).toEqual(row)
})

it.each([-0.1, 1.01, '50%', {}, false])('rejects invalid workload progress %s', async (progress) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'workload_123', status: 'RUNNING',
    resultAvailable: false, progress }))
  await expect(createMarketTaskTransport(fetcher, 'http://127.0.0.1:3180/')
    .readWorkload('workload_123', new AbortController().signal)).rejects.toThrow('MARKET_TASK_INVALID_RESPONSE')
})

it.each(['invalid', '2026-09-26T14:00:00', 123])('rejects an ambiguous workload creation time %s', async (createdAt) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'workload_123', status: 'RUNNING',
    resultAvailable: false, createdAt }))
  await expect(createMarketTaskTransport(fetcher, 'http://127.0.0.1:3180/')
    .readWorkload('workload_123', new AbortController().signal)).rejects.toThrow('MARKET_TASK_INVALID_RESPONSE')
})

it('loads a complete catalog larger than a single task result while retaining a bounded catalog limit', async () => {
  const rows = Array.from({ length: 80 }, (_, index) => ({ taskType: `skill_${index}`,
    acceptedInputKinds: ['inline'], requiredParams: [], canQuoteInline: true, formReady: true,
    inputSchema: { oneOf: [{ properties: { input_kind: { const: 'inline' },
      inline_input: { type: 'string', description: 'schema metadata '.repeat(80) } } }] },
    paramsSchema: { type: 'object', additionalProperties: false, required: [], properties: {} },
  }))
  expect(JSON.stringify(rows).length).toBeGreaterThan(64 * 1024)
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(rows))
  expect(await createMarketTaskTransport(fetcher, 'http://127.0.0.1:3180/')
    .taskTypes(new AbortController().signal)).toHaveLength(80)
  fetcher.mockImplementation(async () => new Response(' '.repeat(1024 * 1024 + 1)))
  await expect(createMarketTaskTransport(fetcher, 'http://127.0.0.1:3180/')
    .taskTypes(new AbortController().signal)).rejects.toThrow('MARKET_TASK_INVALID_RESPONSE')
})

it('renders a newly declared scalar parameter and forwards it as data, without a category-specific client branch', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json([{ taskType: 'custom_scan_v1',
    acceptedInputKinds: ['inline'], requiredParams: ['keyword'], canQuoteInline: true, formReady: true,
    paramsSchema: { type: 'object', additionalProperties: false, required: ['keyword'],
      properties: { keyword: { type: 'string', title: '关键词', minLength: 1, maxLength: 120 } } },
  }])).mockResolvedValueOnce(Response.json({ id: 'plan_123' }))
    .mockResolvedValueOnce(Response.json({ id: 'plan_123', authorization: 'approved', workloadId: null }))
  const transport = createMarketTaskTransport(fetcher, 'http://127.0.0.1:3180/')
  const types = await transport.taskTypes(new AbortController().signal)
  expect(types[0]).toMatchObject({ canQuoteInline: true,
    paramFields: [{ name: 'keyword', title: '关键词', required: true, maxLength: 120 }] })
  await transport.createPlan('custom_scan_v1', '扫描文本', new AbortController().signal, { keyword: '合同' })
  expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
    capabilityId: 'custom_scan_v1', goal: '扫描文本', params: { keyword: '合同' }, currency: 'CNY',
  })
})

it('forwards an exact selected product to the Host plan without changing generic calls', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ id: 'plan_123' }))
    .mockResolvedValueOnce(Response.json({ id: 'plan_123', authorization: 'approved', workloadId: null }))
  const selected = { productId: '11111111-2222-4333-8444-555555555555',
    publicationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', ownerId: 167, version: '1.2' }
  await createMarketTaskTransport(fetcher, 'http://127.0.0.1:3180/')
    .createPlan('seller_product_v1', '给我处理', new AbortController().signal,
      {}, undefined, undefined, selected)
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
    capabilityId: 'seller_product_v1', expectedProduct: selected,
  })
})

it('derives a prompt and fixed JSON fields from a reviewed inline form without task-type branching', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json([{
    taskType: 'image.generate', acceptedInputKinds: ['inline'],
    requiredParams: ['output_format'], canQuoteInline: true, formReady: true,
    paramsSchema: { type: 'object', additionalProperties: false, required: ['output_format'],
      properties: { output_format: { type: 'string', enum: ['png'], title: '输出格式' } } },
    inputSchema: { oneOf: [{ type: 'object', additionalProperties: false,
      properties: { input_kind: { const: 'inline' }, inline_input: {
        type: 'string', title: '出图文字与尺寸', contentMediaType: 'application/json',
        contentSchema: { type: 'object', additionalProperties: false,
          required: ['prompt', 'model', 'size'], properties: {
            prompt: { type: 'string', title: '想画什么？', minLength: 1, maxLength: 8000 },
            model: { const: 'grok-4.6' }, size: { const: '1280x720' },
          } },
      } } }] },
  }]))
  const [type] = await createMarketTaskTransport(fetcher, 'http://127.0.0.1:3180/')
    .taskTypes(new AbortController().signal)
  expect(type).toMatchObject({ canQuoteInline: true,
    paramFields: [{ name: 'output_format', choices: ['png'], required: true }],
    inlineForm: { mediaType: 'application/json', template: {
      field: 'prompt', title: '想画什么？', constants: { model: 'grok-4.6', size: '1280x720' },
    } } })
})

it('retains a legacy JSON declaration and its actual length bounds without inventing fields', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json([{
    taskType: 'arbitrary_legacy_v1', acceptedInputKinds: ['inline'], requiredParams: [],
    canQuoteInline: true, formReady: true,
    inputSchema: { oneOf: [{ properties: { input_kind: { const: 'inline' },
      inline_input: { type: 'string', title: '输入 JSON', contentMediaType: 'application/json', minLength: 4, maxLength: 16384 },
    } }] },
  }]))
  const [type] = await createMarketTaskTransport(fetcher, 'http://127.0.0.1:3180/').taskTypes(new AbortController().signal)
  expect(type?.inlineForm).toEqual({ title: '输入 JSON', mediaType: 'application/json', minLength: 4, maxLength: 16384 })
})

it('records an unsupported declared JSON schema instead of treating it as an absent declaration', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json([{
    taskType: 'arbitrary_future_v1', acceptedInputKinds: ['inline'], requiredParams: [], canQuoteInline: true, formReady: true,
    inputSchema: { oneOf: [{ properties: { input_kind: { const: 'inline' }, inline_input: {
      type: 'string', contentMediaType: 'application/json', contentSchema: { type: 'object', '$ref': '#/future' },
    } } }] },
  }]))
  const [type] = await createMarketTaskTransport(fetcher, 'http://127.0.0.1:3180/').taskTypes(new AbortController().signal)
  expect(type?.inlineForm?.structuredDeclared).toBe(true)
  expect(type?.inlineForm?.structured).toBeUndefined()
})

it('offers plain text for any reviewed one-field JSON skill', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json([{
    taskType: 'generic_text_skill_v1', acceptedInputKinds: ['inline'], requiredParams: [],
    canQuoteInline: true, formReady: true,
    paramsSchema: { type: 'object', additionalProperties: false, required: [], properties: {} },
    inputSchema: { oneOf: [{ type: 'object', properties: { input_kind: { const: 'inline' },
      inline_input: { type: 'string', contentMediaType: 'application/json', contentSchema: {
        type: 'object', additionalProperties: false, required: ['text'],
        properties: { text: { type: 'string', minLength: 1, maxLength: 200, title: '要处理的文字' } },
      } },
    } }] },
  }]))
  const [type] = await createMarketTaskTransport(fetcher, 'http://127.0.0.1:3180/')
    .taskTypes(new AbortController().signal)
  expect(type?.inlineForm?.template).toEqual({ field: 'text', constants: {},
    minLength: 1, maxLength: 200, title: '要处理的文字' })
})

it('cannot quote a required field when central server omits its form contract', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json([{ taskType: 'future_v1',
    acceptedInputKinds: ['inline'], requiredParams: ['keyword'], canQuoteInline: true, formReady: false,
  }]))
  const types = await createMarketTaskTransport(fetcher, 'http://127.0.0.1:3180/')
    .taskTypes(new AbortController().signal)
  expect(types[0]?.canQuoteInline).toBe(false)
})

it('reads a fixed five-second H3 form with the model’s 32-bit seed bounds', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json([{
    taskType: 'video_generate', capabilityId: 'video_generate', acceptedInputKinds: ['inline'],
    requiredParams: [], canQuoteInline: true, formReady: true,
    paramsSchema: { type: 'object', additionalProperties: false, required: [], properties: {
      seconds: { type: 'integer', title: '视频秒数', enum: [5], default: 5 },
      seed: { type: 'integer', title: '随机种子', minimum: 1, maximum: 2147483647 },
    } },
    inputSchema: { oneOf: [{ type: 'object', properties: {
      input_kind: { const: 'inline' }, inline_input: { type: 'string', maxLength: 7000, title: '视频描述' },
    } }] },
  }]))
  const [type] = await createMarketTaskTransport(fetcher, 'http://127.0.0.1:3180/')
    .taskTypes(new AbortController().signal)
  expect(type).toMatchObject({ canQuoteInline: true,
    inlineForm: { title: '视频描述', mediaType: 'text/plain', maxLength: 7000 },
    paramFields: [
      { name: 'seconds', type: 'integer', choices: [5], defaultValue: 5 },
      { name: 'seed', type: 'integer', minimum: 1, maximum: 2147483647 },
    ] })
})

it('reads a published task and its result through the authenticated Host routes', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ id: 'workload_123', status: 'DONE', resultAvailable: true }))
    .mockResolvedValueOnce(Response.json({ id: 'workload_123', status: 'DONE', inlineOutput: null,
      artifactRef: `qianshou-media://task/workload_123/${'b'.repeat(64)}.mp4` }))
  const transport = createMarketTaskTransport(fetcher, 'http://127.0.0.1:3180/')
  const signal = new AbortController().signal
  expect(await transport.readWorkload('workload_123', signal)).toMatchObject({ status: 'DONE', resultAvailable: true })
  expect(await transport.readResult('workload_123', signal)).toMatchObject({
    artifactRef: `qianshou-media://task/workload_123/${'b'.repeat(64)}.mp4`,
  })
  expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
    '/api/qianshou/compute/workload', '/api/qianshou/compute/workload/result',
  ])
  expect(fetcher.mock.calls.every(([, init]) => init?.credentials === 'same-origin')).toBe(true)
})

it('reads and decides only an exact buyer acceptance through the same-origin Host', async () => {
  const acceptance = { workloadId: 'workload_123', status: 'pending_buyer', workloadStatus: 'QUARANTINED',
    currency: 'CNY', heldAmount: '0.50', inlineOutput: { report: '检查完成' },
    contentSha256: 'a'.repeat(64), outputKind: 'inline_json', shardId: 'shard_123' }
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(acceptance))
    .mockResolvedValueOnce(Response.json({ ...acceptance, status: 'accepted' }))
  const transport = createMarketTaskTransport(fetcher, 'http://127.0.0.1:3180/')
  const signal = new AbortController().signal
  expect((await transport.readAcceptance('workload_123', signal))?.status).toBe('pending_buyer')
  expect((await transport.decideAcceptance('workload_123', 'accept',
    'f8e42af1-e7a0-4c60-a53d-aa8d04def69b', signal)).status).toBe('accepted')
  expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
    '/api/qianshou/compute/workload/acceptance', '/api/qianshou/compute/workload/acceptance',
  ])
  expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
    id: 'workload_123', decision: 'accept', idempotencyKey: 'f8e42af1-e7a0-4c60-a53d-aa8d04def69b',
  })
  expect(fetcher.mock.calls.every(([, init]) => init?.credentials === 'same-origin')).toBe(true)
})

it('rejects pending buyer acceptance that does not claim a quarantined workload', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
    workloadId: 'workload_123', status: 'pending_buyer', workloadStatus: 'DONE',
    currency: 'CNY', heldAmount: '0.50', inlineOutput: { report: '待确认' },
    contentSha256: 'a'.repeat(64), outputKind: 'inline_json', shardId: 'shard_123',
  }))
  const transport = createMarketTaskTransport(fetcher, 'http://127.0.0.1:3180/')
  await expect(transport.readAcceptance('workload_123', new AbortController().signal))
    .rejects.toThrow('MARKET_TASK_INVALID_RESPONSE')
})

function hostQuote(overrides: Record<string, unknown> = {}) {
  return { planId: 'plan_123', capabilityId: 'custom_scan_v1',
    quoteId: 'a'.repeat(32), taskType: 'custom_scan_v1', currency: 'CNY',
    recommendedBudget: '0.75', requestedBudget: '0.00', balanceEnough: true,
    expiresAt: Math.floor(Date.now() / 1000) + 300, ...overrides }
}

it('approves a local draft and maps the Host quote without submitting any paid task', async () => {
  const quoted = hostQuote({ recommendedBudget: '0.7' })
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ id: 'plan_123', authorization: 'pending', workloadId: null }))
    .mockResolvedValueOnce(Response.json({ id: 'plan_123', authorization: 'approved', workloadId: null }))
    .mockResolvedValueOnce(Response.json(quoted))
  const transport = createMarketTaskTransport(fetcher, 'http://127.0.0.1:3180/')
  const signal = new AbortController().signal
  const id = await transport.createPlan('custom_scan_v1', '扫描文本', signal)
  expect(await transport.quotePlan(id, signal)).toEqual({ planId: id,
    capabilityId: 'custom_scan_v1',
    quoteId: quoted.quoteId, taskType: 'custom_scan_v1', amountYuan: '0.70', currency: 'CNY',
    balanceEnough: true, expiresAt: new Date(Number(quoted.expiresAt) * 1000).toISOString() })
  expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
    '/api/qianshou/compute/plans', '/api/qianshou/compute/plans/confirm',
    '/api/qianshou/compute/plans/quote',
  ])
  expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ id, decision: 'approved' })
  expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({ id })
})

it('confirms the exact displayed amount through the Host paid gate only once', async () => {
  const quoted = hostQuote()
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(quoted))
    .mockResolvedValueOnce(Response.json({ id: 'plan_123', workloadId: 'workload_123' }))
  const transport = createMarketTaskTransport(fetcher, 'http://127.0.0.1:3180/')
  const signal = new AbortController().signal
  const quote = await transport.quotePlan('plan_123', signal, 'custom_scan_v1')
  expect(await Promise.all([
    transport.confirmAndPublish('plan_123', quote.quoteId, signal),
    transport.confirmAndPublish('plan_123', quote.quoteId, signal),
  ])).toEqual(['workload_123', 'workload_123'])
  expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
    '/api/qianshou/compute/plans/quote', '/api/qianshou/compute/plans/confirm-quoted',
  ])
  expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
    id: 'plan_123', quoteId: quote.quoteId, amount: quote.amountYuan,
  })
})

it.each(['network', 'missing receipt'] as const)('keeps a %s submission uncertain and reads its receipt without another POST', async (failure) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(hostQuote()))
  if (failure === 'network') fetcher.mockRejectedValueOnce(new TypeError('Failed to fetch'))
  else fetcher.mockResolvedValueOnce(Response.json({ id: 'plan_123', workloadId: null }))
  fetcher.mockResolvedValueOnce(Response.json([{ id: 'plan_123', workloadId: 'workload_123' }]))
  const transport = createMarketTaskTransport(fetcher, 'http://127.0.0.1:3180/')
  const signal = new AbortController().signal
  const quote = await transport.quotePlan('plan_123', signal, 'custom_scan_v1')
  await expect(transport.confirmAndPublish('plan_123', quote.quoteId, signal)).rejects.toThrow('COMPUTE_SUBMISSION_UNKNOWN')
  await expect(transport.confirmAndPublish('plan_123', quote.quoteId, signal)).rejects.toThrow('COMPUTE_SUBMISSION_UNKNOWN')
  await expect(transport.quotePlan('plan_123', signal, 'custom_scan_v1')).rejects.toThrow('COMPUTE_SUBMISSION_UNKNOWN')
  expect(await transport.findWorkload('plan_123', signal)).toBe('workload_123')
  expect(fetcher.mock.calls.map(([url, init]) => [new URL(String(url)).pathname, init?.method])).toEqual([
    ['/api/qianshou/compute/plans/quote', 'POST'],
    ['/api/qianshou/compute/plans/confirm-quoted', 'POST'],
    ['/api/qianshou/compute/plans', 'GET'],
  ])
})

it('does not cache a reviewed-video rejection that Host made before the paid POST', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(hostQuote({ capabilityId: 'video_generate', taskType: 'video_generate' })))
    .mockResolvedValueOnce(Response.json({ error: { code: 'COMPUTE_VIDEO_REVIEW_CHANGED' } }, { status: 409 }))
  const transport = createMarketTaskTransport(fetcher, 'http://127.0.0.1:3180/')
  const signal = new AbortController().signal
  const quote = await transport.quotePlan('plan_123', signal, 'video_generate')
  await expect(transport.confirmAndPublish('plan_123', quote.quoteId, signal))
    .rejects.toThrow('COMPUTE_VIDEO_REVIEW_CHANGED')
  await expect(transport.confirmAndPublish('plan_123', quote.quoteId, signal))
    .rejects.toThrow('COMPUTE_QUOTE_CONFIRMATION_INVALID')
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('rejects a missing, replaced, expired or unaffordable quote before a paid POST', async () => {
  const signal = new AbortController().signal
  const first = hostQuote()
  const second = hostQuote({ quoteId: 'b'.repeat(32), balanceEnough: false })
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(first))
    .mockResolvedValueOnce(Response.json(second))
  const transport = createMarketTaskTransport(fetcher, 'http://127.0.0.1:3180/')
  await expect(transport.confirmAndPublish('plan_123', String(first.quoteId), signal))
    .rejects.toThrow('COMPUTE_QUOTE_CONFIRMATION_INVALID')
  await transport.quotePlan('plan_123', signal, 'custom_scan_v1')
  await transport.quotePlan('plan_123', signal, 'custom_scan_v1')
  await expect(transport.confirmAndPublish('plan_123', String(first.quoteId), signal))
    .rejects.toThrow('COMPUTE_QUOTE_CONFIRMATION_INVALID')
  await expect(transport.confirmAndPublish('plan_123', String(second.quoteId), signal))
    .rejects.toThrow('COMPUTE_QUOTE_BALANCE_INSUFFICIENT')
  const clock = vi.spyOn(Date, 'now').mockReturnValue((Number(second.expiresAt) + 1) * 1000)
  try {
    await expect(transport.confirmAndPublish('plan_123', String(second.quoteId), signal))
      .rejects.toThrow('COMPUTE_QUOTE_EXPIRED')
  } finally { clock.mockRestore() }
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it.each([
  ['INVALID_COMPUTE_FIELD', { error: { code: 'INVALID_COMPUTE_FIELD' } }],
  ['CORE_V8_UNAVAILABLE', { error: { code: 'CORE_V8_UNAVAILABLE' } }],
  ['MARKET_TASK_UNAVAILABLE', 'unexpected proxy text'],
  ['MARKET_TASK_UNAVAILABLE', { error: [] }],
])('preserves a bounded Host error code %s and tolerates malformed errors', async (code, body) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status: 409 }))
  const transport = createMarketTaskTransport(fetcher, 'http://127.0.0.1:3180/')
  await expect(transport.quotePlan('plan_123', new AbortController().signal, 'custom_scan_v1')).rejects.toThrow(String(code))
})

it.each([
  { recommendedBudget: '0.751' }, { expiresAt: '2026-09-26T00:00:00.000Z' },
  { expiresAt: 1.5 }, { quoteId: 'made-up-quote' },
  { planId: 'plan_other' }, { planId: undefined },
  { capabilityId: 'other_v1' }, { capabilityId: undefined },
])('rejects a quote that does not follow the real Host fields: %j', async (overrides) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(hostQuote(overrides)))
  await expect(createMarketTaskTransport(fetcher, 'http://127.0.0.1:3180/')
    .quotePlan('plan_123', new AbortController().signal, 'custom_scan_v1')).rejects.toThrow('MARKET_TASK_INVALID_RESPONSE')
})
