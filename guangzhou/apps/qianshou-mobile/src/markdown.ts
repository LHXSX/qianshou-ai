/**
 * 轻量 Markdown 解析：把模型回复解析成结构化的块与行内片段。
 *
 * ## 为什么自己写
 * 模型回复的是 Markdown，而界面直接按 `\n` 切行原样显示，于是 `**粗体**`、
 * `- 列表`、`1. 序号`、``` 代码块 ``` 全部裸露出来——这正是"看起来乱"的原因。
 *
 * 引入通用 Markdown 库（marked / markdown-it / react-markdown）会给一个
 * 68KB gzip 的手机页面再加几十到几百 KB，而对话里真正出现的语法只有有限几种。
 * 所以这里只实现**会实际出现**的子集，并且**解析与渲染分离**：
 * 解析结果是纯数据，可以在没有 DOM 的环境里把边界完整测到。
 *
 * ## 支持范围（刻意有限）
 * 块级：段落、标题（#~######）、无序列表（- * +）、有序列表（1.）、引用（>）、
 *       围栏代码块（```）、分隔线（---）
 * 行内：粗体（**x** / __x__）、斜体（*x* / _x_）、行内代码（`x`）、
 *       链接（[文字](地址)）
 *
 * **刻意不做**：嵌套列表、表格、HTML 直出、脚注。
 * 遇到不认识的语法一律当普通文本——宁可朴素，也不要把内容吃掉。
 */

/** 行内片段。 */
export type Inline =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'strong'; readonly text: string }
  | { readonly kind: 'em'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'link'; readonly text: string; readonly href: string }

/**
 * 列表项。
 *
 * `sub` 是缩进在它下面的子内容：模型经常用
 * `1. 第一步\n   - 子要点` 这种结构，拍平之后就分不清谁属于谁，
 * 编号还会被拆成两个独立的 `<ol>` 显示成「1. 1.」。
 */
export interface ListItem {
  readonly inline: readonly Inline[]
  readonly sub: readonly Block[]
}

/** 块级节点。 */
export type Block =
  | { readonly kind: 'paragraph'; readonly lines: readonly (readonly Inline[])[] }
  | { readonly kind: 'heading'; readonly level: number; readonly inline: readonly Inline[] }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly ListItem[] }
  | { readonly kind: 'quote'; readonly lines: readonly (readonly Inline[])[] }
  | { readonly kind: 'code'; readonly lang: string; readonly text: string }
  | { readonly kind: 'rule' }
  | { readonly kind: 'table'; readonly header: readonly (readonly Inline[])[]; readonly rows: readonly (readonly (readonly Inline[])[])[]; readonly align: readonly TableAlign[] }

/** 表格单元格的对齐方式，来自分隔行里的冒号。 */
export type TableAlign = 'left' | 'center' | 'right' | null

/** 围栏开始/结束的正则；允许 ``` 后跟语言名。 */
const FENCE = /^\s*(```+|~~~+)\s*([A-Za-z0-9_+-]*)\s*$/
/** 标题：1~6 个 # 后至少一个空格。 */
const HEADING = /^(#{1,6})\s+(.*)$/
/** 无序列表项；捕获前导空白用于判断层级。 */
const BULLET = /^(\s*)[-*+]\s+(.*)$/
/** 有序列表项。 */
const ORDERED = /^(\s*)[0-9]+[.)]\s+(.*)$/
/** 引用行。 */
const QUOTE = /^\s*>\s?(.*)$/
/** 分隔线：三个以上的 - * _（允许中间空格）。 */
const RULE = /^\s*([-*_])\s*(?:\1\s*){2,}$/
/** 表格分隔行：`| --- | :--: |` 这种。 */
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

/** 一个 tab 当几格宽。 */
const TAB_WIDTH = 4
/** 一个空格当几格宽。 */
const SPACE_WIDTH = 1

/** 数出这一行前导空白占几格。 */
function indentOf(line: string): number {
  let width = 0
  for (const ch of line) {
    if (ch === ' ') width += SPACE_WIDTH
    else if (ch === '\t') width += TAB_WIDTH
    else break
  }
  return width
}

/**
 * 按竖线切开一行表格。
 * @param line - 原始行。
 * @returns 每个单元格的原文（已去首尾空白）；不是表格行时返回空数组。
 */
function splitRow(line: string): string[] {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return []
  // 首尾的竖线只是边框，不算列分隔。
  const body = trimmed.replace(/^\|/, '').replace(/\|$/, '')
  return body.split('|').map(cell => cell.trim())
}

/** 分隔行决定每一列的对齐方式。 */
function alignOf(separator: string): readonly TableAlign[] {
  return splitRow(separator).map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return null
  })
}

/**
 * 解析行内语法。
 *
 * 用单次扫描而不是多次正则替换：后者在 `**a `b` c**` 这类嵌套下会把标记吃错位。
 * @param text - 一行原始文本。
 * @returns 行内片段序列；纯文本时返回单个 `text` 片段。
 */
export function parseInline(text: string): readonly Inline[] {
  const out: Inline[] = []
  let buffer = ''
  let index = 0

  /** 把已累积的普通文本冲进结果，避免产生空片段。 */
  const flush = (): void => {
    if (buffer.length > 0) { out.push({ kind: 'text', text: buffer }); buffer = '' }
  }

  while (index < text.length) {
    const rest = text.slice(index)

    // 行内代码：优先于强调，否则 `**x**` 会被当成粗体的一部分。
    const code = /^`([^`]+)`/.exec(rest)
    if (code !== null) { flush(); out.push({ kind: 'code', text: code[1] ?? '' }); index += code[0].length; continue }

    // 链接 [文字](地址)
    const link = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest)
    if (link !== null) {
      flush()
      out.push({ kind: 'link', text: link[1] ?? '', href: link[2] ?? '' })
      index += link[0].length
      continue
    }

    // 粗体 **x** 或 __x__
    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest)
    if (strong !== null) { flush(); out.push({ kind: 'strong', text: strong[2] ?? '' }); index += strong[0].length; continue }

    // 斜体 *x* 或 _x_（要求两侧都是非空格，避免把 a * b 误判）
    const em = /^(\*|_)(?=\S)([\s\S]*?\S)\1/.exec(rest)
    if (em !== null) { flush(); out.push({ kind: 'em', text: em[2] ?? '' }); index += em[0].length; continue }

    buffer += text[index]
    index += 1
  }
  flush()
  return out
}

/**
 * 把整段文本解析成块。
 *
 * 流式期间文本是不完整的：末尾可能停在半个围栏或半个粗体上。这里对**未闭合的
 * 围栏**按"代码块到结尾"处理，因为把半截代码当普通段落渲染会闪出大量星号与井号。
 * @param source - 完整或正在增长的文本。
 * @returns 块序列。
 */
/**
 * 解析块级结构。
 *
 * 递归实现，因为列表项下面可以挂子内容。`indent` 是「本层内容必须至少缩进到几格」：
 * 顶层从 0 开始，进入某个列表项之后传它自己的缩进 + 1，这样
 * `1. 第一步` 后面缩进的 `- 子要点` 会变成**它的子块**，而不是另起一个顶层列表。
 * @param source - 整段 Markdown 原文。
 * @returns 块级节点序列。
 */
export function parseBlocks(source: string): readonly Block[] {
  return parseRange(source.split('\n'), 0, 0)[0]
}

/**
 * 解析若干行。
 * @param lines - 全部行。
 * @param from - 起始下标。
 * @param indent - 本层内容至少要有的缩进格数。
 * @returns 解析出的块，以及停下来的下标（遇到更浅的内容就把控制权交回上层）。
 */
function parseRange(lines: readonly string[], from: number, indent: number): readonly [readonly Block[], number] {
  const blocks: Block[] = []
  let paragraph: string[] = []

  /** 冲掉累积中的段落。 */
  const flushParagraph = (): void => {
    if (paragraph.length > 0) { blocks.push({ kind: 'paragraph', lines: paragraph.map(parseInline) }); paragraph = [] }
  }

  let index = from
  while (index < lines.length) {
    const line = lines[index] ?? ''

    // 比本层更浅的内容不属于这里：原样交回上层。
    if (line.trim().length > 0 && indentOf(line) < indent) break

    // 围栏代码块
    const fence = FENCE.exec(line)
    if (fence !== null) {
      flushParagraph()
      const marker = fence[1] ?? '```'
      const lang = fence[2] ?? ''
      const body: string[] = []
      index += 1
      let closed = false
      while (index < lines.length) {
        const inner = lines[index] ?? ''
        const end = FENCE.exec(inner)
        if (end !== null && (end[1] ?? '').startsWith(marker.charAt(0))) { closed = true; index += 1; break }
        body.push(inner)
        index += 1
      }
      // 未闭合也要出块：半截代码留在普通段落里会露出反引号。
      blocks.push({ kind: 'code', lang, text: body.join('\n') })
      void closed
      continue
    }

    if (RULE.test(line)) { flushParagraph(); blocks.push({ kind: 'rule' }); index += 1; continue }

    const heading = HEADING.exec(line)
    if (heading !== null) {
      flushParagraph()
      blocks.push({ kind: 'heading', level: (heading[1] ?? '').length, inline: parseInline(heading[2] ?? '') })
      index += 1
      continue
    }

    // 表格：当前行像表格行、且下一行是分隔行时才成立。
    // 少了这层判定，正文里单独一个 `|` 会被误判成表格。
    const nextLine = lines[index + 1]
    if (nextLine !== undefined && TABLE_SEPARATOR.test(nextLine) && splitRow(line).length > 0) {
      const header = splitRow(line)
      const align = alignOf(nextLine)
      const rows: string[][] = []
      index += 2
      while (index < lines.length) {
        const rowLine = lines[index] ?? ''
        if (rowLine.trim().length === 0) break
        const cells = splitRow(rowLine)
        if (cells.length === 0) break
        rows.push(cells)
        index += 1
      }
      flushParagraph()
      blocks.push({
        kind: 'table',
        header: header.map(parseInline),
        // 补齐到表头列数：模型经常少写最后一列的空单元格。
        rows: rows.map(cells => header.map((_, column) => parseInline(cells[column] ?? ''))),
        align: header.map((_, column) => align[column] ?? null),
      })
      continue
    }

    const quote = QUOTE.exec(line)
    if (quote !== null) {
      flushParagraph()
      const body: string[] = [quote[1] ?? '']
      index += 1
      while (index < lines.length) {
        const more = QUOTE.exec(lines[index] ?? '')
        if (more === null) break
        body.push(more[1] ?? '')
        index += 1
      }
      blocks.push({ kind: 'quote', lines: body.map(parseInline) })
      continue
    }

    const bullet = BULLET.exec(line)
    const ordered = ORDERED.exec(line)
    if (bullet !== null || ordered !== null) {
      flushParagraph()
      const isOrdered = ordered !== null
      const listIndent = indentOf(line)
      const items: ListItem[] = []
      while (index < lines.length) {
        const current = lines[index] ?? ''
        const marker = isOrdered ? ORDERED.exec(current) : BULLET.exec(current)
        if (marker === null) break
        // 同层的才并入这一条列表；更深的内容留给递归去当子块。
        if (indentOf(current) !== listIndent) break
        const inline = parseInline(marker[2] ?? '')
        index += 1
        // 紧跟在后面的、缩进更深的内容，就是这个列表项的子块。
        const nested = index < lines.length
          && (lines[index] ?? '').trim().length > 0
          && indentOf(lines[index] ?? '') > listIndent
        const sub: readonly [readonly Block[], number] = nested
          ? parseRange(lines, index, listIndent + 1)
          : [[], index]
        items.push({ inline, sub: sub[0] })
        index = sub[1]
      }
      // 空列表（只可能来自纯标记行）不当块，避免出现一个空方框。
      if (items.length > 0) blocks.push({ kind: 'list', ordered: isOrdered, items })
      continue
    }

    if (line.trim().length === 0) { flushParagraph(); index += 1; continue }

    paragraph.push(line)
    index += 1
  }
  flushParagraph()
  return [blocks, index]
}

/**
 * 把块还原成纯文本；用于复制、导出与可访问性标签。
 * @param blocks - 待还原的块。
 * @param prefix - 每行前置的缩进；递归还原列表项子块时逐层加深。
 * @returns 段与段之间用空行分隔的纯文本。
 */
export function blocksToPlainText(blocks: readonly Block[], prefix = ''): string {
  const inlineText = (parts: readonly Inline[]): string => parts.map(part => part.text).join('')
  /**
   * 列表项按层级缩进两格。
   * 复制出去的文本里没有列表元素，子要点再用 `•` 就和父条目分不开了。
   */
  const listText = (items: readonly ListItem[], indent: string): string =>
    items.map(item => [
      `${indent}• ${inlineText(item.inline)}`,
      ...(item.sub.length > 0 ? [blocksToPlainText(item.sub, `${indent}  `)] : []),
    ].join('\n')).join('\n')
  return blocks.map((block) => {
    if (block.kind === 'code') return block.text
    if (block.kind === 'rule') return '---'
    if (block.kind === 'heading') return inlineText(block.inline)
    if (block.kind === 'list') return listText(block.items, prefix)
    // 表格还原成逐行的单元格，复制出去仍然能看清每一列是什么。
    if (block.kind === 'table') {
      return [block.header, ...block.rows].map(cells => cells.map(inlineText).join(' | ')).join('\n')
    }
    if (block.kind === 'quote') return block.lines.map(inlineText).join('\n')
    return block.lines.map(inlineText).join('\n')
  }).join('\n\n')
}
