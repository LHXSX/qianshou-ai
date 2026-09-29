/**
 * 模块就绪度：**哪些能真做、哪些只是占位，必须写在接口里**。
 *
 * 用户明确要求"不许造假数据；依赖未就绪就做占位页并如实写"。把这件事做成接口的
 * 一等公民（而不是文档里的一句话）有两个好处：
 *
 * 1. 前端不用猜——占位页直接渲染这里的 `missing` 清单；
 * 2. 它同时是**给后端的工单**：每个占位模块都列出了"缺哪个服务的哪个接口"。
 */

/** 就绪度三档。 */
export type ModuleStatus = 'ready' | 'read-only' | 'dependency-unavailable'

/** 缺一个接口。 */
export interface MissingInterface {
  /** 需要的方法与路径（按现有服务风格写的建议形状）。 */
  readonly interface: string
  /** 为什么需要它（缺了它哪一步做不了）。 */
  readonly why: string
  /** 谁该提供它。 */
  readonly owner: string
}

/** 一个模块的就绪度。 */
export interface ModuleReadiness {
  readonly key: string
  readonly title: string
  readonly status: ModuleStatus
  readonly summary: string
  readonly missing: readonly MissingInterface[]
}

/** 尚未建成的属主服务对应的模块（占位页）。 */
export const BLOCKED_MODULES: Readonly<Record<'market' | 'discovery' | 'order' | 'models', {
  readonly title: string
  readonly summary: string
  readonly missing: readonly MissingInterface[]
}>> = {
  market: {
    title: '技能 / 专家市场',
    summary: '技能与专家的市场目录服务尚未建成，本版没有可读的条目，也没有可写的审核动作。',
    missing: [
      {
        interface: 'GET /internal/market/items?status=pending_review',
        why: '上架审核需要待审队列；没有它连"有哪些申请"都不知道。',
        owner: '市场目录服务（未建）',
      },
      {
        interface: 'POST /internal/market/items/{id}/review',
        why: '通过/驳回上架申请，并记录审核人与理由。',
        owner: '市场目录服务（未建）',
      },
      {
        interface: 'POST /internal/market/items/{id}/unpublish',
        why: '下架已发布条目（第三方内容出问题时必须能立刻停用）。',
        owner: '市场目录服务（未建）',
      },
      {
        interface: 'GET /internal/market/pricing',
        why: '官方定价与开发者分成规则是**钱**，必须由属主服务给出唯一口径。',
        owner: '市场目录服务（未建）',
      },
    ],
  },
  discovery: {
    title: '发现页内容',
    summary: '发现页的内容服务尚未建成；公告、推荐位与举报队列都没有可读写的地方。',
    missing: [
      {
        interface: 'GET /internal/content/announcements',
        why: '公告列表与状态（草稿/已发布/已下线）。',
        owner: '内容服务（未建）',
      },
      {
        interface: 'POST /internal/content/announcements',
        why: '发布公告；发布动作必须可审计（改了会影响全部用户）。',
        owner: '内容服务（未建）',
      },
      {
        interface: 'GET /internal/content/recommendations',
        why: '推荐位当前配置，改之前要能看到现状。',
        owner: '内容服务（未建）',
      },
      {
        interface: 'GET /internal/content/reports?status=open',
        why: '举报处理队列。',
        owner: '内容服务（未建）',
      },
    ],
  },
  order: {
    title: '支付订单与提现',
    summary: '支付管理页面已接上海账号会话与支付接口；全局查询需上海部署 admin/payment/orders。退款与工单服务仍未开放。',
    missing: [
      { interface: 'GET /api/v8/admin/payment/orders', why: '上海全局订单接口需要部署并联调；不能用个人充值历史冒充全局列表。', owner: '上海支付服务' },
      { interface: '退款政策与工单服务', why: '本轮不决定退款政策、不删除账本、不操作工单或同步 SP。', owner: '产品与上海服务' },
    ],
  },
  models: {
    title: '模型路由',
    summary: '前台名字与后端绑定的读写面在模型网关进程（7080）里；本管理台进程（7090）还没有同一份已验证身份能调用它。7080 的 POST /api/qianshou/ai/admin/names 与 /bind 已经存在，认的是工作台会话里的 isAdmin，不是本台 cookie。',
    missing: [
      {
        interface: 'POST /api/qianshou/ai/admin/names',
        why: '列出前台名字、档位、生命周期与全量绑定历史。',
        owner: '模型网关（工作台进程 7080）',
      },
      {
        interface: 'POST /api/qianshou/ai/admin/bind',
        why: '追加一条绑定。生效日必须在未来；操作者必须来自已验证主体。',
        owner: '模型网关（工作台进程 7080）',
      },
    ],
  },
}

/** 直接用占位实现替换的模块端点。 */
export function blockedReadiness(key: 'market' | 'discovery' | 'order' | 'models'): ModuleReadiness {
  const spec = BLOCKED_MODULES[key]
  return {
    key,
    title: spec.title,
    status: 'dependency-unavailable',
    summary: spec.summary,
    missing: spec.missing,
  }
}
