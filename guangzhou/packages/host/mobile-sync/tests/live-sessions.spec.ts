import { describe, expect, it } from 'vitest'
import { liveSessionIds } from '../src/gateway/live-sessions.ts'

describe('live Session listing for owner-authenticated bootstrap', () => {
  it('contributes no ids when the store is missing, unreadable, or not a list', () => {
    expect(liveSessionIds(undefined)).toEqual([])
    expect(liveSessionIds(null)).toEqual([])
    expect(liveSessionIds('store')).toEqual([])
    expect(liveSessionIds({})).toEqual([])
    expect(liveSessionIds({ list: 1 })).toEqual([])
    expect(liveSessionIds({ list: () => { throw new Error('unreadable') } })).toEqual([])
    expect(liveSessionIds({ list: () => 'nope' })).toEqual([])
    expect(liveSessionIds({
      list: () => [{ id: '' }, { name: 'no-id' }, 12, { id: 'session-live' }, 'session-named'],
    })).toEqual(['session-live', 'session-named'])
  })
})
