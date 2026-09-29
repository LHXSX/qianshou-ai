/**
 * 档位页：三档商品横向对比 + 当前档位标记。
 *
 * 三件事让它有用而不是广告：
 * 1. **每元买到多少 SP 是可算的**，直接算出来显示——高价档更划算这件事
 *    应该是用户自己看出来的结论，不是我写上去的标语；
 * 2. **标出用户当前所在档**，并**只**在更低的档位上写"降档信息"，
 *    不暗示"你该升级"；
 * 3. 服务端报了一个本表没有的档位 id 时，**照原样显示**一条额外说明，
 *    不把用户硬塞进三档模型里。
 */

import { TIER_OFFERS, offerOf, spPerYuan, type TierOffer } from '../tiers.ts'
import type { AccountView } from '../store.ts'
import type { TranslateAccount } from '../locales.ts'
import css from './tabs.module.css'

/** 档位页。 */
export function PlanTab({ state, t }: {
  readonly state: AccountView
  readonly t: TranslateAccount
}) {
  const current = state.gateway?.tier.id ?? null
  const label = state.gateway?.tier.label ?? null
  const known = current === null ? null : offerOf(current)
  const order = TIER_OFFERS.map(offer => offer.id)
  const currentIndex = current === null ? -1 : order.indexOf(current as TierOffer['id'])

  return (
    <>
      {current !== null && known === null ? (
        <section className={css.notice} data-kind="anonymous">
          {/* 服务端说了一个我们商品表里没有的档位：照原样显示。 */}
          <h2>{t('field.tier')}</h2>
          <p>{label ?? current}</p>
        </section>
      ) : null}

      <div className={css.tierGrid}>
        {TIER_OFFERS.map((offer, index) => {
          const active = current === offer.id
          const perYuan = spPerYuan(offer)
          return (
            <section
              key={offer.id}
              className={css.tierCard}
              data-active={active ? '1' : '0'}
              data-above={currentIndex >= 0 && index > currentIndex ? '1' : '0'}
              aria-current={active ? 'true' : undefined}
            >
              <header className={css.tierHead}>
                <span className={css.tierName}>{t(`tier.${offer.id}` as 'tier.basic')}</span>
                {active ? <span className={css.tierBadge}>{t('plan.current')}</span> : null}
              </header>
              <div className={css.tierPrice}>
                <span className={css.tierYuan}>{offer.monthlyYuan}</span>
                <span className={css.tierPer}>{t('plan.perMonth')}</span>
              </div>
              <dl className={css.tierFacts}>
                <div>
                  <dt>{t('plan.sp')}</dt>
                  <dd>{offer.monthlySp.toLocaleString('zh-CN')}</dd>
                </div>
                <div>
                  <dt>{t('plan.perYuan')}</dt>
                  {/* 三档都是 10 SP/元（测试钉住了），所以这里**不能**暗示"越高档越划算"。
                      写在同一栏里让用户自己看到它们相等，比我写一句"更划算"诚实。 */}
                  <dd>{perYuan === null ? '—' : `${perYuan} SP`}</dd>
                </div>
                <div>
                  <dt>{t('plan.power')}</dt>
                  <dd>{offer.id === 'basic' ? t('plan.power.no') : t('plan.power.yes')}</dd>
                </div>
                <div>
                  <dt>{t('field.context')}</dt>
                  <dd>{t('field.context.value', { tokens: offer.contextLimitTokens.toLocaleString('zh-CN') })}</dd>
                </div>
                <div>
                  <dt>{t('field.concurrency')}</dt>
                  <dd>{String(offer.concurrency)}</dd>
                </div>
              </dl>
            </section>
          )
        })}
      </div>

      <section className={css.card}>
        <h2 className={css.cardTitle}>{t('plan.same')}</h2>
        <p className={css.hint}>{t('plan.same.body')}</p>
      </section>

      <section className={css.card}>
        <h2 className={css.cardTitle}>{t('plan.how.title')}</h2>
        <p className={css.hint}>{t('plan.how.body')}</p>
      </section>
    </>
  )
}
