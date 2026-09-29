import { describe, expect, it } from 'vitest'
import type { ChatNodeStore } from '../src/client/contract/snapshot.ts'
import type { ChatTimelineEntriesSnapshot } from '../src/client/contract/timeline-entries.ts'
import { mergeTimelineEntries } from '../src/client/chat/timeline-entry-order.ts'

const nodes = { get: (key: string) => ({ anchorSeq: Number(key.slice(1)) }) } as ChatNodeStore
const snapshot = (times = [100, 300]): ChatTimelineEntriesSnapshot => ({
  eventTimes: times.map((time, i) => ({ seq: i + 1, time })),
  entries: [{ sourceId: 'feature', id: 'first', createdAt: 50 },
    { sourceId: 'feature', id: 'middle', createdAt: 200 },
    { sourceId: 'feature', id: 'last', createdAt: 400 }],
})
const labels = (input: ReturnType<typeof mergeTimelineEntries>) => input.map(row => row.kind === 'node' ? row.key : row.entry.id)

describe('feature rows within Host Chat order', () => {
  it('interleaves before, between and after real event-time anchors without reordering Host nodes', () => {
    expect(labels(mergeTimelineEntries(['n1', 'n2'], nodes, snapshot())))
      .toEqual(['first', 'n1', 'middle', 'n2', 'last'])
    expect(labels(mergeTimelineEntries([], nodes, snapshot()))).toEqual(['first', 'middle', 'last'])
    expect(mergeTimelineEntries(['n1', 'n2'], nodes, { ...snapshot(), entries: [] }).map(row => row.key)).toEqual(['n1', 'n2'])
  })

  it('keeps equal-time feature rows after the matching Host node and preserves backward-clock Host order', () => {
    const input = { ...snapshot([300, 100]), entries: [{ sourceId: 'feature', id: 'equal', createdAt: 100 }] }
    expect(labels(mergeTimelineEntries(['n1', 'n2'], nodes, input))).toEqual(['n1', 'n2', 'equal'])
    expect(mergeTimelineEntries(['n1', 'n2'], nodes, input).filter(row => row.kind === 'node').map(row => row.key)).toEqual(['n1', 'n2'])
  })

  it('refines unloaded earlier placement and keeps entry keys across later completion evidence', () => {
    const input = snapshot()
    expect(labels(mergeTimelineEntries(['n2'], nodes, input))).toEqual(['first', 'middle', 'n2', 'last'])
    const initial = mergeTimelineEntries(['n1', 'n2'], nodes, input)
    const later = mergeTimelineEntries(['n1', 'n2', 'n3'], nodes, { ...input, eventTimes: [...input.eventTimes, { seq: 3, time: 500 }] })
    expect(labels(later)).toEqual(['first', 'n1', 'middle', 'n2', 'last', 'n3'])
    expect(later.filter(row => row.kind === 'entry').map(row => row.key)).toEqual(initial.filter(row => row.kind === 'entry').map(row => row.key))
  })

  it('uses unambiguous tuple keys and tolerates a missing Host anchor without inventing a Turn', () => {
    const input: ChatTimelineEntriesSnapshot = { eventTimes: [], entries: [
      { sourceId: 'a:b', id: 'c', createdAt: 10 }, { sourceId: 'a', id: 'b:c', createdAt: 10 },
    ] }
    const flow = mergeTimelineEntries(['n9'], nodes, input)
    expect(new Set(flow.map(row => row.key)).size).toBe(3)
    expect(labels(flow)).toEqual(['c', 'b:c', 'n9'])
  })
})
