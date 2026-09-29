/**
 * Markdown 解析的契约测试。
 *
 * 这些用例锁的是**渲染正确性**：标记不能被吃掉、也不能裸露出来。
 * 尤其覆盖流式期间的半截文本——那是实际观感最容易崩的地方。
 */
import { describe, expect, it } from 'vitest'
import { blocksToPlainText, parseBlocks, parseInline, type Inline } from '../src/markdown.ts'

/** 取第一个块的文本，便于断言。 */
function firstLine(source: string): string {
  const block = parseBlocks(source)[0]
  if (block === undefined) return ''
  return blocksToPlainText([block])
}

describe('行内解析', () => {
  it('纯文本原样返回', () => {
    expect(parseInline('就是一句话')).toEqual([{ kind: 'text', text: '就是一句话' }])
  })

  it('粗体被识别，标记不进入文本', () => {
    expect(parseInline('这是**重点**内容')).toEqual([
      { kind: 'text', text: '这是' },
      { kind: 'strong', text: '重点' },
      { kind: 'text', text: '内容' },
    ])
  })

  it('双下划线粗体同样识别', () => {
    expect(parseInline('__重点__')).toEqual([{ kind: 'strong', text: '重点' }])
  })

  it('斜体被识别', () => {
    expect(parseInline('*斜*体')).toEqual([
      { kind: 'em', text: '斜' },
      { kind: 'text', text: '体' },
    ])
  })

  it('单独的星号不被误判为强调（a * b 这种乘法场景）', () => {
    expect(parseInline('3 * 4 = 12')).toEqual([{ kind: 'text', text: '3 * 4 = 12' }])
  })

  it('行内代码优先于强调，反引号内容原样保留', () => {
    expect(parseInline('用 `**x**` 表示粗体')).toEqual([
      { kind: 'text', text: '用 ' },
      { kind: 'code', text: '**x**' },
      { kind: 'text', text: ' 表示粗体' },
    ])
  })

  it('链接拆成文字与地址', () => {
    expect(parseInline('见[文档](https://example.com/a)')).toEqual([
      { kind: 'text', text: '见' },
      { kind: 'link', text: '文档', href: 'https://example.com/a' },
    ])
  })

  it('未闭合的粗体标记当普通文本，不吃掉后面的内容', () => {
    expect(parseInline('**没闭合')).toEqual([{ kind: 'text', text: '**没闭合' }])
  })

  it('中文与标点不会被标点规则误伤', () => {
    expect(parseInline('他说：「好的。」')).toEqual([{ kind: 'text', text: '他说：「好的。」' }])
  })
})

describe('块级解析', () => {
  it('标题按层数识别', () => {
    expect(parseBlocks('### 三级标题')[0]).toEqual({
      kind: 'heading', level: 3, inline: [{ kind: 'text', text: '三级标题' }],
    })
  })

  it('井号后没有空格时不当作标题', () => {
    expect(parseBlocks('#不是标题')[0]?.kind).toBe('paragraph')
  })

  it('无序列表聚成一个块', () => {
    const block = parseBlocks('- 甲\n- 乙\n- 丙')[0]
    expect(block?.kind).toBe('list')
    if (block?.kind !== 'list') return
    expect(block.ordered).toBe(false)
    expect(block.items).toHaveLength(3)
  })

  it('有序列表标记为 ordered，序号本身不进入文本', () => {
    const block = parseBlocks('1. 第一\n2. 第二')[0]
    expect(block?.kind).toBe('list')
    if (block?.kind !== 'list') return
    expect(block.ordered).toBe(true)
    expect(blocksToPlainText([block])).toBe('• 第一\n• 第二')
  })

  it('引用聚成一个块', () => {
    const block = parseBlocks('> 第一行\n> 第二行')[0]
    expect(block?.kind).toBe('quote')
    expect(blocksToPlainText([block as never])).toBe('第一行\n第二行')
  })

  it('分隔线独占一块', () => {
    expect(parseBlocks('---')[0]).toEqual({ kind: 'rule' })
  })

  it('围栏代码块保留原文与语言', () => {
    const block = parseBlocks('```ts\nconst a = 1\n```')[0]
    expect(block).toEqual({ kind: 'code', lang: 'ts', text: 'const a = 1' })
  })

  it('未闭合的围栏按"代码块到结尾"处理，不把反引号漏到段落里', () => {
    const blocks = parseBlocks('说明如下：\n```py\nprint("hi")')
    expect(blocks[0]?.kind).toBe('paragraph')
    expect(blocks[1]?.kind).toBe('code')
    expect(blocksToPlainText([blocks[1] as never])).toBe('print("hi")')
  })

  it('连续普通行合成一个段落，空行分段', () => {
    const blocks = parseBlocks('第一行\n第二行\n\n第三段')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.kind).toBe('paragraph')
    if (blocks[0]?.kind !== 'paragraph') return
    expect(blocks[0].lines).toHaveLength(2)
  })

  it('列表紧跟段落时能正确断开', () => {
    const blocks = parseBlocks('先说明：\n- 甲\n- 乙')
    expect(blocks.map(b => b.kind)).toEqual(['paragraph', 'list'])
  })
})

describe('流式期间的半截文本', () => {
  it('只到 `**` 时不报错也不吞字', () => {
    const blocks = parseBlocks('这是**')
    expect(blocksToPlainText(blocks)).toContain('这是')
  })

  it('半个代码围栏内没有裸露的反引号', () => {
    const blocks = parseBlocks('例子：\n```\ncode here')
    const plain = blocksToPlainText(blocks)
    expect(plain).not.toContain('```')
    expect(plain).toContain('code here')
  })

  it('空文本产生空块列表', () => {
    expect(parseBlocks('')).toEqual([])
  })
})

/**
 * 模型最常输出的两种格式：表格与嵌套列表。
 *
 * 这两条都是用户实报的"输出很乱"的直接原因，所以断言写到具体形状上：
 * 以前表格整块变成一个段落、`| 方案 | 成本 |` 原样显示；嵌套的子弹点会被拍平到顶层，
 * 有序列表还被拆成两个 `<ol>` 显示成「1. 1.」。
 */
/** 把一段行内内容还原成纯文本；断言表格单元格时用。 */
function plainInline(parts: readonly Inline[]): string {
  return blocksToPlainText([{ kind: 'paragraph', lines: [parts] }])
}

describe('表格', () => {
  const TABLE = '| 方案 | 成本 | 周期 |\n| --- | :--: | ---: |\n| A | 低 | 2 周 |\n| B | 中 | 1 月 |'

  it('识别成表格块，而不是一个塞满竖线的段落', () => {
    const block = parseBlocks(TABLE)[0]
    expect(block?.kind).toBe('table')
  })

  it('表头、数据行与对齐方式都取到了', () => {
    const block = parseBlocks(TABLE)[0]
    if (block?.kind !== 'table') throw new Error('没有解析成表格')
    expect(block.header.map(plainInline)).toEqual(['方案', '成本', '周期'])
    expect(block.rows).toHaveLength(2)
    expect(block.align).toEqual([null, 'center', 'right'])
  })

  it('少写最后一列的网关也能补齐，不会串列', () => {
    const block = parseBlocks('| A | B | C |\n| --- | --- | --- |\n| 1 | 2 |')[0]
    if (block?.kind !== 'table') throw new Error('没有解析成表格')
    expect(block.rows[0]).toHaveLength(3)
    expect(plainInline(block.rows[0]?.[2] ?? [])).toBe('')
  })

  it('单元格里的行内标记照样解析', () => {
    const block = parseBlocks('| 项 | 说明 |\n| --- | --- |\n| **重要** | `code` |')[0]
    if (block?.kind !== 'table') throw new Error('没有解析成表格')
    expect(block.rows[0]?.[0]?.[0]?.kind).toBe('strong')
    expect(block.rows[0]?.[1]?.[0]?.kind).toBe('code')
  })

  it('正文里单独一行竖线不被误判成表格', () => {
    // 表格必须有分隔行才算数；否则普通文本里的 `|` 会被吃掉。
    const block = parseBlocks('a | b\n下一行是普通文字')[0]
    expect(block?.kind).toBe('paragraph')
  })

  it('还原成纯文本时按列拼回，复制出去仍看得清', () => {
    expect(blocksToPlainText(parseBlocks(TABLE))).toBe('方案 | 成本 | 周期\nA | 低 | 2 周\nB | 中 | 1 月')
  })
})

describe('列表嵌套', () => {
  const NESTED = '1. 第一步：先做调研\n   - 用户访谈\n   - 竞品拆解\n2. 第二步：再定方案'

  it('缩进的子弹点是子块，挂在父条目下面', () => {
    const block = parseBlocks(NESTED)[0]
    if (block?.kind !== 'list') throw new Error('没有解析成列表')
    expect(block.items).toHaveLength(2)
    expect(block.items[0]?.sub).toHaveLength(1)
    expect(block.items[0]?.sub[0]?.kind).toBe('list')
    expect(block.items[1]?.sub).toHaveLength(0)
  })

  it('两条编号同属一个有序列表，所以显示的是 1. 2. 而不是 1. 1.', () => {
    const blocks = parseBlocks(NESTED)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.kind).toBe('list')
  })

  it('列表项里没缩进的普通行，作为该项的子段落', () => {
    const block = parseBlocks('- 第一条\n  这一行属于第一条\n- 第二条')[0]
    if (block?.kind !== 'list') throw new Error('没有解析成列表')
    expect(block.items[0]?.sub[0]?.kind).toBe('paragraph')
    expect(block.items).toHaveLength(2)
  })

  it('子层结束、回到同层继续列，不会被吃掉', () => {
    const block = parseBlocks('- 甲\n  - 甲一\n- 乙')[0]
    if (block?.kind !== 'list') throw new Error('没有解析成列表')
    expect(block.items.map(item => plainInline(item.inline))).toEqual(['甲', '乙'])
    expect(block.items[1]?.sub).toHaveLength(0)
  })

  it('纯文本还原用缩进表示层级，子要点不与父条目混在一起', () => {
    expect(blocksToPlainText(parseBlocks(NESTED))).toBe('• 第一步：先做调研\n  • 用户访谈\n  • 竞品拆解\n• 第二步：再定方案')
  })
})

describe('纯文本还原', () => {
  it('粗体与其他标记都被去掉', () => {
    const plain = blocksToPlainText(parseBlocks('## 标题\n\n这是**重点**与`代码`'))
    expect(plain).toBe('标题\n\n这是重点与代码')
  })

  it('列表还原为项目符号', () => {
    expect(blocksToPlainText(parseBlocks('- 甲\n- 乙'))).toBe('• 甲\n• 乙')
  })

  it('firstLine 辅助函数取到首块', () => {
    expect(firstLine('# 标题\n正文')).toBe('标题')
  })
})
