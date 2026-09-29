import { memo, useCallback, useState } from 'react'
import { DisclosureRow, IconContextInjectionOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNode } from '../contract/chat-nodes.ts'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { contextBody } from './ContextBody.tsx'
import { qianshouContextLabel } from './qianshou-context.ts'
import { useSearchableHidden } from './searchable-hidden.ts'
import css from './ContextInjectionRow.module.css'

interface ContextGroupProps {
  readonly contextKeys: readonly string[]
  readonly useChatNode: ChatViewSlotProps['useChatNode']
  readonly t: ChatViewSlotProps['t']
}

const ContextGroupEntry = memo(function ContextGroupEntry({ nodeKey, useChatNode, t }: {
  readonly nodeKey: string
  readonly useChatNode: ChatViewSlotProps['useChatNode']
  readonly t: ChatViewSlotProps['t']
}) {
  const node = useChatNode(nodeKey) as ChatNode | undefined
  if (node?.kind !== 'context') return null
  const { data } = node
  const { rendered, body } = contextBody(data.form, { content: data.content, source: data.source, t })
  return (
    <section className={css.groupEntry} data-context-group-entry={nodeKey}>
      <div className={css.groupLabel}>{qianshouContextLabel(data, t)}</div>
      <div className={css.groupContent} data-context-injection-body data-context-form={rendered ?? undefined}>
        {body}
      </div>
    </section>
  )
})

/** One quiet, searchable disclosure even before the Turn-process controller exists. */
export function QianshouContextGroup({ contextKeys, useChatNode, t }: ContextGroupProps) {
  const [open, setOpen] = useState(false)
  const reveal = useCallback(() => { setOpen(true) }, [])
  const bodyRef = useSearchableHidden(!open, reveal)
  return (
    <div className={css.group} data-qianshou-context-group>
      <DisclosureRow
        icon={<IconContextInjectionOutline16 size={14} />}
        title={t('message.contextGroup.title')}
        collapsedContent={<span className={css.groupCount} aria-hidden>
          {t('message.contextGroup.count', { count: contextKeys.length })}
        </span>}
        keepContentWhenOpen
        chevronClassName={css.chevron}
        open={open}
        expandable
        expandOnRowClick
        onToggle={() => { setOpen(value => !value) }}
      />
      <div ref={bodyRef} className={css.groupBody} data-context-group-body>
        {contextKeys.map(nodeKey => <ContextGroupEntry key={nodeKey} nodeKey={nodeKey} useChatNode={useChatNode} t={t} />)}
      </div>
    </div>
  )
}
