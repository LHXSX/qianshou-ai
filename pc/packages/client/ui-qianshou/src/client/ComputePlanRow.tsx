/** Conversation-native, owner-operated distributed task consent and quote card. */
import { useEffect, useState } from 'react'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { GENERIC_COMPUTE_ERROR, type ComputePlanTransport, type ComputePlanView, type ComputeQuoteView } from './compute-plan-transport.ts'
import css from './ComputePlanRow.module.css'

type Props = Pick<ToolCallViewProps, 'block'> & PropsLocale<'qianshou.brand'> & { transport: ComputePlanTransport }
const PLAN_ID = /^plan_[0-9a-f-]{36}$/u

/** Only a settled Host tool result carrying the known protocol can open owner actions. */
export function planIdFromToolResult(block: Props['block']): string | null {
  if (!('kind' in block) || block.kind !== 'tool-result' || block.isError) return null
  const meta = block.meta
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return null
  const value = meta as Record<string, unknown>
  return value.protocol === 'qianshou.task-card.v1'
    && typeof value.cardId === 'string' && PLAN_ID.test(value.cardId) ? value.cardId : null
}

function failure(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  return /^[A-Z][A-Z0-9_]{2,100}$/u.test(message) ? message : GENERIC_COMPUTE_ERROR
}

function yuan(minor: number): string {
  return `${Math.trunc(minor / 100)}.${String(minor % 100).padStart(2, '0')}`
}

export function ComputePlanRow({ block, transport, t }: Props) {
  const id = planIdFromToolResult(block)
  const [plan, setPlan] = useState<ComputePlanView | null>(null)
  const [quote, setQuote] = useState<ComputeQuoteView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [unknown, setUnknown] = useState(false)
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))

  useEffect(() => {
    setPlan(null)
    setQuote(null)
    setError(null)
    setUnknown(false)
    if (id === null) return
    const controller = new AbortController()
    void transport.read(id, controller.signal).then(next => {
      if (!controller.signal.aborted) setPlan(next)
    }).catch(reason => {
      if (!controller.signal.aborted) setError(failure(reason))
    })
    return () => { controller.abort() }
  }, [id, transport])

  useEffect(() => {
    if (quote === null) return
    const timer = setInterval(() => { setNow(Math.floor(Date.now() / 1000)) }, 1_000)
    return () => { clearInterval(timer) }
  }, [quote])

  const refresh = async () => {
    if (id === null || busy) return
    setBusy(true); setError(null)
    try {
      const next = await transport.read(id)
      setPlan(next)
      if (next.workloadId !== null) { setUnknown(false); setQuote(null) }
    } catch (reason) { setError(failure(reason)) }
    finally { setBusy(false) }
  }
  const decide = async (decision: 'approved' | 'declined') => {
    if (id === null || plan === null || plan.workloadId !== null || busy) return
    setBusy(true); setError(null)
    try {
      const next = await transport.decide(id, decision)
      setPlan(next)
      setQuote(null)
    } catch (reason) { setError(failure(reason)) }
    finally { setBusy(false) }
  }
  const getQuote = async () => {
    if (id === null || plan?.authorization !== 'approved' || plan.workloadId !== null || busy || unknown) return
    setBusy(true); setError(null); setQuote(null)
    try {
      const next = await transport.quote(id)
      // The exact input sent to Shanghai must be the same text the owner reviewed.
      if (next.goal !== plan.request.goal) throw new Error('COMPUTE_QUOTE_PLAN_CHANGED')
      setQuote(next)
      setNow(Math.floor(Date.now() / 1000))
    } catch (reason) { setError(failure(reason)) }
    finally { setBusy(false) }
  }
  const submit = async () => {
    if (id === null || quote === null || plan?.authorization !== 'approved' || plan.workloadId !== null
      || busy || unknown || !quote.balanceEnough || quote.expiresAt <= Math.floor(Date.now() / 1000)) return
    setBusy(true); setError(null)
    try {
      const next = await transport.submit(id, quote)
      setPlan(next)
      setQuote(null)
    } catch (reason) {
      const code = failure(reason)
      if (code === 'COMPUTE_QUOTE_EXPIRED' || code === 'COMPUTE_QUOTE_BALANCE_INSUFFICIENT') {
        setQuote(null); setError(code)
      } else {
        // A lost POST response might still have created a task. Never present a retry.
        setUnknown(true); setError(code)
      }
    } finally { setBusy(false) }
  }

  const expired = quote !== null && quote.expiresAt <= now
  const submitted = plan?.workloadId !== null && plan?.workloadId !== undefined
  return <section className={css.card} data-tool="compute_plan_draft" data-stage={
    submitted ? 'submitted' : unknown ? 'unknown' : quote !== null ? 'quoted'
      : plan?.authorization ?? (id === null ? 'invalid' : 'loading')
  }>
    <div className={css.header}>
      <span className={css.mark} aria-hidden="true">✳</span>
      <div><strong>{t('computePlanTitle')}</strong><small>{
        submitted ? t('computePlanSubmitted') : unknown ? t('computePlanStatusUnknown')
          : quote !== null ? t('computePlanQuote') : plan?.authorization === 'approved' ? t('computePlanApproved')
            : plan?.authorization === 'declined' ? t('computePlanStatusDeclined') : t('computePlanDraft')
      }</small></div>
    </div>
    {id === null ? <p className={css.notice}>{t('computePlanUnavailable')}</p> : null}
    {id !== null && plan === null ? <p className={css.notice}>{error === null ? t('computePlanLoading') : t('computePlanUnavailable')}</p> : null}
    {plan !== null ? <>
      <dl className={css.facts}>
        <div><dt>{t('computePlanCapability')}</dt><dd>{plan.request.capabilityId}</dd></div>
        <div><dt>{t('computePlanBudget')}</dt><dd>¥{yuan(plan.request.budgetMinor)}</dd></div>
        <div><dt>{t('computePlanNodes')}</dt><dd>{plan.request.maxNodes ?? t('computePlanAutoNodes')}</dd></div>
      </dl>
      {quote === null && !submitted ? <div className={css.input}>
        <span>{t('computePlanGoal')}</span><pre>{plan.request.goal}</pre>
      </div> : null}
      {plan.authorization === 'pending' && !unknown && !submitted ? <>
        <p className={css.notice}>{t('computePlanDraftHint')}</p>
        <div className={css.actions}>
          <button type="button" disabled={busy} onClick={() => { void decide('approved') }}>{t('computePlanApprove')}</button>
          <button type="button" className={css.quiet} disabled={busy} onClick={() => { void decide('declined') }}>{t('computePlanCancel')}</button>
        </div>
      </> : null}
      {plan.authorization === 'approved' && quote === null && !unknown && !submitted ? <>
        <p className={css.notice}>{t('computePlanApproved')}</p>
        <div className={css.actions}>
          <button type="button" disabled={busy} onClick={() => { void getQuote() }}>{t('computePlanGetQuote')}</button>
          <button type="button" className={css.quiet} disabled={busy} onClick={() => { void decide('declined') }}>{t('computePlanCancel')}</button>
        </div>
      </> : null}
      {plan.authorization === 'declined' && !submitted ? <p className={css.notice}>{t('computePlanDeclined')}</p> : null}
      {quote !== null && !unknown && !submitted ? <div className={css.quote}>
        <strong>{t('computePlanQuote')}</strong>
        <div className={css.price}><span>{t('computePlanPrice')}</span><b>¥{quote.recommendedBudget}</b></div>
        <p className={css.notice}>{t('computePlanSettlement')}</p>
        <dl className={css.quoteFacts}>
          <div><dt>{t('computePlanRequested')}</dt><dd>¥{quote.requestedBudget}</dd></div>
          <div><dt>{t('computePlanTaskType')}</dt><dd>{quote.taskType}</dd></div>
          <div><dt>{t('computePlanPriceBasis')}</dt><dd>{quote.priceBasis}</dd></div>
          <div><dt>{t('computePlanExpiry')}</dt><dd>{new Date(quote.expiresAt * 1_000).toLocaleString()}</dd></div>
        </dl>
        <p className={css.notice}>{t('computePlanExecution', { seconds: quote.timeoutSeconds, nodes: quote.maxShards })}</p>
        <div className={css.input}>
          <span>{t('computePlanInput')}</span><p>{t('computePlanInputScope')}</p><pre>{quote.goal}</pre>
        </div>
        {expired ? <p role="status" className={css.warning}>{t('computePlanQuoteExpired')}</p> : null}
        {!quote.balanceEnough ? <p role="status" className={css.warning}>{t('computePlanBalanceShort')}</p> : null}
        <div className={css.actions}>
          {expired || !quote.balanceEnough ? <button type="button" disabled={busy} onClick={() => { void getQuote() }}>{t('computePlanRequote')}</button>
            : <button type="button" disabled={busy || !quote.balanceEnough} onClick={() => { void submit() }}>
              {busy ? t('computePlanSubmitting') : t('computePlanSubmit', { amount: quote.recommendedBudget })}
            </button>}
          <button type="button" className={css.quiet} disabled={busy} onClick={() => { void decide('declined') }}>{t('computePlanCancel')}</button>
        </div>
      </div> : null}
      {submitted ? <p role="status" className={css.success}>{t('computePlanSubmitted')} <code>{plan.workloadId}</code></p> : null}
      {unknown ? <div role="alert" className={css.warning}>
        <p>{t('computePlanUnknown')}</p>
        <button type="button" className={css.quiet} disabled={busy} onClick={() => { void refresh() }}>{t('computePlanRefresh')}</button>
      </div> : null}
    </> : null}
    {error !== null ? <p role="alert" className={css.error}>{
      error === 'COMPUTE_QUOTE_EXPIRED' ? t('computePlanQuoteExpired')
        : error === 'COMPUTE_QUOTE_BALANCE_INSUFFICIENT' ? t('computePlanNoBalance')
          : t('computePlanError')
    } <code>{error}</code></p> : null}
    {id !== null && plan === null && error !== null ? <button type="button" className={css.quiet} disabled={busy}
      onClick={() => { void refresh() }}>{t('computePlanRefresh')}</button> : null}
  </section>
}
