/**
 * 充值页：把**真实的计价模型**讲清楚，并给出**真实的升级路径**。
 *
 * ## 为什么不放付款按钮
 *
 * 后端没有支付。`packages/host/model-gateway/src/subscription-routes.ts` 明说：
 * 支付回调、订单号、退款由部署方接自己的系统，然后调管理路由把权益给上；
 * 网关只负责"钱已经收过了，把权益给上"。上游账号 API 也只有 auth 与 profile。
 *
 * 所以这一页的价值在于**回答三个真问题**，而不是放一个假按钮：
 * 1. 我的额度是怎么算出来的？（按 token，SP 锚 0.01 元）
 * 2. 为什么 39 元给 390 SP，390 SP 却只"值"3.90 元？（计价口径不同，必须讲明）
 * 3. 我要更多额度，具体走哪一步？（真实路径）
 *
 * 一条硬规则：**绝不在这里写任何"立即支付/扫码付款"这类控件**，
 * 除非后端真的接了支付。画一个按不动的付款按钮比留白危险得多——
 * 用户会以为钱付了。
 */

import { AI_STATUS_PATH } from '../endpoints.ts'
import { yuanOfSp } from '../status.ts'
import { TIER_OFFERS } from '../tiers.ts'
import type { AccountView } from '../store.ts'
import type { TranslateAccount } from '../locales.ts'
import css from './tabs.module.css'

/** 充值页。 */
export function CreditTab({ state, t }: {
  readonly state: AccountView
  readonly t: TranslateAccount
}) {
  const credit = state.gateway?.credit ?? null
  const tierId = state.gateway?.tier.id ?? null
  const offer = TIER_OFFERS.find(item => item.id === tierId) ?? null

  return (
    <>
      {/* 1) 余额与折算——把"数字怎么来的"摆在同一屏。 */}
      <section className={css.card}>
        <h2 className={css.cardTitle}>{t('credit.balance.title')}</h2>
        {credit === null ? (
          <p className={css.hint}>{t('credit.noData')}</p>
        ) : (
          <dl className={css.rows}>
            <div>
              <dt>{t('usage.remaining')}</dt>
              <dd><strong>{credit.remainingSp.toFixed(2)}</strong> SP</dd>
            </div>
            <div>
              <dt>{t('credit.sameAs')}</dt>
              <dd>{t('card.balance.yuan', { yuan: yuanOfSp(credit.remainingSp) })}</dd>
            </div>
            {credit.monthlySp === null ? null : (
              <div>
                <dt>{t('credit.granted')}</dt>
                <dd>{credit.monthlySp.toFixed(2)} SP{offer === null ? '' : `（${offer.monthlyYuan} 元档）`}</dd>
              </div>
            )}
            {credit.usedInWindowSp === null || credit.windowLimitSp === null ? null : (
              <div>
                <dt>{t('field.window')}</dt>
                <dd>{t('field.window.value', { used: credit.usedInWindowSp.toFixed(2), limit: credit.windowLimitSp.toFixed(2) })}</dd>
              </div>
            )}
          </dl>
        )}
      </section>

      {/* 2) 计价口径——这一条不写清就会被读成算错账。 */}
      <section className={css.card} data-tone="note">
        <h2 className={css.cardTitle}>{t('credit.why.title')}</h2>
        <p className={css.hint}>{t('credit.why.body')}</p>
        <p className={css.hint}>{t('plan.hint')}</p>
      </section>

      {/* 3) 真实升级路径。这里是文字，不是控件——因为后端没有支付。 */}
      <section className={css.card}>
        <h2 className={css.cardTitle}>{t('credit.how.title')}</h2>
        <ol className={css.steps}>
          <li>{t('credit.how.1')}</li>
          <li>{t('credit.how.2')}</li>
          <li>{t('credit.how.3')}</li>
        </ol>
        <p className={css.hint}>{t('credit.how.note')}</p>
      </section>

      {/* 4) 谁在记账——可核对性是订阅制能被信任的前提。 */}
      <section className={css.card}>
        <h2 className={css.cardTitle}>{t('credit.where.title')}</h2>
        <p className={css.hint}>
          {t('credit.where.body')}
          {' '}
          <code className={css.code}>{AI_STATUS_PATH}</code>
        </p>
        <p className={css.hint}>{t('credit.where.audit')}</p>
      </section>
    </>
  )
}
