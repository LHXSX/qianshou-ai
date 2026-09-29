/**
 * 用量页：把每一分额度对到某一次调用。
 *
 * 这一页的**唯一目的**是让扣费可核对：调用时刻、模型前台名、输入/输出 token、
 * 本次扣了多少 SP。没有它，「扣了 0.05 SP」是一个无法验证的数字。
 *
 * 两条纪律：
 * 1. **读不到就说读不到**，不显示 0 条当作"你没用过"——两者含义完全不同。
 * 2. **不补零**：某条记录若字段缺失，解析层直接丢掉它（见 `usage.ts`），
 *    显示一个 0 会让用户以为那次免费，而实际扣费可能最多。
 */

import type { UsageRead } from '../usage.ts'
import { totalsOf } from '../usage.ts'
import type { TranslateAccount } from '../locales.ts'
import css from './tabs.module.css'

/** 用量页。 */
export function UsageTab({ usage, loading, onRefresh, t }: {
  readonly usage: UsageRead | null
  readonly loading: boolean
  readonly onRefresh: () => void
  readonly t: TranslateAccount
}) {
  if (usage === null || loading) {
    return (
      <section className={css.card}>
        <h2 className={css.cardTitle}>{t('usage.title')}</h2>
        <p className={css.hint}>{t('usage.loading')}</p>
      </section>
    )
  }

  if (usage.kind === 'unavailable' || usage.kind === 'rejected') {
    return (
      <section className={css.notice} data-kind="unavailable">
        <h2>{t('usage.failed')}</h2>
        <p>{usage.kind === 'rejected' && usage.message !== null ? usage.message : t('card.unavailable.hint')}</p>
        <button type="button" className={css.primary} onClick={onRefresh}>{t('unavailable.retry')}</button>
      </section>
    )
  }

  if (usage.entries.length === 0) {
    return (
      <section className={css.card}>
        <h2 className={css.cardTitle}>{t('usage.title')}</h2>
        <p className={css.hint}>{t('usage.empty')}</p>
      </section>
    )
  }

  const totals = totalsOf(usage.entries)

  return (
    <>
      <section className={css.card}>
        <h2 className={css.cardTitle}>{t('usage.total')}</h2>
        <dl className={css.miniRows}>
          <div><dt>{t('usage.calls')}</dt><dd>{totals.calls}</dd></div>
          <div><dt>{t('usage.input')}</dt><dd>{totals.inputTokens.toLocaleString('zh-CN')}</dd></div>
          <div><dt>{t('usage.output')}</dt><dd>{totals.outputTokens.toLocaleString('zh-CN')}</dd></div>
          <div><dt>{t('usage.sp')}</dt><dd><strong>{totals.sp.toFixed(2)}</strong> SP</dd></div>
        </dl>
      </section>

      <section className={css.card}>
        <h2 className={css.cardTitle}>{t('usage.records')}</h2>
        <div className={css.tableWrap}>
          <table className={css.table}>
            <thead>
              <tr>
                <th scope="col">{t('usage.col.time')}</th>
                <th scope="col">{t('usage.col.model')}</th>
                <th scope="col" className={css.num}>{t('usage.col.input')}</th>
                <th scope="col" className={css.num}>{t('usage.col.output')}</th>
                <th scope="col" className={css.num}>{t('usage.col.sp')}</th>
              </tr>
            </thead>
            <tbody>
              {usage.entries.map(entry => (
                <tr key={`${entry.at}-${entry.model}`}>
                  <td>{new Date(entry.at).toLocaleString('zh-CN', { hour12: false })}</td>
                  <td>{entry.model}</td>
                  <td className={css.num}>{entry.inputTokens.toLocaleString('zh-CN')}</td>
                  <td className={css.num}>{entry.outputTokens.toLocaleString('zh-CN')}</td>
                  <td className={css.num}>{entry.sp.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={css.hint}>{t('usage.modelNote')}</p>
        <p className={css.hint}>{t('usage.ownOnly')}</p>
      </section>
    </>
  )
}
