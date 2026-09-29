// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarketplacePanel } from '../src/client/MarketplacePanel.tsx'
import type { MarketplaceView, PreflightReportView } from '../src/client/marketplace-controller.ts'
import { en, zh, type MarketplaceKey } from '../src/client/marketplace-locales.ts'

afterEach(cleanup)

const t = (key: MarketplaceKey): string => en[key]

const failed: PreflightReportView = {
  listingId: 'qianshou.article',
  steps: [
    { id: 'signature', state: 'passed', reason: '', detail: '' },
    { id: 'dependencies', state: 'failed', reason: 'DEPENDENCY_MISSING', detail: 'name=qianshou-extra min=1.2.0' },
    { id: 'model', state: 'not-checked', reason: 'PENDING_EARLIER_STEP', detail: '' },
    { id: 'resources', state: 'not-checked', reason: 'PENDING_EARLIER_STEP', detail: '' },
  ],
  verdict: 'failed',
  failedStep: 'dependencies',
  actions: ['fix', 'recheck', 'cancel', 'rollback'],
}

function view(overrides: Partial<MarketplaceView> = {}): MarketplaceView {
  return {
    mode: 'shipped',
    source: 'shipped',
    listings: [{
      id: 'qianshou.article', title: '文章', summary: 'article', capabilityId: 'text.transform',
      version: '1', installable: true,
    }],
    installedRecords: [],
    loading: false,
    busyId: null,
    workingId: null,
    error: null,
    report: null,
    notice: null,
    ...overrides,
  }
}

const actions = () => ({
  ensure: vi.fn(), reload: vi.fn(), inspect: vi.fn(), install: vi.fn(), recheck: vi.fn(), repair: vi.fn(), rollback: vi.fn(), dismiss: vi.fn(),
})

function openDetail(): void {
  fireEvent.click(screen.getByRole('button', { name: en.viewDetails }))
}

function openSkillCreator(): void {
  fireEvent.click(screen.getByRole('button', { name: en.newPlugin }))
  fireEvent.click(screen.getByRole('menuitem', { name: en.skillCreatorStart }))
}

describe('market preflight panel', () => {
  it('opens skill creation as a conversation without starting plugin installation', async () => {
    const props = actions()
    const startSkillCreator = vi.fn(() => Promise.resolve(true))
    render(<MarketplacePanel view={view()} t={t} {...props}
      startSkillCreator={startSkillCreator} />)

    openSkillCreator()
    await vi.waitFor(() => { expect(startSkillCreator).toHaveBeenCalledOnce() })
    expect(props.install).not.toHaveBeenCalled()
  })

  it('shows only the skill assistant and explains when it cannot be opened', async () => {
    render(<MarketplacePanel view={view()} t={t} {...actions()} startSkillCreator={() => Promise.resolve(false)} />)
    fireEvent.click(screen.getByRole('button', { name: en.newPlugin }))
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).not.toContain('Create with Qianshou')
    fireEvent.click(screen.getByRole('menuitem', { name: en.skillCreatorStart }))
    await vi.waitFor(() => { expect(screen.getByRole('status').textContent).toBe(en.creatorUnavailable) })
  })

  it('shows all four checks in order with the failing reason and its facts', () => {
    render(<MarketplacePanel view={view({ error: 'preflightFailed', report: failed })} t={t} {...actions()} />)
    openDetail()
    const items = within(screen.getByRole('list', { name: en.preflightTitle })).getAllByRole('listitem')
    expect(items.map(item => item.textContent)).toEqual([
      'SignaturePassed',
      'DependenciesFailedA required component is not installed on this computer.name=qianshou-extra min=1.2.0',
      `ModelNot checked${en.reasonPendingEarlierStep}`,
      `ResourcesNot checked${en.reasonPendingEarlierStep}`,
    ])
  })

  it('offers exactly the recovery actions the host reported, in its order', () => {
    const props = actions()
    const narrowed = { ...failed, actions: ['rollback', 'cancel'] }
    render(<MarketplacePanel view={view({ error: 'preflightFailed', report: narrowed })} t={t} {...props} />)
    openDetail()
    const buttons = screen.getAllByRole('button').map(button => button.textContent)
    expect(buttons.slice(-3, -1)).toEqual([en.actionRollback, en.actionCancel])
    expect(buttons).not.toContain(en.actionFix)
    expect(buttons).not.toContain(en.actionRecheck)
    fireEvent.click(screen.getByRole('button', { name: en.actionRollback }))
    expect(props.rollback).toHaveBeenCalledExactlyOnceWith('qianshou.article')
    expect(props.dismiss).not.toHaveBeenCalled()
  })

  it('offers fix, check again, roll back and cancel for a failed check', () => {
    const props = actions()
    render(<MarketplacePanel view={view({ error: 'preflightFailed', report: failed })} t={t} {...props} />)
    openDetail()
    const fix = screen.getByRole('button', { name: en.actionFix })
    const recheck = screen.getByRole('button', { name: en.actionRecheck })
    const rollback = screen.getByRole('button', { name: en.actionRollback })
    const cancel = screen.getByRole('button', { name: en.actionCancel })
    fireEvent.click(fix)
    fireEvent.click(recheck)
    fireEvent.click(rollback)
    fireEvent.click(cancel)
    expect(props.repair).toHaveBeenCalledExactlyOnceWith('qianshou.article')
    expect(props.recheck).toHaveBeenCalledExactlyOnceWith('qianshou.article')
    expect(props.rollback).toHaveBeenCalledExactlyOnceWith('qianshou.article')
    expect(props.dismiss).toHaveBeenCalledOnce()
  })

  it('disables the recovery actions while one is in flight', () => {
    render(<MarketplacePanel view={view({ error: 'preflightFailed', report: failed, workingId: 'qianshou.article' })} t={t} {...actions()} />)
    openDetail()
    for (const name of [en.actionFix, en.actionRecheck, en.actionRollback, en.actionCancel]) {
      expect(screen.getByRole('button', { name })).toHaveProperty('disabled', true)
    }
  })

  it('shows no check list before a failure and reports what a repair did', () => {
    render(<MarketplacePanel view={view()} t={t} {...actions()} />)
    expect(screen.queryByRole('listitem')).toBeNull()
    cleanup()
    render(<MarketplacePanel view={view({ notice: 'repairUnavailable' })} t={t} {...actions()} />)
    expect(screen.getByRole('status').textContent).toBe(en.repairUnavailable)
  })

  it('requires an explicit device check before installation and keeps a failed device from installing', () => {
    const props = actions()
    const { rerender } = render(<MarketplacePanel view={view()} t={t} {...props} />)
    openDetail()
    const get = screen.getByRole('button', { name: en.get })
    expect(get).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: en.checkDevice }))
    expect(props.inspect).toHaveBeenCalledExactlyOnceWith('qianshou.article')
    expect(props.install).not.toHaveBeenCalled()
    rerender(<MarketplacePanel view={view({ report: failed, error: 'preflightFailed' })} t={t} {...props} />)
    expect(screen.getByRole('button', { name: en.get })).toHaveProperty('disabled', true)
    rerender(<MarketplacePanel view={view({ report: { ...failed, verdict: 'passed', failedStep: null, actions: [] }, error: null })} t={t} {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.get }))
    expect(props.install).toHaveBeenCalledExactlyOnceWith('qianshou.article')
  })

  it('filters the real catalog by search text without showing fictitious products', () => {
    render(<MarketplacePanel view={view({ listings: [
      ...view().listings,
      { id: 'qianshou.image', title: '图片', summary: 'image', capabilityId: 'image.generate', version: '1', installable: false },
    ] })} t={t} {...actions()} />)
    fireEvent.change(screen.getByRole('searchbox', { name: en.searchLabel }), { target: { value: 'image.generate' } })
    expect(screen.getByText(en.resultCount.replace('{count}', '1'))).toBeTruthy()
    expect(screen.getByRole('heading', { name: en.imageTitle })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: en.articleTitle })).toBeNull()
  })

  it('focuses a skill linked from a community post in the real market catalog', () => {
    const props = actions()
    render(<MarketplacePanel view={view({ listings: [
      ...view().listings,
      { id: 'qianshou.image', title: '图片', summary: 'image', capabilityId: 'image.generate', version: '1', installable: false },
    ] })} t={t} {...props} />)
    fireEvent(window, new CustomEvent('qianshou:open-market-item', { detail: { skillId: 'qianshou.image' } }))
    expect(screen.getByRole('searchbox', { name: en.searchLabel })).toHaveProperty('value', 'qianshou.image')
    expect(screen.getByRole('heading', { name: en.imageTitle })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: en.articleTitle })).toBeNull()
    expect(props.reload).toHaveBeenCalledOnce()
  })

  it('switches market categories and installed listings using real catalog facts', () => {
    render(<MarketplacePanel view={view({ listings: [
      ...view().listings,
      { id: 'qianshou.image', title: '图片', summary: 'image', capabilityId: 'image.generate', version: '1', installable: false },
    ], installedRecords: [{ id: 'qianshou.article', version: '1', capabilityId: 'text.transform' }] })} t={t} {...actions()} />)
    fireEvent.change(screen.getByRole('combobox', { name: en.categoryLabel }), { target: { value: 'image' } })
    expect(screen.getByRole('heading', { name: en.imageTitle })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: en.articleTitle })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: en.installedTab }))
    expect(screen.getByRole('heading', { name: en.articleTitle })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: en.imageTitle })).toBeNull()
  })

  it('shows Chinese category options and finds known catalog entries by their Chinese names', () => {
    const chinese = (key: MarketplaceKey): string => zh[key]
    render(<MarketplacePanel view={view({ listings: [
      { id: 'qianshou.article', title: 'Article', summary: 'Transform text', capabilityId: 'text.transform', version: '1', installable: true },
      { id: 'qianshou.image', title: 'Image', summary: 'Create images', capabilityId: 'image.generate', version: '1', installable: false },
      { id: 'example.video', title: 'Example video', summary: 'Video work', capabilityId: 'video.render', version: '1', installable: true },
    ] })} t={chinese} {...actions()} />)
    const category = screen.getByRole('combobox', { name: zh.categoryLabel })
    expect(within(category).getAllByRole('option').map(option => option.textContent)).toEqual([
      zh.categoryAll, zh.categoryText, zh.categoryImage, zh.categoryVideo,
    ])
    fireEvent.change(category, { target: { value: 'image' } })
    expect(screen.getByRole('heading', { name: zh.imageTitle })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: zh.articleTitle })).toBeNull()
    fireEvent.change(category, { target: { value: 'all' } })
    fireEvent.change(screen.getByRole('searchbox', { name: zh.searchLabel }), { target: { value: zh.imageTitle } })
    expect(screen.getByRole('heading', { name: zh.imageTitle })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: zh.articleTitle })).toBeNull()
  })

  it.each([
    { version: '0', capabilityId: 'text.transform' },
    { version: '1', capabilityId: 'text.other' },
  ])('does not treat a saved record with changed version or capability as current: %j', record => {
    const props = actions()
    render(<MarketplacePanel view={view({
      installedRecords: [{ id: 'qianshou.article', ...record }],
    })} t={t} {...props} />)
    expect(screen.getByText(en.needsUpdate)).toBeTruthy()
    expect(screen.queryByText(en.installed)).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: en.installedTab }))
    expect(screen.getByRole('heading', { name: en.articleTitle })).toBeTruthy()
    openDetail()
    expect(screen.getByRole('button', { name: en.get })).toHaveProperty('disabled', true)
    expect(screen.getByText(en.updateCheckFirst)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.checkDevice }))
    expect(props.inspect).toHaveBeenCalledExactlyOnceWith('qianshou.article')
  })

  it('keeps a saved record visible after its catalog listing disappears', () => {
    render(<MarketplacePanel view={view({
      listings: [], installedRecords: [{ id: 'old.article', version: '1', capabilityId: 'text.transform' }],
    })} t={t} {...actions()} />)
    fireEvent.click(screen.getByRole('tab', { name: en.installedTab }))
    expect(screen.getByRole('heading', { name: 'old.article' })).toBeTruthy()
    expect(screen.getByText(en.delisted)).toBeTruthy()
    expect(screen.getByText(en.delistedExplanation)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.viewDetails })).toBeNull()
  })

  it('opens the Host package inspection flow for a Git link', () => {
    const openPackageInstall = vi.fn()
    render(<MarketplacePanel view={view()} t={t} {...actions()} openPackageInstall={openPackageInstall} />)
    fireEvent.click(screen.getByRole('button', { name: en.newPlugin }))
    fireEvent.click(screen.getByRole('menuitem', { name: en.installFromLink }))
    expect(openPackageInstall).toHaveBeenCalledOnce()
  })

  it('shows declared OS and process requirements and a real mismatch without enabling install', () => {
    const mismatch: PreflightReportView = {
      ...failed,
      failedStep: 'resources',
      steps: failed.steps.map(step => step.id === 'resources'
        ? { id: 'resources', state: 'failed', reason: 'RESOURCE_PLATFORM_UNSUPPORTED', detail: 'platform=darwin required=win32' }
        : { ...step, state: 'passed', reason: '', detail: '' }),
      compatibility: {
        platform: { state: 'mismatched', observed: 'darwin', required: ['win32'] },
        architecture: { state: 'not-checked', observed: 'arm64', required: ['x64'] },
        gpuMemory: { state: 'not-probed' },
      },
    }
    render(<MarketplacePanel view={view({ report: mismatch, error: 'preflightFailed', listings: [{
      ...view().listings[0]!, packageSpec: '@publisher/workflow@1', requirements: {
        signature: { kind: 'publisher', publisher: 'publisher', value: 'signed' },
        packages: [], model: '', minFreeDiskBytes: 0, minTotalMemoryBytes: 0,
        platforms: ['win32'], architectures: ['x64'],
      },
    }] })} t={t} {...actions()} />)
    openDetail()
    expect(screen.getAllByText('Windows').length).toBeGreaterThan(0)
    expect(screen.getByText('macOS · Does not match')).toBeTruthy()
    expect(screen.getByText(en.reasonPlatformUnsupported)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.get })).toHaveProperty('disabled', true)
  })
})
