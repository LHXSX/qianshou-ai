import { expect, it, vi } from 'vitest'
import { listPlatformOrderPublications, previewPlatformOrderPublicationPrice,
  submitPlatformOrderPublication,
  type OrderPublicationPayload } from '../src/order-publication-http.ts'

const digest = `sha256:${'a'.repeat(64)}`
const id = 'b9418e38-b3a5-5722-8005-cc7afbe2a21a'
const payload: OrderPublicationPayload = {
  task_type: 'bar_chart_svg_v1', capability_id: 'video.render', input_kinds: ['inline'],
  output_kind: 'artifact_ref', contract_version: 'v1', artifact_digest: digest,
  package_digest: digest, version: '0.1.0', name: '图表视频', category: 'video',
  description: '把柱状图制作为视频', configuration: '仅支持内联 JSON 配方',
  currency: 'CNY', price_yuan: '2.00',
}
const receipt = { id, owner_id: 111111, status: 'review', task_type: payload.task_type,
  artifact_digest: digest, package_digest: digest, currency: 'CNY', price_yuan: '2.00',
  review_reasons: ['等待独立审核'] }

it('reads machine evidence status from the owner GET without submitting or approving', async () => {
  const evidence = { package: 'valid', sample: 'missing', pricing: 'valid', review: 'invalid' }
  const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ items: [{ ...receipt, evidence_status: evidence }] }))
  await expect(listPlatformOrderPublications({ origin: 'https://shanghai.example', token: 'owner-token', fetch: send }))
    .resolves.toMatchObject([{ evidenceStatus: evidence }])
  expect(send).toHaveBeenCalledOnce()
  expect(send.mock.calls[0]?.[1]?.method).toBe('GET')
})

it.each([null, [], { sample: 'approved' }, { unknown: 'valid' }, { sample: ['missing'] }])
('rejects malformed evidence statuses instead of claiming pending or valid', async (evidence) => {
  const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ items: [{ ...receipt, evidence_status: evidence }] }))
  await expect(listPlatformOrderPublications({ origin: 'https://shanghai.example', token: 'owner-token', fetch: send }))
    .rejects.toThrow('order-platform-unavailable')
})

it.each(['0.00', '25.50', '100000.00'])('locks sale price %s in the same publication POST and reads the actual auto-listed product receipt', async salePrice => {
  const productId = '663125de-83c4-4c47-ade1-0d5d5298f267'
  const send = vi.fn(async () => Response.json({ ...receipt, status: 'approved',
    sale_price_yuan: salePrice, market_product_id: productId, market_product_status: 'published' }))
  const submitted = await submitPlatformOrderPublication({ origin: 'https://shanghai.example', token: 'test-token',
    payload: { ...payload, sale_price_yuan: salePrice }, fetch: send as unknown as typeof fetch })
  expect(submitted).toMatchObject({ status: 'approved', salePriceYuan: salePrice,
    marketProductId: productId, marketProductStatus: 'published', priceYuan: '2.00' })
  expect(send).toHaveBeenCalledOnce()
  expect(JSON.parse(String((send.mock.calls[0] as unknown as [URL, RequestInit])[1].body)))
    .toMatchObject({ sale_price_yuan: salePrice, price_yuan: '2.00' })
})

it('rejects changed sale receipts and invalid sale bounds, while keeping legacy null sale rows readable', async () => {
  const send = vi.fn(async () => Response.json({ ...receipt, sale_price_yuan: '20.01' }))
  const input = { origin: 'https://shanghai.example', token: 'test-token',
    payload: { ...payload, sale_price_yuan: '20.00' }, fetch: send as unknown as typeof fetch }
  await expect(submitPlatformOrderPublication(input)).rejects.toThrow('order-platform-unavailable')
  send.mockClear()
  await expect(submitPlatformOrderPublication({ ...input, payload: { ...payload, sale_price_yuan: '100000.01' } }))
    .rejects.toThrow('order-platform-unavailable')
  expect(send).not.toHaveBeenCalled()
  const legacy = vi.fn(async () => Response.json({ items: [{ ...receipt, sale_price_yuan: null,
    market_product_id: null, market_product_status: null }] }))
  await expect(listPlatformOrderPublications({ origin: input.origin, token: input.token,
    fetch: legacy as unknown as typeof fetch })).resolves.toMatchObject([{ salePriceYuan: null,
      marketProductId: null, marketProductStatus: null }])
})

it('submits only exact adapter metadata with the account JWT and requires a platform receipt', async () => {
  const send = vi.fn(async (_url: URL, _request: RequestInit) => new Response(JSON.stringify(receipt), {
    status: 200, headers: { 'content-type': 'application/json' },
  }))
  const result = await submitPlatformOrderPublication({ origin: 'https://shanghai.example', token: 'owner-token',
    payload, fetch: send as unknown as typeof fetch })
  expect(result).toEqual({ id, ownerId: 111111, status: 'review', artifactDigest: digest,
    priceYuan: '2.00', reviewReasons: ['等待独立审核'] })
  expect(send).toHaveBeenCalledTimes(1)
  const [url, request] = send.mock.calls[0]!
  expect(url.href).toBe('https://shanghai.example/api/v8/task-adapter-publications')
  expect(request.method).toBe('POST')
  expect(request.redirect).toBe('error')
  expect(request.credentials).toBe('omit')
  expect((request.headers as Record<string, string>).authorization).toBe('Bearer owner-token')
  expect(JSON.parse(request.body as string)).toEqual(payload)
  expect(JSON.stringify(result)).not.toContain('owner-token')
})

it('previews Shanghai-owned CNY price only for the exact canonical task definition digest', async () => {
  const definition = { schema: 'qianshou.reviewed-task-definition.v1' as const,
    taskType: 'new_text_task_v1', capabilityId: 'text.transform', category: 'text',
    inputKinds: ['inline'] as const, outputKind: 'inline_json' as const,
    inputContract: 'inline-json-bounded.v1', resultStrategy: 'buyer-confirmed-structure.v1',
    paramsSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    inputSchema: { type: 'string', minLength: 1, maxLength: 16384,
      contentMediaType: 'application/json', title: '输入 JSON' } }
  const definitionDigest = `sha256:${'b'.repeat(64)}`
  const quoted = { pricing_mode: 'platform', currency: 'CNY', price_yuan: '2.50',
    settings_version: 7, task_definition_sha256: definitionDigest,
    input_contract: definition.inputContract, result_strategy: definition.resultStrategy,
    output_kind: definition.outputKind }
  const send = vi.fn(async (_url: URL, _request: RequestInit) => Response.json(quoted))
  const input = { origin: 'https://shanghai.example', token: 'owner-token',
    taskType: definition.taskType, taskDefinition: definition,
    taskDefinitionSha256: definitionDigest, fetch: send as unknown as typeof fetch }
  await expect(previewPlatformOrderPublicationPrice(input)).resolves.toEqual({
    priceYuan: '2.50', settingsVersion: 7, taskDefinitionSha256: definitionDigest })
  const [url, request] = send.mock.calls[0]!
  expect(url.pathname).toBe('/api/v8/task-adapter-publications/price-preview')
  expect(JSON.parse(String(request.body))).toEqual({ task_type: definition.taskType,
    task_definition: definition })
  const forged = vi.fn(async () => Response.json({ ...quoted,
    task_definition_sha256: `sha256:${'c'.repeat(64)}` }))
  await expect(previewPlatformOrderPublicationPrice({ ...input,
    fetch: forged as unknown as typeof fetch })).rejects.toThrow('order-platform-unavailable')
})

it('does not turn a route gap, contract rejection, or forged digest into published status', async () => {
  const rejected = vi.fn(async () => new Response('{}', { status: 400 }))
  await expect(submitPlatformOrderPublication({ origin: 'https://shanghai.example', token: 'token', payload,
    fetch: rejected as unknown as typeof fetch })).rejects.toThrow('order-platform-contract')
  const absent = vi.fn(async () => new Response('{}', { status: 404 }))
  await expect(submitPlatformOrderPublication({ origin: 'https://shanghai.example', token: 'token', payload,
    fetch: absent as unknown as typeof fetch })).rejects.toThrow('order-platform-route-unavailable')
  const forged = vi.fn(async () => new Response(JSON.stringify({ ...receipt, artifact_digest: `sha256:${'b'.repeat(64)}` }), { status: 200 }))
  await expect(submitPlatformOrderPublication({ origin: 'https://shanghai.example', token: 'token', payload,
    fetch: forged as unknown as typeof fetch })).rejects.toThrow('order-platform-unavailable')
  expect(rejected).toHaveBeenCalledTimes(1)
  expect(absent).toHaveBeenCalledTimes(1)
  expect(forged).toHaveBeenCalledTimes(1)
})

it('reads only bounded owner-scoped publication rows and rejects mixed owners', async () => {
  const mineRow = { ...receipt, status: 'approved', review_reasons: [] }
  const send = vi.fn(async () => new Response(JSON.stringify({ items: [mineRow] }), { status: 200 }))
  await expect(listPlatformOrderPublications({ origin: 'https://shanghai.example', token: 'owner-token',
    fetch: send as unknown as typeof fetch })).resolves.toEqual([{
    id, ownerId: 111111, taskType: payload.task_type, artifactDigest: digest,
    packageDigest: digest, priceYuan: '2.00', status: 'approved', reviewReasons: [], packageUploadStatus: 'missing',
    authorManifestStatus: 'missing',
  }])
  expect((send.mock.calls[0] as unknown as [URL])[0].href)
    .toBe('https://shanghai.example/api/v8/task-adapter-publications/mine')
  const mixed = vi.fn(async () => new Response(JSON.stringify({
    items: [mineRow, { ...mineRow, owner_id: 222222 }],
  }), { status: 200 }))
  await expect(listPlatformOrderPublications({ origin: 'https://shanghai.example', token: 'owner-token',
    fetch: mixed as unknown as typeof fetch })).rejects.toThrow('order-platform-unavailable')
})

it('accepts Shanghai independent inline sample state without treating it as SVG work', async () => {
  const row = { ...receipt, status: 'review', review_reasons: [],
    package_upload_status: 'confirmed', author_manifest_status: 'recorded',
    review_sample_status: 'independent_sample_required', media_evidence_status: 'missing' }
  const send = vi.fn(async () => Response.json({ items: [row] }))
  await expect(listPlatformOrderPublications({ origin: 'https://shanghai.example', token: 'owner-token',
    fetch: send as unknown as typeof fetch })).resolves.toMatchObject([{
    id, status: 'review', reviewSampleStatus: 'independent_sample_required',
    packageUploadStatus: 'confirmed', authorManifestStatus: 'recorded',
  }])
})
