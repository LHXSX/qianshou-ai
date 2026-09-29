/**
 * Markdown 的 React 渲染。
 *
 * 与 `markdown.ts` 的分工：那边只负责解析成纯数据（可无浏览器测试），
 * 这里只负责把数据渲染成 DOM。分开的好处是排版边界能在测试里穷举，
 * 而不是靠肉眼看界面。
 *
 * 性能约定：流式期间每次增量都会重渲染。所以这里的组件都很小、不做记忆化以外的
 * 额外计算——真正省开销的是调用方"只重渲染尾行"的策略（见 `App.tsx` 的 SettledLines）。
 */
import { memo, type ReactNode } from 'react'
import { parseBlocks, parseInline, type Block, type Inline } from './markdown.ts'

/** 渲染一串行内片段。 */
function Inlines({ parts }: { parts: readonly Inline[] }): ReactNode {
  return (
    <>
      {parts.map((part, index) => {
        const key = `${part.kind}-${index}`
        if (part.kind === 'strong') return <strong key={key}>{part.text}</strong>
        if (part.kind === 'em') return <em key={key}>{part.text}</em>
        if (part.kind === 'code') return <code key={key}>{part.text}</code>
        if (part.kind === 'link') {
          // 外链一律新窗口打开并加 noopener：模型给的地址不可信。
          return <a key={key} href={part.href} target="_blank" rel="noreferrer noopener">{part.text}</a>
        }
        return <span key={key}>{part.text}</span>
      })}
    </>
  )
}

/** 渲染一个块。 */
function BlockView({ block }: { block: Block }): ReactNode {
  switch (block.kind) {
    case 'heading': {
      const Tag = (`h${Math.min(6, Math.max(1, block.level))}`) as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      return <Tag><Inlines parts={block.inline} /></Tag>
    }
    case 'list': {
      const items = block.items.map((item, index) => (
        <li key={index}>
          <Inlines parts={item.inline} />
          {/*
            子内容嵌在同一条 `<li>` 里，而不是另起一个列表：模型用
            `1. 第一步\n   - 子要点` 时，平铺会让子要点看起来和第一步同级。
          */}
          {item.sub.map((child, childIndex) => <BlockView key={childIndex} block={child} />)}
        </li>
      ))
      return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>
    }
    case 'table':
      return (
        <div className="md-table">
          <table>
            <thead>
              <tr>
                {block.header.map((cell, index) => (
                  <th key={index} style={block.align[index] === null ? undefined : { textAlign: block.align[index] ?? undefined }}>
                    <Inlines parts={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} style={block.align[cellIndex] === null ? undefined : { textAlign: block.align[cellIndex] ?? undefined }}>
                      <Inlines parts={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'quote':
      return (
        <blockquote>
          {block.lines.map((line, index) => (
            <p key={index}><Inlines parts={line} /></p>
          ))}
        </blockquote>
      )
    case 'code':
      return (
        <pre>
          <code className={block.lang.length > 0 ? `language-${block.lang}` : undefined}>{block.text}</code>
        </pre>
      )
    case 'rule':
      return <hr />
    case 'paragraph':
      return (
        <>
          {block.lines.map((line, index) => (
            <p key={index}><Inlines parts={line} /></p>
          ))}
        </>
      )
  }
}

/**
 * 渲染整段 Markdown。
 * @param props.text - 模型回复的原文。
 * @param props.inline - 为 true 时只做行内解析、不产生块级元素；
 *   流式的**尾行**用它，因为一行还在增长时套 `<p>` 会导致段落反复拆合。
 */
export function MarkdownView({ text, inline = false }: { text: string; inline?: boolean }): ReactNode {
  if (inline) return <Inlines parts={parseInline(text)} />
  const blocks = parseBlocks(text)
  return (
    <div className="md">
      {blocks.map((block, index) => <BlockView key={index} block={block} />)}
    </div>
  )
}

/** 记忆化导出：已定稿的段落文本不变时跳过重解析。 */
export const Markdown = memo(MarkdownView)
