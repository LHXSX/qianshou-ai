/**
 * 订阅与限额的契约测试。
 *
 * 这里断言的都是**钱与边界**，所以每条都要能说清"错了会怎样"：
 * 上下文上限错了 → 1M 输入按 2K 的成本卖出（507 倍亏损）；
 * 档位判定错了 → 普通版能用强力档（3.3 倍成本）；
 * 预算按平均值预留 → 长回答超支；
 * 余额换算错了 → 计费本身失真。
 */
import { describe, expect, it } from 'vitest'
import {
  BACKENDS,
  CNY_PER_USD,
  MIN_OUTPUT_TOKENS,
  PUBLISHED_MODELS,
  SP_PER_YUAN,
  TIERS,
  admit,
  estimateTokens,
  spForUsage,
  type CreditState,
} from '../src/tiers.ts'

/** 额度充裕的账户，用来把"额度"这个变量从其它判定里隔离出去。 */
const RICH: CreditState = { remainingMonthlySp: 1_000_000, usedInWindowSp: 0 }

describe('token 估算：偏保守，宁可高估', () => {
  it('中日韩按 1 字符 ≈ 1 token', () => {
    expect(estimateTokens('你好世界')).toBe(4)
  })

  it('拉丁文按 4 字符 ≈ 1 token，且向上取整', () => {
    expect(estimateTokens('abcdefgh')).toBe(2)
    expect(estimateTokens('abcde')).toBe(2) // 1.25 → 向上取整
  })

  it('混排时两类分开算', () => {
    // 2 个汉字 + 4 个字母 = 2 + 1
    expect(estimateTokens('你好abcd')).toBe(3)
  })

  it('空串是 0', () => {
    expect(estimateTokens('')).toBe(0)
  })
})

describe('用量换算成点数', () => {
  it('1 SP = 0.01 元，换算与官方单价一致', () => {
    // flash：输入 $0.30/百万、输出 $1.20/百万
    // 100 万输入 + 100 万输出 = (0.30 + 1.20) 美元 = 1.50 美元 ≈ 10.8 元 = 1080 SP
    const sp = spForUsage(BACKENDS.flash as never, { inputTokens: 1_000_000, outputTokens: 1_000_000 })
    expect(sp).toBeCloseTo(1.5 * CNY_PER_USD * SP_PER_YUAN, 1)
  })

  it('向上取整到 0.01 SP：不留下"调用了却不计费"的缝隙', () => {
    const sp = spForUsage(BACKENDS.flash as never, { inputTokens: 1, outputTokens: 0 })
    expect(sp).toBeGreaterThan(0)
  })

  it('强力档单价高于快速档（这是档位差异的成本根据）', () => {
    const usage = { inputTokens: 100_000, outputTokens: 20_000 }
    expect(spForUsage(BACKENDS.pro as never, usage)).toBeGreaterThan(spForUsage(BACKENDS.flash as never, usage))
  })
})

describe('档位与模型', () => {
  it('普通版用不了强力档，并且给出可行的替代', () => {
    const result = admit({ accountId: 'a', tier: 'basic', publishedName: '千手·强力', messages: [{ role: 'user', content: '你好' }] }, RICH)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('model-not-in-tier')
    expect(result.message).toContain('千手·迅捷')
    expect(result.suggestion?.publishedName).toBe('千手·迅捷')
  })

  it('高级版可以用强力档', () => {
    const result = admit({ accountId: 'a', tier: 'plus', publishedName: '千手·强力', messages: [{ role: 'user', content: '你好' }] }, RICH)
    expect(result.ok).toBe(true)
  })

  it('前台名字是唯一入口：真实后端标识只出现在内部的 backends 里', () => {
    const result = admit({ accountId: 'a', tier: 'plus', publishedName: '千手·强力', messages: [{ role: 'user', content: '你好' }] }, RICH)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.model.publishedName).toBe('千手·强力')
    expect(result.backends[0]?.id).toBe('deepseek-v4-pro')
  })

  it('不认识的前台名字被拒', () => {
    const result = admit({ accountId: 'a', tier: 'plus', publishedName: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] }, RICH)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('unknown-model')
  })

  it('空请求被拒', () => {
    const result = admit({ accountId: 'a', tier: 'plus', publishedName: '千手·迅捷', messages: [] }, RICH)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('invalid-request')
  })
})

describe('上下文上限：这是成本控制，不是营销限制', () => {
  /** 造一段约 n 个 token 的中文。 */
  const chinese = (n: number): string => '字'.repeat(n)

  it('超过档位上限被拒，并说清上限与被告知的用法', () => {
    const long = chinese(TIERS.basic.contextLimitTokens + 1)
    const result = admit({ accountId: 'a', tier: 'basic', publishedName: '千手·迅捷', messages: [{ role: 'user', content: long }] }, RICH)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('context-too-long')
    expect(result.message).toContain('拆成几次')
  })

  it('刚好到上限放行（边界不误杀）', () => {
    const exact = chinese(TIERS.basic.contextLimitTokens)
    const result = admit({ accountId: 'a', tier: 'basic', publishedName: '千手·迅捷', messages: [{ role: 'user', content: exact }] }, RICH)
    expect(result.ok).toBe(true)
  })

  it('高档位的上限确实更高（否则分档没有意义）', () => {
    expect(TIERS.max.contextLimitTokens).toBeGreaterThan(TIERS.plus.contextLimitTokens)
    expect(TIERS.plus.contextLimitTokens).toBeGreaterThan(TIERS.basic.contextLimitTokens)
  })

  it('多轮消息累加计算，不是只看最后一条', () => {
    const half = chinese(TIERS.basic.contextLimitTokens / 2 + 1)
    const result = admit({
      accountId: 'a',
      tier: 'basic',
      publishedName: '千手·迅捷',
      messages: [{ role: 'user', content: half }, { role: 'assistant', content: half }],
    }, RICH)
    expect(result.ok).toBe(false)
  })
})

describe('输出上限：解决"写死 2000"', () => {
  it('不给就用模型默认值', () => {
    const result = admit({ accountId: 'a', tier: 'plus', publishedName: '千手·强力', messages: [{ role: 'user', content: 'hi' }] }, RICH)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.maxOutputTokens).toBe(PUBLISHED_MODELS[1]?.maxOutputTokens)
  })

  it('调用方要得再多也被模型上限封住（否则成本失控）', () => {
    const result = admit({
      accountId: 'a',
      tier: 'plus',
      publishedName: '千手·迅捷',
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 999_999,
    }, RICH)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.maxOutputTokens).toBe(PUBLISHED_MODELS[0]?.maxOutputTokens)
  })

  it('调用方要得更少时尊重调用方，但不低于下限（真实端点的教训）', () => {
    // 真实端点实测：会推理的模型把推理 token 也算进 `max_tokens`，
    // 上限太小（16/64）时全部预算被推理吃掉，**正文一个字都轮不到**——
    // 用户收到的是"内容无法识别"，而根因是一个小得不合理的上限。
    const outcome = admit(
      { accountId: 'a', tier: 'basic', publishedName: '千手·迅捷', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 100 },
      { remainingMonthlySp: 1000, usedInWindowSp: 0 },
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.maxOutputTokens).toBe(MIN_OUTPUT_TOKENS)
  })

  it('调用方要得多时不越模型上限', () => {
    const outcome = admit(
      { accountId: 'a', tier: 'basic', publishedName: '千手·迅捷', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 999_999 },
      { remainingMonthlySp: 1000, usedInWindowSp: 0 },
    )
    expect(outcome.ok).toBe(true)
    // 封顶在前、抬底在后：反了会把"模型本身只支持这么多"的上游限制顶穿。
    if (outcome.ok) expect(outcome.maxOutputTokens).toBe(PUBLISHED_MODELS[0]?.maxOutputTokens)
  })

  it('下限不会超过模型自身上限（顺序验证）', () => {
    const model = PUBLISHED_MODELS[0]
    const outcome = admit(
      { accountId: 'a', tier: 'basic', publishedName: model?.publishedName ?? '', messages: [{ role: 'user', content: 'hi' }] },
      { remainingMonthlySp: 1000, usedInWindowSp: 0 },
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok && model !== undefined) {
      expect(outcome.maxOutputTokens).toBeLessThanOrEqual(Math.max(MIN_OUTPUT_TOKENS, model.maxOutputTokens))
    }
  })
})

describe('额度与刹车', () => {
  it('预算按**最坏情况**预留：输出用满', () => {
    const result = admit({
      accountId: 'a',
      tier: 'plus',
      publishedName: '千手·强力',
      messages: [{ role: 'user', content: '你好' }],
      maxOutputTokens: 16384,
    }, RICH)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // 16K 输出的最坏花费远大于一次典型问答；按平均值得出的预算会在长回答上超支。
    expect(result.reservedSp).toBeGreaterThan(1)
  })

  it('月额度不足时拒绝，并指出还剩多少与这次最多要多少', () => {
    const result = admit({
      accountId: 'a',
      tier: 'basic',
      publishedName: '千手·迅捷',
      messages: [{ role: 'user', content: '你好' }],
    }, { remainingMonthlySp: 0.01, usedInWindowSp: 0 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('no-credit')
    expect(result.message).toContain('0.01')
  })

  it('五小时刹车独立于月额度：月额度够也会被刹车拦下', () => {
    const result = admit({
      accountId: 'a',
      tier: 'basic',
      publishedName: '千手·迅捷',
      messages: [{ role: 'user', content: '你好' }],
    }, { remainingMonthlySp: 1000, usedInWindowSp: TIERS.basic.windowFiveHourSp })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe('no-credit')
      expect(result.message).toContain('五小时')
    }
  })

  it('判定顺序：先模型、再上下文、最后额度（否则给出误导性的拒绝）', () => {
    // 三样都不满足时，应当先说"模型不属于该档位"——那是用户能自己改的。
    const result = admit({
      accountId: 'a',
      tier: 'basic',
      publishedName: '千手·强力',
      messages: [{ role: 'user', content: '字'.repeat(TIERS.max.contextLimitTokens) }],
    }, { remainingMonthlySp: 0, usedInWindowSp: 0 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('model-not-in-tier')
  })
})

describe('三档的价格与额度自洽', () => {
  it('额度随价格等比递增（用户能一眼看懂贵在哪）', () => {
    const ratio = TIERS.plus.monthlySp / TIERS.basic.monthlySp
    expect(ratio).toBeCloseTo(TIERS.plus.monthlyYuan / TIERS.basic.monthlyYuan, 1)
  })

  it('1 SP = 0.01 元：额度上限不超过售价', () => {
    for (const tier of Object.values(TIERS)) {
      // 额度是按"内部价目表"折算的，天然小于面值——否则卖一单亏一单。
      expect(tier.monthlySp * (1 / SP_PER_YUAN)).toBeLessThan(tier.monthlyYuan)
    }
  })

  it('只有顶档允许按量付费，且默认关闭', () => {
    expect(TIERS.basic.payAsYouGo).toBe(false)
    expect(TIERS.plus.payAsYouGo).toBe(false)
    expect(TIERS.max.payAsYouGo).toBe(true)
  })

  it('并发上限随档位递增', () => {
    expect(TIERS.max.concurrency).toBeGreaterThan(TIERS.plus.concurrency)
    expect(TIERS.plus.concurrency).toBeGreaterThan(TIERS.basic.concurrency)
  })
})
