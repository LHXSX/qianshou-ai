/**
 * 总览：一句话回答「我现在什么状态」。
 *
 * 版面顺序是刻意的：**身份 → 额度 → 出口**。
 * 身份在最上是因为后面所有数字都依附于"这是谁的账"；额度居中因为它是最常看的；
 * 出口放最后且只有两个（换档位 / 看用量），因为这一页不是操作页。
 */

import { remainingRatio, yuanOfSp } from '../status.ts'
import type { AccountView } from '../store.ts'
import type { TranslateAccount } from '../locales.ts'
import css from './tabs.module.css'

/** 总览页。 */
export function OverviewTab({ state, onRefresh, onGoPlan, onGoCredit, t }: {
  readonly state: AccountView
  readonly onRefresh: () => void
  readonly onGoPlan: () => void
  readonly onGoCredit: () => void
  readonly t: TranslateAccount
}) {
  const { account, gateway, accountPhase, gatewayPhase, gatewayMessage } = state
  const accountDown = accountPhase === 'unavailable'
  const anonymous = accountPhase === 'anonymous'
  const ratio = gateway === null ? null : remainingRatio(gateway.credit)
  const low = ratio !== null && ratio <= 0.15

  return (
    <>
      {anonymous ? (
        <section className={css.notice} data-kind="anonymous">
          <h2>{t('empty.title')}</h2>
          <p>{t('empty.body')}</p>
        </section>
      ) : null}

      {accountDown ? (
        <section className={css.notice} data-kind="unavailable">
          <h2>{t('unavailable.title')}</h2>
          <p>{t('unavailable.body')}</p>
          <button type="button" className={css.primary} onClick={onRefresh}>{t('unavailable.retry')}</button>
        </section>
      ) : null}

      {account === null ? null : (
        <section className={css.card}>
          <h2 className={css.cardTitle}>{t('page.section.account')}</h2>
          <div className={css.identity}>
            <span className={css.bigAvatar} aria-hidden="true">
              {(account.username.trim() || account.email.trim() || '·').slice(0, 1).toUpperCase()}
            </span>
            <div className={css.identityText}>
              <strong>{account.username.trim() || `#${account.id}`}</strong>
              <span>{account.email.trim() || `#${account.id}`}</span>
            </div>
            <span className={css.rolePill}>{roleLabel(account.role, t)}</span>
          </div>
        </section>
      )}

      {gatewayPhase === 'unavailable' && !accountDown ? (
        <section className={css.notice} data-kind="unavailable">
          <h2>{t('unavailable.title')}</h2>
          <p>{t('card.unavailable.hint')}</p>
          <button type="button" className={css.primary} onClick={onRefresh}>{t('unavailable.retry')}</button>
        </section>
      ) : null}

      {gatewayPhase === 'anonymous' && gatewayMessage !== null ? (
        <section className={css.notice} data-kind="rejected">
          <h2>{t('unavailable.title')}</h2>
          {/* 服务端原话照抄——它才是可行动信息。 */}
          <p>{gatewayMessage}</p>
        </section>
      ) : null}

      {gateway === null ? null : (
        <section className={css.card} data-tone={low ? 'low' : 'ok'}>
          <h2 className={css.cardTitle}>{t('card.balance')}</h2>
          <div className={css.balanceRow}>
            <span className={css.balanceSp}>{gateway.credit.remainingSp.toFixed(2)}</span>
            <span className={css.balanceUnit}>SP</span>
            <span className={css.balanceYuan}>{t('card.balance.yuan', { yuan: yuanOfSp(gateway.credit.remainingSp) })}</span>
          </div>
          <div className={css.meter} data-known={ratio === null ? '0' : '1'}>
            <span className={css.meterFill} style={{ width: `${Math.round((ratio ?? 0) * 100)}%` }} data-low={low ? '1' : '0'} />
          </div>
          <dl className={css.miniRows}>
            <div>
              <dt>{t('field.tier')}</dt>
              <dd>{gateway.tier.label.length > 0 ? gateway.tier.label : gateway.tier.id}</dd>
            </div>
            {gateway.credit.monthlySp === null ? null : (
              <div>
                <dt>{t('usage.remaining')}</dt>
                <dd>{t('card.balance.value', { sp: gateway.credit.remainingSp.toFixed(2) })} / {gateway.credit.monthlySp.toFixed(2)} SP</dd>
              </div>
            )}
            {gateway.limits.concurrency === null ? null : (
              <div><dt>{t('field.concurrency')}</dt><dd>{String(gateway.limits.concurrency)}</dd></div>
            )}
          </dl>
        </section>
      )}

      <div className={css.actions}>
        <button type="button" className={css.primary} onClick={onGoPlan}>{t('plan.upgrade')}</button>
        <button type="button" className={css.ghost} onClick={onGoCredit}>{t('tab.credit')}</button>
      </div>
    </>
  )
}

/** 账号类型显示名；未知角色**照原样显示**，不猜它对应什么权限。 */
function roleLabel(role: string, t: TranslateAccount): string {
  if (role === 'personal') return t('field.role.personal')
  if (role === 'admin') return t('field.role.admin')
  if (role === 'enterprise') return t('field.role.enterprise')
  return role
}
