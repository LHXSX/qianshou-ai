/**
 * 控制台纯逻辑的规格测试：响应校验、**提交前**的时间校验、顺序调整、灰度边界。
 *
 * 这些用例不碰浏览器，也不碰真实宿主：它们钉住的是「界面没有权力省略的规则」。
 */

import { describe, expect, it } from 'vitest'
import {
  INVALID_ROUTE_RESPONSE, appendBackend, bindingPhase, bindFailure, formatEffectiveFrom, fromLocalInputValue,
  historyOf, latestBindingAt, moveBackend, parseRolloutPercent, parseRouteCatalog, presetEffectiveFrom,
  removeBackend, seedBackendKeys, serverMessage, toLocalInputValue, validateBindRequest,
  type BindDraft,
} from '../src/client/route-catalog.ts'
import {
  HOUR, NOW, activeBinding, catalog, expiredBinding, flatPayload, nameRecord, namesPayload, proBinding, scheduledBinding,
} from './fixtures.ts'

/** 一个通过校验的草稿（名字与键位都来自接口）。 */
function draft(overrides: Partial<BindDraft> = {}): BindDraft {
  return { publishedName: '千手·迅捷', backendKeys: ['pro'], rolloutPercent: '100', reason: '把主后端换成更强的那个', ...overrides }
}

describe('路由目录的响应校验', () => {
  it('照宿主形状解析目录，并把历史按生效时刻升序排好', () => {
    const parsed = parseRouteCatalog(namesPayload())
    expect(parsed.names.map(name => name.publishedName)).toEqual(['千手·迅捷', '千手·强力', '千手·轻量'])
    expect(parsed.names[0]?.history.map(binding => binding.effectiveFrom))
      .toEqual([expiredBinding.effectiveFrom, activeBinding.effectiveFrom])
    expect(parsed.names[0]?.tiers).toEqual(['basic', 'plus', 'max'])
    expect(parsed.names[0]?.upgradeRule).toBe('on-expiry')
    expect(parsed.names[2]?.history).toEqual([])
    expect(parsed.backends).toEqual([
      { key: 'flash', upstreamId: 'deepseek-flash', concurrency: 2500 },
      { key: 'pro', upstreamId: 'deepseek-v4-pro', concurrency: 500 },
    ])
  })

  it('也接受历史挂在顶层 bindings 的形状，缺历史的名字得到空历史而不是编造', () => {
    const parsed = parseRouteCatalog(flatPayload())
    expect(parsed.names[0]?.history).toHaveLength(2)
    expect(historyOf(parsed, '千手·强力')).toHaveLength(1)
    expect(historyOf(parsed, '千手·轻量')).toEqual([])
    expect(historyOf(parsed, '不存在的名字')).toEqual([])
  })

  it('结构不认识时抛 INVALID_ROUTE_RESPONSE，而不是把半个目录当有效事实', () => {
    const broken = [
      { ok: false, names: [], backends: [] },
      { ok: true, names: 'x', backends: [] },
      { ok: true, names: [], backends: [{ key: 'flash', id: 'deepseek-flash' }] },
      {
        ok: true,
        backends: [],
        names: [{
          publishedName: '千手·迅捷', tiers: ['basic'], maxOutputTokens: 1, order: 0,
          upgradeRule: 'on-expiry', lifecycleStage: 'unknown-stage', shutdownDate: null, migrationTarget: null, history: [],
        }],
      },
      {
        ok: true,
        backends: [],
        names: [{
          publishedName: '千手·迅捷', tiers: [], maxOutputTokens: 1, order: 0,
          upgradeRule: 'on-expiry', lifecycleStage: 'ga', shutdownDate: null, migrationTarget: null, history: [],
        }],
      },
      {
        ok: true,
        backends: [],
        names: [{
          publishedName: '千手·迅捷', tiers: ['basic'], maxOutputTokens: 1, order: 0,
          upgradeRule: 'on-expiry', lifecycleStage: 'ga', shutdownDate: null, migrationTarget: null,
          history: [{ ...activeBinding, rolloutPercent: 140 }],
        }],
      },
      {
        ok: true,
        backends: [],
        names: [{
          publishedName: '千手·迅捷', tiers: ['basic'], maxOutputTokens: 1, order: 0,
          upgradeRule: 'on-expiry', lifecycleStage: 'ga', shutdownDate: null, migrationTarget: null,
          history: [{ ...activeBinding, backendKeys: [] }],
        }],
      },
    ]
    for (const value of broken) {
      expect(() => parseRouteCatalog(value)).toThrow(INVALID_ROUTE_RESPONSE)
    }
  })

  it('一条绑定的失效时刻早于生效时刻时拒绝（历史不能自相矛盾）', () => {
    const payload = namesPayload() as { names: { history: unknown[] }[] }
    payload.names[0]!.history = [{ ...activeBinding, effectiveFrom: NOW, effectiveTo: NOW - HOUR }]
    expect(() => parseRouteCatalog(payload)).toThrow(INVALID_ROUTE_RESPONSE)
  })
})

describe('追加绑定表单的时间校验（提交前挡住）', () => {
  const now = NOW

  it('过去时刻在提交前被挡住，并说明「必须在将来」', () => {
    const check = validateBindRequest(draft(), catalog(), now - HOUR, now)
    expect(check.ok).toBe(false)
    if (check.ok) throw new Error('unreachable')
    expect(check.message).toContain('生效时刻必须在将来')
  })

  it('生效时刻必须严格晚于同名字上一条绑定', () => {
    const check = validateBindRequest(draft(), catalog(), activeBinding.effectiveFrom, now)
    expect(check.ok).toBe(false)
    if (check.ok) throw new Error('unreachable')
    expect(check.message).toContain('绑定只允许往后追加')
    expect(check.message).toContain(formatEffectiveFrom(activeBinding.effectiveFrom))
  })

  it('恰好晚一毫秒即可通过，且请求体不带 operator（操作者由宿主按会话填入）', () => {
    // 上一条绑定已经排在未来（计划中）：新绑定只要比它晚一毫秒就不动历史。
    const planned = NOW + 48 * HOUR
    const future = catalog({ names: [{ ...nameRecord(), history: [{ ...activeBinding, effectiveFrom: planned }] }] })
    const late = validateBindRequest(draft(), future, planned + 1, NOW)
    expect(late.ok).toBe(true)
    if (!late.ok) throw new Error('unreachable')
    expect(late.request).toEqual({
      publishedName: '千手·迅捷', backendKeys: ['pro'], effectiveFrom: planned + 1,
      reason: '把主后端换成更强的那个', rolloutPercent: 100,
    })
    expect(Object.keys(late.request)).not.toContain('operator')
    // 同一时刻（不晚于）被拒：只允许往后追加。
    const equal = validateBindRequest(draft(), future, planned, NOW)
    expect(equal.ok).toBe(false)
  })

  it('没有历史的名字只需晚于「现在」', () => {
    const first = catalog({ names: [{ ...catalog().names[1]!, history: [] }] })
    expect(validateBindRequest(draft({ publishedName: '千手·强力' }), first, now + HOUR, now).ok).toBe(true)
  })

  it.each([
    ['未选名字', draft({ publishedName: '' }), '请选择一个已登记的前台名字'],
    ['空键位列表', draft({ backendKeys: [] }), '至少要选一个后端键位'],
    ['不认识的键位', draft({ backendKeys: ['turbo'] }), '不认识的后端键位：turbo'],
    ['重复键位', draft({ backendKeys: ['pro', 'pro'] }), '不能出现两次'],
    ['原因为空', draft({ reason: '   ' }), '请填写变更原因'],
    ['灰度非法', draft({ rolloutPercent: '101' }), '0 到 100 之间的整数'],
  ])('%s 被拒绝并给出可行动的中文原因', (_label, value, expected) => {
    const check = validateBindRequest(value, catalog(), now + HOUR, now)
    expect(check.ok).toBe(false)
    if (check.ok) throw new Error('unreachable')
    expect(check.message).toContain(expected)
  })

  it('同一份草稿在有效时刻下可以通过（证明拒绝来自时间而不是其它字段）', () => {
    const value = draft({ backendKeys: ['flash', 'pro'], rolloutPercent: '0' })
    expect(validateBindRequest(value, catalog(), now + 72 * HOUR, now).ok).toBe(true)
  })
})

describe('灰度百分比边界', () => {
  it.each([['0', 0], ['100', 100], ['37', 37]])('%s 解析为 %d', (text, expected) => {
    expect(parseRolloutPercent(text)).toBe(expected)
  })

  it.each([['-1'], ['101'], ['1.5'], [''], ['0100'], ['abc']])('%s 不是合法灰度值', (text) => {
    expect(parseRolloutPercent(text)).toBeNull()
  })

  it('0 与 100 都能通过表单校验，但都仍在未来生效', () => {
    expect(validateBindRequest(draft({ rolloutPercent: '0' }), catalog(), NOW + HOUR, NOW).ok).toBe(true)
    expect(validateBindRequest(draft({ rolloutPercent: '100' }), catalog(), NOW + HOUR, NOW).ok).toBe(true)
  })
})

describe('后端顺序调整与历史投影', () => {
  it('上移与下移只换一位，且不修改传入数组', () => {
    const keys = ['flash', 'pro'] as const
    expect(moveBackend(keys, 1, -1)).toEqual(['pro', 'flash'])
    expect(moveBackend(keys, 0, 1)).toEqual(['pro', 'flash'])
    expect(keys).toEqual(['flash', 'pro'])
  })

  it('越界移动原样返回同一引用（没有发生调整就不要造一份新历史）', () => {
    const keys = ['flash', 'pro'] as const
    expect(moveBackend(keys, 0, -1)).toBe(keys)
    expect(moveBackend(keys, 1, 1)).toBe(keys)
    expect(moveBackend(keys, 5, 1)).toBe(keys)
    expect(moveBackend([], 0, 1)).toEqual([])
  })

  it('移除与追加：不存在时原样返回，存在时不产生重复', () => {
    const keys = ['flash', 'pro'] as const
    expect(removeBackend(keys, 'flash')).toEqual(['pro'])
    expect(removeBackend(keys, 'turbo')).toBe(keys)
    expect(appendBackend(keys, 'flash')).toBe(keys)
    expect(appendBackend(keys, 'pro-plus')).toEqual(['flash', 'pro', 'pro-plus'])
    expect(appendBackend([], 'flash')).toEqual(['flash'])
  })

  it('绑定状态按生效区间判定：生效中 / 计划中 / 已失效', () => {
    expect(bindingPhase(activeBinding, NOW)).toBe('active')
    expect(bindingPhase(expiredBinding, NOW)).toBe('retired')
    expect(bindingPhase(scheduledBinding, NOW)).toBe('scheduled')
    expect(bindingPhase(proBinding, NOW)).toBe('active')
  })

  it('新绑定初值取当前生效的那条顺序；没有生效的就取最新的一条', () => {
    expect(seedBackendKeys(catalog(), '千手·迅捷', NOW)).toEqual(['flash', 'pro'])
    const onlyScheduled = catalog({
      names: [{ ...catalog().names[0]!, history: [scheduledBinding] }],
    })
    expect(seedBackendKeys(onlyScheduled, '千手·迅捷', NOW)).toEqual(['pro', 'flash'])
    // 从来没有绑定过的名字：退化成接口登记的后端顺序（不是空列表）。
    expect(seedBackendKeys(catalog(), '千手·轻量', NOW)).toEqual(['flash', 'pro'])
    expect(seedBackendKeys(catalog(), '不存在的名字', NOW)).toEqual(['flash', 'pro'])
  })

  it('上一条绑定的时刻就是追加下限', () => {
    expect(latestBindingAt([expiredBinding, activeBinding])).toBe(activeBinding.effectiveFrom)
    expect(latestBindingAt([expiredBinding, scheduledBinding, activeBinding])).toBe(scheduledBinding.effectiveFrom)
    expect(latestBindingAt([])).toBeNull()
  })
})

describe('本机时刻文本与失败分类', () => {
  it('本机时刻文本往返一致（表单预填与回读共用一份实现）', () => {
    const at = NOW + 37 * 60_000
    const text = toLocalInputValue(at)
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u)
    expect(fromLocalInputValue(text)).toBe(at - (at % 60_000))
  })

  it('不存在的日期与格式错误返回 null，而不是悄悄滚到下一个月', () => {
    expect(fromLocalInputValue('2026-02-31T10:00')).toBeNull()
    expect(fromLocalInputValue('2026-9-1T10:00')).toBeNull()
    expect(fromLocalInputValue('')).toBeNull()
  })

  it('预设生效时刻分别是 24 小时、3 天、7 天之后', () => {
    expect(presetEffectiveFrom('in-24h', NOW)).toBe(NOW + 24 * HOUR)
    expect(presetEffectiveFrom('in-3d', NOW)).toBe(NOW + 72 * HOUR)
    expect(presetEffectiveFrom('in-7d', NOW)).toBe(NOW + 168 * HOUR)
  })

  it('401 说「请先登录」而不是网络错误，并把服务端原因原样带回', () => {
    const failure = bindFailure(401, { ok: false, message: '请先登录。' })
    expect(failure.kind).toBe('not-signed-in')
    expect(failure.message).toBe('请先登录。')
  })

  it('403 说「需要管理员权限」，同样照抄服务端原因', () => {
    const failure = bindFailure(403, { ok: false, message: '这个操作需要管理员权限。' })
    expect(failure.kind).toBe('forbidden')
    expect(failure.message).toBe('这个操作需要管理员权限。')
  })

  it('400 的中文原因是可行动的：原样保留（例如「必须晚于上一条绑定」）', () => {
    const message = '生效时刻必须晚于上一条绑定（2026-09-15T00:00:00.000Z）'
    expect(bindFailure(400, { ok: false, message })).toEqual({ kind: 'invalid', message })
  })

  it('500 没有说明时退化成 HTTP 状态码，不伪造原因', () => {
    expect(bindFailure(500, null)).toEqual({ kind: 'request-failed', message: 'HTTP_500' })
    expect(serverMessage({ message: 'x' })).toBe('x')
    expect(serverMessage({ error: { code: 'A', message: 'y' } })).toBe('y')
    expect(serverMessage([1, 2])).toBeUndefined()
  })
})
