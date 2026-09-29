/**
 * 就绪度三档的展示元数据（API.md §3）。
 *
 * 注意：这是**展示映射**，不是权限判断。
 * 前端不解释「某个角色能看到什么」，只把服务端给的 `status` 渲染成三色。
 */

import type { ModuleStatus } from '@/api/types'

export interface ModuleStatusMeta {
  readonly label: string
  /** Element Plus tag 类型：ready=success / read-only=warning / dependency-unavailable=danger。 */
  readonly tagType: 'success' | 'warning' | 'danger'
  readonly description: string
}

const STATUS_META: Readonly<Record<ModuleStatus, ModuleStatusMeta>> = {
  ready: {
    label: '可用',
    tagType: 'success',
    description: '读写接口都已由属主服务提供。',
  },
  'read-only': {
    label: '只读',
    tagType: 'warning',
    description: '真实数据可读；写入接口等待属主服务开放。',
  },
  'dependency-unavailable': {
    label: '依赖未就绪',
    tagType: 'danger',
    description: '属主服务尚未提供接口，页面为占位说明。',
  },
}

/** 未知 status（服务端新增档位）按「依赖未就绪」展示，不猜。 */
export function moduleStatusMeta(status: ModuleStatus | string): ModuleStatusMeta {
  return STATUS_META[status as ModuleStatus] ?? {
    label: `未知状态（${String(status)}）`,
    tagType: 'danger',
    description: '前端未识别该就绪度档位，请更新前端或核对契约。',
  }
}

/**
 * 就绪度矩阵的展示顺序：与前端菜单顺序对齐；
 * 服务端新增的模块会按原顺序追加在末尾，不会被丢掉。
 */
const MODULE_ORDER: readonly string[] = [
  'account',
  'subscription',
  'models',
  'market',
  'discovery',
  'order',
  'rbac',
  'audit',
  'flags',
  'whitelist',
]

/** 按展示顺序排序；未在 `MODULE_ORDER` 中的 key 保持服务端顺序排在后面。 */
export function sortModules<T extends { readonly key: string }>(modules: readonly T[]): T[] {
  const rank = (key: string): number => {
    const index = MODULE_ORDER.indexOf(key)
    return index === -1 ? MODULE_ORDER.length : index
  }
  return [...modules].sort((left, right) => rank(left.key) - rank(right.key))
}
