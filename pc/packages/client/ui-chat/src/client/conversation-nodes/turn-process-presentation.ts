import type { ChatNode } from '../contract/chat-nodes.ts'
import type {
  ChatLocationNodeIndex, ChatNodeStore, ChatTurnProcessPresentation,
} from '../contract/snapshot.ts'
import { TURN_PROCESS_INDEPENDENT_KINDS } from '../contract/turn-process.ts'
import type { TurnProcessActivity } from '../contract/turn-process.ts'

function nodeTurn(node: ChatNode | undefined): number | undefined {
  const location = node?.location
  return location?.kind === 'turn' || location?.kind === 'step' ? location.turn.turn : undefined
}

function samePresentation(
  left: ChatTurnProcessPresentation | undefined,
  right: ChatTurnProcessPresentation | undefined,
): boolean {
  return left === right || (left !== undefined && right !== undefined
    && left.spec === right.spec
    && left.turn === right.turn
    && left.turnClosed === right.turnClosed
    && left.hasExternalProcess === right.hasExternalProcess
    && left.compactAnswer === right.compactAnswer
    && left.activity === right.activity)
}

type OfficeWork = 'document' | 'presentation' | 'spreadsheet'
const OFFICE_SKILLS: Readonly<Record<string, OfficeWork>> = {
  'office-docx': 'document', 'office-pptx': 'presentation', 'office-xlsx': 'spreadsheet',
}

function recordedOfficeSkill(raw: string | undefined): OfficeWork | undefined {
  if (raw === undefined) return undefined
  let args: unknown
  try { args = JSON.parse(raw) }
  catch (_error) { return undefined } // Streaming or malformed arguments provide no task evidence.
  if (args === null || typeof args !== 'object' || !('name' in args) || typeof args.name !== 'string') return undefined
  return Object.hasOwn(OFFICE_SKILLS, args.name) ? OFFICE_SKILLS[args.name] : undefined
}

function derivePresentation(
  turn: number,
  locations: ChatLocationNodeIndex,
  nodes: ChatNodeStore,
): ChatTurnProcessPresentation | undefined {
  const keys = locations.getTurn(turn)
  const control = keys
    .map(key => nodes.get(key) as ChatNode | undefined)
    .find((node): node is ChatNode<'turn-process'> => node?.kind === 'turn-process')
  if (control === undefined) return undefined

  const spec = control.data
  const location = control.location
  if (location.kind !== 'turn' && location.kind !== 'step') return undefined
  let openingHumanAnchor: number | undefined
  for (const key of keys) {
    const node = nodes.get(key) as ChatNode | undefined
    if ((node?.kind === 'user' || node?.kind === 'steering')
      && node.anchorSeq < spec.controlAnchorSeq) {
      openingHumanAnchor = Math.min(openingHumanAnchor ?? node.anchorSeq, node.anchorSeq)
    }
  }

  let hasExternalProcess = false
  let compactAnswer = true
  let officeWork: OfficeWork | undefined
  let activity: TurnProcessActivity | undefined
  for (const key of keys) {
    const node = nodes.get(key) as ChatNode | undefined
    if (node === undefined || node.kind === 'turn-process') continue
    if (node.kind === 'tool-call') {
      const root = node.data.root
      const call = 'kind' in root ? root.call : root
      const failed = 'kind' in root && (root.isError || root.error !== undefined
        || root.content.some(content => content.type === 'text' && /\[exit code:\s*-?[1-9]\d*\]/.test(content.text)))
      if (call?.name === 'skill') {
        officeWork = failed ? undefined : recordedOfficeSkill(call.argsRaw)
        activity = officeWork === undefined ? undefined : `prepare-${officeWork}`
      } else if (failed) {
        activity = undefined
      } else if (officeWork !== undefined && call !== null
        && ['bash', 'pwsh', 'write', 'edit'].includes(call.name)) {
        activity = officeWork
      }
    }
    if ((node.kind === 'user' || node.kind === 'steering')
      && (openingHumanAnchor === undefined || node.anchorSeq > openingHumanAnchor)
      && (spec.answerAnchorSeq === null || node.anchorSeq < spec.answerAnchorSeq)) {
      compactAnswer = false
    }
    if (TURN_PROCESS_INDEPENDENT_KINDS.has(node.kind)
      || node.anchorSeq < spec.processStartSeq
      || (spec.answerAnchorSeq !== null && node.anchorSeq >= spec.answerAnchorSeq)) continue
    if (node.kind !== 'assistant-step' || spec.answerStep === null || node.data.step !== spec.answerStep) {
      hasExternalProcess = true
    }
  }
  return {
    turn,
    spec,
    turnClosed: location.turn.status === 'closed',
    hasExternalProcess,
    compactAnswer,
    ...(activity === undefined ? {} : { activity }),
  }
}

/** Mutable projection of cross-Node process layout facts by Turn. */
export class ChatTurnProcessProjector {
  private presentations = new Map<number, ChatTurnProcessPresentation>()

  /**
   * Read the retained process presentation for a Node's Turn.
   * @param node - Current Chat Node.
   * @returns The Turn's process presentation, when present.
   */
  get(node: ChatNode | undefined): ChatTurnProcessPresentation | undefined {
    const turn = nodeTurn(node)
    return turn === undefined ? undefined : this.presentations.get(turn)
  }

  /**
   * Replace every projected Turn.
   * @param order - visible Chat Node order.
   * @param locations - current Chat Location index.
   * @param nodes - current Chat Node store.
   * @returns Turns whose process presentation changed.
   */
  replace(
    order: readonly string[],
    locations: ChatLocationNodeIndex,
    nodes: ChatNodeStore,
  ): ReadonlySet<number> {
    const turns = new Set<number>()
    for (const key of order) {
      const turn = nodeTurn(nodes.get(key) as ChatNode | undefined)
      if (turn !== undefined) turns.add(turn)
    }
    const changed = new Set<number>()
    for (const turn of new Set([...this.presentations.keys(), ...turns])) {
      if (this.set(turn, turns.has(turn) ? derivePresentation(turn, locations, nodes) : undefined)) {
        changed.add(turn)
      }
    }
    return changed
  }

  /**
   * Recompute selected Turns after incremental Node changes.
   * @param turns - affected Turn numbers.
   * @param locations - current Chat Location index.
   * @param nodes - current Chat Node store.
   * @returns Turns whose process presentation changed.
   */
  update(
    turns: ReadonlySet<number>,
    locations: ChatLocationNodeIndex,
    nodes: ChatNodeStore,
  ): ReadonlySet<number> {
    const changed = new Set<number>()
    for (const turn of turns) {
      if (this.set(turn, derivePresentation(turn, locations, nodes))) changed.add(turn)
    }
    return changed
  }

  private set(turn: number, next: ChatTurnProcessPresentation | undefined): boolean {
    const current = this.presentations.get(turn)
    if (samePresentation(current, next)) return false
    if (next === undefined) this.presentations.delete(turn)
    else this.presentations.set(turn, next)
    return true
  }
}
