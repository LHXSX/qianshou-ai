// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalSkillEntry, NativeAuthorOrderSkillActivation } from '@deepseek-ai/dsh-api-remotes/client'
import { LocalSkillsController, type LocalOrderSkillEligibility } from '../src/client/local-skills-controller.ts'
import { LocalSkillsPanel, type LocalSkillsPanelProps } from '../src/client/LocalSkillsPanel.tsx'
import { OrderPublicationsPanel } from '../src/client/OrderPublicationsPanel.tsx'
import { OrderPublicationController, type OrderPublicationItem, type OrderPublicationRemote } from '../src/client/order-publication-controller.ts'
import { confirmedAuthorActivation } from '../src/client/author-activation-receipt.ts'
import { zh } from '../src/client/local-skill-locales.ts'
import { zh as marketZh } from '../src/client/marketplace-locales.ts'

afterEach(cleanup)
const labels: Readonly<Record<string, string>> = { ...zh, ...marketZh }
const translate = (key: string): string => {
  const value = labels[key]
  if (value === undefined) throw new Error(`Missing test locale: ${key}`)
  return value
}
const publicationId = '4176e294-62e3-4e65-b1a2-93e16b1c35a7'
const deviceId = 'f161e584-5b61-44a1-bf41-3d62f728bf27'
const productId = '6708cc04-8d83-4e6b-aa5b-376d0b7876bd'
const skill: LocalSkillEntry = { source: 'user-agents', name: 'ordinary-readable-name',
  displayName: '我的视频能力', description: '真实设备上的视频服务', path: '/qa/skills/ordinary-readable-name/SKILL.md',
  updatedAt: 1, modelInvocable: true, userInvocable: true }
const eligible: LocalOrderSkillEligibility = { source: skill.source, name: skill.name, path: skill.path,
  taskType: 'owned_video_v1', artifactDigest: `sha256:${'a'.repeat(64)}`, runtimeKind: 'native-h3' }
const key = `skill:${skill.source}:${skill.name}`
const native: NativeAuthorOrderSkillActivation = { runtimeKind: 'native-h3', source: 'user-agents', name: skill.name,
  publicationId, deviceId, runtimeDigest: `sha256:${'b'.repeat(64)}`, deviceVerified: true, dispatchEligible: true,
  order: { mode: 'idle', maxConcurrency: 1, enabledServiceIds: ['node'] } }
const approved: OrderPublicationItem = { runtimeKind: 'native-h3', phase: 'approved', publicationId,
  archiveStatus: 'confirmed', reviewReasons: [] }

function controller(receipt: unknown, declaration = eligible) {
  const activate = vi.fn(async () => ({ ok: true as const, value: receipt }))
  const instance = new LocalSkillsController({ listLocal: async () => ({ ok: true, value: { skills: [skill] } }) }, {
    localOrderSkillEligibility: async () => ({ ok: true, value: { items: [declaration] } }),
    activateAuthorOrderSkill: activate,
  })
  return { instance, activate }
}

it('accepts the actual native-device receipt without inventing an installed product', async () => {
  const h = controller(native)
  try {
    await h.instance.reload()
    await vi.waitFor(() => { expect(h.instance.store.getSnapshot().eligibilityStatus).toBe('ready') })
    await h.instance.enable('user-agents', skill.name)
    expect(h.activate).toHaveBeenCalledExactlyOnceWith({ source: 'user-agents', name: skill.name })
    expect(h.instance.store.getSnapshot().activations?.[`user-agents:${skill.name}`]).toEqual({ phase: 'ready', runtimeKind: 'native-h3' })
    expect(native).not.toHaveProperty('productId')
    expect(native).not.toHaveProperty('deviceInstalled')
  } finally { h.instance.dispose() }
})

it('refuses native success when the current local declaration is no longer native', async () => {
  const { runtimeKind: _kind, ...generic } = eligible
  const h = controller(native, generic)
  try {
    await h.instance.reload()
    await vi.waitFor(() => { expect(h.instance.store.getSnapshot().eligibilityStatus).toBe('ready') })
    await h.instance.enable('user-agents', skill.name)
    expect(h.instance.store.getSnapshot().activations?.[`user-agents:${skill.name}`]).toEqual({
      phase: 'failed', reason: 'order-author-source-changed' })
  } finally { h.instance.dispose() }
})

it.each([
  ['another source', { source: 'user-dsh' }], ['another skill', { name: 'native-h3-name-is-not-authority' }],
  ['unverified device', { deviceVerified: false }], ['unknown kind', { runtimeKind: 'native-other' }],
  ['mixed installed product', { productId }], ['mixed installed flag', { deviceInstalled: true }],
  ['wrong device id', { deviceId: 'another-device' }], ['wrong digest', { runtimeDigest: 'b'.repeat(64) }],
  ['ungranted node', { order: { mode: 'idle', enabledServiceIds: [] } }],
  ['owner disabled', { order: { mode: 'off', enabledServiceIds: ['node'] } }],
] satisfies Array<[string, Record<string, unknown>]>)('rejects %s from the native confirmation', (_name, change) => {
  expect(confirmedAuthorActivation({ ...native, ...change }, 'user-agents', skill.name)).toBe(false)
})

it('preserves the ordinary product installation gate', () => {
  const { runtimeKind: _kind, deviceVerified: _verified, ...base } = native
  expect(confirmedAuthorActivation({ ...base, productId, deviceInstalled: true }, 'user-agents', skill.name)).toBe(true)
  expect(confirmedAuthorActivation({ ...base, deviceInstalled: true }, 'user-agents', skill.name)).toBe(false)
  expect(confirmedAuthorActivation({ ...base, productId, deviceInstalled: false }, 'user-agents', skill.name)).toBe(false)
})

it.each([
  ['current device proof and grant', true, true, 'idle', 'ready'],
  ['an approval without device proof', false, true, 'idle', undefined],
  ['a disabled local grant', true, false, 'idle', undefined],
  ['owner sharing off', true, true, 'off', undefined],
] as const)('restores readiness only from %s', async (_label, verified, enabled, mode, phase) => {
  const instance = new LocalSkillsController({ listLocal: async () => ({ ok: true, value: { skills: [skill] } }) }, {
    localOrderSkillEligibility: async () => ({ ok: true, value: { items: [eligible] } }),
    orderSources: async () => ({ ok: true, value: { sources: [{ id: key, kind: 'skill', source: skill.source,
      runtimeKind: 'native-h3', capabilityId: 'video.render', serviceId: verified ? 'node' : null,
      eligible: verified, enabled, reason: verified ? 'ready' : 'publication-approved',
      authorPublication: { publicationId, status: 'approved', archiveConfirmed: true } }] } }),
    myCapabilities: async () => ({ ok: true, value: { order: { mode } } }),
  })
  try {
    await instance.reload()
    await vi.waitFor(() => { expect(instance.store.getSnapshot().eligibilityStatus).toBe('ready') })
    await vi.waitFor(() => { expect(instance.store.getSnapshot().activations).toBeDefined() })
    expect(instance.store.getSnapshot().activations?.[`user-agents:${skill.name}`]?.phase).toBe(phase)
    if (phase === 'ready') expect(instance.store.getSnapshot().activations?.[`user-agents:${skill.name}`]?.runtimeKind).toBe('native-h3')
  } finally { instance.dispose() }
})

function props(row: OrderPublicationItem, declaration = eligible): LocalSkillsPanelProps {
  return { view: { status: 'ready', skills: [skill], eligibilityStatus: 'ready', orderEligible: [declaration] },
    t: translate, ensure: async () => {}, reload: async () => {}, useSkill: () => true,
    enableOrderSkill: vi.fn(async () => {}), publication: { busyKey: null, items: { [key]: row },
      sellerProducts: {}, sellerProductsUnavailable: false, sellerProductErrors: {} } }
}
function show(surface: 'local' | 'publications', input: LocalSkillsPanelProps) {
  return surface === 'local' ? render(<LocalSkillsPanel {...input} />)
    : render(<OrderPublicationsPanel localSkills={input} t={translate} manage={() => {}} />)
}

describe.each(['local', 'publications'] as const)('%s native author entry', (surface) => {
  it('enables an approved local native skill without a sale product and preserves the real handler', () => {
    const input = props(approved)
    show(surface, input)
    fireEvent.click(screen.getByRole('button', { name: zh.authorEnable }))
    expect(input.enableOrderSkill).toHaveBeenCalledExactlyOnceWith('user-agents', skill.name)
    expect(screen.queryByText(zh.authorNativeEnabled)).toBeNull()
  })
  it.each([
    ['missing archive', { archiveStatus: 'pending' }], ['stale authority', { reviewSyncStale: true }],
    ['not approved', { phase: 'submitted' }], ['review blockers', { reviewReasons: ['not verified'] }],
    ['archived', { lifecycle: { state: 'active', archived: true, revision: 1, allowedActions: [], blockingReasons: [] } }],
  ] satisfies Array<[string, Partial<OrderPublicationItem>]>)('hides the action for %s', (_title, change) => {
    show(surface, props({ ...approved, ...change }))
    expect(screen.queryByRole('button', { name: zh.authorEnable })).toBeNull()
  })
  it('does not guess native authority from the skill name or a mismatched local path', () => {
    const input = props(approved, { ...eligible, path: '/qa/another/SKILL.md' })
    show(surface, input)
    expect(screen.queryByRole('button', { name: zh.authorEnable })).toBeNull()
  })
  it('keeps ordinary unlisted approvals ineligible', () => {
    const { runtimeKind: _kind, ...generic } = approved
    show(surface, props(generic))
    expect(screen.queryByRole('button', { name: zh.authorEnable })).toBeNull()
  })
  it('retains the ordinary published-product enable entry', () => {
    const { runtimeKind: _kind, ...generic } = approved
    const input = props({ ...generic, marketProductId: productId, marketProductStatus: 'published' })
    show(surface, input)
    fireEvent.click(screen.getByRole('button', { name: zh.authorEnable }))
    expect(input.enableOrderSkill).toHaveBeenCalledExactlyOnceWith('user-agents', skill.name)
  })
})

it('projects only the explicit Host native discriminator and clears it when fresh metadata omits it', async () => {
  let nativeKind = true
  const unavailable = async () => ({ ok: false as const, error: { message: 'unavailable' } })
  const remote: OrderPublicationRemote = { account: { state: async () => ({ ok: true, value: { account: { id: '167' } } }) },
    catalog: { myOrderSkillPublications: async () => ({ ok: true, value: { items: [{ source: 'user-agents', name: skill.name,
      publicationId, status: 'approved', taskType: eligible.taskType, artifactDigest: eligible.artifactDigest,
      archiveStatus: 'confirmed', reviewReasons: [], ...(nativeKind ? { runtimeKind: 'native-h3' as const } : {}) }] } }),
    mySellerOrderProducts: async () => ({ ok: true, value: { items: [] } }), previewInstalledOrderSkillPrice: unavailable,
    localCandidates: unavailable, checkLocalCandidateInstall: unavailable, localOrderPublicationDraft: unavailable,
    saveLocalOrderPublicationDraft: unavailable, submitInstalledOrderSkill: unavailable, retryInstalledOrderSkillArchive: unavailable,
    startOrderReviewSamples: unavailable, orderSources: unavailable, selectOrderSource: unavailable },
    manager: { inspect: unavailable, installBundle: unavailable, setBundleEnabled: unavailable, checkBundle: unavailable } }
  const instance = new OrderPublicationController(remote)
  try {
    await instance.refreshSkillPublications()
    expect(instance.store.getSnapshot().items[key]?.runtimeKind).toBe('native-h3')
    nativeKind = false
    await instance.refreshSkillPublications()
    expect(instance.store.getSnapshot().items[key]).not.toHaveProperty('runtimeKind')
  } finally { instance.dispose() }
})
