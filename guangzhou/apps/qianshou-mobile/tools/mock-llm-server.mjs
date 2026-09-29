/**
 * 本机测试服务端 —— 用于端到端验证手机端的完整调用链路。
 *
 * 它**不是** LLM：只是把服务商的真实帧格式吐回来。两个面：
 * - `/v1/chat/completions`：OpenAI 兼容的流式对话（含跨 chunk 的半行、`[DONE]` 终止）；
 * - `/anthropic/v1/messages`：Anthropic 兼容的 Messages 接口，带原生
 *   `web_search_20250305` 服务端工具。它按**请求内容**判断轮次，而不是记状态：
 *   最后一条助手消息里已有 `server_tool_use` 块 → 这是搜索后的第二轮，回结果与正文；
 *   否则 → 第一轮回一次工具调用 + `pause_turn`，把回合交回客户端。
 *
 * 这样可以在没有密钥的情况下验证「界面 → 调用层 → SSE 解析 → 逐字渲染 → 落盘」整条
 * 链路，以及搜索循环真的会发第二轮；且验证的是同一套代码路径。
 *
 * 用法：node tools/mock-llm-server.mjs [port] [--reject]
 */
import { createServer } from 'node:http'

const PORT = Number(process.argv[2] ?? 18999)
/** 认证行为：默认只接受任意非空 Bearer；传 `--reject` 则一律 401，用于验证错误提示。 */
const REJECT = process.argv.includes('--reject')

/** 每帧之间的间隔；调大一点，中间状态（正在搜索/正在整理）才观察得到。 */
const FRAME_GAP_MS = Number(process.env.MOCK_FRAME_GAP_MS ?? 1)

/** 按请求里最后一条用户消息生成一段可辨认的回复。 */
function replyFor(body) {
  let last = '（空）'
  try {
    const parsed = JSON.parse(body)
    const messages = Array.isArray(parsed?.messages) ? parsed.messages : []
    const user = [...messages].reverse().find(m => m?.role === 'user')
    if (typeof user?.content === 'string') last = user.content
  } catch { /* 请求体不可解析时用占位 */ }
  const model = (() => { try { return JSON.parse(body)?.model ?? 'unknown' } catch { return 'unknown' } })()
  // 默认回一段**足够长**、且**带完整结构**的正文：
  // 滚动跟随、长回复渲染只有超过一屏才测得出来；标题/列表/表格/代码是模型最常见的
  // 输出形状，端到端要验证的正是「它们真的变成了元素」。
  // 末尾刻意留一个空行：表格要等空行才算定稿，否则最后一行会一直按流式处理。
  const filler = Array.from({ length: 6 }, (_, i) => `第 ${i + 1} 行：这是用于验证滚动与流式渲染的填充正文。`).join('\n')
  return [
    `收到你的消息：「${last.slice(0, 60)}」。我是本机测试服务端（模型标记 ${model}）。`,
    '',
    '## 结构检查',
    '',
    '下面几段用来确认排版真的生效：',
    '',
    '- 列表项一：应该有项目符号与缩进',
    '- 列表项二：**粗体**与 `行内代码` 都该变成元素',
    '  - 子要点：应该缩进在上一项里面',
    '',
    '| 项目 | 期望 | 状态 |',
    '| --- | :--: | ---: |',
    '| 标题 | 变成 h2 | 好 |',
    '| 表格 | 变成 table | 好 |',
    '',
    '```ts',
    'const ok = true',
    '```',
    '',
    '> 引用块左侧应该有竖线。',
    '',
    filler,
    '',
  ].join('\n')
}

/** 把回复切成多次增量，并按真实服务商的帧格式编码。 */
function frames(text) {
  const size = 8
  const out = []
  // 换行必须**逐帧**发送：SSE 的一帧是一行 `data:`，把带换行的整段塞进一帧会把帧切断，
  // 客户端只能读到第一行。真实服务商也是这样——换行本身作为一个 delta。
  for (let i = 0; i < text.length; i += size) {
    const piece = text.slice(i, i + size)
    out.push(`data: ${JSON.stringify({ id: 'mock-1', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: { content: piece } }] })}\n\n`)
  }
  out.push('data: [DONE]\n\n')
  return out
}

/** Anthropic 事件的一帧。 */
const anthropicFrame = payload => `data: ${JSON.stringify(payload)}\n\n`

/**
 * 判断这次请求是搜索的第几轮。
 *
 * 只看请求体，不在服务端记状态：客户端把上一轮的助手内容原样送回来时，最后一条
 * 消息就是那条带 `server_tool_use` 的助手轮——这正是"服务端把回合交回"的判据。
 */
function searchRound(body) {
  try {
    const messages = JSON.parse(body)?.messages
    if (!Array.isArray(messages)) return 1
    const assistant = [...messages].reverse().find(m => m?.role === 'assistant')
    if (assistant === undefined || !Array.isArray(assistant.content)) return 1
    return assistant.content.some(block => block?.type === 'server_tool_use') ? 2 : 1
  } catch {
    return 1
  }
}

/** 第一轮：服务端发起搜索，然后把这个回合交回客户端。 */
function searchRoundOne(query) {
  return [
    anthropicFrame({ type: 'message_start', message: { id: 'msg-mock-1', model: 'mock' } }),
    anthropicFrame({ type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srv-mock-1', name: 'web_search' } }),
    anthropicFrame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query }) } }),
    anthropicFrame({ type: 'content_block_stop', index: 0 }),
    anthropicFrame({ type: 'message_delta', delta: { stop_reason: 'pause_turn' } }),
    anthropicFrame({ type: 'message_stop' }),
  ]
}

/** 第二轮：搜索结果 + 正文。来源与正文都明确标注是本机测试服务端，不冒充实况。 */
function searchRoundTwo() {
  const answer = '这是本机测试服务端在第二轮给出的回答：搜索工具已返回结果，正文由假服务端生成，不是真实新闻。'
  const chunks = [anthropicFrame({ type: 'message_start', message: { id: 'msg-mock-2', model: 'mock' } })]
  chunks.push(anthropicFrame({
    type: 'content_block_start',
    index: 0,
    content_block: {
      type: 'web_search_tool_result',
      tool_use_id: 'srv-mock-1',
      content: [
        { type: 'web_search_result', url: 'https://example.com/mock-result-1', title: '示例来源 1', page_age: '2026-01-01' },
        { type: 'web_search_result', url: 'https://example.org/mock-result-2', title: '示例来源 2' },
      ],
    },
  }))
  chunks.push(anthropicFrame({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }))
  for (let i = 0; i < answer.length; i += 8) {
    chunks.push(anthropicFrame({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: answer.slice(i, i + 8) } }))
  }
  chunks.push(anthropicFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }))
  chunks.push(anthropicFrame({ type: 'message_stop' }))
  return chunks
}

/**
 * 跨域响应头。
 *
 * 浏览器对跨域 POST 必发 `OPTIONS` 预检，预检请求**不带 Authorization**——
 * 若把预检当普通请求要求鉴权（返回 401），浏览器会直接判定请求失败，页面只会看到
 * "连不上服务商"。真实部署里手机端与用户自建网关也不同源，同理。
 * （官方服务商自带 CORS 头，不受此影响。）
 */
function corsHeaders(request) {
  return {
    'access-control-allow-origin': request.headers.origin ?? '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, x-api-key, anthropic-version',
    'access-control-max-age': '600',
  }
}

/** 逐帧写出，间隔可调：真实网络也是碎的，测试端就该比真实更苛刻。 */
function writeFrames(response, chunks) {
  const payload = chunks.join('')
  let index = 0
  const tick = setInterval(() => {
    if (index >= payload.length) { clearInterval(tick); response.end(); return }
    // 每次写一小段（而非逐字节），既保留跨 chunk 的半行边界，又不至于慢到超时。
    response.write(payload.slice(index, index + 3))
    index += 3
  }, FRAME_GAP_MS)
}

const server = createServer((request, response) => {
  const cors = corsHeaders(request)
  if (request.method === 'OPTIONS') {
    response.writeHead(204, cors)
    response.end()
    return
  }
  const isAnthropic = request.url?.endsWith('/anthropic/v1/messages') === true
  if (!isAnthropic && !request.url?.endsWith('/chat/completions')) {
    response.writeHead(404, { ...cors, 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'not found' } }))
    return
  }
  const parts = []
  request.on('data', part => parts.push(part))
  request.on('end', () => {
    const body = Buffer.concat(parts).toString('utf8')
    const auth = request.headers.authorization ?? ''
    const anthropicKey = request.headers['x-api-key'] ?? ''
    // Anthropic 面按 `x-api-key` 或 `Authorization: Bearer` 任一鉴权；对话面沿用 Bearer。
    const authorized = isAnthropic
      ? (typeof anthropicKey === 'string' && anthropicKey.length > 0) || /^Bearer\s+\S+/.test(auth)
      : /^Bearer\s+\S+/.test(auth)
    if (REJECT || !authorized) {
      response.writeHead(401, { ...cors, 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'invalid api key' } }))
      return
    }
    response.writeHead(200, { ...cors, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' })
    if (isAnthropic) {
      const round = searchRound(body)
      const query = (() => {
        try {
          const messages = JSON.parse(body)?.messages ?? []
          const user = [...messages].reverse().find(m => m?.role === 'user')
          return typeof user?.content === 'string' ? user.content.slice(0, 40) : '（空）'
        } catch { return '（空）' }
      })()
      process.stdout.write(`[anthropic] 第 ${round} 轮\n`)
      writeFrames(response, round === 1 ? searchRoundOne(query) : searchRoundTwo())
      return
    }
    writeFrames(response, frames(replyFor(body)))
  })
})

server.listen(PORT, '127.0.0.1', () => {
  /**
   * 传 `0` 时由系统分配空闲端口，并把**实际**端口用一行机器可读的格式打出来。
   *
   * 为什么需要：测试里硬编码端口（如 18997）在与别的测试并发跑时会**抢端口**，
   * 表现为"单跑全绿、合跑偶发红"——那种随机失败最难查，也最容易被人当成噪音忽略。
   * 让系统分配就没有冲突这回事。
   */
  // 端口要从 server 身上问：listen 回调里拿不到它，但我踩过两次坑（`info`、`self`
  // 都是想当然，Node ESM 里都不存在），所以这里显式用模块级的 server 变量。
  const address = server.address()
  const actual = (address !== null && typeof address === 'object' ? address.port : undefined) ?? PORT
  console.log(`QIANSHOU_MOCK_PORT=${actual}`)
  console.log(`OpenAI 兼容测试服务端已就绪: http://127.0.0.1:${actual}/v1${REJECT ? '（全部 401 模式）' : ''}`)
  console.log(`Anthropic 兼容（联网搜索）: http://127.0.0.1:${actual}/anthropic/v1/messages`)
})
