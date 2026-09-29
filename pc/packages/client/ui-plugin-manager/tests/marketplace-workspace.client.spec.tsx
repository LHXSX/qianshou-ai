// @vitest-environment jsdom
import { createHash } from 'node:crypto'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MarketplacePanel, type MarketplacePanelProps } from '../src/client/MarketplacePanel.tsx'
import { OFFICIAL_SKILLS } from '../src/client/official-skills.ts'
import { zh } from '../src/client/marketplace-locales.ts'
import { zh as localZh } from '../src/client/local-skill-locales.ts'
import { MarketplaceNavigation } from '../src/client/marketplace-navigation.ts'

afterEach(() => { cleanup(); sessionStorage.clear() })
function props(): MarketplacePanelProps {
  return {
    view: { mode: 'shipped', source: 'shipped', listings: [], installedRecords: [], loading: false,
      busyId: null, workingId: null, error: null, report: null, notice: null },
    t: key => zh[key], ensure: vi.fn(), reload: vi.fn(), inspect: vi.fn(), install: vi.fn(),
    recheck: vi.fn(), repair: vi.fn(), rollback: vi.fn(), dismiss: vi.fn(),
    startSkillCreator: vi.fn(async () => true), openPackageInstall: vi.fn(),
    marketCapabilities: { reload: vi.fn(), view: { capabilities: [], loaded: true, loading: false, error: false } },
    localSkills: { view: { status: 'ready', skills: [{ name: 'generic-scan', displayName: '通用扫描', description: '扫描文本',
      source: 'user-agents', path: '/home/me/.agents/skills/generic-scan/SKILL.md', updatedAt: 1,
      modelInvocable: true, userInvocable: true }] }, t: key => localZh[key],
    ensure: vi.fn(async () => {}), reload: vi.fn(async () => {}), refreshPublications: vi.fn(async () => {}),
    planOrderAdapter: vi.fn(async () => true), openIntake: vi.fn(),
    publication: { busyKey: null, sellerProducts: {}, sellerProductsUnavailable: false, sellerProductErrors: {},
      items: { 'skill:user-agents:generic-scan': { phase: 'archive-pending', publicationId: 'publication-1' } } } },
    skillImport: { view: { status: 'idle', fileName: '', content: null, inspection: null, writtenPath: null, error: null },
      inspectFile: vi.fn(), install: vi.fn(), checkWrite: vi.fn(), dismiss: vi.fn() },
  }
}
it('keeps two consumption tabs and hides publication, orders, adapter management and create flows', () => {
  const p = props()
  render(<MarketplacePanel {...p} />)
  expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual([zh.workspaceMarket, zh.workspaceMine])
  expect(screen.getByText(zh.officialImageTitle)).toBeTruthy()
  expect(screen.getByText(zh.officialVideoTitle)).toBeTruthy()
  expect(screen.queryByText(zh.workspacePublications)).toBeNull()
  expect(screen.queryByRole('button', { name: zh.newPlugin })).toBeNull()
  expect(screen.queryByRole('button', { name: zh.marketManageIntake })).toBeNull()
  fireEvent.click(screen.getByRole('tab', { name: zh.workspaceMine }))
  expect(screen.getByText('通用扫描')).toBeTruthy()
  expect(screen.queryByText('publication-1')).toBeNull()
  expect(screen.queryByRole('button', { name: localZh.publishOrder })).toBeNull()
  expect(p.localSkills?.refreshPublications).not.toHaveBeenCalled()
})
it('routes developer submissions to the existing forum without creating a publication', () => {
  const listener = vi.fn(); window.addEventListener('qianshou:open-community', listener)
  const p = props(); render(<MarketplacePanel {...p} />)
  fireEvent.click(screen.getByRole('button', { name: zh.developerForumOpen }))
  expect(listener).toHaveBeenCalledOnce()
  expect(p.startSkillCreator).not.toHaveBeenCalled()
  window.removeEventListener('qianshou:open-community', listener)
})
it('consumes legacy publication links as an exact local skill focus and preserves source identity', async () => {
  const p = props(), original = p.localSkills!.view.skills[0]!
  const navigation = new MarketplaceNavigation(vi.fn())
  navigation.openPublications({ source: 'user-agents', name: original.name })
  render(<MarketplacePanel {...p} localSkills={{ ...p.localSkills!, view: { ...p.localSkills!.view, skills: [original,
    { ...original, source: 'user-dsh', path: '/other/SKILL.md', displayName: '同名另一份' }] } }}
  publicationsNavigation={{ request: navigation.store.getSnapshot().request, consume: id => navigation.consume(id) }} />)
  await waitFor(() => { expect(screen.getByRole('tab', { name: zh.workspaceMine }).getAttribute('aria-selected')).toBe('true') })
  expect(screen.getByText('通用扫描')).toBeTruthy()
  expect(screen.queryByText('同名另一份')).toBeNull()
  expect(screen.queryByText('publication-1')).toBeNull()
})
it('installs only the clicked official bytes once and does not replay an uncertain write', async () => {
  const p = props(), skill = OFFICIAL_SKILLS[0]
  const rendered = render(<MarketplacePanel {...p} />)
  fireEvent.click(screen.getAllByRole('button', { name: zh.ordinarySkillsAdd })[0]!)
  const file = vi.mocked(p.skillImport!.inspectFile).mock.calls[0]![0]
  expect(file.name).toBe(`${skill.name}.md`)
  expect(file.size).toBe(new TextEncoder().encode(skill.content).byteLength)
  const inspection = { inspectionId: 'original-inspection', name: skill.name, description: '图像创作',
    sha256: skill.sha256, bytes: file.size, targetPath: '/private/skills/SKILL.md', expiresAt: Date.now() + 10000,
    modelInvocable: true, userInvocable: true }
  const ready = { ...p.skillImport!, view: { ...p.skillImport!.view, status: 'ready' as const,
    content: skill.content, inspection, fileName: file.name } }
  rendered.rerender(<MarketplacePanel {...p} skillImport={ready} />)
  await waitFor(() => { expect(p.skillImport!.install).toHaveBeenCalledOnce() })
  rendered.rerender(<MarketplacePanel {...p} skillImport={{ ...ready, view: { ...ready.view, status: 'unconfirmed' } }} />)
  rendered.rerender(<MarketplacePanel {...p} skillImport={ready} />)
  expect(p.skillImport!.install).toHaveBeenCalledOnce()
  expect(p.install).not.toHaveBeenCalled()
})
it('does not install a same-name inspection of different bytes and does not mark it as the official installation', () => {
  const p = props(), skill = OFFICIAL_SKILLS[0]
  const rendered = render(<MarketplacePanel {...p} />)
  fireEvent.click(screen.getAllByRole('button', { name: zh.ordinarySkillsAdd })[0]!)
  rendered.rerender(<MarketplacePanel {...p} skillImport={{ ...p.skillImport!, view: { ...p.skillImport!.view,
    status: 'ready', content: 'different instructions', inspection: { inspectionId: 'other', name: skill.name,
      description: '', sha256: '0'.repeat(64), bytes: 22, targetPath: '/private/SKILL.md', expiresAt: Date.now() + 10000,
      userInvocable: true, modelInvocable: true } } }} />)
  expect(p.skillImport!.install).not.toHaveBeenCalled()
  for (const entry of OFFICIAL_SKILLS) expect(createHash('sha256').update(entry.content).digest('hex')).toBe(entry.sha256)
})
