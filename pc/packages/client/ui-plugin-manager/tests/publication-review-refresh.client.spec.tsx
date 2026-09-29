// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { usePublicationReviewRefresh } from '../src/client/use-publication-review-refresh.ts'
import { OrderPublicationsPanel } from '../src/client/OrderPublicationsPanel.tsx'
import { LocalSkillsPanel, type LocalSkillsPanelProps } from '../src/client/LocalSkillsPanel.tsx'
import { zh } from '../src/client/local-skill-locales.ts'
import { zh as marketZh } from '../src/client/marketplace-locales.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

it.each(['order-author-key-unavailable', 'order-archive-upload-failed', 'https://private.example/?token=secret'])(
  'shows the same safe archive failure on both author pages for %s', (archiveError) => {
    const message = archiveError === 'order-author-key-unavailable' ? zh.publishAuthorKeyUnavailable
      : archiveError === 'order-archive-upload-failed' ? zh.publishArchiveUploadFailed : zh.publishArchiveError
    const props: LocalSkillsPanelProps = {
      view: { status: 'ready', skills: [{ source: 'user-agents', name: 'sample', displayName: 'H3合同校验',
        description: '仅参数校验', path: '/skills/sample/SKILL.md', updatedAt: 1, userInvocable: true, modelInvocable: true }] },
      t: key => zh[key], ensure: vi.fn(async () => {}), reload: vi.fn(async () => {}),
      publication: { busyKey: null, sellerProducts: {}, sellerProductsUnavailable: false, sellerProductErrors: {},
        items: { 'skill:user-agents:sample': { phase: 'archive-pending', publicationId: 'current-version', archiveError } } },
    }
    const view = render(<OrderPublicationsPanel localSkills={props} t={key => marketZh[key]} manage={vi.fn()} />)
    expect(screen.getByRole('alert').textContent).toBe(message)
    expect(view.container.textContent).not.toContain('private.example')
    view.unmount()
    const mine = render(<LocalSkillsPanel {...props} />)
    expect(screen.getByRole('alert').textContent).toBe(message)
    expect(mine.container.textContent).not.toContain('private.example')
  },
)

it('reads serially while pending and stops after the page leaves or review completes', async () => {
  vi.useFakeTimers()
  let finish!: () => void
  const refresh = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
  const hook = renderHook(({ enabled }) => { usePublicationReviewRefresh(enabled, refresh, false) },
    { initialProps: { enabled: true } })
  await act(() => vi.advanceTimersByTimeAsync(15_000))
  expect(refresh).toHaveBeenCalledOnce()
  await act(() => vi.advanceTimersByTimeAsync(60_000))
  expect(refresh).toHaveBeenCalledOnce()
  await act(async () => { finish() })
  await act(() => vi.advanceTimersByTimeAsync(15_000))
  expect(refresh).toHaveBeenCalledTimes(2)
  hook.rerender({ enabled: false })
  await act(async () => { finish() })
  await act(() => vi.advanceTimersByTimeAsync(60_000))
  expect(refresh).toHaveBeenCalledTimes(2)
  hook.unmount()
})

it('pauses hidden pages and owner actions, then recovers from a failed read', async () => {
  vi.useFakeTimers()
  let hidden = true
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => hidden ? 'hidden' : 'visible')
  const refresh = vi.fn().mockRejectedValueOnce(new Error('read unavailable')).mockResolvedValue(undefined)
  const hook = renderHook(({ busy }) => { usePublicationReviewRefresh(true, refresh, busy) },
    { initialProps: { busy: false } })
  await act(() => vi.advanceTimersByTimeAsync(60_000))
  expect(refresh).not.toHaveBeenCalled()
  hidden = false
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
  hook.rerender({ busy: true })
  await act(() => vi.advanceTimersByTimeAsync(15_000))
  expect(refresh).not.toHaveBeenCalled()
  hook.rerender({ busy: false })
  await act(() => vi.advanceTimersByTimeAsync(30_000))
  expect(refresh).toHaveBeenCalledTimes(2)
  hook.unmount()
  await act(() => vi.advanceTimersByTimeAsync(60_000))
  expect(refresh).toHaveBeenCalledTimes(2)
})

it('uses the latest read callback without restarting the waiting period', async () => {
  vi.useFakeTimers()
  const first = vi.fn(async () => {})
  const second = vi.fn(async () => {})
  const hook = renderHook(({ refresh }) => { usePublicationReviewRefresh(true, refresh, false) },
    { initialProps: { refresh: first } })
  await act(() => vi.advanceTimersByTimeAsync(10_000))
  hook.rerender({ refresh: second })
  await act(() => vi.advanceTimersByTimeAsync(5_000))
  expect(first).not.toHaveBeenCalled()
  expect(second).toHaveBeenCalledOnce()
})

it('distinguishes missing automatic evidence from invalid evidence without granting publication', () => {
  const props: LocalSkillsPanelProps = {
    view: { status: 'ready', skills: [] }, t: key => zh[key], ensure: vi.fn(async () => {}),
    reload: vi.fn(async () => {}), refreshPublications: vi.fn(async () => {}),
    submitSkillProduct: vi.fn(async () => false), publication: {
      busyKey: null, sellerProducts: {}, sellerProductErrors: {}, sellerProductsUnavailable: false,
      items: { 'skill:user-agents:reverse': { phase: 'submitted', publicationId: 'real-publication',
        reviewReasons: ['sample: 可信回执缺失或过大', 'package: 可信回执缺失或过大'],
        evidenceStatus: { sample: 'missing', package: 'invalid' },
        reviewSampleStatus: 'independent_sample_required' } },
    },
  }
  render(<OrderPublicationsPanel localSkills={props} t={key => marketZh[key]} manage={vi.fn()} />)
  expect(screen.getByText(zh.publishEvidencePending.replace('{kind}', zh.publishEvidenceSample))).toBeTruthy()
  expect(screen.getByText(zh.publishEvidenceInvalid.replace('{kind}', zh.publishEvidencePackage))).toBeTruthy()
  expect(screen.getByText(zh.publishAutoReviewProgress)).toBeTruthy()
  expect(props.submitSkillProduct).not.toHaveBeenCalled()
})

it('keeps reading pending review on My Skills, then stops when its platform receipt is approved', async () => {
  vi.useFakeTimers()
  const refresh = vi.fn(async () => {})
  const props: LocalSkillsPanelProps = {
    view: { status: 'ready', skills: [{ source: 'user-agents', name: 'sample', displayName: '新技能',
      description: '当前技能', path: '/skills/sample/SKILL.md', updatedAt: 1, userInvocable: true, modelInvocable: true }] },
    t: key => zh[key], ensure: vi.fn(async () => {}), reload: vi.fn(async () => {}),
    refreshPublications: refresh,
    publication: { busyKey: null, sellerProducts: {}, sellerProductsUnavailable: false, sellerProductErrors: {},
      items: { 'skill:user-agents:sample': { phase: 'submitted', publicationId: 'current-version' } } },
  }
  const view = render(<LocalSkillsPanel {...props} />)
  expect(refresh).toHaveBeenCalledOnce()
  await act(() => vi.advanceTimersByTimeAsync(15_000))
  expect(refresh).toHaveBeenCalledTimes(2)
  view.rerender(<LocalSkillsPanel {...props} publication={{ ...props.publication!, items: {
    'skill:user-agents:sample': { phase: 'approved', publicationId: 'current-version' },
  } }} />)
  expect(screen.getByText(zh.publishStatusApproved)).toBeTruthy()
  await act(() => vi.advanceTimersByTimeAsync(60_000))
  expect(refresh).toHaveBeenCalledTimes(2)
})

it('shows an in-progress read and only confirms a fresh platform sync when the receipt is not stale', () => {
  const syncedAt = new Date('2026-09-27T04:00:00+08:00').getTime()
  const props: LocalSkillsPanelProps = { view: { status: 'ready', skills: [] },
    t: key => zh[key], ensure: vi.fn(async () => {}), reload: vi.fn(async () => {}),
    refreshPublications: vi.fn(async () => {}), publication: {
      busyKey: null, refreshing: true, sellerProducts: {}, sellerProductsUnavailable: false, sellerProductErrors: {},
      items: { 'publication:receipt': { phase: 'submitted', publicationId: 'receipt' } },
    } }
  const view = render(<OrderPublicationsPanel localSkills={props} t={key => marketZh[key]} manage={vi.fn()} />)
  expect(screen.getByRole('button', { name: zh.publishRefreshingReview }).hasAttribute('disabled')).toBe(true)
  const synced = zh.publishReviewSynced.replace('{time}', new Date(syncedAt).toLocaleTimeString())
  view.rerender(<OrderPublicationsPanel localSkills={{ ...props, publication: { ...props.publication!, refreshing: false,
    reviewSyncedAt: syncedAt } }} t={key => marketZh[key]} manage={vi.fn()} />)
  expect(screen.getByText(synced)).toBeTruthy()
  view.rerender(<OrderPublicationsPanel localSkills={{ ...props, publication: { ...props.publication!, refreshing: false,
    reviewSyncedAt: syncedAt, items: { 'publication:receipt': {
      phase: 'submitted', publicationId: 'receipt', reviewSyncStale: true,
    } } } }} t={key => marketZh[key]} manage={vi.fn()} />)
  expect(screen.queryByText(synced)).toBeNull()
  expect(screen.getByText(zh.publishReviewSyncStale)).toBeTruthy()
})
