/** Presentation-only grouping; durable context and provider requests stay untouched. */
import type { ChatNode } from '../contract/chat-nodes.ts'
import type { ChatNodeStore, ContextMessageNode } from '../contract/snapshot.ts'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { ChatTimelineFlowRow } from './timeline-entry-order.ts'

/** Collect injected information once per loaded Turn; unresolved rows require adjacency. */
export function qianshouContextGroups(
  flow: readonly ChatTimelineFlowRow[], nodes: ChatNodeStore,
): ReadonlyMap<string, readonly string[]> {
  const groups = new Map<string, string[]>()
  const turns = new Map<number, string[]>()
  let adjacent: string[] | undefined
  for (const row of flow) {
    const node = row.kind === 'node' ? nodes.get(row.key) as ChatNode | undefined : undefined
    if (node?.kind !== 'context' || node.data.producer.role === 'recall') {
      adjacent = undefined
      continue
    }
    const location = node.location
    const turn = location.kind === 'turn' || location.kind === 'step' ? location.turn.turn : undefined
    let keys = turn === undefined ? adjacent : turns.get(turn)
    if (keys === undefined) {
      keys = []
      if (turn !== undefined) turns.set(turn, keys)
      groups.set(node.key, keys)
    } else {
      groups.set(node.key, [])
    }
    keys.push(node.key)
    adjacent = turn === undefined ? keys : undefined
  }
  return groups
}

/** Name the information from its recorded producer or declared form, without inventing activity. */
export function qianshouContextLabel(data: ContextMessageNode, t: ChatViewSlotProps['t']): string {
  const label = data.producer.label ?? ''
  if (label === 'time-context') return t('message.contextGroup.time')
  if (label === 'skill-catalog') return t('message.contextGroup.skills')
  if (data.form === 'instructions' || /(?:system-prompt|agent-instructions)$/.test(label)) {
    return t('message.contextGroup.rules')
  }
  if (data.form === 'catalog') return t('message.contextGroup.catalog')
  if (data.form === 'snapshot') return t('message.contextGroup.snapshot')
  if (data.form === 'notice') return t('message.contextGroup.notice')
  if (data.form === 'relay') return t('message.contextGroup.relay')
  return /[\u3400-\u9fff]/.test(label) ? label : t('message.contextGroup.other')
}
