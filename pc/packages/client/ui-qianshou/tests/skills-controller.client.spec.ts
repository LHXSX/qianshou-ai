import { describe, expect, it, vi } from 'vitest'
import type { SessionId, SkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import { SkillsController } from '../src/client/skills-controller.ts'

const skill: SkillEntry = { name: 'write-report', description: 'Prepare a report', modelInvocable: true }
const session = 'session-1' as SessionId

describe('Qianshou composer skills', () => {
  it('reads the current session catalog once and keeps it separate from another session', async () => {
    const list = vi.fn(async ({ sessionId }: { sessionId: SessionId }) => ({
      ok: true as const, value: { skills: sessionId === session ? [skill] : [] },
    }))
    const controller = new SkillsController({ list })
    await Promise.all([controller.load(session), controller.load(session)])
    await controller.load(session)
    expect(list).toHaveBeenCalledTimes(1)
    expect(controller.storeFor(session).getSnapshot().skills).toEqual([skill])

    const other = 'session-2' as SessionId
    await controller.load(other)
    expect(controller.storeFor(other).getSnapshot().skills).toEqual([])
    expect(controller.storeFor(session).getSnapshot().skills).toEqual([skill])
  })

  it('ignores an old response after a preset change and retries a failed read', async () => {
    let resolveOld: ((result: { ok: true; value: { skills: SkillEntry[] } }) => void) | undefined
    const list = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
      .mockResolvedValueOnce({ ok: false, error: new Error('offline') })
      .mockResolvedValueOnce({ ok: true, value: { skills: [skill] } })
    const controller = new SkillsController({ list })
    const old = controller.load(session)
    controller.invalidate(session)
    await controller.load(session)
    expect(controller.storeFor(session).getSnapshot()).toMatchObject({ skills: [], error: true, loading: false })
    resolveOld?.({ ok: true, value: { skills: [{ ...skill, name: 'stale' }] } })
    await old
    expect(controller.storeFor(session).getSnapshot().skills).toEqual([])

    await controller.reload(session)
    expect(controller.storeFor(session).getSnapshot()).toMatchObject({ skills: [skill], error: false })
  })

  it('refreshes mounted sessions when the skill files change', async () => {
    const added = { ...skill, name: 'svg-to-video', displayName: 'SVG 动画视频', category: 'video' as const }
    const list = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { skills: [skill] } })
      .mockResolvedValueOnce({ ok: true, value: { skills: [skill, added] } })
    const controller = new SkillsController({ list })
    await controller.load(session)
    await controller.refreshKnown()
    expect(list).toHaveBeenCalledTimes(2)
    expect(controller.storeFor(session).getSnapshot().skills).toEqual([skill, added])
  })
})
