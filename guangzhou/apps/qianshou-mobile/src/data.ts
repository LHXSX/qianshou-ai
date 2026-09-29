export type TabId = 'chat' | 'agents' | 'discover' | 'tasks' | 'me'
export type TaskStatus = 'running' | 'done' | 'failed'

export const FACES = [
  '/media/face-01.png',
  '/media/face-02.png',
  '/media/face-03.png',
  '/media/face-04.png',
  '/media/face-05.png',
  '/media/face-06.png',
] as const

export const HOME_TILES = [
  { id: 'create', title: '创建专家', desc: '让一群AI为你工作', tint: 'blue', glyph: 'bars' },
  { id: 'run', title: '任务运行', desc: '分配 · 执行 · 监控', tint: 'green', glyph: 'nodes' },
  { id: 'flow', title: '工作流', desc: '自动化你的业务', tint: 'violet', glyph: 'flow' },
  { id: 'data', title: '数据分析', desc: '从数据中发现价值', tint: 'orange', glyph: 'bars' },
] as const

export const SUGGESTIONS = [
  ['帮我分析行业的市场机会', '生成一个产品宣传视频脚本', '搭建一个自动化工作流', '帮我做一份财务分析报告'],
  ['把这份周报整理成老板能直接转发的摘要', '根据现有代码写一份接口说明', '帮我设计一次用户访谈提纲', '对比三个竞品的定价和功能差异'],
] as const

export const AGENT_CATEGORIES = [
  { id: 'hot', label: '推荐', icon: 'star' },
  { id: 'office', label: '办公提效', icon: 'brief' },
  { id: 'finance', label: '财务会计', icon: 'bars' },
  { id: 'law', label: '法律合规', icon: 'scale' },
  { id: 'market', label: '营销运营', icon: 'mega' },
  { id: 'content', label: '内容创作', icon: 'pen' },
  { id: 'code', label: '研发编程', icon: 'code' },
  { id: 'industry', label: '行业方案', icon: 'grid' },
] as const

/**
 * 智能体能力模板。
 *
 * **刻意不含任何使用人数、评分或排名**：我们没有这些数据，编出来就是虚假宣传。
 * 也**不假借他方品牌**（例如"ChatGPT 智能体"——我们没有任何 ChatGPT 智能体）。
 * 这里只陈述"这一类智能体能做什么"，规模与效果由用户自己判断。
 */
export const AGENTS = [
  {
    id: 'writing', mark: 'pen', name: '内容写作',
    desc: '多模态内容创作、复杂问题推理、专业知识问答',
    tags: ['对话', '写作', '分析', '多模态'],
    short: '全能对话助手\n思考 · 创作 · 分析',
  },
  {
    id: 'finance', mark: 'bars', name: '财务分析',
    desc: '发票识别、做账、报表分析、税务咨询',
    tags: ['财务', '税务', '报表', '合规'],
    short: '发票识别、做账\n报表分析、税务咨询',
  },
  {
    id: 'law', mark: 'scale', name: '合同审查',
    desc: '合同审查、法律咨询、风险预警',
    tags: ['合同', '合规', '法律咨询', '风险分析'],
    short: '合同审查、法律咨询\n风险预警',
  },
  {
    id: 'video', mark: 'play', name: '视频制作',
    desc: '文案生成、脚本创作、视频剪辑、数字人',
    tags: ['视频', '脚本', '剪辑', '数字人'],
    short: '文案生成、视频剪辑\n数字人、批量生产',
  },
  {
    id: 'market', mark: 'trend', name: '市场研究',
    desc: '行业研究、竞品分析、市场预测、战略建议',
    tags: ['行业分析', '竞品', '市场预测', '商业策略'],
    short: '行业研究、竞品分析',
  },
  {
    id: 'hr', mark: 'cap', name: '招聘筛选',
    desc: '简历筛选、人才画像、面试助手、HR问答',
    tags: ['招聘', '简历', '面试', '人才分析'],
    short: '简历筛选、面试助手',
  },
] as const

/**
 * 任务列表。
 *
 * 原先这里有 5 条**完整编造**的任务：假进度（68%）、假智能体数（12 个）、假 ETA
 * （"预计剩余 3 分钟"）。手机端拿不到真实任务列表，所以这里只能是空数组——
 * 编一条"正在跑 68%"的任务比什么都不显示更坏。
 *
 * 真实来源（待接）：账号体系的算力任务接口 `/api/v8/workloads`（见
 * `docs/dev-plan/设计-统一账号与双端贯通.zh.md`）。接上之前，任务屏显示空态。
 */
export const TASKS: readonly {
  readonly id: string
  readonly tint: string
  readonly glyph: string
  readonly title: string
  readonly desc: string
  readonly progress: number
  readonly status: TaskStatus
  readonly agents: number
  readonly extra: number
  readonly eta: string
}[] = []

export const DISCOVER_CATS = [
  { id: 'hot', label: '热门推荐', icon: 'flame' },
  { id: 'office', label: '办公提效', icon: 'brief' },
  { id: 'data', label: '数据分析', icon: 'bars' },
  { id: 'content', label: '内容创作', icon: 'pen' },
  { id: 'edu', label: '学习教育', icon: 'cap' },
  { id: 'code', label: '研发编程', icon: 'code' },
  { id: 'more', label: '更多分类', icon: 'grid' },
] as const

export const INDUSTRIES = [
  { id: 'biz', image: '/media/industry-enterprise.png', title: '企业服务', desc: '合同审查 · 报表分析' },
  { id: 'edu', image: '/media/industry-campus.png', title: '高校科研', desc: '文献整理 · 数据计算' },
  { id: 'mfg', image: '/media/industry-factory.png', title: '智能制造', desc: '生产数据 · 报表汇总' },
  { id: 'med', image: '/media/industry-medical.png', title: '医疗健康', desc: '文献分析 · 资料整理' },
] as const

export const CASES = [
  {
    id: 'report', image: '/media/case-report.png', title: '行业分析报告的成稿流程',
    desc: '收集资料、梳理趋势、产出可交付的报告结构',
    tags: ['市场分析', '数据整理', '报告结构'],
  },
  {
    id: 'clip', image: '/media/case-video.png', title: '短视频脚本的产出流程',
    desc: '定主题、写脚本、拆分镜，成稿后再交给剪辑',
    tags: ['文案', '脚本', '分镜'],
  },
] as const

/**
 * 抽屉的导航项。
 *
 * 判据只有一条：**名字说的页面必须真的存在**。原先 10 项里有「工作流」「文件与数据」
 * 「知识库」三条，点下去都被映射到任务屏——等于承诺了三个不存在的页面；「团队协作」
 * 「应用市场」同理。现在只留落点与名称一致的项，其余等页面做出来再加。
 * 另：这里**没有**硬编码的角标数字（曾经有过 `badge: '12'`），任务数必须来自真实数据源。
 */
export const MENU = [
  { id: 'chat', label: '对话', icon: 'chat', badge: null },
  { id: 'square', label: '专家广场', icon: 'grid', badge: null },
  { id: 'mine', label: '我的专家', icon: 'list', badge: null },
  { id: 'tasks', label: '任务中心', icon: 'folder', badge: null },
  { id: 'models', label: '模型与 API', icon: 'diamond', badge: null },
  { id: 'me', label: '我的', icon: 'star', badge: null },
] as const

/**
 * 抽屉底部行。
 *
 * 原先是充值与会员、账单记录、我的团队、设置、帮助与反馈、关于——其中「充值与会员」写着
 * "升级享更多权益"（没有权益来源）、账单与团队没有实现、帮助与关于没有页面。
 * 只留**真能打开**的设置。
 */
export const MENU_TAIL = [
  { id: 'vip', label: '充值与会员', icon: 'receipt', extra: null },
  { id: 'bills', label: '账单记录', icon: 'list', extra: null },
  { id: 'myteam', label: '我的团队', icon: 'people', extra: null },
  { id: 'settings', label: '设置', icon: 'gear', extra: null },
  { id: 'help', label: '帮助与反馈', icon: 'question', extra: null },
  { id: 'about', label: '关于千手AI', icon: 'info', extra: null },
] as const

// 这里原本有 `FOLLOWUPS`（特斯拉、比亚迪、PPT 大纲三条写死的示例），已删除：
// 连带问题现在由 `src/followups.ts` 按用户当前那句话现算，写死的示例必然离题。

export const TASK_SECTIONS = ['任务', '工作流', '专家', '文件', '数据', 'API'] as const

export const DISPATCH_SECTIONS = ['任务运行', '专家', '数据中心', '节点管理', '统计分析'] as const

export const REGIONS = [
  { id: 'na', name: '北美', x: '14%', y: '28%' },
  { id: 'eu', name: '欧洲', x: '46%', y: '24%' },
  { id: 'sa', name: '南美', x: '28%', y: '62%' },
  { id: 'as', name: '亚洲', x: '74%', y: '30%' },
  { id: 'oc', name: '大洋洲', x: '78%', y: '68%' },
] as const

/**
 * 实时任务流。
 *
 * 原本这里是四条**完全编造**的"正在执行"的任务（含节点数、子任务数、帧耗时、进度）。
 * 那些数字没有任何真实来源，留着就是虚假宣传，因此整块清空。
 * 界面据此显示空态；等供给与调度数据真接上后再填真实内容。
 */
/** 一条实时任务流的形状；字段与将来真实调度数据对齐，当前没有任何条目。 */
export interface LiveJob {
  readonly id: string
  readonly tint: string
  readonly glyph: string
  readonly title: string
  readonly meta: string
  readonly nodes: string
  readonly speed: string
  readonly progress: number
  readonly state: string
}

export const LIVE_JOBS: readonly LiveJob[] = []

/**
 * 「我的」页的功能行。
 *
 * 原先这里有 5 条（我的订单、使用记录、发票管理、我的智能体、我的团队）——**一条都没实现**，
 * 点下去只弹「已打开」。手机端真正具备的能力目前只有本页上面那两张卡（对话模式、当前模型）
 * 与设置页，所以这里留空；等账号体系接上后（余额、节点、会话、订单）再逐条加回来。
 */
/**
 * 「我的」页的功能行。**每一条都要做出来**，且都有真实后台可接：
 * 我的订单 `/payment/orders` · 使用记录 `/ai/agent/audit/stats` · 发票 `/business/me/invoices` ·
 * 我的智能体（本地会话 + 云端）· 我的团队 `/enterprise/members`（企业账号）。
 */
export const ME_ROWS = [
  { id: 'orders', icon: 'receipt', label: '我的订单', extra: '查看全部' },
  { id: 'usage', icon: 'clock', label: '使用记录', extra: '对话 / 任务 / API' },
  { id: 'invoice', icon: 'list', label: '发票管理', extra: '申请与下载' },
  { id: 'agents', icon: 'grid', label: '我的专家', extra: '我创建的专家' },
  { id: 'team', icon: 'people', label: '我的团队', extra: '团队协作与成员管理' },
] as const

/**
 * 「我的」页尾部行。
 *
 * 去掉了「领取奖励」与写死的 `版本 1.0.0`：奖励机制还没有权威来源；版本号改成
 * 运行时注入（`__APP_VERSION__`，见 `vite.config.ts`），不再手写。
 */
export const ME_TAIL = [
  { id: 'invite', icon: 'gift', label: '邀请好友', extra: null },
  { id: 'help', icon: 'question', label: '帮助与反馈', extra: '使用问题 · 意见反馈' },
  { id: 'about', icon: 'info', label: '关于千手AI', extra: null },
] as const

/** Map a drawer item onto a bottom tab.
 * @param id - Drawer row id from MENU / MENU_TAIL.
 * @returns The tab that should become active.
 */
export function tabForMenu(id: string): TabId {
  if (id === 'square' || id === 'mine' || id === 'store') return 'agents'
  if (id === 'tasks' || id === 'flow' || id === 'files' || id === 'knowledge') return 'tasks'
  if (id === 'models') return 'discover'
  if (id === 'vip' || id === 'bills' || id === 'myteam' || id === 'settings' || id === 'help' || id === 'about' || id === 'team') return 'me'
  return 'chat'
}

/** Keep a task filter aligned with the four status chips.
 * @param filter - Requested filter id.
 * @param status - Task status.
 * @returns Whether the row should remain visible.
 */
export function taskMatches(filter: string, status: TaskStatus): boolean {
  if (filter === 'all') return true
  if (filter === 'running') return status === 'running'
  if (filter === 'done') return status === 'done'
  if (filter === 'failed') return status === 'failed'
  return true
}
