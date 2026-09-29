// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { LocalSkillArchiveEntry, LocalSkillArchiveReceipt, LocalSkillEntry, LocalSkillRestoreReceipt } from '@deepseek-ai/dsh-api-remotes/client'
import { LocalSkillsController } from '../src/client/local-skills-controller.ts'
import { LocalSkillsPanel } from '../src/client/LocalSkillsPanel.tsx'
import { zh } from '../src/client/local-skill-locales.ts'

afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.restoreAllMocks() })
const labels: Readonly<Record<string, string>> = { ...zh }
const t = (key: string): string => {
  const value = labels[key]
  if (value === undefined) throw new Error(`Missing test locale: ${key}`)
  return value
}
const skill: LocalSkillEntry = { name: 'local-example', displayName: '中文示例', description: '本机示例',
  source: 'user-dsh', path: '/home/skills/local-example/SKILL.md', sha256: 'a'.repeat(64),
  canArchive: true, userInvocable: true, modelInvocable: true, updatedAt: 1 }
const request = { source: skill.source, name: skill.name, path: skill.path, sha256: 'a'.repeat(64) }
const receipt: LocalSkillArchiveReceipt = { state: 'archived', source: skill.source, name: skill.name,
  originalPath: '/home/skills/local-example', archivePath: '/home/.qianshou-skill-archives/id/local-example',
  receiptPath: '/home/.qianshou-skill-archives/id/restore.json', sha256: request.sha256 }
const entry: LocalSkillArchiveEntry = { ...receipt, archiveId: '7c09594d-dcfa-47cb-b47d-1b197bcf1c30',
  archivedAt: '2026-09-27T01:00:00.000Z', displayName: '中文示例', description: '本机示例' }
const restoreRequest = { source: entry.source, archiveId: entry.archiveId, sha256: entry.sha256 }
const restoreReceipt: LocalSkillRestoreReceipt = { ...restoreRequest, state: 'restored', name: entry.name, path: skill.path }

it.each([
  ['Asia/Shanghai', '2026/9/27'],
  ['America/Los_Angeles', '2026/9/26'],
])('shows the archive date in the device timezone %s without rewriting its timestamp', (timezone, visibleDate) => {
  vi.stubEnv('TZ', timezone)
  vi.spyOn(navigator, 'language', 'get').mockReturnValue('zh-CN')
  const archivedAt = '2026-09-26T21:52:00.000Z'
  const { container } = render(<LocalSkillsPanel t={t} ensure={async () => {}} reload={async () => {}}
    refreshLocalArchives={async () => {}} restoreLocalSkill={async () => true}
    view={{ status: 'ready', skills: [], archiveStatus: 'ready', archives: [{ ...entry, archivedAt }] }} />)
  fireEvent.click(screen.getByRole('button', { name: '回收站' }))
  const time = container.querySelector('time')
  expect(time?.textContent).toBe(visibleDate)
  expect(time?.getAttribute('datetime')).toBe(archivedAt)
})

it('removes a verified archived card before the subsequent inventory read settles', async () => {
  const refreshed = Promise.withResolvers<{ ok: true; value: { skills: readonly LocalSkillEntry[] } }>()
  let calls = 0
  const controller = new LocalSkillsController({ listLocal: () => ++calls === 1
    ? Promise.resolve({ ok: true, value: { skills: [skill] } }) : refreshed.promise,
  archiveLocal: async () => ({ ok: true, value: receipt }) })
  await controller.reload()
  const archived = controller.archive(request)
  await vi.waitFor(() => { expect(calls).toBe(2) })
  expect(controller.store.getSnapshot().skills).toEqual([])
  expect(controller.store.getSnapshot().removals?.[skill.path]?.phase).toBe('archived')
  refreshed.resolve({ ok: true, value: { skills: [] } })
  expect(await archived).toBe(true)
  controller.dispose()
})

it('coalesces real archive reads and recovers only a selected receipt without calling order activation', async () => {
  const archiveResponse = Promise.withResolvers<{ ok: true; value: { items: readonly LocalSkillArchiveEntry[] } }>()
  let restored = false
  const archiveList = vi.fn(() => restored ? Promise.resolve({ ok: true as const, value: { items: [] } }) : archiveResponse.promise)
  const restoreLocal = vi.fn(async () => { restored = true; return { ok: true as const, value: restoreReceipt } })
  const activateAuthorOrderSkill = vi.fn(async () => ({ ok: true as const, value: {} }))
  const controller = new LocalSkillsController({ listLocal: async () => ({ ok: true, value: { skills: restored ? [skill] : [] } }),
    archiveList, restoreLocal }, { localOrderSkillEligibility: async () => ({ ok: true, value: { items: [] } }), activateAuthorOrderSkill })
  await controller.reload()
  const first = controller.refreshArchives()
  const second = controller.refreshArchives()
  archiveResponse.resolve({ ok: true, value: { items: [entry] } })
  await Promise.all([first, second])
  expect(archiveList).toHaveBeenCalledTimes(1)
  expect(await controller.restore({ ...restoreRequest, sha256: 'b'.repeat(64) })).toBe(false)
  expect(restoreLocal).not.toHaveBeenCalled()
  expect(await controller.restore(restoreRequest)).toBe(true)
  expect(restoreLocal).toHaveBeenCalledExactlyOnceWith(restoreRequest)
  expect(activateAuthorOrderSkill).not.toHaveBeenCalled()
  expect(controller.store.getSnapshot().skills).toEqual([skill])
  expect(controller.store.getSnapshot().archives).toEqual([])
  controller.dispose()
})

it('retains a conflicting archive and rejects mismatched restoration authority', async () => {
  let mismatch = false
  const controller = new LocalSkillsController({ listLocal: async () => ({ ok: true, value: { skills: [] } }),
    archiveList: async () => ({ ok: true, value: { items: [entry] } }),
    restoreLocal: async () => mismatch ? { ok: true, value: { ...restoreReceipt, name: 'different' } }
      : { ok: false, error: { code: 'skill-import/conflict' } } })
  await controller.reload(); await controller.refreshArchives()
  expect(await controller.restore(restoreRequest)).toBe(false)
  expect(controller.store.getSnapshot().archives).toEqual([entry])
  expect(controller.store.getSnapshot().restorations?.[entry.archiveId]?.reason).toBe('skill-import/conflict')
  mismatch = true
  expect(await controller.restore(restoreRequest)).toBe(false)
  expect(controller.store.getSnapshot().restorations?.[entry.archiveId]?.reason).toBe('local-recovery-unconfirmed')
  controller.dispose()
})

it('clears recovery rows when the owner changes while a restore is pending', async () => {
  let owner = 1
  const response = Promise.withResolvers<{ ok: true; value: LocalSkillRestoreReceipt }>()
  const restoreLocal = vi.fn(() => response.promise)
  const controller = new LocalSkillsController({ listLocal: async () => ({ ok: true, value: { skills: [] } }),
    archiveList: async () => ({ ok: true, value: { items: [entry] } }), restoreLocal }, undefined, async () => owner)
  await controller.reload(); await controller.refreshArchives()
  const pending = controller.restore(restoreRequest)
  await vi.waitFor(() => { expect(restoreLocal).toHaveBeenCalledTimes(1) })
  owner = 2; response.resolve({ ok: true, value: restoreReceipt })
  expect(await pending).toBe(false)
  expect(controller.store.getSnapshot().archives).toBeUndefined()
  expect(controller.store.getSnapshot().skills).toEqual([])
  controller.dispose()
})

it('combines deletion notices without paths and presents a real recycle action only on explicit click', async () => {
  const refreshLocalArchives = vi.fn(async () => {})
  const restoreLocalSkill = vi.fn(async () => true)
  const { container } = render(<LocalSkillsPanel t={t} ensure={async () => {}} reload={async () => {}}
    refreshLocalArchives={refreshLocalArchives} restoreLocalSkill={restoreLocalSkill}
    view={{ status: 'ready', skills: [], archiveStatus: 'ready', archives: [entry], removals: {
      one: { phase: 'archived', receipt }, two: { phase: 'archived', receipt },
    } }} />)
  expect(screen.getAllByText('已移到回收站。')).toHaveLength(1)
  expect(container.textContent).not.toContain(receipt.archivePath)
  expect(restoreLocalSkill).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '回收站' }))
  expect(refreshLocalArchives).toHaveBeenCalledTimes(1)
  expect(screen.getByText('中文示例')).toBeDefined()
  const details = container.querySelector('details')
  expect(details?.open).toBe(false)
  expect(details?.textContent).toContain(entry.originalPath)
  fireEvent.click(screen.getByRole('button', { name: '恢复' }))
  await waitFor(() => { expect(restoreLocalSkill).toHaveBeenCalledExactlyOnceWith(restoreRequest) })
  await waitFor(() => { expect(screen.getByText('已恢复到我的技能。')).toBeDefined() })
})

it('shows one new removal notice when the same path is archived again with a new verified receipt', () => {
  const view = { status: 'ready' as const, skills: [], removals: { [skill.path]: { phase: 'archived' as const, receipt } } }
  const panel = render(<LocalSkillsPanel t={t} ensure={async () => {}} reload={async () => {}} view={view} />)
  fireEvent.click(screen.getByRole('button', { name: zh.localNoticeDismiss }))
  expect(screen.queryByText(zh.localRemoveDone)).toBeNull()
  panel.rerender(<LocalSkillsPanel t={t} ensure={async () => {}} reload={async () => {}}
    view={{ ...view, removals: { [skill.path]: { phase: 'archived', receipt: { ...receipt,
      receiptPath: '/home/.qianshou-skill-archives/new-id/restore.json', archivePath: '/home/.qianshou-skill-archives/new-id/local-example' } } } }} />)
  expect(screen.getAllByText(zh.localRemoveDone)).toHaveLength(1)
})
