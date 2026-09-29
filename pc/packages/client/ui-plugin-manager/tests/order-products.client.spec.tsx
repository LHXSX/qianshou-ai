// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { OrderProductsController } from '../src/client/order-products-controller.ts'
import { OrderProductsPanel } from '../src/client/OrderProductsPanel.tsx'
import { MarketplacePanel } from '../src/client/MarketplacePanel.tsx'
import { zh, type MarketplaceKey } from '../src/client/marketplace-locales.ts'
import type { EnterMarketConversation } from '../src/client/market-conversation-entry.ts'

afterEach(cleanup)

it('sends ordinary use to the shared conversation entry with the exact publication version while purchase remains separate', async () => {
  const product = { id: 'good', publicationId: 'pub', ownerId: 2, taskType: 'file_read_v1',
    name: '文档审查', description: '审查文件', category: 'text', version: '1.0.0', artifactDigest: 'sha256:a',
    reviewedSellerRuntimeDigest: 'sha256:b', salePriceYuan: '1.00', currency: 'CNY' as const,
    availableToPurchase: true, archiveDigest: 'sha256:c', archiveSizeBytes: 100 }
  const enter = vi.fn<EnterMarketConversation>(async () => true), buy = vi.fn()
  const view = render(<OrderProductsPanel view={{ products: [product], loaded: true, loading: false, error: null,
    action: null, buyerReadiness: { ready: true, reason: null }, entitlements: [], entitlementsKnown: true }}
    t={key => zh[key]} reload={vi.fn()} enterConversation={enter} buyAndActivate={buy} />)
  fireEvent.click(screen.getByRole('button', { name: zh.marketConversationUse }))
  await waitFor(() => expect(enter).toHaveBeenCalledOnce())
  expect(enter.mock.calls[0]?.[0]).toEqual({ taskType: product.taskType,
    product: { productId: product.id, publicationId: product.publicationId, version: product.version, ownerId: product.ownerId } })
  expect(buy).not.toHaveBeenCalled()
  expect(view.container.querySelector('textarea, input[type="file"]')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '一键获取并启用' }))
  expect(buy).toHaveBeenCalledExactlyOnceWith(product.id)
})

it('keeps an unknown entitlement visible and refuses repeat purchase or device activation', async () => {
  const product = { id: 'good', publicationId: 'pub', ownerId: 2, taskType: 'text_reverse_v1',
    name: '文字反转', description: '处理文字', category: 'text', version: '1.0.0', artifactDigest: 'sha256:a',
    reviewedSellerRuntimeDigest: 'sha256:b', salePriceYuan: '1.00', currency: 'CNY' as const,
    availableToPurchase: true, archiveDigest: 'sha256:c', archiveSizeBytes: 100 }
  const purchase = vi.fn(), activate = vi.fn()
  const controller = new OrderProductsController({
    orderAdapterProducts: async () => ({ ok: true, value: { products: [product] } }),
    orderAdapterBuyerReadiness: async () => ({ ok: true, value: { ready: true, reason: null } }),
    myPurchasedOrderAdapters: async () => ({ ok: true, value: { items: [{ productId: 'good', entitlementId: 'owned',
      productName: '文字反转', status: 'unknown', deviceInstalled: false, installExpiresAt: null }] } }),
    purchaseOrderAdapterProduct: purchase, activatePurchasedOrderAdapter: activate,
  })
  await controller.reload()
  await controller.buyAndActivate('good')
  expect(purchase).not.toHaveBeenCalled()
  expect(activate).not.toHaveBeenCalled()
  expect(controller.store.getSnapshot().entitlements[0]?.status).toBe('unknown')
  render(<OrderProductsPanel view={controller.store.getSnapshot()} reload={() => {}} t={key => zh[key]}
    buyAndActivate={() => {}} />)
  expect(screen.getByRole('button', { name: '权益状态待核对' })).toHaveProperty('disabled', true)
  controller.dispose()
})

it('does not query goods until opened, and discards an older response after refresh', async () => {
  const first = Promise.withResolvers<{ ok: true; value: { products: [] } }>()
  const list = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce({ ok: true, value: { products: [] } })
  const controller = new OrderProductsController({ orderAdapterProducts: list })
  expect(list).not.toHaveBeenCalled()
  const pending = controller.reload()
  await controller.reload()
  first.resolve({ ok: true, value: { products: [] } })
  await pending
  expect(controller.store.getSnapshot()).toMatchObject({ loaded: true, loading: false, products: [] })
  controller.dispose()
})

it.each([
  ['order-product-not-found', 'route_unavailable', '商品目录尚未接通'],
  ['order-product-invalid', 'invalid', '商品数据校验失败'],
  ['order-product-unavailable', 'unavailable', '商品目录读取失败'],
] as const)('explains %s without showing a purchasable good', async (code, expected, heading) => {
  const controller = new OrderProductsController({ orderAdapterProducts: vi.fn().mockResolvedValue({
    ok: false, error: { message: `QIANSHOU_CATALOG_${code}` },
  }) })
  await controller.reload()
  const view = controller.store.getSnapshot()
  expect(view).toMatchObject({ loaded: true, loading: false, products: [], error: expected })
  render(<OrderProductsPanel view={view} reload={vi.fn()} t={key => zh[key]} />)
  expect(screen.getByRole('alert').textContent).toContain(heading)
  expect(screen.queryByRole('button', { name: '购买暂未开放' })).toBeNull()
  controller.dispose()
})

it('shows a distinct empty state only after a successful platform response', async () => {
  const controller = new OrderProductsController({ orderAdapterProducts: vi.fn().mockResolvedValue({
    ok: true, value: { products: [] },
  }) })
  await controller.reload()
  const view = controller.store.getSnapshot()
  expect(view).toMatchObject({ loaded: true, error: null, products: [] })
  render(<OrderProductsPanel view={view} reload={vi.fn()} t={key => zh[key]} />)
  expect(screen.getByText('暂无上架商品')).toBeTruthy()
  expect(screen.getByText(/已连接中央服务器/)).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  controller.dispose()
})

it('separates approved goods from the legacy market and visibly blocks charging before device receipts exist', () => {
  const reload = vi.fn()
  const actions = { ensure: vi.fn(), reload: vi.fn(), inspect: vi.fn(), install: vi.fn(),
    recheck: vi.fn(), repair: vi.fn(), rollback: vi.fn(), dismiss: vi.fn() }
  render(<MarketplacePanel view={{ mode: 'shipped', source: 'shipped', listings: [], installedRecords: [],
    loading: false, busyId: null, workingId: null, error: null, report: null, notice: null }}
    t={(key: MarketplaceKey) => zh[key]} {...actions}
    orderProducts={{ view: { products: [{ id: 'good', publicationId: 'pub', ownerId: 1,
      taskType: 'bar_chart_svg_v1', name: '柱状图视频', description: '受限内联 JSON 生成媒体',
      category: 'video', version: '0.1.0', artifactDigest: 'sha256:a', reviewedSellerRuntimeDigest: 'sha256:b',
      salePriceYuan: '10.00', currency: 'CNY', availableToPurchase: false,
      purchaseBlockReason: '独立验收服务未就绪，暂停扣款',
      archiveDigest: 'sha256:c', archiveSizeBytes: 42 }], loaded: true, loading: false,
      error: null, action: null, buyerReadiness: { ready: true, reason: null },
      entitlements: [], entitlementsKnown: true }, reload }} />)
  expect(screen.queryByRole('heading', { name: '柱状图视频' })).toBeNull()
  fireEvent.click(screen.getByRole('tab', { name: '可购买接单技能' }))
  expect(reload).toHaveBeenCalledOnce()
  expect(screen.getByRole('heading', { name: '柱状图视频' })).toBeTruthy()
  expect(screen.getByText('购买价 ¥10.00')).toBeTruthy()
  expect(screen.getByText('视频 · 0.1.0')).toBeTruthy()
  expect(screen.getByText('任务类型：bar_chart_svg_v1')).toBeTruthy()
  expect(screen.getByText(/单次任务由中央服务器另行报价/)).toBeTruthy()
  expect(screen.getByRole('button', { name: '购买暂未开放' })).toHaveProperty('disabled', true)
  expect(screen.getByRole('status').textContent).toContain('暂停购买扣款')
  expect(screen.getByText('独立验收服务未就绪，暂停扣款')).toBeTruthy()
  expect(actions.install).not.toHaveBeenCalled()
})

it('one click purchases then activates only on a central server-confirmed device receipt', async () => {
  const product = { id: 'good', publicationId: 'pub', ownerId: 2, taskType: 'text_reverse_v1',
    name: '文字反转', description: '处理输入文字', category: 'text', version: '1.0.0',
    artifactDigest: 'sha256:a', reviewedSellerRuntimeDigest: 'sha256:a', salePriceYuan: '1.00',
    currency: 'CNY' as const, availableToPurchase: true, archiveDigest: 'sha256:b', archiveSizeBytes: 100 }
  const purchase = vi.fn().mockResolvedValue({ ok: true, value: {
    productId: 'good', entitlementId: 'entitlement', status: 'pending_install' } })
  const activate = vi.fn().mockResolvedValue({ ok: true, value: {
    productId: 'good', deviceInstalled: true, dispatchEligible: true } })
  const controller = new OrderProductsController({
    orderAdapterProducts: vi.fn().mockResolvedValue({ ok: true, value: { products: [product] } }),
    orderAdapterBuyerReadiness: vi.fn().mockResolvedValue({ ok: true, value: { ready: true, reason: null } }),
    myPurchasedOrderAdapters: vi.fn().mockResolvedValue({ ok: true, value: { items: [] } }),
    purchaseOrderAdapterProduct: purchase, activatePurchasedOrderAdapter: activate,
  })
  await controller.reload()
  const props = { reload: vi.fn(), buyAndActivate: (id: string) => { void controller.buyAndActivate(id) },
    t: (key: MarketplaceKey) => zh[key] }
  const view = render(<OrderProductsPanel {...props} view={controller.store.getSnapshot()} />)
  const button = screen.getByRole('button', { name: '一键获取并启用' })
  expect(button).toHaveProperty('disabled', false)
  fireEvent.click(button)
  await waitFor(() => { expect(controller.store.getSnapshot().action?.phase).toBe('ready') })
  expect(purchase).toHaveBeenCalledOnce()
  expect(activate).toHaveBeenCalledWith({ productId: 'good' })
  view.rerender(<OrderProductsPanel {...props} view={controller.store.getSnapshot()} />)
  expect(screen.getByRole('button', { name: '本机已激活' })).toHaveProperty('disabled', true)
  expect(screen.getByText(/中央服务器已确认这台设备的激活回执/)).toBeTruthy()
  controller.dispose()
})

it('blocks charging when the buyer PC has no central server node connection', async () => {
  const purchase = vi.fn()
  const controller = new OrderProductsController({
    orderAdapterProducts: vi.fn().mockResolvedValue({ ok: true, value: { products: [{
      id: 'good', publicationId: 'pub', ownerId: 2, taskType: 'text_reverse_v1', name: '文字反转',
      description: '处理输入文字', category: 'text', version: '1.0.0', artifactDigest: 'sha256:a',
      reviewedSellerRuntimeDigest: 'sha256:a', salePriceYuan: '1.00', currency: 'CNY',
      availableToPurchase: true, archiveDigest: 'sha256:b', archiveSizeBytes: 100,
    }] } }),
    orderAdapterBuyerReadiness: vi.fn().mockResolvedValue({ ok: true, value: {
      ready: false, reason: 'node-offline' } }),
    myPurchasedOrderAdapters: vi.fn().mockResolvedValue({ ok: true, value: { items: [] } }),
    purchaseOrderAdapterProduct: purchase,
  })
  await controller.reload()
  render(<OrderProductsPanel view={controller.store.getSnapshot()} reload={vi.fn()}
    buyAndActivate={id => { void controller.buyAndActivate(id) }} t={key => zh[key]} />)
  expect(screen.getByRole('button', { name: '购买暂未开放' })).toHaveProperty('disabled', true)
  expect(screen.getByRole('status').textContent).toContain('尚未连接中央服务器')
  await controller.buyAndActivate('good')
  expect(purchase).not.toHaveBeenCalled()
  controller.dispose()
})

it('keeps a purchased entitlement pending and retries only independent verification', async () => {
  const product = { id: 'good', publicationId: 'pub', ownerId: 2, taskType: 'text_reverse_v1',
    name: '文字反转', description: '处理输入文字', category: 'text', version: '1.0.0',
    artifactDigest: 'sha256:a', reviewedSellerRuntimeDigest: 'sha256:a', salePriceYuan: '1.00',
    currency: 'CNY' as const, availableToPurchase: true, archiveDigest: 'sha256:b', archiveSizeBytes: 100 }
  const purchase = vi.fn().mockResolvedValue({ ok: true, value: {
    productId: 'good', entitlementId: 'entitlement', status: 'pending_install' } })
  const activate = vi.fn().mockResolvedValueOnce({ ok: false,
    error: { message: 'QIANSHOU_CATALOG_order-attestor-unavailable' } }).mockResolvedValueOnce({
      ok: true, value: { productId: 'good', deviceInstalled: true, dispatchEligible: true },
    })
  const controller = new OrderProductsController({
    orderAdapterProducts: vi.fn().mockResolvedValue({ ok: true, value: { products: [product] } }),
    orderAdapterBuyerReadiness: vi.fn().mockResolvedValue({ ok: true, value: { ready: true, reason: null } }),
    myPurchasedOrderAdapters: vi.fn().mockResolvedValue({ ok: true, value: { items: [] } }),
    purchaseOrderAdapterProduct: purchase, activatePurchasedOrderAdapter: activate,
  })
  await controller.reload()
  const props = { reload: vi.fn(), buyAndActivate: (id: string) => { void controller.buyAndActivate(id) },
    t: (key: MarketplaceKey) => zh[key] }
  const view = render(<OrderProductsPanel {...props} view={controller.store.getSnapshot()} />)
  fireEvent.click(screen.getByRole('button', { name: '一键获取并启用' }))
  await waitFor(() => { expect(controller.store.getSnapshot().action).toMatchObject({
    phase: 'failed', owned: true, reason: 'attestor_unavailable' }) })
  view.rerender(<OrderProductsPanel {...props} view={controller.store.getSnapshot()} />)
  expect(screen.getByRole('alert').textContent).toContain('权益仍在')
  fireEvent.click(screen.getByRole('button', { name: '继续设备验收' }))
  await waitFor(() => { expect(controller.store.getSnapshot().action?.phase).toBe('ready') })
  expect(purchase).toHaveBeenCalledOnce()
  expect(activate).toHaveBeenCalledTimes(2)
  controller.dispose()
})

it('restores a paid entitlement after restart and resumes verification without charging again', async () => {
  const product = { id: 'good', publicationId: 'pub', ownerId: 2, taskType: 'text_reverse_v1',
    name: '文字反转', description: '处理输入文字', category: 'text', version: '1.0.0',
    artifactDigest: 'sha256:a', reviewedSellerRuntimeDigest: 'sha256:a', salePriceYuan: '1.00',
    currency: 'CNY' as const, availableToPurchase: false,
    purchaseBlockReason: '独立验收服务暂未就绪，暂停购买扣款',
    archiveDigest: 'sha256:b', archiveSizeBytes: 100 }
  const purchase = vi.fn()
  const activate = vi.fn().mockResolvedValue({ ok: true, value: {
    productId: 'good', deviceInstalled: true, dispatchEligible: true } })
  const controller = new OrderProductsController({
    orderAdapterProducts: vi.fn().mockResolvedValue({ ok: true, value: { products: [product] } }),
    orderAdapterBuyerReadiness: vi.fn().mockResolvedValue({ ok: true, value: { ready: true, reason: null } }),
    myPurchasedOrderAdapters: vi.fn().mockResolvedValue({ ok: true, value: { items: [{
      productId: 'good', entitlementId: 'entitlement', productName: '文字反转',
      status: 'pending_install', deviceInstalled: false, installExpiresAt: '2099-01-01T00:00:00Z',
    }] } }),
    purchaseOrderAdapterProduct: purchase, activatePurchasedOrderAdapter: activate,
  })
  await controller.reload()
  const props = { reload: vi.fn(), buyAndActivate: (id: string) => { void controller.buyAndActivate(id) },
    t: (key: MarketplaceKey) => zh[key] }
  const panel = render(<OrderProductsPanel {...props} view={controller.store.getSnapshot()} />)
  const button = screen.getByRole('button', { name: '继续设备验收' })
  expect(button).toHaveProperty('disabled', false)
  fireEvent.click(button)
  await waitFor(() => { expect(controller.store.getSnapshot().action?.phase).toBe('ready') })
  expect(purchase).not.toHaveBeenCalled()
  expect(activate).toHaveBeenCalledOnce()
  panel.rerender(<OrderProductsPanel {...props} view={controller.store.getSnapshot()} />)
  expect(screen.getByRole('button', { name: '本机已激活' })).toHaveProperty('disabled', true)
  controller.dispose()
})

it('does not charge when the account purchase ledger cannot be read', async () => {
  const purchase = vi.fn()
  const controller = new OrderProductsController({
    orderAdapterProducts: vi.fn().mockResolvedValue({ ok: true, value: { products: [{
      id: 'good', publicationId: 'pub', ownerId: 2, taskType: 'text_reverse_v1', name: '文字反转',
      description: '处理输入文字', category: 'text', version: '1.0.0', artifactDigest: 'sha256:a',
      reviewedSellerRuntimeDigest: 'sha256:a', salePriceYuan: '1.00', currency: 'CNY',
      availableToPurchase: true, archiveDigest: 'sha256:b', archiveSizeBytes: 100,
    }] } }),
    orderAdapterBuyerReadiness: vi.fn().mockResolvedValue({ ok: true, value: { ready: true, reason: null } }),
    myPurchasedOrderAdapters: vi.fn().mockResolvedValue({
      ok: false, error: { message: 'QIANSHOU_CATALOG_order-product-unavailable' } }),
    purchaseOrderAdapterProduct: purchase,
  })
  await controller.reload()
  render(<OrderProductsPanel view={controller.store.getSnapshot()} reload={vi.fn()}
    buyAndActivate={id => { void controller.buyAndActivate(id) }} t={key => zh[key]} />)
  expect(screen.getByRole('button', { name: '购买暂未开放' })).toHaveProperty('disabled', true)
  expect(screen.getByRole('status').textContent).toContain('无法确认账号的已购权益')
  await controller.buyAndActivate('good')
  expect(purchase).not.toHaveBeenCalled()
  controller.dispose()
})
