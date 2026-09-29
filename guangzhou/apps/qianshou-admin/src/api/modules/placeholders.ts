/**
 * §8.3 技能 / 专家市场、§8.4 发现页内容、§8.5 订单与工单、§8.5b 模型路由的占位接口。
 *
 * 四个模块在服务端当前都返回 `503 dependency_unavailable`（带 `module` + `missing[]`）；
 * 页面的缺口信息直接来自服务端响应，**不编数据、不用假条目填充**。
 * 模型路由的缺口指向已存在的 7080 `POST /api/qianshou/ai/admin/names` 与 `/bind`，不是未建服务。
 */

import { postJson } from '../client'
import { AdminApiError } from '../errors'
import { ENDPOINTS } from '../endpoints'

/** 占位模块标识，与服务端模块 key 对齐（用于就绪度矩阵匹配）。 */
export type PlaceholderModule = 'market' | 'discovery' | 'order' | 'models'

export interface PlaceholderDescriptor {
  readonly module: PlaceholderModule
  /** 契约 §8.x 里该模块的 overview 端点。 */
  readonly path: string
  /** 页面标题。 */
  readonly title: string
  /** 该模块在契约里列出的权限键，供页面说明「就绪后这里会展示什么」。 */
  readonly permissions: readonly string[]
}

export const PLACEHOLDER_MODULES: Readonly<Record<PlaceholderModule, PlaceholderDescriptor>> = {
  market: {
    module: 'market',
    path: ENDPOINTS.marketOverview,
    title: '技能 / 专家市场',
    permissions: ['market.read', 'market.review', 'market.pricing.manage'],
  },
  discovery: {
    module: 'discovery',
    path: ENDPOINTS.discoveryOverview,
    title: '发现页内容',
    permissions: ['discovery.read', 'discovery.publish', 'discovery.report.handle'],
  },
  order: {
    module: 'order',
    path: ENDPOINTS.orderOverview,
    title: '订单与工单',
    permissions: ['order.read', 'order.refund', 'ticket.read', 'ticket.reply'],
  },
  models: {
    module: 'models',
    path: ENDPOINTS.modelsOverview,
    title: '模型路由',
    permissions: ['models.read', 'models.bind'],
  },
}

/** 探测结果：要么服务端仍返回缺口（占位），要么它已经能返回真实数据。 */
export type PlaceholderProbe =
  | { readonly kind: 'dependency-unavailable'; readonly error: AdminApiError }
  | { readonly kind: 'available'; readonly payload: unknown }

/**
 * 调用占位模块 overview 并区分两种结局。
 * 只有 `503 dependency_unavailable` 会被当成「占位」；其它错误（403/401/502）原样抛出，
 * 由统一错误组件按契约渲染，避免把鉴权问题误报成「服务未就绪」。
 */
export async function probePlaceholderOverview(module: PlaceholderModule): Promise<PlaceholderProbe> {
  try {
    const response = await postJson<{ ok: true } & Record<string, unknown>>(PLACEHOLDER_MODULES[module].path, {})
    const { ok: _ok, ...payload } = response
    return { kind: 'available', payload }
  } catch (error) {
    if (error instanceof AdminApiError && error.isDependencyUnavailable) {
      return { kind: 'dependency-unavailable', error }
    }
    throw error
  }
}
