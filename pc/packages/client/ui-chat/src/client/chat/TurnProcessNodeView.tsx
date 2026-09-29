import { memo } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import { RunningQianshouCat } from './RunningQianshouCat.tsx'
import css from './TurnProcessNodeView.module.css'

const ACTIVITY_LABELS = {
  'prepare-document': 'message.turnProcess.prepareDocument',
  document: 'message.turnProcess.document',
  'prepare-presentation': 'message.turnProcess.preparePresentation',
  presentation: 'message.turnProcess.presentation',
  'prepare-spreadsheet': 'message.turnProcess.prepareSpreadsheet',
  spreadsheet: 'message.turnProcess.spreadsheet',
} as const

/** Turn-level process disclosure controller. */
export const TurnProcessNodeView = memo(function TurnProcessNodeView({
  node, turnProcess, t, agentMode,
}: ChatNodeViewProps<'turn-process'>) {
  if (turnProcess === undefined) throw new Error('turn-process node requires Turn process owner state')
  if (!turnProcess.foldable) return null
  const open = turnProcess.open
  const labels: string[] = []
  if (node.data.toolCallCount > 0) {
    labels.push(t(
      node.data.toolCallCount === 1
        ? 'message.turnProcess.toolCalls.one'
        : 'message.turnProcess.toolCalls.other',
      { count: node.data.toolCallCount },
    ))
  }
  if (node.data.messageCount > 0) {
    labels.push(t(
      node.data.messageCount === 1
        ? 'message.turnProcess.messages.one'
        : 'message.turnProcess.messages.other',
      { count: node.data.messageCount },
    ))
  }
  if (node.data.subagentCount > 0) {
    labels.push(t(
      node.data.subagentCount === 1
        ? 'message.turnProcess.subagents.one'
        : 'message.turnProcess.subagents.other',
      { count: node.data.subagentCount },
    ))
  }
  const qianshouProcess = process.env.DSH_CLIENT_BUILD_PROFILE === 'qianshou'
  const active = (node.location.kind === 'turn' || node.location.kind === 'step') && node.location.turn.status === 'open'
  const label = qianshouProcess
    ? t(active
      ? turnProcess.activity === undefined ? 'message.turnProcess.processing' : ACTIVITY_LABELS[turnProcess.activity]
      : 'message.turnProcess.details')
    : labels.length === 0
      ? t('message.turnProcess.thoughtForAWhile')
      : labels.join(t('message.turnProcess.separator'))
  return (
    <button
      type="button"
      className={css.root}
      data-open={open || undefined}
      data-turn-process-running={qianshouProcess && active || undefined}
      data-turn-process={node.data.turn}
      data-turn-process-messages={node.data.messageCount}
      data-turn-process-tool-calls={node.data.toolCallCount}
      data-turn-process-subagents={node.data.subagentCount}
      aria-expanded={open}
      onClick={(event) => {
        event.currentTarget.focus()
        turnProcess.setOpen(!open)
      }}
    >
      {qianshouProcess && active && <RunningQianshouCat mode={agentMode ?? 'ceo'} />}
      <span className={css.label}>{label}</span>
      <IconChevronDownOutline14 className={css.chevron} />
    </button>
  )
})
