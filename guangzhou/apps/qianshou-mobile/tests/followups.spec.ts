/**
 * 连带问题：内容必须跟着话题走，且点下去真的发出去。
 *
 * 背景：界面上原来挂的是 `data.ts` 里写死的三条示例（特斯拉、比亚迪、PPT 大纲），
 * 用户问什么都显示这三条；而且点了只把文字填进输入框，不会发送。这两条都是用户
 * 直接反馈的问题，所以这里逐条钉住。
 */
import { describe, expect, it } from 'vitest'
import { asksHowTo, deriveFollowUps, extractKeywords, isYesNoQuestion } from '../src/followups.ts'

/** 任何一句都必然带上话题词；这是"不许跑题"的最小判据。 */
function allMention(list: readonly { readonly text: string }[], word: string): boolean {
  return list.every(item => item.text.includes(word))
}

describe('关键词：只取表里认得的实词', () => {
  it('中文按词典收词，助词与泛词不进候选', () => {
    const words = extractKeywords('帮我分析一下这个行业的市场机会')
    expect(words).toContain('行业')
    for (const noise of ['帮我', '一下', '这个', '的']) expect(words).not.toContain(noise)
  })

  it('顺序就是出现顺序：先谈到的那个词当主题', () => {
    expect(extractKeywords('帮我分析一下跨境电商的物流成本')[0]).toBe('跨境')
  })

  it('拉丁词整体收下，纯数字不算话题', () => {
    expect(extractKeywords('用 Nginx 做反向代理')).toContain('Nginx')
    expect(extractKeywords('现在是 2026 年')).toEqual([])
  })

  it('表里没有的词一个都不猜——猜错行业比给通用追问更糟', () => {
    // 「结构化」「说明」这类词不在表里，宁可空手而归。
    expect(extractKeywords('请给我一份结构化的说明')).toEqual([])
    expect(extractKeywords('你好')).toEqual([])
    expect(extractKeywords('谢谢')).toEqual([])
  })
})

describe('问句类型：决定追问问结论还是问做法', () => {
  it('「吗/是否」问句', () => {
    expect(isYesNoQuestion('这个方案能落地吗')).toBe(true)
    expect(isYesNoQuestion('是否值得投入')).toBe(true)
    expect(isYesNoQuestion('帮我写一份总结')).toBe(false)
  })

  it('问做法的句子', () => {
    expect(asksHowTo('怎么把周报自动化')).toBe(true)
    expect(asksHowTo('这份合同有什么风险')).toBe(false)
  })
})

describe('派生追问：贴话题、可点击发送、永不空白', () => {
  it('每一条都带上当前话题词，不再出现写死的示例', () => {
    const list = deriveFollowUps('帮我分析一下跨境电商的物流成本')
    expect(list.length).toBeGreaterThanOrEqual(2)
    expect(allMention(list, '跨境')).toBe(true)
    const flat = list.map(item => item.text).join('｜')
    expect(flat).not.toContain('特斯拉')
    expect(flat).not.toContain('比亚迪')
    expect(flat).not.toContain('PPT')
  })

  it('换个话题就换一批，绝不出现上一轮的关键词', () => {
    const medical = deriveFollowUps('帮我把这份医学影像数据整理一下')
    const flat = medical.map(item => item.text).join('｜')
    expect(flat).not.toContain('跨境')
  })

  it('问做法时给的是可执行方向', () => {
    const list = deriveFollowUps('怎么把发布流程做成自动的')
    expect(list.map(item => item.text).join('｜')).toMatch(/步骤|坑|清单/)
  })

  it('是非问句给的是展开和收口，不是再来一次是怎么做', () => {
    const list = deriveFollowUps('这个价格合理吗')
    expect(list.map(item => item.text).join('｜')).toMatch(/展开|注意|清单/)
  })

  it('客套话这类没有话题的输入：给通用追问，而不是空数组或别行业的词', () => {
    const list = deriveFollowUps('你好')
    expect(list.length).toBeGreaterThanOrEqual(2)
    const flat = list.map(item => item.text).join('｜')
    expect(flat).not.toContain('特斯拉')
    expect(flat).not.toContain('行业')
  })

  it('标签放得下：正文本身就短，不用靠省略号硬切', () => {
    // 手机上实测过：靠 `text-overflow` 切出来的「展开说说请给我一份结构…」
    // 既看不出要问什么，又占了两倍宽度。所以要求**正文**本身就足够短。
    for (const question of ['帮我分析一下跨境电商的物流成本', '你好', '这个价格合理吗', '用 Nginx 做反向代理']) {
      for (const item of deriveFollowUps(question)) {
        expect(item.label.length).toBeLessThanOrEqual(16)
        expect(item.text.length).toBeLessThanOrEqual(18)
        expect(item.text).not.toContain('…')
        expect(item.text.trim()).toBe(item.text)
        expect(item.text.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('气泡排版：换行必须活下来', () => {
  it('用户气泡保留换行，否则手机上粘贴的多行会挤成一坨', async () => {
    const { readFileSync } = await import('node:fs')
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
    const rule = /\.bubble-user\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(rule).toContain('white-space: pre-wrap')
    expect(rule).toContain('overflow-wrap')
  })

  it('时间戳在气泡外面，不再把气泡底部撑肿', async () => {
    const { readFileSync } = await import('node:fs')
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
    const rule = /\.bubble-time\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(rule).toContain('margin')
    expect(rule).not.toContain('opacity')
  })
})

describe('界面接线：点击等于发送', () => {
  it('连带问题接的是发送函数，不是"填进输入框"', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
    expect(source).toContain('onFollow={sendText}')
    // `openChat` 只把文字放进输入框；它再出现在 onFollow 上就是回归。
    expect(source).not.toMatch(/onFollow=\{openChat\}/)
  })

  it('写死的示例已经删掉，没有第二条链路再读它', async () => {
    const { readFileSync } = await import('node:fs')
    const data = readFileSync(new URL('../src/data.ts', import.meta.url), 'utf8')
    expect(data).not.toMatch(/export const FOLLOWUPS/)
  })
})
