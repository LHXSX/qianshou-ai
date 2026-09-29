/**
 * composer 底部控制行：**"放不下必须表现为收起，不能表现为压扁"** 的静态回归。
 *
 * 背景（真实缺陷，用户截图）：中等宽度窗口下，`.tools` 里的 productChip 被 flex
 * 收缩压成"一列一个字"（宽 ≈33px = 1 字 11px + 左右 padding 20px），高度由 26px
 * 涨到 74px；而 `.row` 的高度契约钉死在 41px，多出来的部分**纵向溢出到卡片
 * 下边框外面**。根因不是阈值本身，而是 chip 允许被压：
 * `.productChip` 没有 `white-space: nowrap`、没有 `flex: none`。
 *
 * 这组测试把"修复的结构前提"钉死——它们在修复前必红、修复后转绿：
 *   1. chip 不可断行、不参与收缩（这是"不会被压扁"的唯一保证）；
 *   2. 每一档容器查询都必须是**收起**（`display: none`），不许出现
 *      "缩字号 / 缩 padding / 缩 chip 宽度"这类"压扁"式写法；
 *   3. 收起必须**有顺序**：越次要的越先收，且档位从宽到窄单调推进；
 *   4. 行高契约不许被放宽（41px 只能是 41px，不得改成 auto/min-height 之类）。
 *
 * 这里只做**静态规则**核对（jsdom 没有真实布局引擎，算不出 flex 收缩结果）；
 * 真实几何由 `tools/composer-width-probe.mjs` 在真实 Chrome 里量，两者互补。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const rawCss = readFileSync(
  fileURLToPath(new URL('../src/client/skeleton/InputBar.module.css', import.meta.url)),
  'utf8',
)

/** 去掉注释，避免注释里的字面量（例如解释用的 `width` 或示例里的 `}`）干扰断言。 */
function stripComments(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//gu, '')
}

/* 解析一律基于**去注释**的文本：注释里出现过 `.productChips { display: none }`
   这样的示例，会让"取第一条规则体"的解析在最里层的 `}` 处提前截断。 */
const css = stripComments(rawCss)

/** 取出某个顶层选择器的规则体（只用于本文件里这几个扁平规则）。 */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'u').exec(css)
  const body = match?.[1]
  if (body === undefined) throw new Error(`rule ${selector} not found in InputBar.module.css`)
  return body
}

/** 取出所有 `@container (max-width: N)` 段落，按文件出现顺序（＝从宽到窄的声明顺序）。 */
function containerBlocks(): { maxWidth: number; body: string }[] {
  const blocks: { maxWidth: number; body: string }[] = []
  const pattern = /@container\s*\(max-width:\s*(\d+)px\)\s*\{/gu
  let match: RegExpExecArray | null
  while ((match = pattern.exec(css)) !== null) {
    const maxWidth = Number(match[1])
    let depth = 1
    let index = pattern.lastIndex
    while (index < css.length && depth > 0) {
      if (css[index] === '{') depth += 1
      else if (css[index] === '}') depth -= 1
      index += 1
    }
    blocks.push({ maxWidth, body: css.slice(pattern.lastIndex, index - 1) })
    pattern.lastIndex = index
  }
  return blocks
}

describe('composer 控制行：放不下要收起，不许压扁', () => {
  it('chip 钉死"单行 + 不收缩"——这是不会被压成单字列的唯一条款', () => {
    const chip = ruleBody('.productChip')
    expect(chip).toMatch(/white-space:\s*nowrap/u)
    expect(chip).toMatch(/flex:\s*none/u)
  })

  it('chip 上没有任何"压扁式"的降级写法', () => {
    const chip = ruleBody('.productChip')
    // 缩字号/缩内边距/缩宽高都会制造"可读性碎片"，本轮明确不允许。
    expect(chip).not.toMatch(/font-size:\s*0/u)
    expect(chip).not.toMatch(/text-overflow/u)
    expect(chip).not.toMatch(/max-width/u)
    expect(chip).not.toMatch(/overflow:\s*hidden/u)
  })

  it('chip 组与工具组永不换行（换行 + 41px 行高 = 纵向溢出）', () => {
    expect(ruleBody('.productChips')).toMatch(/flex-wrap:\s*nowrap/u)
    expect(ruleBody('.tools')).toMatch(/flex-wrap:\s*nowrap/u)
  })

  it('`.row` 的行高契约仍是钉死的 41px，没有被放宽成内容高度', () => {
    const row = ruleBody('.row')
    expect(row).toMatch(/height:\s*41px/u)
    expect(row).not.toMatch(/height:\s*auto/u)
    expect(row).not.toMatch(/min-height/u)
    expect(row).toMatch(/overflow-x:\s*clip/u)
  })

  it('每一档容器查询都只做"收起"，不做"缩小"', () => {
    const blocks = containerBlocks()
    expect(blocks.length).toBeGreaterThanOrEqual(4)
    for (const block of blocks) {
      const declarations = stripComments(block.body)
      /* 每档必须至少有一条"收起"或"把右侧地板让出来"的规则。
         后者（`.trailing { min-width: … }`）不是缩小 chip，而是把空间让给
         chip —— 它同样不允许在断点里改字号/内边距/宽高。 */
      const hidesSomething = /display:\s*none/u.test(declarations)
      const yieldsFloor = /\.trailing\s*\{[^}]*min-width/u.test(declarations)
      expect(hidesSomething || yieldsFloor).toBe(true)
      // 断点里不许出现会改尺寸/排版的属性（宽高只允许出现在 `.trailing` 的地板上）。
      expect(declarations).not.toMatch(/font-size/u)
      expect(declarations).not.toMatch(/padding/u)
      expect(declarations).not.toMatch(/\bheight\b/u)
    }
  })

  it('右组可以收窄、但有地板——这是"发送按钮不被裁"的唯一结构保证', () => {
    /* 旧值 `flex: none` 让右组一步不让，于是"放不下"变成整行溢出，
       再由 `.row` 的 `overflow-x: clip` 安静裁掉**发送按钮**
       （实测：会话态组合下 `.row` 横向溢出 35px，发送按钮右缘超出卡片 20.5px）。

       注意 `.trailing` 在文件里出现在组合选择器里（`.tools, .modes, .trailing`），
       所以这里必须抓**含 flex 声明的那一条**，不能抓第一条匹配。 */
    const trailing = [...css.matchAll(/(?:^|\n)\.trailing\s*\{([^}]*)\}/gu)]
      .map((match) => match[1]!)
      .find((body) => /flex\s*:/u.test(body))
    expect(trailing).toBeDefined()
    expect(trailing!).toMatch(/flex:\s*0\s+1\s+auto/u)
    expect(trailing!).toMatch(/min-width:\s*var\(--dsh-composer-trailing-floor/u)
  })

  it('窄宽度的右组地板覆盖必须排在基础 .trailing 规则之后', () => {
    /* 同优先级下"后出现者胜"。把 `min-width: 46px` 写在文件中部时，
       基础规则 `.trailing { min-width: … }` 会把它盖掉，
       计算值恒为 180px——实测容器 340px 时行横向溢出 32px。
       修法是把覆盖挪到文件末尾，这条断言把它钉住。 */
    const baseAt = css.indexOf('.trailing {')
    expect(baseAt).toBeGreaterThan(-1)
    const floorOverrides = [...css.matchAll(/@container\s*\(max-width:\s*(\d+)px\)\s*\{[^}]*\.trailing\s*\{[^}]*min-width/gu)]
    expect(floorOverrides.length).toBeGreaterThanOrEqual(2)
    for (const match of floorOverrides) {
      expect(match.index!).toBeGreaterThan(baseAt)
    }
  })

  it('地板覆盖必须挂在 .trailing 上，不能写成 .row（容器查不到自己）', () => {
    /* `@container` 的查询容器就是 `.row` 自己，而 `.row` 是它所查询元素的祖先：
       把规则写成 `.row { --dsh-composer-trailing-floor: … }` 放在 `@container`
       里**永远不会命中**（实测：容器 340px 时该变量仍是空值、`.trailing` 仍是
       180px 地板，行溢出 32px）。所以地板只能挂在 `.trailing` 上。 */
    for (const block of containerBlocks()) {
      const declarations = stripComments(block.body)
      expect(declarations).not.toMatch(/\.row\s*\{/u)
    }
  })

  it('收起顺序是从次要到核心，且档位从宽到窄单调推进', () => {
    const blocks = containerBlocks()
    /* "档位推进"的校验对象是**收起规则**（收 chip / 收投递方式），
       它们必须按容器宽度从宽到窄依次书写。
       右组的"地板覆盖"是另一类规则：它必须放在文件末尾（同优先级下
       后出现者胜，见下一条断言），所以不参与这条顺序校验。 */
    const hideBlocks = blocks.filter((block) => /display:\s*none/u.test(stripComments(block.body)))
    const widths = hideBlocks.map((block) => block.maxWidth)
    expect(widths.length).toBeGreaterThanOrEqual(4)
    expect(new Set(widths).size).toBe(widths.length)
    const sorted = [...widths].sort((left, right) => right - left)
    expect(widths).toEqual(sorted)
    // ⑤「更多工具」必须和 ④「图像」一起最先被收（两者都只值一次点击，
    // 且「+」打开的命令菜单里都有）——收它们必须发生在任何核心 chip 之前。
    const first = blocks[0]!
    expect(first.body).toContain('nth-child(4)')
    expect(first.body).toContain('nth-child(5)')
    expect(first.body).not.toContain('nth-child(2)')
    expect(first.body).not.toContain('nth-child(3)')
    // 核心三件套的收起顺序：②深度思考 → ③文件 → ④图像 → 整排。
    const removalOrder = blocks
      .flatMap((block) => [...block.body.matchAll(/nth-child\((\d)\)/gu)].map((match) => Number(match[1])))
    expect(removalOrder.indexOf(5)).toBeLessThan(removalOrder.indexOf(2))
    expect(removalOrder.indexOf(4)).toBeLessThan(removalOrder.indexOf(2))
    expect(removalOrder.indexOf(2)).toBeLessThan(removalOrder.indexOf(3))
  })

  it('收起阈值必须来自实测需求：不得早于"真的放不下"就收', () => {
    /* 判据是**实测不等式**，不是估出来的数：
       - 视口 1488px（`.row` 宽 739.1px）→ 5 个 chip 全可见；
       - 视口 528px 与 448px（`.row` 宽 528 / 448px）→ 行横向溢出 17px / 13px，
         也就是"5 个 chip 已经真的放不下"；
       - 视口 488px（`.row` 宽 488px）→ 溢出 0（此时 ⑤④ 已被 520 档收起）。

       于是"最宽的 chip 收起档"只能落在 528 与 488 之间，实际取 **520**。
       旧代码在 720px 就收 ⑤④，而 1440 视口下行宽实测 708px、右边还空约 490px
       —— 那种"视口看着不大就收"正是本轮要消灭的病根。

       同时给出下界校验：520 必须小于"整排 chip 的实测最坏需求"
       28+12+310+342.8 = 692.8px，否则就是把放得下的一排也收掉。 */
    const MEASURED_OVERFLOW_AT = 528
    const MEASURED_FITS_AT = 488
    const FULL_ROW_NEED_WITH_WORST_TRAILING = 28 + 12 + 310 + 342.8
    expect(FULL_ROW_NEED_WITH_WORST_TRAILING).toBeCloseTo(692.8, 1)

    const chipHideBlocks = containerBlocks().filter((block) => /nth-child\(4\)/u.test(block.body))
    expect(chipHideBlocks.length).toBeGreaterThanOrEqual(1)
    const widestChipHide = Math.max(...chipHideBlocks.map((block) => block.maxWidth))
    expect(widestChipHide).toBeGreaterThan(MEASURED_FITS_AT)
    expect(widestChipHide).toBeLessThan(MEASURED_OVERFLOW_AT)
    expect(widestChipHide).toBeLessThan(FULL_ROW_NEED_WITH_WORST_TRAILING)
  })
})
