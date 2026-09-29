// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SkillImportPanel } from '../src/client/SkillImportPanel.tsx'
import { en, type MarketplaceKey } from '../src/client/marketplace-locales.ts'
import type { SkillImportView } from '../src/client/skill-import-controller.ts'
import type { SessionSkillsView } from '../src/client/session-skills-controller.ts'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'

afterEach(cleanup)
const t = (key: MarketplaceKey) => en[key]
const ready: SkillImportView = {
  status: 'ready', fileName: 'SKILL.md', content: '---\nname: draft-helper\n---\nInstructions.', error: null, writtenPath: null,
  inspection: { inspectionId: 'review-1', name: 'draft-helper', description: 'Help draft text.',
    sha256: 'a'.repeat(64), bytes: 42, targetPath: '/test/skills/draft-helper/SKILL.md',
    expiresAt: Date.now() + 60_000, modelInvocable: true, userInvocable: true },
}

describe('local skill import panel', () => {
  it('shows the reviewed name, destination, digest and explicit add action', () => {
    const install = vi.fn()
    const page = render(<SkillImportPanel view={ready} t={t} install={install} checkWrite={vi.fn()} dismiss={vi.fn()} />)
    expect(screen.getByText('draft-helper')).toBeTruthy()
    expect(screen.getByText('/test/skills/draft-helper/SKILL.md')).toBeTruthy()
    expect(screen.getByText('a'.repeat(64))).toBeTruthy()
    fireEvent.click(screen.getByText(en.skillImportPreview))
    expect(document.querySelector('pre')?.textContent).toBe(ready.content)
    expect(install).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.skillImportConfirm }))
    expect(install).toHaveBeenCalledOnce()
    const session: SessionSkillsView = { sessionId: 'session-1' as SessionId, status: 'ready',
      skills: [{ name: 'draft-helper', description: 'Help draft text.', modelInvocable: true,
        path: ready.inspection!.targetPath }] }
    page.rerender(<SkillImportPanel view={{ ...ready, status: 'written', content: null,
      writtenPath: ready.inspection?.targetPath ?? null }}
      t={t} install={install} checkWrite={vi.fn()} dismiss={vi.fn()} refreshSkills={vi.fn()}
      sessionSkillsView={session} />)
    expect(screen.getByRole('status').textContent).toContain(en.skillImportWritten)
    expect(screen.getByRole('status').textContent).toContain(en.skillImportDiscovered)
    expect(screen.getByRole('button', { name: en.skillImportRefresh })).toBeTruthy()
    page.rerender(<SkillImportPanel view={{ ...ready, status: 'written', content: null,
      writtenPath: ready.inspection?.targetPath ?? null }}
      t={t} install={install} checkWrite={vi.fn()} dismiss={vi.fn()} refreshSkills={vi.fn()}
      sessionSkillsView={{ ...session, skills: [{ ...session.skills[0]!, path: '/other/SKILL.md' }] }} />)
    expect(screen.getByRole('status').textContent).toContain(en.skillImportShadowed)
  })
})
