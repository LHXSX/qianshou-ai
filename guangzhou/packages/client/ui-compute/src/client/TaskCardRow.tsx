/** Conversation row for a local compute plan draft; Confirm stays local, Publish posts the developer-task route. */
import { useEffect } from 'react'
import { ComputeCapabilityId, ComputePlanId } from '@deepseek-ai/dsh-compute-core/protocol'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { ComputeFace } from './ComputePage.tsx'
import { projectComputeTaskCard } from './status-card.ts'
import css from './TaskCardRow.module.css'

type TaskCardRowProps = ToolCallViewProps & PropsLocale<'qianshou.compute'> & InjectFace<ComputeFace>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Read replayable draft observations from persisted tool-result metadata. */
function parseDraftMeta(value: unknown): {
  cardId: string
  title: string
  capabilityId: string
  budgetMinor: number
  createdAt: string
} | null {
  if (!isRecord(value) || value.protocol !== 'qianshou.task-card.v1' || !text(value.cardId) || !text(value.title)
    || !text(value.capabilityId) || !text(value.createdAt) || !Number.isSafeInteger(value.budgetMinor)
    || (value.budgetMinor as number) < 0) return null
  return {
    cardId: value.cardId, title: value.title, capabilityId: value.capabilityId,
    budgetMinor: value.budgetMinor as number, createdAt: value.createdAt,
  }
}

function yuan(minor: number): string {
  return (minor / 100).toFixed(2)
}

/** Project a CEO plan-draft tool result into the conversation task card. */
export function TaskCardRow(props: TaskCardRowProps) {
  const { block, t } = props
  const state = props.useCompute(snapshot => snapshot)
  useEffect(() => { void props.ensureLoaded() }, [props.ensureLoaded])
  if (!('kind' in block) || block.kind !== 'tool-result') {
    return <article className={css.card}><p className={css.hint}>{t('cardPending')}</p></article>
  }
  if (block.isError) {
    return <article className={css.card}><p className={css.hint}>{t('cardUnavailable')}</p></article>
  }
  const meta = parseDraftMeta(block.meta)
  if (meta === null) {
    return <article className={css.card}><p className={css.hint}>{t('cardUnavailable')}</p></article>
  }
  const draft = state.drafts.find(item => item.id === meta.cardId)
  const authorization = draft?.authorization ?? 'pending'
  const workloadId = draft?.workloadId ?? null
  const card = projectComputeTaskCard({
    cardId: meta.cardId,
    title: meta.title,
    capability: {
      id: ComputeCapabilityId(meta.capabilityId),
      name: meta.capabilityId,
      description: meta.title,
      delivery: 'remote',
      available: true,
    },
    authorization: authorization === 'pending' ? 'required' : authorization,
    submission: workloadId ? 'submitted' : authorization === 'approved' ? 'ready' : undefined,
    updatedAt: meta.createdAt,
  })
  const eyebrow = workloadId ? 'cardPublished' : authorization === 'approved' ? 'cardApproved' : authorization === 'declined' ? 'cardDeclined' : 'cardAwaiting'
  const hint = workloadId ? 'cardPublishedHint' : authorization === 'approved' ? 'cardPublishHint' : authorization === 'pending' ? 'cardDraftHint' : 'cardConfirmHint'
  const busy = state.loading || state.saving
  return (
    <article className={css.card} data-compute-card-id={card.cardId} data-compute-card-phase={card.phase}
      data-compute-card-authorization={authorization} data-compute-card-workload={workloadId ?? ''}>
      <p className={css.eyebrow}>{t(eyebrow)}</p>
      <h2 className={css.title}>{card.title}</h2>
      <dl className={css.meta}>
        <div><dt>{t('cardCapability')}</dt><dd>{card.capability.name}</dd></div>
        <div><dt>{t('cardBudget')}</dt><dd>{t('amount', { amount: yuan(meta.budgetMinor) })}</dd></div>
        {workloadId !== null && <div><dt>{t('cardWorkload')}</dt><dd>{workloadId}</dd></div>}
      </dl>
      <p className={css.hint}>{t(hint)}</p>
      {authorization === 'pending' && <div className={css.actions}>
        <Button variant="primary" size="sm" disabled={busy}
          onClick={() => { void props.confirmDraft(ComputePlanId(meta.cardId), 'approved') }}>{t('cardConfirm')}</Button>
        <Button variant="ghost" size="sm" disabled={busy}
          onClick={() => { void props.confirmDraft(ComputePlanId(meta.cardId), 'declined') }}>{t('cardDecline')}</Button>
      </div>}
      {authorization === 'approved' && workloadId === null && <div className={css.actions}>
        <Button variant="primary" size="sm" disabled={busy}
          onClick={() => { void props.publishDraft(ComputePlanId(meta.cardId)) }}>{t('cardPublish')}</Button>
      </div>}
    </article>
  )
}
