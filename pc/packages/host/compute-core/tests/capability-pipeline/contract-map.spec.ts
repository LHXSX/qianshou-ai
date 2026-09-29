/**
 * 工单 8 · 第 ② 步：本机清单 → 平台契约名映射。
 *
 * ## 这个测试防的是什么
 *
 * 节点今天的广告面来自**固定清单**（实测日志 `能力广告 · ["text.transform"]`），与"本机实际装了什么"
 * 没有自动映射。装了东西却不能报、或报了名字对不上，对主人的表现是**永远没单且查不出原因**。
 *
 * 因此本步的本体不是"映射成功的那部分"，而是**未映射清单**：任何本机项对不上契约名时，
 * 必须作为一条**带原因的记录**出现在结果里，而不是被 `filter` 掉。
 * 反面证据（本会话实测）：`contracts/v1/capabilities.registry.json` 自己就记着两组
 * `observed_unmapped_software` —— `tldextract` 与 `node/git/python3/ffprobe/bash`。
 * 如果这里静默过滤，那两组观测就等于没发生过。
 */
import { describe, expect, it } from 'vitest'
import {
  mapLocalItemsToContract,
  normalizeAdvertisedName,
  type LocalCapabilityItem,
} from '../../src/capability-pipeline/contract-map.ts'

describe('契约名别名归一（v1 规则：lowercase + hyphen-to-underscore）', () => {
  it('大小写与首尾空白归一到同一个 token', () => {
    expect(normalizeAdvertisedName('  FFmpeg ')).toBe('ffmpeg')
    expect(normalizeAdvertisedName('PyMuPDF')).toBe('pymupdf')
  })

  it('连字符与下划线归一成同一个 token（生产池里真实出现过 faster-whisper 广告）', () => {
    expect(normalizeAdvertisedName('faster-whisper')).toBe(normalizeAdvertisedName('faster_whisper'))
  })

  it('空输入保持空，不抛错（调用方自己决定空值算不算一项）', () => {
    expect(normalizeAdvertisedName('   ')).toBe('')
  })
})

describe('① 未映射项必须列清单，不许静默忽略', () => {
  it('本机真实工具清单里对不上契约名的项（ffprobe/bash/git）全部出现在未映射清单里', () => {
    const items: readonly LocalCapabilityItem[] = [
      { id: 'ffmpeg', kind: 'tool' },
      { id: 'ffprobe', kind: 'tool' },
      { id: 'bash', kind: 'tool' },
      { id: 'git', kind: 'tool' },
    ]
    const result = mapLocalItemsToContract(items)

    // ffmpeg 是注册表里真有实现的工具 ⇒ 映射成立。
    expect(result.capabilities).toContain('media.transcode')
    expect(result.mapped.filter(row => row.localId === 'ffmpeg').length).toBeGreaterThan(0)

    // 其余三项没有任何契约名 ⇒ 必须逐条带原因列出。
    expect(result.unmapped.map(item => item.localId).sort()).toEqual(['bash', 'ffprobe', 'git'])
    for (const item of result.unmapped) {
      expect(item.reason).toBe('NO_REGISTRY_IMPLEMENTATION')
      expect(item.detail.length).toBeGreaterThan(0)
    }
  })

  it('未映射清单按 localId 稳定排序，便于两次探测做 diff', () => {
    const result = mapLocalItemsToContract([
      { id: 'zzz-unknown', kind: 'plugin' },
      { id: 'aaa-unknown', kind: 'plugin' },
    ])
    expect(result.unmapped.map(item => item.localId)).toEqual(['aaa-unknown', 'zzz-unknown'])
    expect(result.capabilities).toEqual([])
  })

  it('空 id 与畸形名字各自有独立原因，不会被合并成"未知"', () => {
    const result = mapLocalItemsToContract([
      { id: '   ', kind: 'tool' },
      { id: 'Text Transform', kind: 'tool' },
    ])
    expect(result.unmapped.map(item => item.reason).sort()).toEqual(['EMPTY_INVENTORY_ITEM', 'MALFORMED_NAME'])
  })
})

describe('② 别名归一：旧式裸名与实现名都归到契约名', () => {
  it('旧式裸名 word_count（事故② 的形状）归一到 text.transform，而不是被丢掉', () => {
    const result = mapLocalItemsToContract([
      { id: 'word-count-runner', kind: 'workflow', capability: 'word_count' },
    ])
    expect(result.capabilities).toEqual(['text.transform'])
    expect(result.mapped).toEqual([
      expect.objectContaining({ localId: 'word-count-runner', capability: 'text.transform', via: 'legacy-task-type' }),
    ])
    expect(result.unmapped).toEqual([])
  })

  it('已经写对的契约名按原样收下（via = direct-contract-name）', () => {
    const result = mapLocalItemsToContract([
      { id: 'film-host', kind: 'workflow', capability: 'media.compose' },
    ])
    expect(result.mapped[0]?.via).toBe('direct-contract-name')
    expect(result.unmapped).toEqual([])
  })

  it('一个实现可以满足多个契约能力（ffmpeg 一条覆盖 5 项），每条都留来源', () => {
    const result = mapLocalItemsToContract([{ id: 'ffmpeg', kind: 'tool' }])
    expect(result.capabilities).toEqual([
      'audio.extract',
      'audio.transcode',
      'media.probe',
      'media.thumbnail',
      'media.transcode',
    ])
    expect(result.mapped.every(row => row.via === 'implementation')).toBe(true)
  })

  it('实现名的大小写/连字符差异照样命中（PIL → pillow）', () => {
    const result = mapLocalItemsToContract([{ id: 'PIL', kind: 'package' }])
    expect(result.capabilities).toContain('image.transform')
    expect(result.unmapped).toEqual([])
  })

  it('本机模型项归到 llm.generate.local，最终能否广告由健康自检决定（标记 via）', () => {
    const result = mapLocalItemsToContract([{ id: 'qwen3:8b', kind: 'model' }])
    expect(result.capabilities).toEqual(['llm.generate.local'])
    expect(result.mapped[0]?.via).toBe('executor-self-test')
  })
})

describe('角色组（AND）不满时不许假装映射成立', () => {
  it('只装了 requests：web.fetch 因缺 html_parser 不成立，requests 进未映射清单并说明缺什么', () => {
    const result = mapLocalItemsToContract([{ id: 'requests', kind: 'package' }])
    expect(result.capabilities).toEqual([])
    expect(result.unmapped).toEqual([
      expect.objectContaining({ localId: 'requests', reason: 'ROLE_GROUP_INCOMPLETE' }),
    ])
    expect(result.incompleteGroups).toEqual([
      expect.objectContaining({ capability: 'web.fetch', missingRoles: ['html_parser'] }),
    ])
  })

  it('requests + selectolax 补齐 web.fetch 后，两项都记为 set-completion 映射', () => {
    const result = mapLocalItemsToContract([
      { id: 'requests', kind: 'package' },
      { id: 'selectolax', kind: 'package' },
    ])
    expect(result.capabilities).toEqual(['web.fetch'])
    expect(result.mapped.map(row => row.localId).sort()).toEqual(['requests', 'selectolax'])
    expect(result.mapped.every(row => row.via === 'set-completion')).toBe(true)
    // web.extract 仍缺 content_extractor ⇒ 不许顺手报出去。
    expect(result.capabilities).not.toContain('web.extract')
    expect(result.incompleteGroups).toEqual([
      expect.objectContaining({ capability: 'web.extract', missingRoles: ['content_extractor'] }),
    ])
  })

  it('只装了 selectolax：两个角色组都缺，两组缺失都要列出来', () => {
    const result = mapLocalItemsToContract([{ id: 'selectolax', kind: 'package' }])
    expect(result.incompleteGroups.map(group => group.capability)).toEqual(['web.extract', 'web.fetch'])
    expect(result.unmapped).toEqual([
      expect.objectContaining({ localId: 'selectolax', reason: 'ROLE_GROUP_INCOMPLETE' }),
    ])
  })
})
