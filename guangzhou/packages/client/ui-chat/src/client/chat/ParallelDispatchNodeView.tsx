import type { SessionParallelValue } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import { MessageIconActions } from './MessageIconActions.tsx'
import { UserStyleBubble } from './MessageItem.tsx'
import css from './ParallelDispatchNodeView.module.css'

/** Navigation runs only after the user selects an accepted child's record. */
export interface ParallelDispatchInjected {
  openChild: (address: Pick<SessionParallelValue, 'parentSessionId' | 'childSessionId' | 'mode'>) => void
}

/**
 * Show a durable independent-task submission without impersonating a CEO reply.
 * @param props - Accepted receipt, attachment presentation and explicit child navigation.
 * @returns the original message when recorded, followed by its dispatch receipt.
 */
export function ParallelDispatchNodeView({
  node, renderMessageImages, openFile, openSkill, openChild, t,
}: ChatNodeViewProps<'parallel-dispatch'> & ParallelDispatchInjected) {
  const { receipt, time } = node.data
  const { message } = receipt
  return <section className={css.root} data-parallel-dispatch={receipt.requestId}>
    {message !== undefined && <UserStyleBubble content={message.content}
      renderMessageImages={renderMessageImages} references={{ openFile, openSkill }} t={t}
      actions={text => <MessageIconActions text={text} time={time} clock="start" t={t} />} />}
    <div className={css.receipt}>
      <span className={css.mark} aria-hidden="true">↗</span>
      <div className={css.copy}>
        <span className={css.title}>{t('parallel.dispatched')}</span>
        {message === undefined && <p className={css.legacy}>
          <span>{t('parallel.legacySummary')}</span>{receipt.label}
        </p>}
      </div>
      <button className={css.open} type="button" onClick={() => {
        openChild({ parentSessionId: receipt.parentSessionId, childSessionId: receipt.childSessionId, mode: receipt.mode })
      }}>{t('parallel.openRecord')}</button>
    </div>
  </section>
}
