// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionId, SkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionSkillsPanel, type SessionSkillsLabels } from '../src/client/SessionSkillsPanel.tsx'
import type { SessionSkillsView } from '../src/client/session-skills-controller.ts'
import { zh as localZh } from '../src/client/local-skill-locales.ts'

afterEach(cleanup)

const labels: SessionSkillsLabels = {
  title: 'Skills callable in this Session', scope: 'This list follows the current Session.',
  searchLabel: 'Search Session skills', searchPlaceholder: 'Name or description', refresh: 'Refresh',
  loading: 'Reading skills', unavailable: 'Skills unavailable', noSession: 'Open a Session',
  empty: 'No callable skills', noMatches: 'No matching skills', count: '{count} skills', userOnly: 'User only',
  useSkill: 'Use in chat', useUnavailable: 'Conversation unavailable', details: 'Read description',
}
const sessionId = 'test-session' as SessionId
const skills: SkillEntry[] = [
  { name: 'write-report', description: 'Prepare an article.', modelInvocable: true },
  { name: 'review-copy', description: 'Check text.', whenToUse: 'Before publishing.', modelInvocable: false },
]
const view = (state: Partial<SessionSkillsView> = {}): SessionSkillsView => ({
  sessionId, skills, status: 'ready', ...state,
})

describe('Session skills market panel', () => {
  it('keeps no-Session, loading, failure, and empty states distinct', () => {
    const reload = vi.fn()
    const page = render(<SessionSkillsPanel view={view({ sessionId: null, skills: [], status: 'no-session' })}
      labels={labels} reload={reload} />)
    expect(screen.getByRole('status').textContent).toBe(labels.noSession)
    expect(screen.getByRole('button', { name: labels.refresh })).toHaveProperty('disabled', true)
    page.rerender(<SessionSkillsPanel view={view({ skills: [], status: 'loading' })} labels={labels} reload={reload} />)
    expect(screen.getByRole('status').textContent).toBe(labels.loading)
    page.rerender(<SessionSkillsPanel view={view({ skills: [], status: 'error' })} labels={labels} reload={reload} />)
    expect(screen.getByRole('alert').textContent).toBe(labels.unavailable)
    fireEvent.click(screen.getByRole('button', { name: labels.refresh }))
    expect(reload).toHaveBeenCalledOnce()
    page.rerender(<SessionSkillsPanel view={view({ skills: [], status: 'ready' })} labels={labels} reload={reload} />)
    expect(screen.getByRole('status').textContent).toBe(labels.empty)
  })

  it('searches the Host entries and marks user-only invocation', () => {
    render(<SessionSkillsPanel view={view()} labels={labels} reload={vi.fn()} />)
    expect(screen.getByText('write-report')).toBeTruthy()
    expect(screen.getByText('review-copy')).toBeTruthy()
    expect(screen.getByText(labels.userOnly)).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox', { name: labels.searchLabel }), { target: { value: 'publishing' } })
    expect(screen.queryByText('write-report')).toBeNull()
    expect(screen.getByText('review-copy')).toBeTruthy()
    expect(screen.getByText('1 skills')).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox', { name: labels.searchLabel }), { target: { value: 'missing' } })
    expect(screen.getByRole('status').textContent).toBe(labels.noMatches)
  })

  it('sends only the selected skill name to the owner and reports a failed handoff', () => {
    const useSkill = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    render(<SessionSkillsPanel view={view()} labels={labels} reload={vi.fn()} useSkill={useSkill} />)
    fireEvent.click(screen.getAllByRole('button', { name: labels.useSkill })[0]!)
    expect(useSkill).toHaveBeenCalledExactlyOnceWith('write-report')
    expect(screen.getByRole('alert').textContent).toBe(labels.useUnavailable)
    fireEvent.click(screen.getAllByRole('button', { name: labels.useSkill })[1]!)
    expect(useSkill).toHaveBeenLastCalledWith('review-copy')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows a Chinese title and category while retaining the callable command', () => {
    render(<SessionSkillsPanel view={view({ skills: [{ name: 'svg-to-video', displayName: 'SVG 绘图转视频',
      description: 'Turn SVG frames into a GIF.', category: 'video', modelInvocable: true }] })}
      labels={labels} reload={vi.fn()} localT={key => localZh[key]} />)
    expect(screen.getByRole('heading', { name: 'SVG 绘图转视频' })).toBeTruthy()
    expect(screen.getByText(localZh.categoryVideo)).toBeTruthy()
    expect(screen.getByText('/svg-to-video')).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox', { name: labels.searchLabel }), { target: { value: '逐帧' } })
    expect(screen.getByRole('heading', { name: 'SVG 绘图转视频' })).toBeTruthy()
  })
})
