/**
 * 控制台测试夹具：**照抄宿主真实响应形状**（`packages/host/model-gateway/src/admin-routes.ts`
 * 的 `names` 处理器：`{ ok, names: [{...record, history}], backends: [{key,id,concurrency}] }`）。
 *
 * 夹具里的 `deepseek-*` 是上游标识，只出现在 `id` 字段——页面测试会断言它
 * **不出现在 DOM**，这正是展示纪律的可验证证据。
 */

import type { BackendBinding, PublishedNameRecord, RouteBackend, RouteCatalog } from '../src/client/route-catalog.ts'

/** 夹具时间锚点：基准时刻取测试进程当前时间，让「过去 / 生效中 / 将来」在真实时钟下都成立。 */
export const NOW = Date.now()
/** 一小时。 */
export const HOUR = 3_600_000

/** 一条已失效的绑定：过去生效、由下一条封顶。 */
export const expiredBinding: BackendBinding = {
  publishedName: '千手·迅捷',
  effectiveFrom: NOW - 72 * HOUR,
  effectiveTo: NOW - 24 * HOUR,
  backendKeys: ['pro'],
  reason: '上一周期临时顶配',
  operator: 'account-1',
  rolloutPercent: 100,
}

/** 当前生效的绑定。 */
export const activeBinding: BackendBinding = {
  publishedName: '千手·迅捷',
  effectiveFrom: NOW - 24 * HOUR,
  effectiveTo: null,
  backendKeys: ['flash', 'pro'],
  reason: '默认目录：插件启动时登记',
  operator: 'system',
  rolloutPercent: 100,
}

/** 计划中的绑定（未来生效，晚于 activeBinding）。 */
export const scheduledBinding: BackendBinding = {
  publishedName: '千手·迅捷',
  effectiveFrom: NOW + 48 * HOUR,
  effectiveTo: null,
  backendKeys: ['pro', 'flash'],
  reason: '下周换主后端',
  operator: 'admin',
  rolloutPercent: 25,
}

/** 强力的第一条绑定：生效中。 */
export const proBinding: BackendBinding = {
  publishedName: '千手·强力',
  effectiveFrom: NOW - 48 * HOUR,
  effectiveTo: null,
  backendKeys: ['pro'],
  reason: '默认目录：插件启动时登记',
  operator: 'system',
  rolloutPercent: 100,
}

/** 一个前台名字（含全量历史，按生效时刻升序）。 */
export function nameRecord(overrides: Partial<PublishedNameRecord> = {}): PublishedNameRecord {
  return {
    publishedName: '千手·迅捷',
    label: '千手·迅捷',
    tiers: ['basic', 'plus', 'max'],
    maxOutputTokens: 4096,
    order: 0,
    upgradeRule: 'on-expiry',
    lifecycleStage: 'ga',
    shutdownDate: null,
    migrationTarget: null,
    history: [expiredBinding, activeBinding],
    ...overrides,
  }
}

/** 可选后端：键位与并发上限（上游标识只在 `upstreamId`）。 */
export const backends: readonly RouteBackend[] = [
  { key: 'flash', upstreamId: 'deepseek-flash', concurrency: 2500 },
  { key: 'pro', upstreamId: 'deepseek-v4-pro', concurrency: 500 },
]

/** 一个完整目录（已校验形态）。 */
export function catalog(overrides: Partial<RouteCatalog> = {}): RouteCatalog {
  return {
    names: [
      nameRecord(),
      nameRecord({
        publishedName: '千手·强力',
        label: '千手·强力',
        tiers: ['plus', 'max'],
        maxOutputTokens: 16384,
        order: 1,
        history: [proBinding],
      }),
      nameRecord({ publishedName: '千手·轻量', label: '千手·轻量', maxOutputTokens: 8192, order: 2, history: [] }),
    ],
    backends,
    ...overrides,
  }
}

/** 一个名字的原始 JSON 记录（历史字段由调用方决定挂在哪一层）。 */
function rawName(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    publishedName: '千手·迅捷',
    label: '千手·迅捷',
    tiers: ['basic', 'plus', 'max'],
    maxOutputTokens: 4096,
    order: 0,
    upgradeRule: 'on-expiry',
    lifecycleStage: 'ga',
    shutdownDate: null,
    migrationTarget: null,
    ...overrides,
  }
}

/** 后端原始记录。 */
function rawBackends(): unknown {
  return backends.map(backend => ({ key: backend.key, id: backend.upstreamId, concurrency: backend.concurrency }))
}

/** 宿主 `names` 路由的真实响应体（历史挂在每个名字上）。 */
export function namesPayload(): unknown {
  return {
    ok: true,
    names: [
      { ...rawName(), history: [expiredBinding, activeBinding] },
      {
        ...rawName({
          publishedName: '千手·强力', label: '千手·强力', tiers: ['plus', 'max'], maxOutputTokens: 16384, order: 1,
        }),
        history: [proBinding],
      },
      { ...rawName({ publishedName: '千手·轻量', label: '千手·轻量', maxOutputTokens: 8192, order: 2 }), history: [] },
    ],
    backends: rawBackends(),
  }
}

/** 另一种已见的形状：历史挂在顶层 `bindings` 上。 */
export function flatPayload(): unknown {
  return {
    ok: true,
    names: [
      rawName(),
      rawName({ publishedName: '千手·强力', label: '千手·强力', tiers: ['plus', 'max'], maxOutputTokens: 16384, order: 1 }),
      rawName({ publishedName: '千手·轻量', label: '千手·轻量', maxOutputTokens: 8192, order: 2 }),
    ],
    backends: rawBackends(),
    bindings: [expiredBinding, activeBinding, proBinding],
  }
}

/** 带一条「计划中」绑定的响应体：用来验证历史三态中的将来态。 */
export function scheduledPayload(): unknown {
  return {
    ok: true,
    names: [
      { ...rawName(), history: [expiredBinding, activeBinding, { ...scheduledBinding, effectiveTo: null }] },
      { ...rawName({ publishedName: '千手·强力', label: '千手·强力', tiers: ['plus', 'max'], maxOutputTokens: 16384, order: 1 }), history: [proBinding] },
      { ...rawName({ publishedName: '千手·轻量', label: '千手·轻量', maxOutputTokens: 8192, order: 2 }), history: [] },
    ],
    backends: rawBackends(),
  }
}

/** 追加绑定成功后的响应体。 */
export function bindPayload(): unknown {
  return { ok: true, history: [expiredBinding, activeBinding, scheduledBinding] }
}
