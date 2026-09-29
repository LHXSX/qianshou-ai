// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { LocalPluginCandidatesPanel } from '../src/client/LocalPluginCandidatesPanel.tsx'
import { zh } from '../src/client/local-plugin-candidate-locales.ts'
import { LocalPluginCandidatesController } from '../src/client/local-plugin-candidates-controller.ts'
import type { LocalPluginCandidateView } from '../src/client/local-plugin-candidates-controller.ts'

const candidate: LocalPluginCandidateView = {
  draftId: 'plugin_draft_12345678-1234-1234-1234-123456789abc', packageName: 'qianshou-local-123', packagePath: '/private/candidate-123',
  toolName: 'qianshou_local_123', sourceDigest: 'a'.repeat(64), packageDigest: 'b'.repeat(64),
  displayName: '文字统计', description: '计算文字数量', operationTitle: '统计文字', preparedAt: 123,
  installableLocally: true, published: false, dispatchable: false,
  orderAdapter: { version: 1, capabilityId: 'text.transform', taskType: 'word_count',
    inputKind: 'inline', outputKind: 'inline_json', contractVersion: 'v1' },
}
const t = (key: keyof typeof zh) => zh[key]
const emptyPublication = { sellerProducts: {}, sellerProductsUnavailable: false, sellerProductErrors: {} }
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('shows a private candidate and starts verified installation with one click', () => {
  const reload = vi.fn(async () => {})
  const reviewInstall = vi.fn()
  render(<LocalPluginCandidatesPanel view={{ status: 'ready', candidates: [candidate] }} installed={[]}
    t={t} reload={reload} reviewInstall={reviewInstall} />)
  expect(reload).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('heading', { name: '文字统计' })).toBeTruthy()
  expect(screen.getByText(zh.boundary)).toBeTruthy()
  expect(reviewInstall).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText(zh.details))
  expect(screen.getByText(candidate.packagePath)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: zh.reviewInstall }))
  expect(reviewInstall).toHaveBeenCalledExactlyOnceWith(candidate)
})

it('does not offer a second install when the package is already installed', () => {
  const checkInstalled = vi.fn(async () => {})
  render(<LocalPluginCandidatesPanel view={{ status: 'ready', candidates: [candidate] }}
    installed={[{ name: candidate.packageName, installed: true, enabled: true }]}
    t={t} reload={vi.fn(async () => {})} reviewInstall={vi.fn()} checkInstalled={checkInstalled} />)
  expect(screen.getByText(zh.installedOn)).toBeTruthy()
  expect(screen.getByText(zh.installedNote)).toBeTruthy()
  expect(screen.queryByRole('button', { name: zh.reviewInstall })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh.checkInstalled }))
  expect(checkInstalled).toHaveBeenCalledExactlyOnceWith(candidate)
})

it('compares installed candidate bytes read only and clears a stale comparison after package change', async () => {
  const checkLocalCandidateInstall = vi.fn(async () => ({ ok: true as const, value: {
    packageName: candidate.packageName, packageDigest: candidate.packageDigest,
    matched: true, reason: 'matched' as const,
  } }))
  const controller = new LocalPluginCandidatesController({
    localCandidates: async () => ({ ok: true, value: { candidates: [candidate] } }),
    checkLocalCandidateInstall,
  })
  await controller.reload()
  await controller.checkInstalled(candidate)
  expect(checkLocalCandidateInstall).toHaveBeenCalledExactlyOnceWith({
    draftId: candidate.draftId, packageDigest: candidate.packageDigest, requireOrderAdapter: false,
  })
  expect(controller.store.getSnapshot().installedChecks?.[`${candidate.draftId}:${candidate.packageDigest}`])
    .toBe('matched')
  const { rerender } = render(<LocalPluginCandidatesPanel view={controller.store.getSnapshot()}
    installed={[{ name: candidate.packageName, installed: true, enabled: true }]}
    t={t} reload={vi.fn(async () => {})} reviewInstall={vi.fn()}
    checkInstalled={item => controller.checkInstalled(item)} />)
  expect(screen.getByText(zh.installedMatched)).toBeTruthy()
  controller.invalidateInstalledChecks()
  rerender(<LocalPluginCandidatesPanel view={controller.store.getSnapshot()}
    installed={[{ name: candidate.packageName, installed: true, enabled: true }]}
    t={t} reload={vi.fn(async () => {})} reviewInstall={vi.fn()}
    checkInstalled={item => controller.checkInstalled(item)} />)
  expect(screen.getByText(zh.installedNote)).toBeTruthy()
  controller.dispose()
})

it('does not call a same-name package verified when installed bytes differ', async () => {
  const controller = new LocalPluginCandidatesController({
    localCandidates: async () => ({ ok: true, value: { candidates: [candidate] } }),
    checkLocalCandidateInstall: async () => ({ ok: true, value: { packageName: candidate.packageName,
      packageDigest: candidate.packageDigest, matched: false, reason: 'changed' } }),
  })
  await controller.reload()
  await controller.checkInstalled(candidate)
  render(<LocalPluginCandidatesPanel view={controller.store.getSnapshot()}
    installed={[{ name: candidate.packageName, installed: true, enabled: true }]}
    t={t} reload={vi.fn(async () => {})} reviewInstall={vi.fn()}
    checkInstalled={item => controller.checkInstalled(item)} />)
  expect(screen.getByRole('alert').textContent).toContain(zh.installedChanged)
  controller.dispose()
})

it('offers the order publication path and labels local readiness without claiming platform acceptance', () => {
  const publishOrderCandidate = vi.fn(async () => {})
  const openIntake = vi.fn()
  render(<LocalPluginCandidatesPanel view={{ status: 'ready', candidates: [candidate] }} installed={[]}
    t={t} reload={vi.fn(async () => {})} reviewInstall={vi.fn()} publishOrderCandidate={publishOrderCandidate}
    openIntake={openIntake} publication={{ ...emptyPublication, busyKey: null,
      items: { [`candidate:${candidate.draftId}`]: { phase: 'ready' } } }} />)
  fireEvent.click(screen.getByRole('button', { name: zh.publishOrder }))
  expect(publishOrderCandidate).toHaveBeenCalledWith(candidate)
  expect(screen.getByText(zh.publishReady)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: zh.openIntake }))
  expect(openIntake).toHaveBeenCalledTimes(1)
})

it('hides the order preparation action for a plugin without an approved task adapter', () => {
  const openOrderReview = vi.fn()
  const withoutAdapter = { ...candidate }
  delete withoutAdapter.orderAdapter
  render(<LocalPluginCandidatesPanel view={{ status: 'ready', candidates: [withoutAdapter] }}
    installed={[]} t={t} reload={vi.fn(async () => {})} reviewInstall={vi.fn()}
    openOrderReview={openOrderReview} publication={{ ...emptyPublication, busyKey: null, items: {} }} />)
  expect(screen.queryByRole('button', { name: zh.publishOrder })).toBeNull()
  expect(screen.getByRole('button', { name: zh.reviewInstall })).toBeTruthy()
  expect(screen.getByText(zh.boundary)).toBeTruthy()
  expect(openOrderReview).not.toHaveBeenCalled()
})

it('connects the publish button to a review sheet with editable metadata and separate receipt stages', () => {
  const openOrderReview = vi.fn()
  const editOrderReview = vi.fn()
  const saveOrderReview = vi.fn(async () => {})
  const closeOrderReview = vi.fn()
  const common = { view: { status: 'ready' as const, candidates: [candidate] }, installed: [], t,
    reload: vi.fn(async () => {}), reviewInstall: vi.fn(), openOrderReview, editOrderReview,
    saveOrderReview, closeOrderReview }
  const { rerender } = render(<LocalPluginCandidatesPanel {...common}
    publication={{ ...emptyPublication, busyKey: null, items: {} }} />)
  fireEvent.click(screen.getByRole('button', { name: zh.publishOrder }))
  expect(openOrderReview).toHaveBeenCalledExactlyOnceWith(candidate)
  rerender(<LocalPluginCandidatesPanel {...common} publication={{ ...emptyPublication, busyKey: null,
    items: { [`candidate:${candidate.draftId}`]: { phase: 'ready' } },
    review: { candidate, status: 'ready', name: candidate.displayName, purpose: candidate.description,
      category: 'text', configuration: '', saleMode: 'free', salePriceYuan: '' } }} />)
  expect(screen.getByRole('dialog', { name: zh.reviewTitle })).toBeTruthy()
  expect(screen.getByText(zh.reviewStageLocalReady)).toBeTruthy()
  expect(screen.getByText(zh.reviewStageSubmitBlocked)).toBeTruthy()
  expect(screen.getByText(zh.reviewStageAcceptNone)).toBeTruthy()
  expect(screen.getByText(zh.reviewStageBuyerNone)).toBeTruthy()
  expect(screen.getByText(zh.reviewStageGrantUnchanged)).toBeTruthy()
  expect(screen.getByText(zh.reviewSaleHint)).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox', { name: zh.reviewName }), { target: { value: '词频助手' } })
  expect(editOrderReview).toHaveBeenCalledWith({ name: '词频助手' })
  fireEvent.click(screen.getByRole('button', { name: zh.reviewSave }))
  expect(saveOrderReview).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: zh.reviewClose }))
  expect(closeOrderReview).toHaveBeenCalledTimes(1)
})
