/**
 * 会话头部保留节点快捷入口，与左侧固定“接单”入口打开同一个主区面板。
 * 提醒在**这里也看得见**——主人不打开面板时也能被通知到，
 * 但仍然只出现一次（同一条提醒不会因为轮询而重放）。
 */
import type { NodeAlertKind, NodeStatusController } from './controller.ts'
import { useNodeState } from './use-node-state.ts'
import type { NodeCopyKey } from './locales.ts'
import type { NodeTranslate } from './NodeStatusPanel.tsx'
import css from './node-status.module.css'

/** 入口 props。 */
export interface NodeStatusEntryProps {
  /** 状态控制器（与面板同一个实例）。 */
  readonly controller: NodeStatusController
  /** 文案。 */
  readonly t: NodeTranslate
  /** 打开主区接单面板。 */
  readonly open: () => void
}

const ALERT_COPY: Record<NodeAlertKind, NodeCopyKey> = {
  offer: 'alertOffer', started: 'alertStarted', finished: 'alertFinished',
  'finished-unverified': 'alertFinishedUnverified', failed: 'alertFailed', refused: 'alertRefused', canceled: 'alertCanceled',
}

/**
 * 头部入口按钮 + 一次性提醒条。
 * @param props - 控制器、文案与打开动作。
 * @returns 入口。
 */
export function NodeStatusEntry({ controller, t, open }: NodeStatusEntryProps) {
  const state = useNodeState(controller)
  // The fixed left-hand intake route owns the everyday status. Reserve scarce
  // conversation-header space for a real new alert that needs attention.
  if (state.alert === null) return null
  return (
    <span className={css.entry}>
      <button type="button" className={css.entryButton} onClick={open} title={t('entryHint')}>
        <span className={css.entryDot} data-node-phase={state.phase} aria-hidden="true" />
        {t('title')}
      </button>
      {state.alert === null
        ? null
        : (
          <span className={css.entryAlert} data-node-alert={state.alert.kind} role="status">
            <span className={css.alertBadge}>{t(ALERT_COPY[state.alert.kind])}</span>
            {state.alert.shardId === null ? null : <code className={css.mono}>{state.alert.shardId}</code>}
            <button type="button" className={css.dismissButton} onClick={() => { controller.dismissAlerts() }}>{t('dismissAlert')}</button>
          </span>
        )}
    </span>
  )
}
