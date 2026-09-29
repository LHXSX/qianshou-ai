/** 纯函数工具测试：确认令牌校验、diff 行构造、CIDR 覆盖判断、就绪度排序。 */

import { describe, expect, it } from 'vitest'
import { apply, MIN_REASON_LENGTH, remainingMs } from '../src/api/confirm'
import { flattenDiffRows, rowChanged } from '../src/utils/diff-rows'
import { cidrContainsIp } from '../src/utils/cidr'
import { moduleStatusMeta, sortModules } from '../src/utils/module-status'
import { formatDuration, formatSignedSp, formatTime, stringifyDiffValue } from '../src/utils/format'

describe('两步确认（api/confirm）', () => {
  it('reason 少于 4 字时本地就拒绝，不发请求', async () => {
    await expect(apply('/apply', 'token', '太短')).rejects.toThrowError(
      new RegExp(`至少需要 ${MIN_REASON_LENGTH} 个字`),
    )
    await expect(apply('/apply', 'token', '   ')).rejects.toBeInstanceOf(Error)
  })

  it('剩余时间不为负', () => {
    const preview = { token: 't', expiresAt: 1000, diff: { before: null, after: null } }
    expect(remainingMs(preview, 500)).toBe(500)
    expect(remainingMs(preview, 5000)).toBe(0)
  })
})

describe('flattenDiffRows', () => {
  it('合并两侧键并标记真正变化的行', () => {
    const rows = flattenDiffRows({ enabled: false, rolloutPercent: 0 }, { enabled: true, rolloutPercent: 0, note: 'x' })
    expect(rows.map(row => row.path)).toEqual(['enabled', 'note', 'rolloutPercent'])
    expect(rows.find(row => row.path === 'enabled')?.after).toBe('true')
    expect(rowChanged(rows.find(row => row.path === 'enabled')!)).toBe(true)
    expect(rowChanged(rows.find(row => row.path === 'rolloutPercent')!)).toBe(false)
    // 缺失字段显示为占位文本，而不是 undefined
    expect(rows.find(row => row.path === 'note')?.before).toBe('（未提供）')
  })

  it('非对象值退化为整行对比', () => {
    const rows = flattenDiffRows('a', 'b')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.before).toBe('a')
  })
})

describe('cidrContainsIp', () => {
  it('按前缀匹配 IPv4', () => {
    expect(cidrContainsIp('203.0.113.0/24', '203.0.113.7')).toBe(true)
    expect(cidrContainsIp('203.0.113.0/24', '203.0.114.7')).toBe(false)
    expect(cidrContainsIp('127.0.0.1/32', '127.0.0.1')).toBe(true)
    expect(cidrContainsIp('0.0.0.0/0', '8.8.8.8')).toBe(true)
  })

  it('无法判断时返回 false，不猜', () => {
    expect(cidrContainsIp('2001:db8::/32', '2001:db8::1')).toBe(false)
    expect(cidrContainsIp('not-a-cidr', '203.0.113.7')).toBe(false)
    expect(cidrContainsIp('203.0.113.0/99', '203.0.113.7')).toBe(false)
    expect(cidrContainsIp('203.0.113.0/24', '999.1.1.1')).toBe(false)
  })
})

describe('就绪度展示映射', () => {
  it('三档各有一_tagType，未知档位不静默', () => {
    expect(moduleStatusMeta('ready').tagType).toBe('success')
    expect(moduleStatusMeta('read-only').tagType).toBe('warning')
    expect(moduleStatusMeta('dependency-unavailable').tagType).toBe('danger')
    expect(moduleStatusMeta('brand-new-status').label).toContain('brand-new-status')
  })

  it('排序稳定，未知模块排在末尾', () => {
    const sorted = sortModules([
      { key: 'zzz' },
      { key: 'rbac' },
      { key: 'account' },
    ])
    expect(sorted.map(item => item.key)).toEqual(['account', 'rbac', 'zzz'])
  })
})

describe('展示格式化', () => {
  it('空值显示为占位符而不是 0', () => {
    expect(formatTime(undefined)).toBe('—')
    expect(formatTime(0)).toBe('—')
    expect(formatDuration(null)).toBe('—')
    expect(formatSignedSp(undefined)).toBe('—')
    expect(stringifyDiffValue(undefined)).toBe('（未提供）')
  })

  it('时间戳格式化到秒', () => {
    const text = formatTime(new Date(2023, 10, 15, 9, 5, 3).getTime())
    expect(text).toBe('2023-11-15 09:05:03')
  })

  it('时长按量级选单位', () => {
    expect(formatDuration(3 * 86400_000 + 4 * 3600_000)).toBe('3 天 4 小时 0 分')
    expect(formatDuration(90_000)).toBe('1 分 30 秒')
    expect(formatDuration(5_000)).toBe('5 秒')
  })

  it('SP 带正负号', () => {
    expect(formatSignedSp(12)).toBe('+12')
    expect(formatSignedSp(-12)).toBe('-12')
  })
})
