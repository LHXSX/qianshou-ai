import type { Copy } from './copy.ts'

export type FeatureKind = 'plan' | 'data' | 'image' | 'code'

export interface FeatureCard {
  readonly kind: FeatureKind
  readonly title: keyof Copy
  readonly desc: keyof Copy
  readonly prompt: keyof Copy
}

export const FEATURE_CARDS: readonly FeatureCard[] = [
  { kind: 'plan', title: 'cardPlanTitle', desc: 'cardPlanDesc', prompt: 'cardPlanTitle' },
  { kind: 'data', title: 'cardDataTitle', desc: 'cardDataDesc', prompt: 'cardDataTitle' },
  { kind: 'image', title: 'cardImageTitle', desc: 'cardImageDesc', prompt: 'cardImageTitle' },
  { kind: 'code', title: 'cardCodeTitle', desc: 'cardCodeDesc', prompt: 'cardCodeTitle' },
]

export const SUGGESTION_BATCHES: readonly (readonly string[])[] = [
  [
    '帮我分析新能源汽车行业的市场机会',
    '生成一个产品宣传视频脚本',
    '帮我制定一个30天的学习计划',
  ],
  [
    '把这份周报整理成老板能直接转发的摘要',
    '根据现有代码写一份接口说明',
    '帮我设计一次用户访谈提纲',
  ],
  [
    '对比三个竞品的定价和功能差异',
    '写一封跟进客户的中文邮件',
    '把会议记录拆成可执行的任务列表',
  ],
]

export const SUGGESTION_BATCHES_EN: readonly (readonly string[])[] = [
  [
    'Analyze market opportunities in the EV industry',
    'Write a product promo video script',
    'Make a 30-day learning plan',
  ],
  [
    'Turn this weekly report into a forwardable summary',
    'Write API notes from the current code',
    'Draft a user-interview outline',
  ],
  [
    'Compare pricing and features of three competitors',
    'Write a follow-up email to a client',
    'Split meeting notes into actionable tasks',
  ],
]

/** Advance the suggestion batch, wrapping at the end.
 * @param index - Current batch index.
 * @param count - Number of batches.
 * @returns The next batch index.
 */
export function nextBatch(index: number, count: number): number {
  if (!Number.isInteger(index) || count <= 0) return 0
  return (index + 1) % count
}
