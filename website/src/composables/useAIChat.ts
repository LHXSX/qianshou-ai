import { ref, computed } from 'vue'
import { auth } from '../services/api'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  streaming?: boolean
  attachments?: ChatAttachment[]
  /** V4 数据飞轮：assistant 消息对应的 pipeline 交互 id（用于反馈采集）*/
  interactionId?: string
  /** V4 数据飞轮：用户已经给的反馈（避免重复点）*/
  feedback?: 'thumbs_up' | 'thumbs_down' | 'correction' | null
  /** P0-C：本次回答是否走了降级路径（聚合超时/失败等），UI 显示橙色徽章提示用户结果可能不完整 */
  degraded?: boolean
  /** P0-C：降级原因（aggregate_timeout / aggregate_exception:xxx 等），鼠标 hover 显示 */
  degradedReason?: string
}

export interface ChatAttachment {
  id: string
  name: string
  size: number
  type: string
  content?: string
  preview?: string
}

const STORAGE_KEY = 'ec_ai_chat_history'
const RATE_LIMIT_KEY = 'ec_ai_rate'
const RATE_LIMIT_GUEST = 10   // 未登录：每小时最多 10 条
const RATE_LIMIT_USER  = 60   // 已登录：每小时最多 60 条
const RATE_WINDOW_MS   = 60 * 60 * 1000 // 1 小时

function checkRateLimit(): boolean {
  const isLoggedIn = !!auth.getToken()
  const limit = isLoggedIn ? RATE_LIMIT_USER : RATE_LIMIT_GUEST
  const now = Date.now()
  let records: number[] = []
  try {
    records = JSON.parse(localStorage.getItem(RATE_LIMIT_KEY) || '[]')
  } catch { records = [] }
  records = records.filter(t => now - t < RATE_WINDOW_MS)
  if (records.length >= limit) return false
  records.push(now)
  localStorage.setItem(RATE_LIMIT_KEY, JSON.stringify(records))
  return true
}

function getRateLimitRemaining(): number {
  const isLoggedIn = !!auth.getToken()
  const limit = isLoggedIn ? RATE_LIMIT_USER : RATE_LIMIT_GUEST
  const now = Date.now()
  let records: number[] = []
  try {
    records = JSON.parse(localStorage.getItem(RATE_LIMIT_KEY) || '[]')
  } catch { records = [] }
  records = records.filter(t => now - t < RATE_WINDOW_MS)
  return Math.max(0, limit - records.length)
}
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function loadHistory(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.slice(-50).map((m: any) => ({ ...m, attachments: m.attachments || [] }))
  } catch {
    return []
  }
}

function saveHistory(msgs: ChatMessage[]) {
  try {
    const clean = msgs.slice(-50).map(m => ({
      id: m.id, role: m.role, content: m.content,
      timestamp: m.timestamp, streaming: false,
      attachments: m.attachments?.map(a => ({
        id: a.id, name: a.name, size: a.size, type: a.type,
      })),
    }))
    localStorage.setItem(STORAGE_KEY, JSON.stringify(clean))
  } catch { /* quota exceeded */ }
}

export function useAIChat() {
  return chatState
}

const messages = ref<ChatMessage[]>(loadHistory())
const input = ref('')
const loading = ref(false)
const panelOpen = ref(false)
const error = ref('')
const attachments = ref<ChatAttachment[]>([])
const chatExpanded = ref(false)

const lastAssistantMsg = computed(() => {
  for (let i = messages.value.length - 1; i >= 0; i--) {
    if (messages.value[i].role === 'assistant') return messages.value[i]
  }
  return null
})

function addMessage(role: ChatMessage['role'], content: string, atts?: ChatAttachment[]): ChatMessage {
  const msg: ChatMessage = {
    id: genId(),
    role,
    content,
    timestamp: Date.now(),
    attachments: atts,
  }
  messages.value.push(msg)
  saveHistory(messages.value)
  return msg
}

function clearHistory() {
  messages.value = []
  attachments.value = []
  localStorage.removeItem(STORAGE_KEY)
}

function openPanel() {
  panelOpen.value = true
  chatExpanded.value = true
  if (messages.value.length === 0) {
    addMessage('system', '千手问道 · 千手执棋\n\n万象皆算，千手执棋。我可以帮你：\n• 分析数据文件（上传 CSV / JSON / PDF）\n• 编写并执行代码（Python / Shell）\n• 调度分布式计算任务\n• 搜索网页、阅读文档\n• 管理服务器和文件\n\n向千手问道，千手为你执棋 🚀')
  }
}

function closePanel() {
  panelOpen.value = false
  error.value = ''
}

function togglePanel() {
  if (panelOpen.value) {
    closePanel()
  } else {
    openPanel()
  }
}

function expandChat() {
  chatExpanded.value = true
  if (messages.value.length === 0) {
    addMessage('system', '千手问道 · 千手执棋\n\n万象皆算，千手执棋。我可以帮你：\n• 分析数据文件（上传 CSV / JSON / PDF）\n• 编写并执行代码（Python / Shell）\n• 调度分布式计算任务\n• 搜索网页、阅读文档\n• 管理服务器和文件\n\n向千手问道，千手为你执棋 🚀')
  }
}

function collapseChat() {
  chatExpanded.value = false
}

function addAttachment(file: File) {
  if (file.size > MAX_ATTACHMENT_SIZE) {
    error.value = `文件 "${file.name}" 超过 10MB 限制`
    return
  }
  if (attachments.value.length >= 5) {
    error.value = '最多上传 5 个文件'
    return
  }

  const att: ChatAttachment = {
    id: genId(),
    name: file.name,
    size: file.size,
    type: file.type || 'application/octet-stream',
  }

  const reader = new FileReader()
  reader.onload = () => {
    att.content = reader.result as string
    if (file.type.startsWith('image/')) {
      att.preview = att.content
    }
  }
  reader.readAsDataURL(file)

  attachments.value.push(att)
  error.value = ''
}

function removeAttachment(id: string) {
  attachments.value = attachments.value.filter(a => a.id !== id)
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

function buildUserContent(text: string, atts: ChatAttachment[]): string {
  if (atts.length === 0) return text

  const parts: string[] = [text]
  parts.push('\n\n--- 附件信息 ---')
  for (const a of atts) {
    parts.push(`\n📎 ${a.name} (${formatFileSize(a.size)}, ${a.type})`)
    if (a.content && a.type.startsWith('text/')) {
      const textContent = atob(a.content.split(',')[1] || '')
      parts.push(`\n文件内容预览 (前 2000 字符):\n\`\`\`\n${textContent.slice(0, 2000)}\n\`\`\``)
    }
  }
  return parts.join('\n')
}

function buildMultimodalContent(text: string, atts: ChatAttachment[]): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
  const hasImages = atts.some(a => a.type.startsWith('image/') && a.content)
  if (!hasImages) {
    return buildUserContent(text, atts)
  }

  const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
    { type: 'text', text: text },
  ]

  for (const a of atts) {
    if (a.type.startsWith('image/') && a.content) {
      parts.push({
        type: 'image_url',
        image_url: { url: a.content },
      })
    }
  }

  return parts
}

/**
 * V4 P0+ 数据飞轮：用户反馈采集。
 * 把 👍/👎/修正 发到后端 `/api/v8/ai/feedback`，落入训练日志。
 * 失败静默（前端 UI 体验不能被反馈采集挡住）。
 */
async function submitFeedback(
  msg: ChatMessage,
  feedback: 'thumbs_up' | 'thumbs_down' | 'correction',
  correction?: string,
  comment?: string,
): Promise<boolean> {
  if (!msg.interactionId) return false
  // 同一条消息只让用户给一次反馈（防误点 + 减少噪声）
  if (msg.feedback) return false
  try {
    const token = auth.getToken()
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`
    const resp = await fetch('/api/v8/ai/feedback', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        interaction_id: msg.interactionId,
        feedback,
        correction: correction || null,
        comment: comment || null,
      }),
    })
    if (resp.ok) {
      msg.feedback = feedback
      saveHistory(messages.value)
      return true
    }
  } catch {
    // 静默失败
  }
  return false
}

async function sendMessage() {
  const text = input.value.trim()
  if (!text || loading.value) return

  // 未登录优雅引导（首页 AI 后端需鉴权 · 避免直接抛 401 原始 JSON）
  const activeToken = auth.getToken() || await auth.ensureAccessToken()
  if (!activeToken) {
    if (!chatExpanded.value) expandChat()
    addMessage('user', text)
    addMessage('assistant', '👋 千手问道 AI 需要登录后使用。请点右上角「登录 / 个人节点」完成登录，之后即可用一句话调度算力、让 AI 自动写脚本并切片下发。')
    input.value = ''
    return
  }

  if (!checkRateLimit()) {
    const isLoggedIn = !!auth.getToken()
    error.value = isLoggedIn
      ? '您本小时发送消息已达上限（60条），请稍后再试。'
      : '未登录用户每小时最多发送 10 条消息，请登录后享受更多次数。'
    return
  }

  const currentAttachments = [...attachments.value]
  input.value = ''
  error.value = ''

  if (!chatExpanded.value) {
    expandChat()
  }

  buildUserContent(text, currentAttachments)
  addMessage('user', text, currentAttachments)
  attachments.value = []

  addMessage('assistant', '')
  const assistantMsg = messages.value[messages.value.length - 1]
  assistantMsg.streaming = true
  loading.value = true

  try {
    const lastUserIdx = messages.value.length - 2

    const apiMessages = messages.value
      .filter(m => m.role !== 'system' && !m.streaming)
      .slice(-20)
      .map((m, _idx) => {
        const isLastUser = m.role === 'user' && messages.value.indexOf(m) === lastUserIdx
        if (isLastUser && currentAttachments.length > 0) {
          return { role: m.role, content: buildMultimodalContent(m.content, currentAttachments) }
        }
        const content = m.attachments && m.attachments.length > 0
          ? buildMultimodalContent(m.content, m.attachments)
          : m.content
        return { role: m.role, content }
      })

    const files = currentAttachments
      .filter(a => a.content)
      .map(a => ({
        name: a.name,
        size: a.size,
        type: a.type,
        content: a.content,
      }))

    const token = auth.getToken() || activeToken
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    const body: Record<string, any> = {
      model: 'ec-pipeline',
      messages: apiMessages,
      stream: true,
    }
    if (files.length > 0) {
      body.files = files
    }

    const resp = await fetch('/api/v8/ai/agent/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      throw new Error(errText || `HTTP ${resp.status}`)
    }

    const contentType = resp.headers.get('content-type') || ''
    if (!contentType.includes('text/event-stream')) {
      const payload = await resp.json().catch(() => null)
      if (payload?.ok === false) {
        throw new Error(payload.error || 'AI 服务返回失败')
      }
      assistantMsg.content = String(payload?.message || payload?.content || '')
      if (!assistantMsg.content) {
        throw new Error('AI 服务返回了无法识别的响应')
      }
      return
    }

    const reader = resp.body?.getReader()
    if (!reader) {
      assistantMsg.content = '抱歉，无法读取响应流。'
      return
    }

    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        if (trimmed.startsWith('event:') && trimmed.includes('done')) {
          continue
        }

        if (!trimmed.startsWith('data:')) continue
        const dataStr = trimmed.slice(5).trim()
        if (dataStr === '[DONE]') continue

        try {
          const chunk = JSON.parse(dataStr)
          // V4 数据飞轮：捕获 pipeline 的 interaction_id（done 事件带），用于反馈采集
          if (chunk.interaction_id) {
            assistantMsg.interactionId = String(chunk.interaction_id)
          }
          // P0-C：done 帧的降级标记
          if (chunk.degraded === true) {
            assistantMsg.degraded = true
            assistantMsg.degradedReason = String(chunk.degraded_reason || '')
          }
          if (chunk.content) {
            assistantMsg.content += chunk.content
          } else if (chunk.progress_msg) {
            assistantMsg.content = chunk.progress_msg
          }
        } catch {
          // skip unparseable chunks
        }
      }
    }

    if (!assistantMsg.content) {
      assistantMsg.content = '抱歉，没有获取到有效回复。'
    }
  } catch (e: any) {
    const raw = String(e?.message || '')
    const isAuth = /AUTH_TOKEN|Authorization|未登录|登录|401/i.test(raw)
    error.value = isAuth ? '千手问道需要登录后使用，请先登录。' : (raw || '请求失败，请稍后重试')
    assistantMsg.content = assistantMsg.content || (isAuth
      ? '请先登录后再使用千手问道 AI。点右上角「登录」即可。'
      : '抱歉，请求遇到了问题。请稍后重试。')
  } finally {
    assistantMsg.streaming = false
    loading.value = false
    saveHistory(messages.value)
  }
}

const chatState = {
  messages,
  input,
  loading,
  panelOpen,
  error,
  attachments,
  chatExpanded,
  lastAssistantMsg,
  addMessage,
  clearHistory,
  openPanel,
  closePanel,
  togglePanel,
  expandChat,
  collapseChat,
  addAttachment,
  removeAttachment,
  formatFileSize,
  sendMessage,
  submitFeedback,
  getRateLimitRemaining,
}