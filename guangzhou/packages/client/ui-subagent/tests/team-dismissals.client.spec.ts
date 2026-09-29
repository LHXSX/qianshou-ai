import { describe, expect, it } from 'vitest'
import { loadTeamDismissals, reconcileTeamDismissals, saveTeamDismissals, teamRecordVersion } from '../src/client/team-dismissals.ts'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'

function memory() {
  const data = new Map<string, string>()
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
}
describe('local team record display preferences', () => {
  it('persists per-root versions without touching other stored preferences', () => {
    const storage = memory(); storage.setItem('voice.preference', 'keep')
    expect(saveTeamDismissals('root-a', new Map([['child', 'round-1']]), storage)).toBe(true)
    expect([...loadTeamDismissals('root-a', storage)]).toEqual([['child', 'round-1']])
    expect(loadTeamDismissals('root-b', storage).size).toBe(0)
    expect(storage.getItem('voice.preference')).toBe('keep')
    saveTeamDismissals('root-a', new Map(), storage)
    expect(loadTeamDismissals('root-a', storage).size).toBe(0)
  })
  it('fails safely on corrupt and unavailable storage', () => {
    for (const raw of ['broken', '{}', '[1,["child",5],["valid","stamp"]]']) {
      const result = loadTeamDismissals('root', { getItem: () => raw, setItem() {} })
      expect([...result.keys()]).toEqual(raw.startsWith('[1') ? ['valid'] : [])
    }
    const broken = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
    expect(loadTeamDismissals('root', broken).size).toBe(0)
    expect(saveTeamDismissals('root', new Map(), broken)).toBe(false)
  })
  it('retires a hidden completion on new work or new durable activity, without dropping unresolved history', () => {
    const old = new Map([['same', '1'], ['active', '1'], ['new', '1'], ['not-loaded', '1']])
    expect([...reconcileTeamDismissals(old, [
      { id: 'same', running: false, version: '1' }, { id: 'active', running: true, version: '1' },
      { id: 'new', running: false, version: '2' }, { id: 'not-loaded', running: false, version: undefined },
    ])]).toEqual([['same', '1'], ['not-loaded', '1']])
    expect(reconcileTeamDismissals(old, [{ id: 'same', running: false, version: '1' }])).toBe(old)
  })
  it('uses completion time as well as summary activity to recognize a later assignment', () => {
    const summary = { updatedAt: 20, projectionValues: { employeeActivity: { phase: 'completed', at: 10 } } } as SessionSummary
    const previous = teamRecordVersion(summary)
    expect(teamRecordVersion({ ...summary, projectionValues: { employeeActivity: { phase: 'completed', at: 11, tools: {}, update: '' } } })).not.toBe(previous)
    expect(teamRecordVersion({ ...summary, updatedAt: 21 })).not.toBe(previous)
    expect(teamRecordVersion(undefined)).toBeUndefined()
  })
})
