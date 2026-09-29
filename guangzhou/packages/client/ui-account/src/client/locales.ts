/**
 * 账户区文案字典。
 *
 * 两条写完的纪律：
 * 1. 不写"密钥"。我们的额度来自订阅，密钥在服务端；让用户看到"密钥"两个字
 *    会把他们引向一个根本不存在的输入框。
 * 2. 不确定就说不知道。`unknown` / `unavailable` 的文案是"暂时读不到"，
 *    不是"0"，也不是"未登录"——两者会让用户做出错误的动作。
 */

/** 本字典在 locale 服务里的命名空间。 */
export const NS = 'qianshou.account'

/** 本字典的键。 */
export type AccountKey = keyof typeof zh

/**
 * 文案函数：本字典的键 + 可选替位值。
 *
 * 单独定义在这里而不是各组件里，是为了让四个标签页只依赖字典模块，
 * 不互相依赖——否则 `tabs/*` 与 `AccountTabs.tsx` 之间会形成一个类型环，
 * 那种环在改文件顺序或做类型裁剪时会以奇怪的方式爆出来。
 */
export type TranslateAccount = (key: AccountKey, values?: Record<string, string>) => string

/** 中文（默认语言）。 */
export const zh = {
  // ── 侧栏账户卡 ──────────────────────────────────────────────
  'card.anonymous': '未登录',
  'card.anonymous.hint': '登录后开始使用',
  'card.loading': '读取中…',
  'card.unavailable': '暂时读不到',
  'card.unavailable.hint': '网关没有应答，稍后会自动重试',
  'card.balance': '剩余额度',
  /** `{sp}` = 订阅点数。 */
  'card.balance.value': '{sp} SP',
  /**
   * 侧栏卡片上的那一行。必须带「剩余」两个字：只写「普通版 · 390.00 SP」
   * 会被读成"这个档位给 390"或"本周期总量"，而卡片要给的是还剩多少。
   */
  'card.remaining.value': '剩余 {sp} SP',
  /** 括号里注明口径，否则"390 SP 只值 3.90 元"会被当成算错账。 */
  'card.balance.yuan': '按用量计价约 {yuan} 元',
  'card.expand': '打开个人中心',
  'card.refresh': '刷新额度',
  'card.refreshing': '正在刷新…',

  // ── 档位 ────────────────────────────────────────────────────
  'tier.basic': '普通版',
  'tier.plus': '高级版',
  'tier.max': 'Max',
  'tier.unknown': '未知档位',

  // ── 设置小节 ────────────────────────────────────────────────
  /**
   * 设置里这一节的导航名。**刻意不叫「账户」**：设置里已有一个上游的
   * 「账号」小节（登录 / 注册 / 2FA / 退出），那是"我是谁"；
   * 这一节是"我买到什么、还剩多少、这周期用了多少"。两个入口同名会让
   * 用户在两处来回点，也说不清哪个才是充值入口。
   */
  'settings.title': '套餐与用量',

  // ── 套餐与额度页 ────────────────────────────────────────────
  'page.title': '套餐与额度',
  'page.subtitle': '账号、档位与额度都在这里',
  'page.back': '返回对话',
  'page.section.account': '账号',
  'page.section.plan': '档位与额度',
  'page.section.usage': '本周期用量',

  'field.id': '账号 ID',
  'field.username': '用户名',
  'field.email': '邮箱',
  'field.role': '账号类型',
  'field.role.personal': '个人',
  'field.role.admin': '管理员',
  'field.role.enterprise': '企业',
  'field.tier': '当前档位',
  'field.monthly': '每月',
  'field.monthly.value': '{yuan} 元',
  'field.monthly.none': '未订阅',
  'field.concurrency': '并发上限',
  'field.context': '上下文上限',
  'field.context.value': '{tokens} tokens',
  'field.window': '滚动窗口',
  'field.window.value': '{used} / {limit} SP',
  'field.readAt': '更新时间',

  'usage.remaining': '剩余',
  'usage.used': '已用',
  'usage.ratio.none': '总量未知，无法计算比例',

  'empty.title': '还没有登录',
  'empty.body': '登录后这里会显示你的档位、剩余额度和本周期用量。',
  'empty.action': '去登录',

  'unavailable.title': '暂时读不到账户信息',
  'unavailable.body': '宿主账号服务或订阅网关没有应答。这不是你的密钥问题：本产品不向用户收取密钥，模型调用由订阅额度统一结算。',
  'unavailable.retry': '重试',

  'plan.hint': 'SP 是订阅点数（1 SP = 0.01 元），按上游 list price 折算计费；订阅价里含服务与路由成本，所以两者不是同一个换算。额度按真实 token 用量扣费，每次调用都会留痕，可在「模型 » 用量审计」里逐条核对。',
  'plan.upgrade': '升级档位',
  'plan.upgrade.hint': '需要更大的额度或并发时，联系运营开通。',

  // ── 标签页 ──────────────────────────────────────────────────
  'tab.overview': '总览',
  'tab.overview.lead': '登录状态、档位与剩余额度；公开账号信息只用于标识这是谁的账。',
  'tab.plan': '档位',
  'tab.credit': '充值',
  'tab.usage': '用量',

  // ── 档位页 ──────────────────────────────────────────────────
  'plan.lead': '三档的每元 SP 完全相同（都是 10 SP/元）；差别在绝对额度、并发、上下文，以及能不能用强力模型。',
  'plan.current': '当前',
  'plan.perMonth': '/ 月',
  'plan.sp': '每月额度',
  'plan.perYuan': '每元买到',
  'plan.power': '强力模型',
  'plan.power.yes': '可用',
  'plan.power.no': '不包含',
  'plan.same': '三档共有的东西',
  'plan.same.body': '三条读路由与逐调用审计对每档都开着；额度按真实 token 扣，每次调用都在「用量」里留痕。每元买到的 SP 三档相同，所以升级买到的不是更便宜的单价，而是更大的绝对额度、更高的并发、更长的上下文，以及强力模型的使用权（迅捷三档都有，强力只给高级版与 Max）。',
  'plan.how.title': '怎么换档',
  'plan.how.body': '换档由运营在服务端下发，会立刻生效（下一轮对话就按新档算）。本机没有支付流程，所以这一页不放付款按钮。',

  // ── 充值页 ──────────────────────────────────────────────────
  'credit.lead': '额度怎么算、为什么这么算、要更多该走哪一步。',
  'credit.balance.title': '当前余额',
  'credit.noData': '还没读到余额。点右上角刷新重试。',
  'credit.sameAs': '折算',
  'credit.granted': '本周期授予',
  'credit.why.title': '为什么 39 元给 390 SP，390 SP 却只折算 3.90 元',
  'credit.why.body': '这是两个不同的口径，不是算错：SP 按上游 list price 计价（1 SP = 0.01 元），也就是"这些 token 按服务商官方价折算值多少钱"；而你付的 39 元里还包含路由、故障切换、并发保障与运维。所以订阅价与 SP 折算值本来就不该相等。',
  'credit.how.title': '要更多额度',
  'credit.how.1': '在本页上方「档位」看清自己需要哪一档：额度、并发、上下文、能不能用强力模型。',
  'credit.how.2': '把账号 ID 与想要的档位发给运营（账号 ID 在「总览」里）。',
  'credit.how.3': '运营在服务端下发订阅后，回到本页点刷新即可看到新额度与档位。',
  'credit.how.note': '整个链路里没有付款控件，因为服务端没有接支付：支付由部署方自己的系统完成，网关只负责"钱已经收过了，把权益给上"。',
  'credit.where.title': '这些数字从哪来',
  'credit.where.body': '余额来自网关的额度状态路由（只读，不缓存中间层）：',
  'credit.where.audit': '逐调用明细在「用量」标签页，或直接读同一条审计路由。审计只返回你自己的记录，别人看不到你的。',

  // ── 用量页 ──────────────────────────────────────────────────
  'usage.lead': '让每一分额度都能对到某一次调用。',
  'usage.title': '用量',
  'usage.loading': '正在读取用量记录…',
  'usage.failed': '暂时读不到用量',
  'usage.empty': '这个周期还没有调用记录。发起一次对话后再回来看。',
  'usage.total': '本周期合计',
  'usage.calls': '调用次数',
  'usage.input': '输入 token',
  'usage.output': '输出 token',
  'usage.sp': '合计扣费',
  'usage.records': '逐条记录',
  'usage.col.time': '时间',
  'usage.col.model': '模型',
  'usage.col.input': '输入',
  'usage.col.output': '输出',
  'usage.col.sp': '扣费 SP',
  'usage.ownOnly': '只显示你自己的调用记录——审计路由按服务端身份过滤，不接收账号参数。',
  'usage.modelNote': '「模型」一栏记的是实际作答的那个模型。当前档位用不了你请求的模型时，系统会降级到该档可用的模型并照常计费，所以这里可能出现与你所选不同的名字。',
} as const

/** 英文。 */
export const en: Record<AccountKey, string> = {
  'card.anonymous': 'Not signed in',
  'card.anonymous.hint': 'Sign in to start',
  'card.loading': 'Loading…',
  'card.unavailable': 'Unavailable',
  'card.unavailable.hint': 'The gateway did not answer; retrying automatically',
  'card.balance': 'Credit left',
  'card.balance.value': '{sp} SP',
  'card.remaining.value': '{sp} SP left',
  'card.balance.yuan': '≈ ¥{yuan} at usage rates',
  'card.expand': 'Open account center',
  'card.refresh': 'Refresh credit',
  'card.refreshing': 'Refreshing…',

  'tier.basic': 'Basic',
  'tier.plus': 'Plus',
  'tier.max': 'Max',
  'tier.unknown': 'Unknown plan',

  'settings.title': 'Plan and usage',
  'page.title': 'Plan and credit',
  'page.subtitle': 'Your identity, plan and credit in one place',
  'page.back': 'Back to chat',
  'page.section.account': 'Account',
  'page.section.plan': 'Plan and credit',
  'page.section.usage': 'This cycle',

  'field.id': 'Account ID',
  'field.username': 'Username',
  'field.email': 'Email',
  'field.role': 'Account type',
  'field.role.personal': 'Personal',
  'field.role.admin': 'Administrator',
  'field.role.enterprise': 'Enterprise',
  'field.tier': 'Current plan',
  'field.monthly': 'Monthly',
  'field.monthly.value': '¥{yuan}',
  'field.monthly.none': 'Not subscribed',
  'field.concurrency': 'Concurrency cap',
  'field.context': 'Context cap',
  'field.context.value': '{tokens} tokens',
  'field.window': 'Rolling window',
  'field.window.value': '{used} / {limit} SP',
  'field.readAt': 'Updated',

  'usage.remaining': 'Remaining',
  'usage.used': 'Used',
  'usage.ratio.none': 'Total unknown, ratio cannot be computed',

  'empty.title': 'Not signed in yet',
  'empty.body': 'Once you sign in, your plan, remaining credit and this cycle’s usage appear here.',
  'empty.action': 'Sign in',

  'unavailable.title': 'Account information is unreachable',
  'unavailable.body': 'The host account service or the subscription gateway did not answer. This is not an API-key problem: this product never asks you for a key — model calls settle against your subscription credit.',
  'unavailable.retry': 'Retry',

  'plan.hint': 'SP is a subscription credit (1 SP = 0.01 CNY) charged at upstream list prices; the subscription price also covers service and routing, so the two are not the same conversion. Credit is charged on real token usage and every call is recorded — item-by-item review lives in Models » Usage audit.',
  'plan.upgrade': 'Upgrade plan',
  'plan.upgrade.hint': 'Contact operations when you need more credit or concurrency.',

  'tab.overview': 'Overview',
  'tab.overview.lead': 'Sign-in state, plan and remaining credit; the public account fields only identify whose account this is.',
  'tab.plan': 'Plans',
  'tab.credit': 'Top-up',
  'tab.usage': 'Usage',

  'plan.lead': 'All three plans grant the same SP per yuan (10); they differ in absolute credit, concurrency, context and access to the Power model.',
  'plan.current': 'Current',
  'plan.perMonth': '/ month',
  'plan.sp': 'Monthly credit',
  'plan.perYuan': 'Per yuan',
  'plan.power': 'Power model',
  'plan.power.yes': 'Included',
  'plan.power.no': 'Not included',
  'plan.same': 'What every plan shares',
  'plan.same.body': 'The three read routes and the per-call audit are open on every plan; credit is charged on real tokens and every call is recorded under Usage. SP per yuan is identical across the three plans, so upgrading does not buy a cheaper unit price — it buys a larger absolute credit, higher concurrency, longer context, and access to the Power model (Swift is on all three, Power only on Plus and Max).',
  'plan.how.title': 'Changing plan',
  'plan.how.body': 'Operations grants a plan server-side and it takes effect immediately (the next turn is metered at the new plan). There is no payment flow on this machine, so this page carries no payment control.',

  'credit.lead': 'How credit is computed, why it is computed that way, and what to do when you need more.',
  'credit.balance.title': 'Current balance',
  'credit.noData': 'Balance not read yet. Use Refresh in the top right to retry.',
  'credit.sameAs': 'Equivalent',
  'credit.granted': 'Granted this cycle',
  'credit.why.title': 'Why ¥39 grants 390 SP while 390 SP converts to only ¥3.90',
  'credit.why.body': 'These are two different measures, not an arithmetic error: SP is priced at upstream list price (1 SP = ¥0.01), i.e. what those tokens would cost at the provider\'s official rates; the ¥39 you pay also covers routing, failover, concurrency guarantees and operations. A subscription price and an SP equivalence should not be equal.',
  'credit.how.title': 'Need more credit',
  'credit.how.1': 'Compare the Plans tab above: credit, concurrency, context and access to the strong model.',
  'credit.how.2': 'Send your account ID and the plan you want to operations (the ID is on the Overview tab).',
  'credit.how.3': 'After operations grants the subscription server-side, come back and press Refresh to see the new credit and plan.',
  'credit.how.note': 'There is no payment control anywhere in this chain because the server has no payment integration: payment happens in the deployer\'s own system, and the gateway only records that it has been received.',
  'credit.where.title': 'Where these numbers come from',
  'credit.where.body': 'The balance comes from the gateway credit route (read-only, no intermediate cache):',
  'credit.where.audit': 'Per-call detail is on the Usage tab, or read the same audit route directly. The audit returns only your own records — nobody else can see them.',

  'usage.lead': 'Every unit of credit traceable to a specific call.',
  'usage.title': 'Usage',
  'usage.loading': 'Reading usage records…',
  'usage.failed': 'Usage is unreachable right now',
  'usage.empty': 'No calls recorded in this cycle yet. Run a turn and come back.',
  'usage.total': 'This cycle',
  'usage.calls': 'Calls',
  'usage.input': 'Input tokens',
  'usage.output': 'Output tokens',
  'usage.sp': 'Charged',
  'usage.records': 'Records',
  'usage.col.time': 'Time',
  'usage.col.model': 'Model',
  'usage.col.input': 'In',
  'usage.col.output': 'Out',
  'usage.col.sp': 'SP',
  'usage.ownOnly': 'Only your own calls are listed — the audit route filters by server-side identity and takes no account parameter.',
  'usage.modelNote': 'The Model column records the model that actually answered. When your plan cannot use the model you requested, the system falls back to one the plan allows and meters the call as usual — so the name here can differ from the one you picked.',
}
