// @vitest-environment jsdom
/** Ordinary publication preserves explicit price approval and read-only uncertain recovery. */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { OrdinarySkillsController } from '../src/client/ordinary-skill-controller.ts'
import { OrdinarySkillCatalog, OrdinarySkillPublication } from '../src/client/OrdinarySkillPublication.tsx'
import { zh } from '../src/client/ordinary-skill-locales.ts'
import type { OrdinarySkillsRemote } from '../src/client/ordinary-skill-transport.ts'

afterEach(cleanup)
const ok = (value: unknown) => ({ ok: true as const, value })
const choice = { source: 'user-dsh', name: 'sample', displayName: '样例', description: '说明' }
const hash = 'a'.repeat(64)
function fixture() {
  let owner: number | null = 167
  const remote: OrdinarySkillsRemote = {
    ordinarySkillChoices: vi.fn(async () => ok({ skills: [choice] })),
    ordinarySkillCatalog: vi.fn(async () => ok({ listings: [] })),
    ordinarySkillMine: vi.fn(async () => ok({ accountId: String(owner), submissions: [] })),
    submitOrdinarySkill: vi.fn(async (input: Parameters<OrdinarySkillsRemote['submitOrdinarySkill']>[0]) => ok({
      intent: { ...input, accountId: String(owner), packageSha256: hash },
      submission: null, state: 'unknown' })),
  }
  const controller = new OrdinarySkillsController(remote, async () => owner)
  return { controller, remote, setOwner: (value: number | null) => { owner = value } }
}
const edit = { source: 'user-dsh' as const, name: 'sample', title: '样例', summary: '说明', priceYuan: '2.50' }

it('starts with no price and rejects invalid author terms before any submit', async () => {
  const { controller, remote } = fixture(); await controller.reload()
  expect(controller.store.getSnapshot().draft.priceYuan).toBe('')
  controller.edit({ ...edit, priceYuan: '' }); await controller.submit()
  controller.edit({ ...edit, title: ' 样例' }); await controller.submit()
  expect(remote.submitOrdinarySkill).not.toHaveBeenCalled()
  render(<OrdinarySkillPublication view={controller.store.getSnapshot()} edit={(change) =>{  controller.edit(change) }}
    reload={async () => {}} submit={() => controller.submit()} refresh={() => controller.refresh()} t={key => zh[key]} />)
  expect(screen.getByRole('button', { name: zh.submit }).hasAttribute('disabled')).toBe(true)
  controller.dispose()
})

it('shares one explicit UUID and locks unknown outcomes to original read operations', async () => {
  const { controller, remote } = fixture(); await controller.reload(); controller.edit(edit)
  await Promise.all([controller.submit(), controller.submit()])
  expect(remote.submitOrdinarySkill).toHaveBeenCalledOnce()
  const original = controller.store.getSnapshot().submissions[0]!
  expect(original.intent).toMatchObject(edit)
  expect(original.intent.requestId).toMatch(/^[a-f0-9-]{36}$/u)
  controller.edit({ priceYuan: '3' }); await controller.submit(); await controller.refresh()
  expect(controller.store.getSnapshot().draft.priceYuan).toBe('2.50')
  expect(controller.store.getSnapshot().submitState).toBe('unknown')
  expect(remote.submitOrdinarySkill).toHaveBeenCalledOnce()
  expect(remote.ordinarySkillMine).toHaveBeenCalledTimes(2)
  controller.dispose()
})

it('drops an old-owner reply rather than showing or authorizing it for the next account', async () => {
  const { controller, remote, setOwner } = fixture(); await controller.reload(); controller.edit(edit)
  let finish!: (value: Awaited<ReturnType<OrdinarySkillsRemote['submitOrdinarySkill']>>) => void
  vi.mocked(remote.submitOrdinarySkill).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  const pending = controller.submit(); await vi.waitFor(() =>{  expect(remote.submitOrdinarySkill).toHaveBeenCalledOnce() })
  const input = vi.mocked(remote.submitOrdinarySkill).mock.calls[0]![0]
  setOwner(168); await controller.reload()
  finish(ok({ intent: { ...input, accountId: '167', packageSha256: hash }, submission: null, state: 'unknown' }))
  await pending
  expect(controller.store.getSnapshot()).toMatchObject({ accountId: '168', submissions: [], submitState: 'idle', draft: { priceYuan: '' } })
  controller.dispose()
})

it('shows genuine reviewed ordinary price and author kind while purchase and installation remain unavailable', async () => {
  const { controller, remote } = fixture()
  const id = '12345678-1234-4234-8234-123456789abc'
  vi.mocked(remote.ordinarySkillCatalog).mockResolvedValue(ok({ listings: [{ requestId: id, submissionId: id,
    accountId: '167', title: '官方技能', summary: '人工测试通过', priceYuan: '12.30', currency: 'CNY', version: '1.0.0',
    packageSha256: hash, publisherKind: 'official', purchaseAvailable: false, installable: false,
    review: { status: 'published', reviewId: id, operatorId: 'employee', reviewedAt: 1800000000000,
      note: '测试回执', testReceiptSha256: hash } }] }))
  await controller.reload()
  render(<OrdinarySkillCatalog view={controller.store.getSnapshot()} reload={async () => {}} t={key => zh[key]} />)
  expect(screen.getByText('¥12.30 · CNY')).toBeDefined()
  expect(screen.getByText(zh.official)).toBeDefined(); expect(screen.getByText(zh.unavailable)).toBeDefined()
  expect(screen.getAllByRole('button')).toHaveLength(1)
  controller.dispose()
})
