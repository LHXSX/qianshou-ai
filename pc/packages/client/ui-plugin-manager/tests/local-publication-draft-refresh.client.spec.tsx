// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { LocalSkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import { LocalSkillsController, type LocalOrderSkillEligibility } from '../src/client/local-skills-controller.ts'
import { LocalSkillsPanel } from '../src/client/LocalSkillsPanel.tsx'
import { zh } from '../src/client/local-skill-locales.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })
const labels: Readonly<Record<string, string>> = { ...zh }
const t = (key: string): string => {
  const value = labels[key]
  if (value === undefined) throw new Error(`Missing test locale: ${key}`)
  return value
}
const skill: LocalSkillEntry = { source: 'user-dsh', name: 'draft-test', path: '/skills/draft-test/SKILL.md',
  displayName: '草稿测试', description: '保持填写中的发布草稿', updatedAt: 1, sha256: 'a'.repeat(64),
  modelInvocable: true, userInvocable: true }
const eligible: LocalOrderSkillEligibility = { source: skill.source, name: skill.name, path: skill.path,
  taskType: 'draft_test_v1', artifactDigest: `sha256:${'b'.repeat(64)}`, platformPriced: true,
  serviceTitle: '草稿测试', serviceDescription: skill.description }

async function fixture() {
  const files = Promise.withResolvers<{ ok: true; value: { skills: readonly LocalSkillEntry[] } }>()
  const eligibility = Promise.withResolvers<{ ok: true; value: { items: readonly LocalOrderSkillEligibility[] } }>()
  let owner = 1
  const listLocal = vi.fn().mockResolvedValueOnce({ ok: true, value: { skills: [skill] } }).mockReturnValueOnce(files.promise)
    .mockResolvedValue({ ok: true, value: { skills: [skill] } })
  const localOrderSkillEligibility = vi.fn().mockResolvedValueOnce({ ok: true, value: { items: [eligible] } })
    .mockReturnValueOnce(eligibility.promise).mockResolvedValue({ ok: true, value: { items: [eligible] } })
  const controller = new LocalSkillsController({ listLocal }, { localOrderSkillEligibility }, async () => owner)
  await controller.reload()
  await waitFor(() => { expect(controller.store.getSnapshot().eligibilityStatus).toBe('ready') })
  const publish = vi.fn(async () => {})
  let reads = 0
  const refresh = vi.fn(async () => { if (++reads > 1) await controller.reload() })
  function Connected() {
    const view = useSyncExternalStore(listener => controller.store.subscribe(listener), () => controller.store.getSnapshot())
    return <LocalSkillsPanel view={view} t={t} ensure={async () => {}} reload={() => controller.reload()}
      refreshPublications={refresh} publishOrderSkill={publish} previewOrderPrice={async () => ({
        taskType: eligible.taskType, artifactDigest: eligible.artifactDigest, priceYuan: '0.50', settingsVersion: 5,
        taskDefinitionSha256: 'c'.repeat(64),
      })} publication={{ busyKey: null, items: { 'skill:user-dsh:pending-other': { phase: 'submitted', reviewReasons: [] } },
        sellerProducts: {}, sellerProductsUnavailable: false, sellerProductErrors: {} }} />
  }
  vi.useFakeTimers()
  render(<Connected />)
  fireEvent.click(screen.getByText(zh.skillCardManage))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.publishOrder })) })
  expect(screen.getByRole('dialog', { name: zh.publishReviewTitle })).toBeDefined()
  fireEvent.change(screen.getByRole('textbox', { name: zh.publishSalePrice }), { target: { value: '12.30' } })
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
  expect(refresh).toHaveBeenCalledTimes(2)
  expect(listLocal).toHaveBeenCalledTimes(2)
  return { controller, files, eligibility, publish, changeOwner: () => { owner = 2 } }
}

it('keeps an edited publication dialog through the actual 15-second read and only submits after fresh eligibility', async () => {
  const current = await fixture()
  expect(screen.getByRole('dialog', { name: zh.publishReviewTitle })).toBeDefined()
  expect(screen.getByRole('textbox', { name: zh.publishSalePrice }).getAttribute('value')).toBe('12.30')
  expect(screen.getByRole('button', { name: zh.publishReviewSubmit }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: zh.publishReviewSubmit }))
  expect(current.publish).not.toHaveBeenCalled()
  await act(async () => {
    current.files.resolve({ ok: true, value: { skills: [skill] } })
    current.eligibility.resolve({ ok: true, value: { items: [eligible] } })
  })
  expect(screen.getByRole('textbox', { name: zh.publishSalePrice }).getAttribute('value')).toBe('12.30')
  expect(screen.getByRole('button', { name: zh.publishReviewSubmit }).hasAttribute('disabled')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: zh.publishReviewSubmit }))
  expect(current.publish).toHaveBeenCalledWith('user-dsh', 'draft-test', expect.objectContaining({
    salePriceYuan: '12.30', expectedArtifactDigest: eligible.artifactDigest, expectedTaskDefinitionSha256: 'c'.repeat(64),
  }))
  current.controller.dispose()
})

it.each(['source-missing', 'source-changed', 'eligibility-lost', 'owner-changed'] as const)(
  'drops the draft after a fresh read establishes %s and never resurrects it on a later read', async (reason) => {
    const current = await fixture()
    if (reason === 'owner-changed') current.changeOwner()
    await act(async () => {
      current.files.resolve({ ok: true, value: { skills: reason === 'source-missing' ? []
        : [reason === 'source-changed' ? { ...skill, sha256: 'd'.repeat(64), updatedAt: 2 } : skill] } })
      current.eligibility.resolve({ ok: true, value: { items: reason === 'eligibility-lost' ? [] : [eligible] } })
    })
    expect(screen.queryByRole('dialog', { name: zh.publishReviewTitle })).toBeNull()
    expect(current.publish).not.toHaveBeenCalled()
    await act(async () => { await current.controller.reload() })
    expect(screen.queryByRole('dialog', { name: zh.publishReviewTitle })).toBeNull()
    expect(current.publish).not.toHaveBeenCalled()
    current.controller.dispose()
  })
