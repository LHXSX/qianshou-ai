import { expect, it, vi } from 'vitest'
import { listMarketCapabilities } from '../src/market-capabilities-http.ts'

const official = {
  task_type: 'image_generate_v1', capability_id: 'image.generate',
  name: '官方出图', description: '用文字生成图片', category: 'image', category_label_zh: '图片',
  accepted_input_kinds: ['inline'], default_input_kind: 'inline', required_params: [],
  output_kind: 'artifact_ref', contract_version: 'task-registry.v1',
  publisher_kind: 'official', publisher_kinds: ['official'], execution_mode: 'cloud',
  availability: 'contract_ready', callable: true, requires_quote: true,
  execution_quote_path: '/api/v8/developer/tasks/estimate', currency: 'CNY', products: [],
}

it('reads official and user options from one task-type catalog without treating a listing as dispatch', async () => {
  const user = { ...official, publisher_kind: 'user', publisher_kinds: ['user'],
    execution_mode: 'device', task_type: 'legal_term_scan_v1', capability_id: 'text.transform',
    name: '法律术语扫描', category: 'legal', category_label_zh: '法律', products: [{
      product_id: '11111111-1111-4111-8111-111111111111',
      publication_id: '22222222-2222-4222-8222-222222222222', owner_id: 12,
      version: '1.0.0', sale_price_yuan: '12.00', available_to_purchase: true,
    }] }
  const fetch = vi.fn().mockResolvedValue(Response.json({ items: [official, user], total: 2 }))
  const result = await listMarketCapabilities({ origin: 'https://qianshousuanli.com', fetch })
  expect(result.capabilities.map(item => item.publisherKind)).toEqual(['official', 'user'])
  expect(result.capabilities[0]).toMatchObject({ taskType: 'image_generate_v1', executionMode: 'cloud',
    categoryLabelZh: '图片', products: [] })
  expect(result.capabilities[1]?.products[0]).toMatchObject({ salePriceYuan: '12.00' })
  expect(fetch.mock.calls[0]?.[0].toString()).toBe('https://qianshousuanli.com/api/v8/order-adapter-products/capabilities')
})

it('rejects a claim that a product purchase is a task quote or a malformed official listing', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ items: [{ ...official,
    execution_quote_path: '/api/v8/order-adapter-products/purchase' }], total: 1 }))
  await expect(listMarketCapabilities({ origin: 'https://qianshousuanli.com', fetch }))
    .rejects.toThrow('market-capabilities-invalid')
  expect(fetch).toHaveBeenCalledOnce()
})

it('shows a paused official cloud capability without inventing a quote route or a callable task', async () => {
  const paused = { ...official, task_type: 'image.generate',
    contract_version: 'official-provider.v1', output_kind: 'image', required_params: ['prompt'],
    availability: 'paused', callable: false, execution_quote_path: null,
    input_schema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } },
      additionalProperties: false } }
  const fetch = vi.fn().mockResolvedValue(Response.json({ items: [paused], total: 1 }))
  const result = await listMarketCapabilities({ origin: 'https://qianshousuanli.com', fetch })
  expect(result.capabilities[0]).toMatchObject({ taskType: 'image.generate',
    availability: 'paused', executionQuotePath: null, executionMode: 'cloud', requiredParams: ['prompt'] })
})

it('keeps other contracts readable when an older publication used its long description as the display name', async () => {
  // The public 2026-09-26 catalog had a 209-character legal_doc_precheck_v1 title.
  const description = '审'.repeat(209)
  const legal = { ...official, task_type: 'legal_doc_precheck_v1', capability_id: 'legal.doc.precheck',
    name: description, description, publisher_kind: 'user', publisher_kinds: ['user'], execution_mode: 'device' }
  const fetch = vi.fn().mockResolvedValue(Response.json({ items: [official, legal], total: 2 }))
  const result = await listMarketCapabilities({ origin: 'https://qianshousuanli.com', fetch })
  expect(result.capabilities).toHaveLength(2)
  expect(result.capabilities[0]?.name).toBe('官方出图')
  expect(result.capabilities[1]).toMatchObject({ taskType: 'legal_doc_precheck_v1', capabilityId: 'legal.doc.precheck',
    name: `${'审'.repeat(119)}…`, description, requiresQuote: true,
    executionQuotePath: '/api/v8/developer/tasks/estimate' })
})
