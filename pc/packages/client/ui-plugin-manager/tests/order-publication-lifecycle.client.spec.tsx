// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { OrderPublicationController, type OrderPublicationRemote, type PublicationLifecycle,
  type PublicationLifecycleReceipt, type SellerOrderProduct } from '../src/client/order-publication-controller.ts'
import { OrderPublicationsPanel } from '../src/client/OrderPublicationsPanel.tsx'
import type { LocalSkillsPanelProps } from '../src/client/LocalSkillsPanel.tsx'
import { zh } from '../src/client/local-skill-locales.ts'
import { zh as marketZh } from '../src/client/marketplace-locales.ts'

afterEach(cleanup)
const labels: Readonly<Record<string, string>> = { ...zh, ...marketZh }
const translate = (label: string): string => {
  const copy = labels[label]
  if (copy === undefined) throw new Error(`Missing test locale: ${label}`)
  return copy
}
const id = '416dfb88-ea17-4a36-98b5-e1c08edd3c55'
const key = 'skill:user-agents:old-test'
type Owned = Extract<Awaited<ReturnType<OrderPublicationRemote['catalog']['myOrderSkillPublications']>>,
  { ok: true }>['value']['items'][number]
type Request = Parameters<NonNullable<OrderPublicationRemote['catalog']['manageOrderSkillPublication']>>[0]
const lifecycle = (change: Partial<PublicationLifecycle> = {}): PublicationLifecycle => ({
  state: 'active', archived: false, revision: 1, allowedActions: ['withdraw', 'archive'], blockingReasons: [], ...change,
})
const receipt = (change: Partial<PublicationLifecycleReceipt> = {}): PublicationLifecycleReceipt => ({
  publicationId: id, ownerId: 167, name: '旧文字反转测试', status: 'review',
  lifecycle: lifecycle({ state: 'withdrawn', revision: 2, allowedActions: ['archive'] }), ...change,
})
function harness(rowChange: Partial<Owned> = {}, sellerRows: SellerOrderProduct[] = []) {
  let owner = '167'
  const row: Owned = { source: 'user-agents', name: 'old-test', displayName: '旧文字反转测试', publicationId: id,
    status: 'review', taskType: 'old_test_v1', artifactDigest: `sha256:${'a'.repeat(64)}`,
    archiveStatus: 'confirmed', reviewReasons: [], lifecycle: lifecycle(), ...rowChange }
  const mine = vi.fn(async () => ({ ok: true as const, value: { items: [row] } }))
  const mutate = vi.fn(async (_request: Request) => ({ ok: true as const, value: receipt() }))
  const unavailable = async () => ({ ok: false as const, error: { message: 'unavailable' } })
  const remote: OrderPublicationRemote = { account: { state: async () => ({ ok: true, value: { account: { id: owner } } }) },
    catalog: { myOrderSkillPublications: mine, mySellerOrderProducts: async () => ({ ok: true, value: { items: sellerRows } }),
      manageOrderSkillPublication: mutate, previewInstalledOrderSkillPrice: unavailable, localCandidates: unavailable,
      checkLocalCandidateInstall: unavailable, localOrderPublicationDraft: unavailable, saveLocalOrderPublicationDraft: unavailable,
      submitInstalledOrderSkill: unavailable, retryInstalledOrderSkillArchive: unavailable, startOrderReviewSamples: unavailable,
      orderSources: unavailable, selectOrderSource: unavailable },
    manager: { inspect: unavailable, installBundle: unavailable, setBundleEnabled: unavailable, checkBundle: unavailable } }
  return { controller: new OrderPublicationController(remote), mine, mutate, row, setOwner: (next: string) => { owner = next } }
}

it('sends only the confirmed publication id, revision and action; withdrawal retains the record', async () => {
  const h = harness(); await h.controller.refreshSkillPublications()
  expect(h.mine).toHaveBeenCalledExactlyOnceWith({ includeArchived: true })
  expect(await h.controller.managePublicationLifecycle({ recordKey: key, publicationId: id,
    expectedRevision: 1, action: 'withdraw' })).toBe(true)
  expect(h.mutate).toHaveBeenCalledExactlyOnceWith({ publicationId: id, expectedRevision: 1, action: 'withdraw',
    note: 'PC owner confirms publication withdraw' })
  expect(h.controller.store.getSnapshot().items[key]).toMatchObject({ phase: 'withdrawn', publicationId: id,
    displayName: '旧文字反转测试', lifecycle: { state: 'withdrawn', revision: 2 } })
  expect(h.controller.store.getSnapshot().busyKey).toBeNull()
  h.controller.dispose()
})

it('archives a server-confirmed inactive record and restores its withdrawn state without enabling orders', async () => {
  const h = harness({ lifecycle: lifecycle({ state: 'withdrawn', revision: 2, allowedActions: ['archive'] }) })
  h.mutate.mockResolvedValueOnce({ ok: true, value: receipt({ lifecycle: lifecycle({ state: 'withdrawn',
    archived: true, revision: 3, allowedActions: ['restore'] }) }) }).mockResolvedValueOnce({ ok: true,
    value: receipt({ lifecycle: lifecycle({ state: 'withdrawn', archived: false, revision: 4, allowedActions: ['archive'] }) }) })
  await h.controller.refreshSkillPublications()
  expect(await h.controller.managePublicationLifecycle({ recordKey: key, publicationId: id,
    expectedRevision: 2, action: 'archive' })).toBe(true)
  expect(h.controller.store.getSnapshot().items[key]).toMatchObject({ phase: 'archived', publicationId: id,
    lifecycle: { archived: true, revision: 3 } })
  expect(await h.controller.managePublicationLifecycle({ recordKey: key, publicationId: id,
    expectedRevision: 3, action: 'restore' })).toBe(true)
  expect(h.controller.store.getSnapshot().items[key]).toMatchObject({ phase: 'withdrawn', publicationId: id,
    lifecycle: { archived: false, state: 'withdrawn', revision: 4 } })
  h.controller.dispose()
})

it('applies a confirmed delisting to the same seller product while retaining its price and publication history', async () => {
  const productId = '27efcd15-89c4-4d07-9fb0-6e7186689bcc'
  const h = harness({ status: 'approved', marketProductId: productId, marketProductStatus: 'published',
    lifecycle: lifecycle({ allowedActions: ['delist', 'archive'] }) }, [{ id: productId, publicationId: id,
    status: 'published', salePriceYuan: '8.00', canApprove: false, reviewReasons: [] }])
  h.mutate.mockResolvedValue({ ok: true, value: receipt({ status: 'approved', marketProductId: productId,
    marketProductStatus: 'suspended', lifecycle: lifecycle({ state: 'delisted', revision: 2, allowedActions: ['archive'] }) }) })
  await h.controller.refreshSkillPublications()
  expect(await h.controller.managePublicationLifecycle({ recordKey: key, publicationId: id,
    expectedRevision: 1, action: 'delist' })).toBe(true)
  const state = h.controller.store.getSnapshot()
  expect(state.items[key]).toMatchObject({ publicationId: id, phase: 'delisted', marketProductStatus: 'suspended' })
  expect(state.sellerProducts[id]).toMatchObject({ id: productId, publicationId: id, status: 'suspended', salePriceYuan: '8.00' })
  h.controller.dispose()
})

it('retains an approved legal skill when the server denies lifecycle actions and refuses a stale revision', async () => {
  const h = harness({ status: 'approved', displayName: '中国法律助手', lifecycle: lifecycle({
    allowedActions: [], blockingReasons: ['active-orders'] }) }); await h.controller.refreshSkillPublications()
  expect(await h.controller.managePublicationLifecycle({ recordKey: key, publicationId: id,
    expectedRevision: 1, action: 'delist' })).toBe(false)
  expect(await h.controller.managePublicationLifecycle({ recordKey: key, publicationId: id,
    expectedRevision: 0, action: 'withdraw' })).toBe(false)
  expect(h.mutate).not.toHaveBeenCalled()
  expect(h.controller.store.getSnapshot().items[key]).toMatchObject({ phase: 'approved', displayName: '中国法律助手' })
  h.controller.dispose()
})

it('rejects owner replacement before the action and discards a late old-owner receipt', async () => {
  const h = harness(); await h.controller.refreshSkillPublications(); h.setOwner('168')
  expect(await h.controller.managePublicationLifecycle({ recordKey: key, publicationId: id,
    expectedRevision: 1, action: 'withdraw' })).toBe(false)
  expect(h.mutate).not.toHaveBeenCalled(); expect(h.controller.store.getSnapshot().items).toEqual({})
  h.setOwner('167'); await h.controller.refreshSkillPublications()
  const pending = Promise.withResolvers<{ ok: true; value: PublicationLifecycleReceipt }>()
  h.mutate.mockReturnValueOnce(pending.promise)
  const action = h.controller.managePublicationLifecycle({ recordKey: key, publicationId: id, expectedRevision: 1, action: 'withdraw' })
  await vi.waitFor(() => { expect(h.mutate).toHaveBeenCalledTimes(1) })
  h.setOwner('168'); pending.resolve({ ok: true, value: receipt() })
  expect(await action).toBe(false); expect(h.controller.store.getSnapshot().items).toEqual({})
  expect(h.controller.store.getSnapshot().busyKey).toBeNull(); h.controller.dispose()
})

it('keeps an unconfirmed row and drops its authority instead of optimistically hiding it', async () => {
  const h = harness(); h.mutate.mockResolvedValue({ ok: true, value: receipt({ publicationId: 'wrong-record' }) })
  await h.controller.refreshSkillPublications()
  expect(await h.controller.managePublicationLifecycle({ recordKey: key, publicationId: id,
    expectedRevision: 1, action: 'withdraw' })).toBe(false)
  expect(h.controller.store.getSnapshot().items[key]).toMatchObject({ phase: 'submitted', publicationId: id, reviewSyncStale: true })
  expect(await h.controller.managePublicationLifecycle({ recordKey: key, publicationId: id,
    expectedRevision: 1, action: 'withdraw' })).toBe(false)
  expect(h.mutate).toHaveBeenCalledTimes(1); h.controller.dispose()
})

it('keeps cloud history manageable after its local skill file is absent', async () => {
  const h = harness({ source: 'platform', name: '旧文字反转测试', lifecycle: lifecycle({
    state: 'withdrawn', archived: true, revision: 3, allowedActions: ['restore'] }) })
  await h.controller.refreshSkillPublications()
  expect(h.controller.store.getSnapshot().items[`publication:${id}`]).toMatchObject({ displayName: '旧文字反转测试', phase: 'archived' })
  expect(h.controller.store.getSnapshot().items[key]).toBeUndefined(); h.controller.dispose()
})

function panelProps(): LocalSkillsPanelProps {
  return { view: { status: 'ready', skills: [] }, t: translate, ensure: async () => {}, reload: async () => {},
    managePublicationLifecycle: vi.fn(async () => true), publication: { busyKey: null, refreshing: false,
      sellerProducts: {}, sellerProductsUnavailable: false, sellerProductErrors: {}, items: { [key]: {
        phase: 'submitted', publicationId: id, displayName: '旧文字反转测试', lifecycle: lifecycle(), archiveStatus: 'confirmed',
      } } } }
}
function panel(props: LocalSkillsPanelProps) {
  return <OrderPublicationsPanel localSkills={props} t={translate} manage={vi.fn()} />
}

it('names the exact Chinese record and its effects, requires confirmation, and allows cancellation', async () => {
  const props = panelProps(); render(panel(props))
  fireEvent.click(screen.getByRole('button', { name: zh.publicationLifecycleWithdraw }))
  const dialog = screen.getByRole('dialog', { name: '确认撤回投稿「旧文字反转测试」' })
  expect(within(dialog).getByText(zh.publicationLifecycleWithdrawEffect)).toBeTruthy()
  expect(within(dialog).getByText(zh.publicationLifecycleHistoryRetained)).toBeTruthy()
  expect(props.managePublicationLifecycle).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: zh.publicationLifecycleCancel }))
  expect(screen.queryByRole('dialog')).toBeNull(); expect(props.managePublicationLifecycle).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh.publicationLifecycleWithdraw }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认撤回投稿' })) })
  expect(props.managePublicationLifecycle).toHaveBeenCalledExactlyOnceWith({ recordKey: key, publicationId: id,
    action: 'withdraw', expectedRevision: 1 })
})

it('blocks a changed confirmation and shows archived records only from actual server state', () => {
  const props = panelProps(); const view = render(panel(props))
  fireEvent.click(screen.getByRole('button', { name: zh.publicationLifecycleWithdraw }))
  const changed: LocalSkillsPanelProps = { ...props, publication: { ...props.publication!, items: { [key]: {
    ...props.publication!.items[key]!, lifecycle: lifecycle({ revision: 2 }),
  } } } }
  view.rerender(panel(changed))
  expect(screen.getByRole('button', { name: '确认撤回投稿' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '确认撤回投稿' })); expect(props.managePublicationLifecycle).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh.publicationLifecycleCancel }))
  view.rerender(panel({ ...props, publication: { ...props.publication!, items: { [key]: {
    ...props.publication!.items[key]!, phase: 'archived', lifecycle: lifecycle({ state: 'withdrawn',
      archived: true, revision: 3, allowedActions: ['restore'] }),
  } } } }))
  expect(screen.queryByRole('heading', { name: '旧文字反转测试' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh.publicationLifecycleArchivedRecords }))
  expect(screen.getByRole('heading', { name: '旧文字反转测试' })).toBeTruthy()
  expect(screen.getByRole('button', { name: zh.publicationLifecycleRestore })).toBeTruthy()
  expect(screen.queryByRole('button', { name: zh.authorEnable })).toBeNull()
})
