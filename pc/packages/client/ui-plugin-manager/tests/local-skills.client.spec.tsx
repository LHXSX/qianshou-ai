// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { LocalSkillEntry, SkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import { LocalSkillsPanel } from '../src/client/LocalSkillsPanel.tsx'
import { zh } from '../src/client/local-skill-locales.ts'
import { OrderPublicationController, type OrderPublicationRemote } from '../src/client/order-publication-controller.ts'

const svg: LocalSkillEntry = {
  name: 'svg-to-video', displayName: 'SVG 绘图转视频', description: '把 SVG 绘图逐帧展开并合成为 MP4/GIF 视频。',
  category: 'video', source: 'user-agents', path: '/home/me/.agents/skills/svg-to-video/SKILL.md',
  updatedAt: 200, modelInvocable: true, userInvocable: true,
}
const text: LocalSkillEntry = {
  name: 'share', displayName: 'share', description: 'Save and share a repository.',
  source: 'user-agents', path: '/home/me/.agents/skills/share/SKILL.md',
  updatedAt: 100, modelInvocable: true, userInvocable: true,
}
const svgEligible = { source: svg.source, name: svg.name, path: svg.path,
  serviceTitle: 'SVG 绘图转视频', serviceDescription: svg.description,
  taskType: 'bar_chart_svg_v1', artifactDigest: `sha256:${'a'.repeat(64)}` }
const labels = (key: keyof typeof zh) => zh[key]
const actions = { ensure: vi.fn(async () => {}), reload: vi.fn(async () => {}), useSkill: vi.fn(() => true) }
const emptyPublication = { sellerProducts: {}, sellerProductsUnavailable: false, sellerProductErrors: {} }
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('reviews a reversible local removal and states that its cloud publication remains', async () => {
  const archiveLocalSkill = vi.fn(async () => true)
  const removable = { ...text, canArchive: true, sha256: 'a'.repeat(64) }
  render(<LocalSkillsPanel view={{ status: 'ready', skills: [removable] }} t={labels} {...actions}
    archiveLocalSkill={archiveLocalSkill} publication={{ ...emptyPublication, busyKey: null, items: {
      'skill:user-agents:share': { phase: 'approved', publicationId: 'existing-publication', reviewReasons: [] },
    } }} />)
  fireEvent.click(screen.getByRole('button', { name: zh.localRemove }))
  expect(screen.getByText(zh.localRemoveCloud)).toBeTruthy()
  expect(archiveLocalSkill).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh.localRemoveCancel }))
  expect(screen.queryByRole('group', { name: zh.localRemoveTitle })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh.localRemove }))
  fireEvent.click(screen.getByRole('button', { name: zh.localRemoveConfirm }))
  expect(archiveLocalSkill).toHaveBeenCalledExactlyOnceWith({ source: text.source, name: text.name,
    path: text.path, sha256: removable.sha256 })
})

it('hides local removal for managed packages and retains failure or restoration details', () => {
  const archiveLocalSkill = vi.fn(async () => false)
  const removable = { ...text, canArchive: true, sha256: 'a'.repeat(64) }
  const panel = render(<LocalSkillsPanel view={{ status: 'ready', skills: [{ ...removable, canArchive: false }] }}
    t={labels} {...actions} archiveLocalSkill={archiveLocalSkill} />)
  expect(screen.queryByRole('button', { name: zh.localRemove })).toBeNull()
  panel.rerender(<LocalSkillsPanel view={{ status: 'ready', skills: [removable], removals: {
    [text.path]: { phase: 'failed', reason: 'skill-import/in-use' },
  } }} t={labels} {...actions} archiveLocalSkill={archiveLocalSkill} />)
  fireEvent.click(screen.getByRole('button', { name: zh.localRemove }))
  expect(screen.getByRole('alert').textContent).toBe(zh.localRemoveInUse)
  panel.rerender(<LocalSkillsPanel view={{ status: 'ready', skills: [], removals: {
    [text.path]: { phase: 'archived', receipt: { state: 'archived', source: text.source, name: text.name,
      originalPath: '/skills/share', archivePath: '/archives/share', receiptPath: '/archives/restore.json', sha256: 'a'.repeat(64) } },
  } }} t={labels} {...actions} archiveLocalSkill={archiveLocalSkill} />)
  expect(screen.getByText(zh.localRemoveDone)).toBeTruthy()
  expect(screen.queryByText('/archives/share')).toBeNull()
  expect(screen.queryByRole('button', { name: zh.localRemoveConfirm })).toBeNull()
})

describe('local skill discovery presentation', () => {
  it('enables a published author skill directly without navigating to authorization', () => {
    const enableOrderSkill = vi.fn(async () => {})
    const openIntake = vi.fn()
    render(<LocalSkillsPanel view={{ status: 'ready', skills: [svg], eligibilityStatus: 'ready', orderEligible: [svgEligible] }} t={labels} {...actions}
      enableOrderSkill={enableOrderSkill} openIntake={openIntake}
      publication={{ ...emptyPublication, busyKey: null, items: { 'skill:user-agents:svg-to-video': {
        phase: 'approved', marketProductId: 'b9418e38-b3a5-5722-8005-cc7afbe2a21a',
        marketProductStatus: 'published', reviewReasons: [],
      } } }} />)
    fireEvent.click(screen.getByRole('button', { name: zh.authorEnable }))
    expect(enableOrderSkill).toHaveBeenCalledExactlyOnceWith('user-agents', 'svg-to-video')
    expect(openIntake).not.toHaveBeenCalled()
    expect(screen.queryByText(zh.authorEnabled)).toBeNull()
  })

  it('shows the true review sample stage and gives a blocked sample one retry without republishing', () => {
    const retryReviewSamples = vi.fn(async () => {})
    const view = render(<LocalSkillsPanel view={{ status: 'ready', skills: [svg] }} t={labels} {...actions}
      retryReviewSamples={retryReviewSamples} publication={{ ...emptyPublication, busyKey: null, items: {
        'skill:user-agents:svg-to-video': { phase: 'submitted',
          reviewSampleStatus: 'running', mediaEvidenceStatus: 'missing', reviewReasons: [] },
      } }} />)
    expect(screen.getByText(zh.publishSampleRunning)).toBeTruthy()
    expect(screen.queryByRole('button', { name: zh.publishSampleRetry })).toBeNull()
    view.rerender(<LocalSkillsPanel view={{ status: 'ready', skills: [svg] }} t={labels} {...actions}
      retryReviewSamples={retryReviewSamples} publication={{ ...emptyPublication, busyKey: null, items: {
        'skill:user-agents:svg-to-video': { phase: 'submitted',
          reviewSampleStatus: 'blocked', mediaEvidenceStatus: 'invalid', reviewReasons: [] },
      } }} />)
    expect(screen.getByText(zh.publishSampleInvalid)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.publishSampleRetry }))
    expect(retryReviewSamples).toHaveBeenCalledExactlyOnceWith('user-agents', 'svg-to-video')
  })

  it('shows generic independent sample review without offering the SVG sample retry', () => {
    const retryReviewSamples = vi.fn(async () => {})
    render(<LocalSkillsPanel view={{ status: 'ready', skills: [svg] }} t={labels} {...actions}
      retryReviewSamples={retryReviewSamples} publication={{ ...emptyPublication, busyKey: null, items: {
        'skill:user-agents:svg-to-video': { phase: 'submitted',
          reviewSampleStatus: 'independent_sample_required', reviewReasons: [] },
      } }} />)
    expect(screen.getByText(zh.publishIndependentSampleRequired)).toBeTruthy()
    expect(screen.queryByRole('button', { name: zh.publishSampleRetry })).toBeNull()
  })

  it('shows the server review result after refresh without claiming that orders are enabled', () => {
    const refreshPublications = vi.fn(async () => {})
    render(<LocalSkillsPanel view={{ status: 'ready', skills: [svg] }} t={labels} {...actions}
      refreshPublications={refreshPublications} publication={{ ...emptyPublication, busyKey: null, items: {
        'skill:user-agents:svg-to-video': { phase: 'approved',
          publicationId: 'b9418e38-b3a5-5722-8005-cc7afbe2a21a', reviewReasons: [] },
      } }} />)
    expect(refreshPublications).toHaveBeenCalledTimes(1)
    expect(screen.getByText(zh.publishStatusApproved)).toBeTruthy()
    expect(screen.getByText(zh.publishApproved)).toBeTruthy()
    expect(screen.queryByText(zh.publishStatusReady)).toBeNull()
  })

  it('shows a stale receipt honestly, expands every review reason and refreshes on demand', () => {
    const refreshPublications = vi.fn(async () => {})
    const reasons = Array.from({ length: 12 }, (_, index) => `审核条件 ${index + 1}`)
    render(<LocalSkillsPanel view={{ status: 'ready', skills: [svg] }} t={labels} {...actions}
      refreshPublications={refreshPublications} publication={{ ...emptyPublication, busyKey: null, items: {
        'skill:user-agents:svg-to-video': { phase: 'submitted', reviewSyncStale: true,
          publicationId: 'b9418e38-b3a5-5722-8005-cc7afbe2a21a', reviewReasons: reasons,
          packageMigrationRequired: true },
      } }} />)
    expect(screen.getByText(zh.publishPackageMigration)).toBeTruthy()
    expect(screen.getByText(zh.publishReviewSyncStale)).toBeTruthy()
    expect(screen.getByText(zh.publishStatusStale)).toBeTruthy()
    fireEvent.click(screen.getByText(zh.publishReviewReasons.replace('{count}', '12')))
    for (const reason of reasons) expect(screen.getByText(reason)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.publishRefreshReview }))
    expect(refreshPublications).toHaveBeenCalledTimes(2)
  })

  it('submits the exact installed SVG adapter for platform review without enabling media intake', async () => {
    const selectOrderSource = vi.fn()
    const submitInstalledOrderSkill = vi.fn(async () => ({ ok: true as const, value: {
      publicationId: 'b9418e38-b3a5-5722-8005-cc7afbe2a21a', status: 'review' as const,
      taskType: 'bar_chart_svg_v1', artifactDigest: 'sha256:' + 'a'.repeat(64),
      reviewReasons: ['等待广州审核'], platformReady: false, archiveStatus: 'confirmed' as const,
      priceYuan: '2.50',
    } }))
    const controller = new OrderPublicationController({ catalog: {
      submitInstalledOrderSkill,
      orderSources: async () => ({ ok: true, value: { complete: true,
        order: { enabledServiceIds: ['node'] }, sources: [{ id: 'skill:user-agents:svg-to-video', kind: 'skill',
          selectable: false, eligible: false, enabled: false, serviceId: null, reason: 'file-input-unsupported' }] } }),
      selectOrderSource,
    } } as unknown as OrderPublicationRemote)
    function ConnectedPanel() {
      const publication = useSyncExternalStore(
        listener => controller.store.subscribe(listener), () => controller.store.getSnapshot())
      return <LocalSkillsPanel view={{ status: 'ready', skills: [svg],
        eligibilityStatus: 'ready', orderEligible: [svgEligible] }} t={labels} {...actions}
        publication={publication} publishOrderSkill={(source, name, review) => controller.publishSkill(source, name, review)} />
    }
    render(<ConnectedPanel />)
    fireEvent.click(screen.getByRole('button', { name: zh.publishOrder }))
    expect(screen.getByRole('dialog', { name: zh.publishReviewTitle })).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: zh.publishReviewPrice }), { target: { value: '2.50' } })
    fireEvent.change(screen.getByRole('textbox', { name: zh.publishSalePrice }), { target: { value: '20.00' } })
    fireEvent.click(screen.getByRole('button', { name: zh.publishReviewSubmit }))
    await waitFor(() => expect(screen.getByText(zh.publishStatusSubmitted)).toBeTruthy())
    expect(screen.queryByRole('button', { name: zh.publishOrder })).toBeNull()
    expect(screen.getByText(/b9418e38-b3a5-5722-8005-cc7afbe2a21a/u)).toBeTruthy()
    expect(screen.getByText(zh.publishReceiptPrice.replace('{price}', '2.50'))).toBeTruthy()
    expect(submitInstalledOrderSkill).toHaveBeenCalledWith({ source: 'user-agents', name: 'svg-to-video',
      displayName: 'SVG 绘图转视频', purpose: svg.description, configuration: '', priceYuan: '2.50', salePriceYuan: '20.00',
      expectedArtifactDigest: svgEligible.artifactDigest })
    expect(selectOrderSource).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('starts real adapter development when a file adapter is blocked instead of opening a doomed review sheet', async () => {
    const publishOrderSkill = vi.fn(async () => {})
    const planOrderAdapter = vi.fn(async () => true)
    render(<LocalSkillsPanel view={{ status: 'ready', skills: [svg],
      eligibilityStatus: 'ready', orderEligible: [svgEligible] }} t={labels} {...actions}
      publishOrderSkill={publishOrderSkill} planOrderAdapter={planOrderAdapter} publication={{ ...emptyPublication, busyKey: null,
        items: { 'skill:user-agents:svg-to-video': { phase: 'blocked', reason: 'file-input-unsupported' } } }} />)
    fireEvent.click(screen.getByRole('button', { name: zh.publishOrder }))
    expect(publishOrderSkill).not.toHaveBeenCalled()
    await waitFor(() => expect(planOrderAdapter).toHaveBeenCalledExactlyOnceWith('user-agents', 'svg-to-video'))
    expect(screen.queryByRole('dialog', { name: zh.publishReviewTitle })).toBeNull()
    expect(screen.getByText(zh.publishBlockedFile)).toBeTruthy()
  })

  it('submits a free sale once and shows the approved product receipt without a second application', async () => {
    const submitSkillProduct = vi.fn(async () => true)
    const submitInstalledOrderSkill = vi.fn(async () => ({ ok: true as const, value: {
      publicationId: 'b9418e38-b3a5-5722-8005-cc7afbe2a21a', status: 'approved' as const,
      taskType: 'bar_chart_svg_v1', artifactDigest: svgEligible.artifactDigest,
      reviewReasons: [], platformReady: false, archiveStatus: 'confirmed' as const,
      priceYuan: '2.50', salePriceYuan: '0.00',
      marketProductId: '104a209d-553a-4ed4-88e9-8a3ae6f52bd4', marketProductStatus: 'published' as const,
    } }))
    const controller = new OrderPublicationController({ catalog: { submitInstalledOrderSkill } } as unknown as OrderPublicationRemote)
    function ConnectedPanel() {
      const publication = useSyncExternalStore(
        listener => controller.store.subscribe(listener), () => controller.store.getSnapshot())
      return <LocalSkillsPanel view={{ status: 'ready', skills: [svg],
        eligibilityStatus: 'ready', orderEligible: [svgEligible] }} t={labels} {...actions}
        publication={publication} submitSkillProduct={submitSkillProduct}
        publishOrderSkill={(source, name, review) => controller.publishSkill(source, name, review)} />
    }
    render(<ConnectedPanel />)
    fireEvent.click(screen.getByRole('button', { name: zh.publishOrder }))
    fireEvent.change(screen.getByRole('textbox', { name: zh.publishReviewPrice }), { target: { value: '2.50' } })
    fireEvent.change(screen.getByRole('textbox', { name: zh.publishSalePrice }), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: zh.publishReviewSubmit }))
    await screen.findByText(zh.sellerProductPublished)
    expect(submitInstalledOrderSkill).toHaveBeenCalledExactlyOnceWith({
      source: svg.source, name: svg.name, displayName: svgEligible.serviceTitle,
      purpose: svgEligible.serviceDescription, configuration: '',
      priceYuan: '2.50', salePriceYuan: '0.00', expectedArtifactDigest: svgEligible.artifactDigest,
    })
    expect(screen.queryByRole('button', { name: zh.sellerProductSubmit })).toBeNull()
    expect(submitSkillProduct).not.toHaveBeenCalled()
    expect(controller.store.getSnapshot().items['skill:user-agents:svg-to-video'])
      .toMatchObject({ phase: 'approved', salePriceYuan: '0.00', marketProductStatus: 'published',
        marketProductId: '104a209d-553a-4ed4-88e9-8a3ae6f52bd4' })
    controller.dispose()
  })

  it('keeps the first publication step to the price while allowing advanced edits', () => {
    const publishOrderSkill = vi.fn(async () => {})
    render(<LocalSkillsPanel view={{ status: 'ready', skills: [svg],
      eligibilityStatus: 'ready', orderEligible: [svgEligible] }} t={labels} {...actions}
      publishOrderSkill={publishOrderSkill} />)
    fireEvent.click(screen.getByRole('button', { name: zh.publishOrder }))
    expect(screen.getByRole('textbox', { name: zh.publishReviewPrice })).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: zh.publishReviewPurpose })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.publishReviewAdvanced }))
    fireEvent.change(screen.getByRole('textbox', { name: zh.publishReviewPurpose }),
      { target: { value: '新用途说明' } })
    fireEvent.change(screen.getByRole('textbox', { name: zh.publishSalePrice }), { target: { value: '20.00' } })
    fireEvent.click(screen.getByRole('button', { name: zh.publishReviewSubmit }))
    expect(publishOrderSkill).toHaveBeenCalledWith('user-agents', 'svg-to-video', {
      displayName: 'SVG 绘图转视频', purpose: '新用途说明', configuration: '', priceYuan: '0.00', salePriceYuan: '20.00',
      expectedArtifactDigest: svgEligible.artifactDigest })
  })

  it('asks for executable service details instead of copying broad conversation promises', () => {
    const publishOrderSkill = vi.fn(async () => {})
    render(<LocalSkillsPanel view={{ status: 'ready', skills: [svg],
      eligibilityStatus: 'ready', orderEligible: [{ source: svg.source, name: svg.name, path: svg.path,
        taskType: svgEligible.taskType, artifactDigest: svgEligible.artifactDigest }] }}
      t={labels} {...actions} publishOrderSkill={publishOrderSkill} />)
    fireEvent.click(screen.getByRole('button', { name: zh.publishOrder }))
    expect(screen.getByRole('textbox', { name: zh.publishReviewName })).toHaveProperty('value', '')
    expect(screen.getByRole('textbox', { name: zh.publishReviewPurpose })).toHaveProperty('value', '')
    fireEvent.change(screen.getByRole('textbox', { name: zh.publishSalePrice }), { target: { value: '20.00' } })
    fireEvent.click(screen.getByRole('button', { name: zh.publishReviewSubmit }))
    expect(publishOrderSkill).not.toHaveBeenCalled()
  })

  it('previews a signed generic skill CNY tariff, then publishes without asking the author to type a price', async () => {
    const skill = { ...text, name: 'custom-scan', displayName: '我的文本扫描',
      description: '扫描指定文字', category: 'text' }
    const digest = `sha256:${'c'.repeat(64)}`
    const definitionDigest = `sha256:${'d'.repeat(64)}`
    const previewOrderPrice = vi.fn(async () => ({ taskType: 'custom_scan_v1',
      artifactDigest: digest, taskDefinitionSha256: definitionDigest,
      priceYuan: '3.25', settingsVersion: 8 }))
    const publishOrderSkill = vi.fn(async () => {})
    render(<LocalSkillsPanel view={{ status: 'ready', skills: [skill], eligibilityStatus: 'ready',
      orderEligible: [{ source: skill.source, name: skill.name, path: skill.path,
        taskType: 'custom_scan_v1', artifactDigest: digest, platformPriced: true,
        serviceTitle: '我的文本扫描', serviceDescription: '扫描指定文字' }] }}
      t={labels} {...actions} previewOrderPrice={previewOrderPrice} publishOrderSkill={publishOrderSkill} />)
    fireEvent.click(screen.getByRole('button', { name: zh.publishOrder }))
    await screen.findByRole('dialog', { name: zh.publishReviewTitle })
    expect(screen.getByText(zh.publishReviewPlatformPrice.replace('{price}', '3.25'))).toBeTruthy()
    expect(screen.getByText(zh.publishReviewPlatformPriceHint.replace('{version}', '8'))).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: zh.publishReviewPrice })).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: zh.publishSalePrice }), { target: { value: '20.00' } })
    fireEvent.click(screen.getByRole('button', { name: zh.publishReviewSubmit }))
    await waitFor(() => expect(publishOrderSkill).toHaveBeenCalledExactlyOnceWith('user-agents', 'custom-scan', {
      displayName: '我的文本扫描', purpose: '扫描指定文字', configuration: '',
      priceYuan: '3.25', salePriceYuan: '20.00', expectedArtifactDigest: digest,
      expectedTaskDefinitionSha256: definitionDigest }))
    expect(previewOrderPrice).toHaveBeenCalledExactlyOnceWith('user-agents', 'custom-scan')
  })

  it('binds submission to the normalized source digest returned by price preview', async () => {
    const skill = { ...text, name: 'custom-scan', displayName: '我的文本扫描' }
    const before = `sha256:${'a'.repeat(64)}`
    const after = `sha256:${'b'.repeat(64)}`
    const definitionDigest = `sha256:${'d'.repeat(64)}`
    const publishOrderSkill = vi.fn(async () => {})
    render(<LocalSkillsPanel view={{ status: 'ready', skills: [skill], eligibilityStatus: 'ready',
      orderEligible: [{ source: skill.source, name: skill.name, path: skill.path,
        taskType: 'custom_scan_v1', artifactDigest: before, platformPriced: true,
        serviceTitle: '我的文本扫描', serviceDescription: '扫描指定文字' }] }}
      t={labels} {...actions} publishOrderSkill={publishOrderSkill}
      previewOrderPrice={vi.fn(async () => ({ taskType: 'custom_scan_v1', artifactDigest: after,
        taskDefinitionSha256: definitionDigest, priceYuan: '0.50', settingsVersion: 4 }))} />)
    fireEvent.click(screen.getByRole('button', { name: zh.publishOrder }))
    await screen.findByRole('dialog', { name: zh.publishReviewTitle })
    fireEvent.change(screen.getByRole('textbox', { name: zh.publishSalePrice }), { target: { value: '20.00' } })
    fireEvent.click(screen.getByRole('button', { name: zh.publishReviewSubmit }))
    await waitFor(() => expect(publishOrderSkill).toHaveBeenCalledWith('user-agents', 'custom-scan',
      expect.objectContaining({ expectedArtifactDigest: after,
        expectedTaskDefinitionSha256: definitionDigest })))
  })

  it('does not submit a generic skill when central server has no reviewed price', async () => {
    const skill = { ...text, name: 'custom-scan', displayName: '我的文本扫描' }
    const publishOrderSkill = vi.fn(async () => {})
    render(<LocalSkillsPanel view={{ status: 'ready', skills: [skill], eligibilityStatus: 'ready',
      orderEligible: [{ source: skill.source, name: skill.name, path: skill.path,
        taskType: 'custom_scan_v1', artifactDigest: `sha256:${'c'.repeat(64)}`, platformPriced: true }] }}
      t={labels} {...actions} previewOrderPrice={vi.fn(async () => { throw new Error('no tariff') })}
      publishOrderSkill={publishOrderSkill} />)
    fireEvent.click(screen.getByRole('button', { name: zh.publishOrder }))
    expect(await screen.findByText(zh.publishPriceUnavailable)).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: zh.publishReviewTitle })).toBeNull()
    expect(publishOrderSkill).not.toHaveBeenCalled()
  })

  it('uses the same publish button to create a real adapter for an instruction-only skill', async () => {
    const publishOrderSkill = vi.fn(async () => {})
    const planOrderAdapter = vi.fn(async () => true)
    render(<LocalSkillsPanel view={{ status: 'ready', skills: [text],
      eligibilityStatus: 'ready', orderEligible: [] }} t={labels} {...actions}
      publishOrderSkill={publishOrderSkill} planOrderAdapter={planOrderAdapter} />)
    fireEvent.click(screen.getByRole('button', { name: zh.publishOrder }))
    await waitFor(() => expect(planOrderAdapter).toHaveBeenCalledExactlyOnceWith('user-agents', 'share'))
    expect(publishOrderSkill).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: zh.publishReviewTitle })).toBeNull()
  })

  it('opens the assistant without showing a publication sheet when eligibility is missing or stale', async () => {
    const publishOrderSkill = vi.fn(async () => {})
    const planOrderAdapter = vi.fn(async () => true)
    const { rerender } = render(<LocalSkillsPanel view={{ status: 'ready', skills: [svg],
      eligibilityStatus: 'unavailable', orderEligible: [] }} t={labels} {...actions}
      publishOrderSkill={publishOrderSkill} planOrderAdapter={planOrderAdapter} />)
    expect(screen.getByText(zh.orderEligibilityUnavailable)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.publishOrder }))
    expect(planOrderAdapter).toHaveBeenCalledWith('user-agents', 'svg-to-video')
    expect(screen.queryByRole('dialog', { name: zh.publishReviewTitle })).toBeNull()
    await waitFor(() => expect(screen.getByRole('button', { name: zh.publishOrder })).not.toHaveProperty('disabled', true))
    rerender(<LocalSkillsPanel view={{ status: 'ready', skills: [svg],
      eligibilityStatus: 'ready', orderEligible: [{ ...svgEligible, path: '/other/SKILL.md' }] }}
      t={labels} {...actions} publishOrderSkill={publishOrderSkill} planOrderAdapter={planOrderAdapter} />)
    fireEvent.click(screen.getByRole('button', { name: zh.publishOrder }))
    expect(planOrderAdapter).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('dialog', { name: zh.publishReviewTitle })).toBeNull()
  })

  it('shows the saved Chinese title and uses only the exact session winner', () => {
    const winner = { name: svg.name, path: svg.path } as SkillEntry
    const { rerender } = render(<LocalSkillsPanel view={{ status: 'ready', skills: [svg, text] }}
      session={{ status: 'ready', sessionId: 'session' as never, skills: [winner] }} t={labels} {...actions} />)
    expect(screen.getByText('SVG 绘图转视频')).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.categoryVideo })).toBeTruthy()
    expect(screen.getByText(zh.nameShare)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.useSkill }))
    expect(actions.useSkill).toHaveBeenCalledWith('svg-to-video')
    rerender(<LocalSkillsPanel view={{ status: 'ready', skills: [svg] }}
      session={{ status: 'ready', sessionId: 'session' as never,
        skills: [{ name: svg.name, path: '/another/SKILL.md' } as SkillEntry] }} t={labels} {...actions} />)
    expect(screen.queryByRole('button', { name: zh.useSkill })).toBeNull()
    expect(screen.getByText(zh.notInSession)).toBeTruthy()
  })

  it('filters by Chinese category and purpose without exposing English as the primary title', () => {
    render(<LocalSkillsPanel view={{ status: 'ready', skills: [svg, text] }} t={labels} {...actions} />)
    fireEvent.click(screen.getByRole('button', { name: zh.categoryVideo }))
    expect(screen.getByRole('heading', { name: 'SVG 绘图转视频' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: zh.nameShare })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.all }))
    fireEvent.change(screen.getByRole('searchbox', { name: zh.searchLabel }), { target: { value: '保存' } })
    expect(screen.getByRole('heading', { name: zh.nameShare })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'SVG 绘图转视频' })).toBeNull()
  })
})
