// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { LocalSkillsPanel, type LocalSkillsPanelProps } from '../src/client/LocalSkillsPanel.tsx'
import type { LocalTrialDefinition } from '../src/client/LocalSkillTrial.tsx'
import { OrderPublicationsPanel } from '../src/client/OrderPublicationsPanel.tsx'
import { zh } from '../src/client/local-skill-locales.ts'
import { zh as marketZh } from '../src/client/marketplace-locales.ts'

afterEach(cleanup)
const labels: Readonly<Record<string, string>> = { ...zh, ...marketZh }
const t = (key: string): string => {
  const value = labels[key]
  if (value === undefined) throw new Error(`Missing test locale: ${key}`)
  return value
}
const digest = `sha256:${'a'.repeat(64)}`
const skill = { source: 'user-agents' as const, name: 'count-demo', path: '/skills/count-demo/SKILL.md',
  displayName: '中文字符统计', description: '统计一段中文文字。', updatedAt: 1,
  userInvocable: true, modelInvocable: true, canArchive: true, sha256: 'a'.repeat(64) }
const key = 'skill:user-agents:count-demo'
const publicationId = '416dfb88-ea17-4a36-98b5-e1c08edd3c55'
const props = (): LocalSkillsPanelProps => ({
  view: { status: 'ready', skills: [skill], eligibilityStatus: 'ready', orderEligible: [{
    source: skill.source, name: skill.name, path: skill.path, artifactDigest: digest,
    taskType: 'count_demo_v1', platformPriced: true, serviceTitle: skill.displayName,
    serviceDescription: skill.description,
  }] }, session: { status: 'ready', sessionId: SessionId('own-session'), skills: [{
    name: skill.name, path: skill.path, description: skill.description, modelInvocable: true,
  }] }, t, ensure: vi.fn(async () => {}), reload: vi.fn(async () => {}),
  useSkill: vi.fn(() => true), archiveLocalSkill: vi.fn(async () => true),
  publishOrderSkill: vi.fn(async () => {}),
  previewOrderPrice: vi.fn(async () => ({ taskType: 'count_demo_v1', artifactDigest: digest,
    settingsVersion: 1, taskDefinitionSha256: 'b'.repeat(64), priceYuan: '0.50' })),
  loadLocalTrial: vi.fn(async (): Promise<LocalTrialDefinition> => ({ schema: 'qianshou.local-skill-trial.v1', taskType: 'count_demo_v1',
    artifactDigest: digest, supportsLocalTrial: true, unavailableReason: null,
    inputSchemaJson: JSON.stringify({ kind: 'inline-json', maxLength: 16384,
      contentSchema: { type: 'object', properties: { text: { type: 'string', title: '要统计的文字' } },
        required: ['text'], additionalProperties: false } }),
  })),
  runLocalTrial: vi.fn(async () => ({ taskType: 'count_demo_v1', artifactDigest: digest,
    outputJson: '{"count":2}', elapsedMs: 1 })),
})

function disclosure(summary: string): HTMLDetailsElement {
  const node = screen.getByText(summary, { selector: 'summary' }).closest('details')
  if (!(node instanceof HTMLDetailsElement)) throw new Error('Missing actual details disclosure')
  return node
}

it('keeps use and local trial direct while management and machine receipts are initially folded', async () => {
  const p = props(); render(<LocalSkillsPanel {...p} />)
  const manage = disclosure(zh.skillCardManage)
  const details = disclosure(zh.skillCardDetails)
  expect(manage.open).toBe(false); expect(details.open).toBe(false)
  expect(screen.getByRole('button', { name: zh.useSkill }).closest('details')).toBeNull()
  expect(screen.getByRole('button', { name: zh.trialStart }).closest('details')).toBeNull()
  expect(screen.getByText('/count-demo').closest('details')).toBe(details)
  expect(screen.getByRole('button', { name: zh.localRemove }).closest('details')).toBe(manage)
  expect(screen.getByRole('button', { name: zh.publishOrder }).closest('details')).toBe(manage)
  fireEvent.click(screen.getByRole('button', { name: zh.useSkill }))
  expect(p.useSkill).toHaveBeenCalledExactlyOnceWith('count-demo')
  fireEvent.click(screen.getByRole('button', { name: zh.trialStart }))
  await waitFor(() => { expect(screen.getByRole('textbox', { name: '要统计的文字' })).toBeTruthy() })
  fireEvent.change(screen.getByRole('textbox', { name: '要统计的文字' }), { target: { value: '千手' } })
  fireEvent.click(screen.getByRole('button', { name: zh.trialRun }))
  await waitFor(() => { expect(p.runLocalTrial).toHaveBeenCalledExactlyOnceWith('user-agents', 'count-demo',
    '{"text":"千手"}', digest) })
  expect(p.publishOrderSkill).not.toHaveBeenCalled(); expect(p.archiveLocalSkill).not.toHaveBeenCalled()
})

it('opens the real management disclosure without bypassing removal or publication confirmation', async () => {
  const p = props(); render(<LocalSkillsPanel {...p} />)
  const manage = disclosure(zh.skillCardManage)
  fireEvent.click(within(manage).getByText(zh.skillCardManage, { selector: 'summary' }))
  expect(manage.open).toBe(true)
  fireEvent.click(within(manage).getByRole('button', { name: zh.localRemove }))
  expect(screen.getByRole('group', { name: zh.localRemoveTitle })).toBeTruthy()
  expect(p.archiveLocalSkill).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh.localRemoveCancel }))
  fireEvent.click(within(manage).getByRole('button', { name: zh.publishOrder }))
  await waitFor(() => { expect(screen.getByRole('dialog', { name: zh.publishReviewTitle })).toBeTruthy() })
  expect(p.previewOrderPrice).toHaveBeenCalledExactlyOnceWith('user-agents', 'count-demo')
  expect(p.publishOrderSkill).not.toHaveBeenCalled()
})

it('shows listing separately from grant and keeps stale or invalid evidence visible without expanding', () => {
  const p = props()
  p.publication = { busyKey: null, sellerProducts: {}, sellerProductsUnavailable: false, sellerProductErrors: {},
    items: { [key]: { phase: 'approved', publicationId, marketProductId: 'actual-product',
      marketProductStatus: 'published', reviewReasons: [] } } }
  const view = render(<LocalSkillsPanel {...p} />)
  expect(screen.getByText(zh.sellerProductPublished).closest('details')).toBeNull()
  expect(screen.queryByText(zh.authorIntakeSaved)).toBeNull()
  expect(screen.getByText(publicationId).closest('details')?.open).toBe(false)
  view.rerender(<LocalSkillsPanel {...p} publication={{ ...p.publication, items: { [key]: {
    ...p.publication.items[key]!, reviewSyncStale: true, mediaEvidenceStatus: 'invalid',
  } } }} />)
  expect(screen.getByText(zh.publishStatusStale).closest('details')).toBeNull()
  expect(screen.getByText(zh.publishReviewSyncStale).closest('details')).toBeNull()
  expect(screen.getByText(zh.publishSampleInvalid).closest('details')).toBeNull()
  expect(screen.queryByText(zh.sellerProductPublished)).toBeNull()
})

it('states each actual price once and folds publication ids while retaining visible lifecycle blockers', () => {
  const p = props(); p.publication = { busyKey: null, sellerProductsUnavailable: false, sellerProductErrors: {},
    reviewSyncedAt: 1700000000000, sellerProducts: { [publicationId]: { id: 'actual-product', publicationId,
      status: 'published', salePriceYuan: '8.00', canApprove: false, reviewReasons: [] } }, items: { [key]: {
      phase: 'approved', publicationId, displayName: skill.displayName, priceYuan: '0.50', salePriceYuan: '8.00',
      archiveStatus: 'confirmed', lifecycle: { state: 'active', archived: false, revision: 1,
        allowedActions: [], blockingReasons: ['active-orders'] },
    } } }
  render(<OrderPublicationsPanel localSkills={p} t={t} manage={vi.fn()} />)
  expect(screen.getAllByText(zh.sellerProductPrice.replace('{price}', '8.00'))).toHaveLength(1)
  expect(screen.getAllByText(marketZh.publicationExecutionPrice.replace('{price}', '0.50'))).toHaveLength(1)
  expect(screen.getAllByText(zh.sellerProductPublished)).toHaveLength(1)
  expect(screen.getByText(publicationId).closest('details')?.open).toBe(false)
  expect(screen.getByText(zh.publicationLifecycleActiveOrders).closest('details')).toBeNull()
  expect(screen.getByText(zh.publishStatusApproved).closest('details')).toBe(disclosure(zh.skillCardDetails))
})

it('keeps review rejection details expanded and the exact lifecycle confirmation behind management', () => {
  const p = props(); p.managePublicationLifecycle = vi.fn(async () => true)
  p.publication = { busyKey: null, sellerProducts: {}, sellerProductsUnavailable: false, sellerProductErrors: {},
    items: { [key]: { phase: 'rejected', publicationId, displayName: skill.displayName,
      reviewReasons: ['sample: 自检样例不相符'], lifecycle: { state: 'active', archived: false,
        revision: 3, allowedActions: ['archive'], blockingReasons: [] } } } }
  render(<OrderPublicationsPanel localSkills={p} t={t} manage={vi.fn()} />)
  expect(disclosure(zh.skillCardDetails).open).toBe(true)
  expect(screen.getByText('sample: 自检样例不相符')).toBeTruthy()
  expect(screen.getByText('sample: 自检样例不相符').closest('details')?.open).toBe(true)
  const manage = disclosure(zh.skillCardManage)
  expect(manage.open).toBe(false)
  fireEvent.click(within(manage).getByText(zh.skillCardManage, { selector: 'summary' }))
  fireEvent.click(within(manage).getByRole('button', { name: zh.publicationLifecycleArchive }))
  expect(screen.getByRole('dialog', { name: `确认归档记录「${skill.displayName}」` })).toBeTruthy()
  expect(p.managePublicationLifecycle).not.toHaveBeenCalled()
})

it.each([
  ['review', zh.sellerProductPending], ['suspended', zh.publicationLifecycleDelisted], ['rejected', zh.sellerProductRejected],
] as const)('uses the current %s seller receipt instead of an earlier published marker', (status, label) => {
  const p = props(); p.enableOrderSkill = vi.fn(async () => {})
  p.publication = { busyKey: null, sellerProductsUnavailable: false, sellerProductErrors: {},
    sellerProducts: { [publicationId]: { id: 'actual-product', publicationId, status,
      salePriceYuan: '8.00', canApprove: false, reviewReasons: [] } }, items: { [key]: {
      phase: 'approved', publicationId, marketProductStatus: 'published', marketProductId: 'actual-product',
      archiveStatus: 'confirmed',
    } } }
  const view = render(<LocalSkillsPanel {...p} />)
  expect(screen.queryByRole('button', { name: zh.authorEnable })).toBeNull()
  expect(screen.getByText(label).closest('details')).toBeNull()
  expect(screen.queryByText(zh.sellerProductPublished)).toBeNull()
  view.rerender(<OrderPublicationsPanel localSkills={p} t={t} manage={vi.fn()} />)
  expect(screen.queryByRole('button', { name: zh.authorEnable })).toBeNull()
  expect(screen.getByText(label).closest('details')).toBeNull()
  expect(screen.queryByText(zh.sellerProductPublished)).toBeNull()
})
