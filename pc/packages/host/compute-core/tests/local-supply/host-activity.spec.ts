/** Voice activity requires a conforming producer; without one the consumer reports unknown, never idle. */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { readHostVoiceActivity } from '../../src/supply-host.ts'

class VoiceActivityFixture {
  private holds = 0
  active(): boolean { return this.holds > 0 }
  subscribe(_listener: (active: boolean) => void): () => void { return () => {} }
  hold(): () => void {
    this.holds += 1
    return () => { this.holds -= 1 }
  }
}

describe('host voice activity reader', () => {
  it('reports unknown while no producer is loaded', () => {
    expect(readHostVoiceActivity(new Context())).toBeNull()
  })

  it('follows a conforming producer instead of a constant', () => {
    const ctx = new Context()
    const activity = new VoiceActivityFixture()
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
    const noNotifications = new Context()
    noNotifications.provide('voiceActivity', { active: () => false } as unknown as Context['voiceActivity'])
    expect(readHostVoiceActivity(noNotifications)).toBeNull()
  })

  it('lets a broken producer surface as a failed probe rather than a silent idle reading', () => {
    const ctx = new Context()
    ctx.provide('voiceActivity', { active: () => { throw new Error('producer is broken') }, subscribe: () => () => {} })
    // The caller still fails closed (no snapshot, no publication); swallowing this would hide the defect and turn
    // an unreadable fact into an idle one.
    expect(() => readHostVoiceActivity(ctx)).toThrow('producer is broken')
  })

  it.each([undefined, null, 0, 1, 'false', {}, Promise.resolve(false)])('reports a non-boolean producer result as unknown (%j)', (reading) => {
    const ctx = new Context()
    ctx.provide('voiceActivity', { active: () => reading, subscribe: () => () => {} } as unknown as Context['voiceActivity'])
    expect(readHostVoiceActivity(ctx)).toBeNull()
  })
})
