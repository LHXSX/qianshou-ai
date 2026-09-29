/** Voice activity must come from a real producer; a consumer without one reports unknown and never idle. */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { VoiceActivityProjection } from '../../../voice-local/src/activity.ts'
import { readHostVoiceActivity } from '../../src/supply-host.ts'

describe('host voice activity reader', () => {
  it('reports unknown while no producer is loaded', () => {
    expect(readHostVoiceActivity(new Context())).toBeNull()
  })

  it('follows the real projection instead of a constant', () => {
    const ctx = new Context()
    const activity = new VoiceActivityProjection()
    ctx.provide('voiceActivity', activity)
    expect(readHostVoiceActivity(ctx)).toBe(false)
    const release = activity.hold()
    expect(readHostVoiceActivity(ctx)).toBe(true)
    release()
    expect(readHostVoiceActivity(ctx)).toBe(false)
  })

  it('ignores a service value that does not answer with a real reading', () => {
    const ctx = new Context()
    ctx.provide('voiceActivity', {} as unknown as Context['voiceActivity'])
    expect(readHostVoiceActivity(ctx)).toBeNull()
    const other = new Context()
    other.provide('voiceActivity', { active: 'yes' } as unknown as Context['voiceActivity'])
    expect(readHostVoiceActivity(other)).toBeNull()
  })

  it('lets a broken producer surface as a failed probe rather than a silent idle reading', () => {
    const ctx = new Context()
    ctx.provide('voiceActivity', { active: () => { throw new Error('producer is broken') } })
    // The caller still fails closed (no snapshot, no publication); swallowing this would hide the defect and turn
    // an unreadable fact into an idle one.
    expect(() => readHostVoiceActivity(ctx)).toThrow('producer is broken')
  })
})
