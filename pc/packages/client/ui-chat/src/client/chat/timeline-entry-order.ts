/** Insert timestamp-based display rows without sorting or changing Host Chat nodes. */
import type { ChatNodeStore } from '../contract/snapshot.ts'
import type { ChatTimelineEntriesSnapshot, ChatTimelineEntryView } from '../contract/timeline-entries.ts'

export type ChatTimelineFlowRow =
  | { readonly kind: 'node'; readonly key: string }
  | { readonly kind: 'entry'; readonly key: string; readonly entry: ChatTimelineEntryView }

/** Display-only wall-clock gaps; missing earlier anchors refine when history loads. */
export function mergeTimelineEntries(
  order: readonly string[], nodes: ChatNodeStore, snapshot: ChatTimelineEntriesSnapshot,
): readonly ChatTimelineFlowRow[] {
  const times = new Map(snapshot.eventTimes.map(event => [event.seq, event.time]))
  const gaps: ChatTimelineEntryView[][] = Array.from({ length: order.length + 1 }, () => [])
  for (const entry of snapshot.entries) {
    let gap = 0
    for (let i = 0; i < order.length; i++) {
      const nodeKey = order[i]
      const node = nodeKey === undefined ? undefined : nodes.get(nodeKey)
      const time = node === undefined ? undefined : times.get(node.anchorSeq)
      if (time !== undefined && time <= entry.createdAt) gap = i + 1
    }
    gaps[gap]?.push(entry)
  }
  const flow: ChatTimelineFlowRow[] = []
  for (let i = 0; i <= order.length; i++) {
    for (const entry of gaps[i] ?? []) {
      flow.push({ kind: 'entry', key: `external:${JSON.stringify([entry.sourceId, entry.id])}`, entry })
    }
    const nodeKey = order[i]
    if (nodeKey !== undefined) flow.push({ kind: 'node', key: nodeKey })
  }
  return flow
}
