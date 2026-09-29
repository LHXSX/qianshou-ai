/**
 * SSE 分帧的公共部分：把字节流切成行，再从行里取出 `data:` 后面的载荷。
 *
 * 为什么单独一层：手机端有**两条**流式通路——
 * 1. 自带密钥直连上游（`llm.ts`），帧是 OpenAI 兼容的 `choices[].delta.content`；
 * 2. 订阅网关（`subscription.ts`），帧是 `{type:'delta'|'done'|'error'}`。
 *
 * 两条通路的**协议不同、帧格式不同**（这一点不能强行统一：把两家的字段塞进一个解析器，
 * 只会让任何一方改协议时两边一起坏）；但**分帧完全相同**：
 * 跨 chunk 的半行要拼回去、末尾没有换行的那一行要在收流后冲一次、`data:` 行只认前缀。
 * 这三件事写两遍必然有一遍写错，所以拆到这里，两边共用而不是复制粘贴。
 *
 * 纯函数，不碰网络也不碰 `TextDecoder`：解码仍由各自的收流循环负责。
 */

/** 流结束标记：OpenAI 兼容协议用它表示"这一轮没有更多帧了"。 */
export const SSE_DONE = '[DONE]'

/** 一次分帧的结果。 */
export interface LineSplit {
  /** 已经完整的行（不含换行符）。 */
  readonly lines: readonly string[]
  /** 还没收全的尾巴；下次拿到新数据时接在它后面继续切。 */
  readonly rest: string
}

/**
 * 按 `\n` 切分缓冲区。
 *
 * 最后一段一律留在 `rest` 里：它可能是半行（正在等剩下的字节），也可能是收流后
 * 那行没有换行结尾的完整帧——两种都由调用方决定怎么处理，这里不替它们猜。
 * @param buffer - 已累积的原文。
 * @returns 完整行与剩余尾巴。
 */
export function takeLines(buffer: string): LineSplit {
  const parts = buffer.split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts, rest }
}

/**
 * 取出一行 SSE 里 `data:` 后面的载荷。
 *
 * 只认 `data:` 开头的行：注释行（`: keep-alive`）、`event:`、`id:` 这些都不携带正文。
 * 行尾的 `\r` 一并去掉（服务端在 Windows 上换行是 `\r\n`，留着会让 JSON 解析失败）。
 * @param line - 一行原文（不含 `\n`）。
 * @returns 载荷原文；这一行不携带 `data:` 时返回 `null`。
 */
export function sseData(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return null
  return trimmed.slice(5).trim()
}
