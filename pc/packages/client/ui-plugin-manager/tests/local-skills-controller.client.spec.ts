import { describe, expect, it, vi } from 'vitest'
import type { LocalSkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import { LocalSkillsController } from '../src/client/local-skills-controller.ts'
import type { LocalSkillArchiveReceipt } from '@deepseek-ai/dsh-api-remotes/client'

describe('local skill catalog reads', () => {
  it('single-flights author enabling and refuses an unconfirmed response', async () => {
    const response = Promise.withResolvers<{ ok: true; value: unknown }>()
    const activateAuthorOrderSkill = vi.fn(() => response.promise)
    const controller = new LocalSkillsController({ listLocal: async () => ({ ok: true, value: { skills: [] } }) }, {
      localOrderSkillEligibility: async () => ({ ok: true, value: { items: [] } }), activateAuthorOrderSkill,
    })
    await controller.reload()
    await vi.waitFor(() => expect(controller.store.getSnapshot().eligibilityStatus).toBe('ready'))
    const first = controller.enable('user-agents', 'char-counter')
    const second = controller.enable('user-agents', 'char-counter')
    expect(controller.store.getSnapshot().activations?.['user-agents:char-counter']?.phase).toBe('enabling')
    await vi.waitFor(() => expect(activateAuthorOrderSkill).toHaveBeenCalledExactlyOnceWith({ source: 'user-agents', name: 'char-counter' }))
    response.resolve({ ok: true, value: { source: 'user-agents', name: 'another-skill', deviceInstalled: true } })
    await Promise.all([first, second])
    expect(controller.store.getSnapshot().activations?.['user-agents:char-counter']).toEqual({
      phase: 'failed', reason: 'order-author-activation-unknown' })
    controller.dispose()
  })

  it('recovers author readiness from exact device-backed source and owner mode, then withdraws it when off', async () => {
    let mode = 'idle'
    const controller = new LocalSkillsController({ listLocal: async () => ({ ok: true, value: { skills: [] } }) }, {
      localOrderSkillEligibility: async () => ({ ok: true, value: { items: [] } }),
      orderSources: async () => ({ ok: true, value: { sources: [{ id: 'skill:user-agents:char-counter', kind: 'skill',
        source: 'user-agents', authorProductId: 'b9418e38-b3a5-5722-8005-cc7afbe2a21a',
        serviceId: 'node', eligible: true, enabled: true, reason: 'ready' }] } }),
      myCapabilities: async () => ({ ok: true, value: { order: { mode } } }),
    })
    await controller.reload()
    await vi.waitFor(() => expect(controller.store.getSnapshot().activations?.['user-agents:char-counter']).toEqual({ phase: 'ready' }))
    mode = 'off'
    await controller.reload()
    expect(controller.store.getSnapshot().activations?.['user-agents:char-counter']).toBeUndefined()
    controller.dispose()
  })

  it('keeps the newest Host answer when a file-change refresh overtakes an older read', async () => {
    const first = Promise.withResolvers<{ ok: true; value: { skills: LocalSkillEntry[] } }>()
    const second = Promise.withResolvers<{ ok: true; value: { skills: LocalSkillEntry[] } }>()
    const oldSkill = { name: 'old' } as LocalSkillEntry
    const newSkill = { name: 'new' } as LocalSkillEntry
    let calls = 0
    const controller = new LocalSkillsController({ listLocal: () => ++calls === 1 ? first.promise : second.promise })
    const old = controller.reload()
    const fresh = controller.reload()
    second.resolve({ ok: true, value: { skills: [newSkill] } }); await fresh
    first.resolve({ ok: true, value: { skills: [oldSkill] } }); await old
    expect(controller.store.getSnapshot()).toEqual({ status: 'ready', skills: [newSkill] })
    expect(calls).toBe(2)
    controller.dispose()
  })

  it('reports a Host failure and allows a later refresh', async () => {
    let calls = 0
    const controller = new LocalSkillsController({ listLocal: async () => ++calls === 1
      ? { ok: false as const, error: 'unavailable' }
      : { ok: true as const, value: { skills: [] } } })
    await controller.ensure()
    expect(controller.store.getSnapshot().status).toBe('error')
    await controller.reload()
    expect(controller.store.getSnapshot().status).toBe('ready')
    controller.dispose()
  })

  it('pairs local skills with a read-only Host eligibility answer and fails closed when it is unavailable', async () => {
    const skill = { name: 'chart-maker', source: 'user-agents', path: '/skills/chart-maker/SKILL.md' } as LocalSkillEntry
    const adapter = { source: skill.source, name: skill.name, path: skill.path,
      taskType: 'bar_chart_svg_v1', artifactDigest: `sha256:${'a'.repeat(64)}` }
    let reads = 0
    const controller = new LocalSkillsController(
      { listLocal: async () => ({ ok: true, value: { skills: [skill] } }) },
      { localOrderSkillEligibility: async () => ++reads === 1
        ? { ok: true, value: { items: [adapter] } }
        : { ok: false, error: 'service unavailable' } })
    await controller.reload()
    await vi.waitFor(() => expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready', eligibilityStatus: 'ready', orderEligible: [adapter] }))
    await controller.reload()
    await vi.waitFor(() => expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready', eligibilityStatus: 'unavailable', orderEligible: [] }))
    controller.dispose()
  })
})

it('shows local files and eligibility while remote order recovery is still pending', async () => {
  const sources = Promise.withResolvers<{ ok: true; value: unknown }>()
  const eligibility = Promise.withResolvers<{ ok: true; value: { items: [] } }>()
  const skill = { name: 'saved', source: 'user-dsh' } as LocalSkillEntry
  const controller = new LocalSkillsController({ listLocal: async () => ({ ok: true, value: { skills: [skill] } }) }, {
    localOrderSkillEligibility: () => eligibility.promise,
    orderSources: () => sources.promise,
    myCapabilities: async () => ({ ok: true, value: { order: { mode: 'idle' } } }),
  })
  await controller.reload()
  expect(controller.store.getSnapshot()).toMatchObject({ status: 'ready', skills: [skill], eligibilityStatus: 'loading' })
  eligibility.resolve({ ok: true, value: { items: [] } })
  await vi.waitFor(() => expect(controller.store.getSnapshot().eligibilityStatus).toBe('ready'))
  expect(controller.store.getSnapshot().activations).toEqual({})
  controller.dispose()
  sources.resolve({ ok: true, value: { sources: [] } })
})

it('discards background eligibility after owner changes without declaring a saved file approved', async () => {
  let owner = 1
  const eligibility = Promise.withResolvers<{ ok: true; value: { items: [] } }>()
  const controller = new LocalSkillsController({ listLocal: async () => ({ ok: true, value: { skills: [] } }) }, {
    localOrderSkillEligibility: () => eligibility.promise,
  }, async () => owner)
  await controller.reload()
  owner = 2
  eligibility.resolve({ ok: true, value: { items: [] } })
  await vi.waitFor(() => expect(controller.store.getSnapshot()).toMatchObject({ status: 'error', skills: [], eligibilityStatus: 'unavailable' }))
  controller.dispose()
})

const removable: LocalSkillEntry = { name: 'local-example', displayName: '本机示例', description: 'Local example',
  source: 'user-dsh', path: '/home/skills/local-example/SKILL.md', sha256: 'a'.repeat(64), canArchive: true,
  updatedAt: 1, modelInvocable: true, userInvocable: true }
const archiveRequest = { source: removable.source, name: removable.name, path: removable.path, sha256: removable.sha256! }
const archiveReceipt: LocalSkillArchiveReceipt = { state: 'archived', source: removable.source, name: removable.name,
  originalPath: '/home/skills/local-example', archivePath: '/home/.qianshou-skill-archives/id/local-example',
  receiptPath: '/home/.qianshou-skill-archives/id/restore.json', sha256: removable.sha256! }

it('single-flights an exact local removal and refreshes only after its archive receipt', async () => {
  const response = Promise.withResolvers<{ ok: true; value: LocalSkillArchiveReceipt }>()
  let files = [removable]
  const archiveLocal = vi.fn(() => response.promise)
  const controller = new LocalSkillsController({ listLocal: async () => ({ ok: true, value: { skills: files } }), archiveLocal })
  await controller.reload()
  const first = controller.archive(archiveRequest)
  const second = controller.archive(archiveRequest)
  await vi.waitFor(() => expect(archiveLocal).toHaveBeenCalledExactlyOnceWith(archiveRequest))
  expect(controller.store.getSnapshot().skills).toEqual([removable])
  expect(controller.store.getSnapshot().removals?.[removable.path]?.phase).toBe('archiving')
  files = []; response.resolve({ ok: true, value: archiveReceipt })
  expect(await first).toBe(true); expect(await second).toBe(true)
  expect(controller.store.getSnapshot()).toMatchObject({ status: 'ready', skills: [],
    removals: { [removable.path]: { phase: 'archived', receipt: archiveReceipt } } })
  controller.dispose()
})

it('retains a skill after a changed/managed Host refusal or a mismatched archive receipt', async () => {
  let wrongReceipt = false
  const controller = new LocalSkillsController({ listLocal: async () => ({ ok: true, value: { skills: [removable] } }),
    archiveLocal: async () => wrongReceipt ? { ok: true, value: { ...archiveReceipt, name: 'another-skill' } }
      : { ok: false, error: { code: 'skill-import/changed' } } })
  await controller.reload()
  expect(await controller.archive(archiveRequest)).toBe(false)
  expect(controller.store.getSnapshot().removals?.[removable.path]).toEqual({ phase: 'failed', reason: 'skill-import/changed' })
  wrongReceipt = true
  expect(await controller.archive(archiveRequest)).toBe(false)
  expect(controller.store.getSnapshot().skills).toEqual([removable])
  expect(controller.store.getSnapshot().removals?.[removable.path]?.reason).toBe('local-archive-unconfirmed')
  controller.dispose()
})

it('refuses a non-owned inventory selection and discards archive UI after an account change', async () => {
  let owner = 1
  const response = Promise.withResolvers<{ ok: true; value: LocalSkillArchiveReceipt }>()
  const archiveLocal = vi.fn(() => response.promise)
  const controller = new LocalSkillsController({ listLocal: async () => ({ ok: true, value: { skills: [removable] } }), archiveLocal },
    undefined, async () => owner)
  await controller.reload()
  expect(await controller.archive({ ...archiveRequest, path: '/runtime/SKILL.md' })).toBe(false)
  expect(archiveLocal).not.toHaveBeenCalled()
  const pending = controller.archive(archiveRequest)
  await vi.waitFor(() => expect(archiveLocal).toHaveBeenCalledTimes(1))
  owner = 2; response.resolve({ ok: true, value: archiveReceipt })
  expect(await pending).toBe(false)
  expect(controller.store.getSnapshot()).toMatchObject({ status: 'error', skills: [] })
  expect(controller.store.getSnapshot().removals).toBeUndefined()
  controller.dispose()
})
