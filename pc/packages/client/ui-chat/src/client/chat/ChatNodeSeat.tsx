import { memo, useCallback, useMemo } from 'react'
import { JsonBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConversationLocationDataStore, ConversationTurnDataMap } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNodeOwnerProps, ChatViewSlotProps } from '../contract/slots.ts'
import type { ChatNode } from '../contract/chat-nodes.ts'
import { TURN_PROCESS_INDEPENDENT_KINDS } from '../contract/turn-process.ts'
import { storedTurnProcessEntry } from '../stores.ts'
import { useSearchableHidden } from './searchable-hidden.ts'
import css from './ChatView.module.css'
import { qianshouProcessMember } from './qianshou-process.ts'
import { QianshouContextGroup } from './QianshouContextGroup.tsx'

interface ChatNodeSeatProps extends ChatNodeOwnerProps {
  readonly nodeKey: string
  /** First injected-context row owns the group; an empty list marks its following rows. */
  readonly contextKeys?: readonly string[] | undefined
  readonly useChatNode: ChatViewSlotProps['useChatNode']
  readonly useChatNodeProcess: ChatViewSlotProps['useChatNodeProcess']
  readonly historyIncomplete: boolean
  readonly compactTranscript: boolean
  readonly useStore: ChatViewSlotProps['useStore']
  readonly actions: ChatViewSlotProps['actions']
  readonly renderSlot: ChatViewSlotProps['renderSlot']
  readonly t: ChatViewSlotProps['t']
}

type RoutedChatNodeOwner = {
  [Kind in ChatNode['kind']]: ChatNodeOwnerProps & { readonly node: ChatNode<Kind> }
}[ChatNode['kind']]

function turnDataOf(node: ChatNode | undefined): ConversationLocationDataStore<ConversationTurnDataMap> | undefined {
  const location = node?.location
  return location?.kind === 'turn' || location?.kind === 'step' ? location.turn.data : undefined
}

function turnOf(node: ChatNode | undefined): number | undefined {
  const location = node?.location
  return location?.kind === 'turn' || location?.kind === 'step' ? location.turn.turn : undefined
}

/** Subscribe, apply Turn-process visibility, and dispatch one stable Context key. */
export const ChatNodeSeat = memo(function ChatNodeSeat({
  nodeKey, contextKeys, useChatNode, useChatNodeProcess, historyIncomplete, compactTranscript,
  cwd, openFile, openSkill, inspectCall, forkAt,
  loadImage, renderMessageImages, fileMentions, agentMode, useStore, actions, renderSlot, t,
}: ChatNodeSeatProps) {
  const node = useChatNode(nodeKey)
  const routedNode = node as ChatNode | undefined
  const turn = turnOf(routedNode)
  const processPresentation = useChatNodeProcess(nodeKey)
  const processSpec = processPresentation?.spec
  const qianshouProcess = process.env.DSH_CLIENT_BUILD_PROFILE === 'qianshou'
  const answerGeneration = processSpec?.answerStep ?? 0
  const storedEntry = useStore(state => processSpec === undefined
    ? undefined
    : storedTurnProcessEntry(state, processSpec.turn))
  const processEntry = processSpec !== undefined
    && (qianshouProcess || processSpec.answerStep !== null)
    && (storedEntry?.answerStep === answerGeneration
      || (qianshouProcess && storedEntry?.answerStep === 0))
    ? storedEntry
    : undefined
  const processOpen = processEntry !== undefined
  const setOpen = useCallback((open: boolean) => {
    if (processSpec !== undefined && (qianshouProcess || processSpec.answerStep !== null)) {
      actions.setTurnProcessOpen(processSpec.turn, answerGeneration, open)
    }
  }, [actions, answerGeneration, processSpec, qianshouProcess])
  const processWindowReady = processSpec !== undefined
    && processPresentation !== undefined
    && compactTranscript
    && (qianshouProcess || processSpec.answerAnchorSeq !== null)
    && processPresentation.turn === processSpec.turn
    && (qianshouProcess || processPresentation.turnClosed)
    && !historyIncomplete
  const processStartSeq = qianshouProcess && routedNode !== undefined
    && (routedNode.location.kind === 'turn' || routedNode.location.kind === 'step')
    ? routedNode.location.turn.start?.seq ?? processSpec?.processStartSeq
    : processSpec?.processStartSeq
  const processMember = routedNode !== undefined
    && processWindowReady
    && (qianshouProcess ? qianshouProcessMember(routedNode, processPresentation.turnClosed)
      : !TURN_PROCESS_INDEPENDENT_KINDS.has(routedNode.kind))
    && processStartSeq !== undefined && routedNode.anchorSeq >= processStartSeq
    && (processSpec.answerAnchorSeq === null || routedNode.anchorSeq < processSpec.answerAnchorSeq)
  const processAnswer = routedNode !== undefined
    && processWindowReady
    && routedNode.kind === 'assistant-step'
    && routedNode.data.step === processSpec.answerStep
  const ownsDisclosure = routedNode?.kind === 'turn-process' || processAnswer
  const foldable = processWindowReady
    && (qianshouProcess || processMember || (ownsDisclosure
      && (processPresentation.hasExternalProcess || processSpec.inlineReasoning)))
  const turnProcess = useMemo(() => processSpec === undefined
    ? undefined
    : {
      spec: processSpec,
      activity: processPresentation?.activity,
      foldable,
      open: processOpen,
      setOpen,
    }, [
    foldable, processOpen, processSpec, processPresentation?.activity, setOpen,
  ])
  const controllerInactive = routedNode?.kind === 'turn-process'
    && !foldable
  const compactAnswer = processAnswer
    && foldable
    && processPresentation.compactAnswer
    && !processOpen
  const processHidden = controllerInactive || (foldable && processMember && !processOpen)
  const revealProcess = useCallback(() => {
    if (processMember) setOpen(true)
  }, [processMember, setOpen])
  const wrapperRef = useSearchableHidden(processHidden, revealProcess)
  const owner = useMemo<ChatNodeOwnerProps | null>(() => node === undefined
    ? null
    : {
      cwd,
      openFile,
      openSkill,
      inspectCall,
      forkAt,
      loadImage,
      renderMessageImages,
      fileMentions,
      agentMode,
      turnProcess,
    }, [
    node, cwd, openFile, openSkill, inspectCall, forkAt,
    loadImage, renderMessageImages, fileMentions, agentMode, turnProcess,
  ])
  if (routedNode === undefined || owner === null) return null
  if (qianshouProcess && routedNode.kind === 'context' && contextKeys?.length === 0) return null
  if (qianshouProcess && routedNode.kind === 'system-prompt' && !processMember) return null
  const turnData = turnDataOf(routedNode)
  // Runtime dispatch owns the correlation: every Node's discriminant is the
  // keyed-slot entry passed alongside that same Node. TypeScript does not
  // distribute an object containing a union into a union of objects itself.
  const routedOwner = { ...owner, node: routedNode } as RoutedChatNodeOwner
  return (
    <div
      ref={wrapperRef}
      className={css.flowItem}
      data-chat-anchor-key={routedNode.key}
      data-chat-flow-key={routedNode.key}
      data-chat-flow-kind={routedNode.kind}
      data-chat-turn={turn}
      data-turn-process-member={processMember || undefined}
      data-turn-process-hidden={processHidden || undefined}
      data-turn-process-answer={compactAnswer || undefined}
    >
      {qianshouProcess && routedNode.kind === 'context' && contextKeys !== undefined
        ? <QianshouContextGroup contextKeys={contextKeys} useChatNode={useChatNode} t={t} />
        : renderSlot('conversation.chat.node', routedOwner, {
          entryKey: routedNode.kind,
          hookContext: turnData,
          fallback: (
            <JsonBlock
              label={t('message.unknownSurface', { type: routedNode.kind })}
              payload={routedNode.data}
              truncatedLabel={total => t('json.truncated', { total })}
            />
          ),
        })}
    </div>
  )
})
