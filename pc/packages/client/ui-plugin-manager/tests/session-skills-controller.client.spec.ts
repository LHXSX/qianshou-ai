import type { SessionId, SkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import { describe, expect, it, vi } from 'vitest'
import { SessionSkillsController } from '../src/client/session-skills-controller.ts'

const first = 'first-session' as SessionId
const second = 'second-session' as SessionId
const skill: SkillEntry = { name: 'report', description: 'Write a report.', modelInvocable: true }

describe('Qianshou market Session skills', () => {
  it('reads only the selected Session and has an explicit no-Session state', async () => {
    const list = vi.fn().mockResolvedValue({ ok: true, value: { skills: [skill] } })
    const controller = new SessionSkillsController({ list })
    expect(controller.store.getSnapshot()).toEqual({ sessionId: null, skills: [], status: 'no-session' })
    await controller.select(null)
    expect(list).not.toHaveBeenCalled()

    await controller.select(first)
    expect(list).toHaveBeenCalledExactlyOnceWith({ sessionId: first }, expect.any(AbortSignal))
    expect(controller.store.getSnapshot()).toEqual({ sessionId: first, skills: [skill], status: 'ready' })
    await controller.select(null)
    expect(controller.store.getSnapshot()).toEqual({ sessionId: null, skills: [], status: 'no-session' })
    controller.dispose()
  })

  it('drops a late response when the selected Session changes', async () => {
    let resolveFirst!: (result: { ok: true, value: { skills: SkillEntry[] } }) => void
    const list = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve }))
      .mockResolvedValueOnce({ ok: true, value: { skills: [{ ...skill, name: 'second-skill' }] } })
    const controller = new SessionSkillsController({ list })
    const earlier = controller.select(first)
    await controller.select(second)
    resolveFirst({ ok: true, value: { skills: [skill] } })
    await earlier
    expect(controller.store.getSnapshot()).toEqual({
      sessionId: second, skills: [{ ...skill, name: 'second-skill' }], status: 'ready',
    })
    controller.dispose()
  })

  it('shows read failure and retries without publishing an old result', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: new Error('offline') })
      .mockResolvedValueOnce({ ok: true, value: { skills: [skill] } })
    const controller = new SessionSkillsController({ list })
    await controller.select(first)
    expect(controller.store.getSnapshot()).toEqual({ sessionId: first, skills: [], status: 'error' })
    await controller.reload()
    expect(controller.store.getSnapshot()).toEqual({ sessionId: first, skills: [skill], status: 'ready' })
    expect(list).toHaveBeenCalledTimes(2)
    controller.dispose()
  })
})
