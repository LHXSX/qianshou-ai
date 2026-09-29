<template>
  <div class="msg-row" :class="[msg.role, { grouped: grouped, streaming: msg.streaming }]">
    <div class="msg-avatar" v-if="!grouped || msg.role === 'user'">
      <span v-if="msg.role === 'user'">{{ userInitial }}</span>
      <span v-else>🧠</span>
    </div>
    <div class="msg-main">
      <div class="msg-meta" v-if="!grouped || msg.role === 'user'">
        <span class="msg-sender">{{ msg.role === 'user' ? '你' : '千手问道' }}</span>
        <span class="msg-time">{{ formatTime(msg.timestamp) }}</span>
      </div>

      <div v-if="msg.attachments?.length" class="msg-attachments">
        <div v-for="att in msg.attachments" :key="att.id" class="msg-att">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
            <polyline points="13 2 13 9 20 9"/>
          </svg>
          <span>{{ att.name }}</span>
          <span class="att-size">{{ formatSize(att.size) }}</span>
        </div>
      </div>

      <div class="msg-bubble" :class="[msg.role, { streaming: msg.streaming, degraded: msg.degraded }]">
        <div class="msg-text" v-html="renderedContent"></div>
        <span v-if="msg.streaming" class="cursor-blink">|</span>
        <!-- P0-C：降级提示。聚合超时/失败时显示橙色 chip + hover 显示原因 -->
        <div v-if="msg.degraded" class="degraded-badge" :title="msg.degradedReason || '部分流程降级'">
          ⚠️ 结果可能不完整（{{ degradedShort }}）
        </div>
      </div>

      <div class="msg-actions" v-if="msg.role === 'assistant' && !msg.streaming && msg.content">
        <button class="msg-action-btn" @click="copyContent" :class="{ copied: justCopied }">
          <svg v-if="!justCopied" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
          <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <span>{{ justCopied ? '已复制' : '复制' }}</span>
        </button>

        <!-- V4 数据飞轮：用户反馈采集（只在有 interactionId 时显示，每条只能给一次反馈）-->
        <template v-if="msg.interactionId">
          <button
            class="msg-action-btn fb-btn"
            :class="{ active: msg.feedback === 'thumbs_up', locked: !!msg.feedback }"
            :disabled="!!msg.feedback"
            :title="msg.feedback === 'thumbs_up' ? '已点赞' : '回答有用'"
            @click="rate('thumbs_up')"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M7 10v12"/>
              <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H7l-4-4V10l5-3 4-5a2 2 0 0 1 2 2v3.88z"/>
            </svg>
          </button>
          <button
            class="msg-action-btn fb-btn"
            :class="{ active: msg.feedback === 'thumbs_down', locked: !!msg.feedback }"
            :disabled="!!msg.feedback"
            :title="msg.feedback === 'thumbs_down' ? '已点踩' : '回答不准'"
            @click="rate('thumbs_down')"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M17 14V2"/>
              <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H17l4 4v8l-5 3-4 5a2 2 0 0 1-2-2v-3.88z"/>
            </svg>
          </button>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useAIChat, type ChatMessage } from '../../composables/useAIChat'

const props = defineProps<{
  msg: ChatMessage
  grouped?: boolean
}>()

const justCopied = ref(false)
const { submitFeedback } = useAIChat()

async function rate(kind: 'thumbs_up' | 'thumbs_down') {
  if (props.msg.feedback) return
  await submitFeedback(props.msg, kind)
}

const userInitial = computed(() => {
  try {
    const raw = localStorage.getItem('ec_user') || sessionStorage.getItem('ec_user')
    if (raw) {
      const u = JSON.parse(raw)
      return (u.username || 'U')[0].toUpperCase()
    }
  } catch {}
  return 'U'
})

function formatTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (isToday) return `${hh}:${mm}`
  const M = d.getMonth() + 1
  const D = d.getDate()
  return `${M}/${D} ${hh}:${mm}`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

async function copyContent() {
  try {
    await navigator.clipboard.writeText(props.msg.content)
    justCopied.value = true
    setTimeout(() => { justCopied.value = false }, 2000)
  } catch {
    // fallback
    const ta = document.createElement('textarea')
    ta.value = props.msg.content
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
    justCopied.value = true
    setTimeout(() => { justCopied.value = false }, 2000)
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function renderMarkdown(text: string): string {
  const codeBlocks: Array<{ lang: string; code: string }> = []

  let html = text

  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = codeBlocks.length
    const langLabel = lang || 'code'
    codeBlocks.push({ lang: langLabel, code })
    return `\n%%CB${idx}%%\n`
  })

  html = escapeHtml(html)

  html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')

  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')

  html = html.replace(/^#### (.+)$/gm, '<h5>$1</h5>')
  html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>')
  html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>')
  html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>')

  html = html.replace(/^&gt; (.+)$/gm, '<blockquote><p>$1</p></blockquote>')
  html = html.replace(/<\/blockquote>\n<blockquote>/g, '\n')

  html = html.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>')
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>')

  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
  html = html.replace(/(<ul>[\s\S]*?<\/ul>)/g, (m) => m)
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, (m) => {
    if (m.includes('<ul>')) return m
    return `<ol>${m}</ol>`
  })

  html = html.replace(/^---$/gm, '<hr>')

  html = html.replace(/\n\n/g, '</p><p>')
  html = html.replace(/\n/g, '<br>')
  html = html.replace(/<p><br>/g, '<p>')
  html = html.replace(/<br><\/p>/g, '</p>')

  html = html.replace(/(<(?:h[2-5]|ul|ol|blockquote|hr|pre)[\s\S]*?<\/\1>)/g, (m) => {
    return m.replace(/<br>/g, '')
  })

  html = html.replace(/<p>\s*<\/p>/g, '')

  html = html.replace(/%%CB(\d+)%%/g, (_m, idxStr) => {
    const idx = parseInt(idxStr)
    const cb = codeBlocks[idx]
    if (!cb) return ''
    const escaped = escapeHtml(cb.code)
    return `<div class="code-block">
      <div class="code-head">
        <span class="code-lang">${cb.lang}</span>
        <button class="code-copy-btn" data-code="${escaped.replace(/"/g, '&quot;').replace(/\n/g, '&#10;')}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
          复制
        </button>
      </div>
      <pre><code>${escaped}</code></pre>
    </div>`
  })

  if (!html.includes('<p>') && !html.includes('<h') && !html.includes('<ul') && !html.includes('<ol') && !html.includes('<blockquote') && !html.includes('<hr') && !html.includes('<pre') && !html.includes('<div')) {
    html = `<p>${html}</p>`
  }

  return html
}

const renderedContent = computed(() => renderMarkdown(props.msg.content))

// P0-C：降级原因短文案
const degradedShort = computed(() => {
  const r = props.msg.degradedReason || ''
  if (r.startsWith('aggregate_timeout')) return '聚合超时'
  if (r.startsWith('aggregate_exception')) return '聚合服务异常'
  if (r.startsWith('aggregator_failed')) return '主模型聚合失败'
  return '部分流程降级'
})
</script>

<style scoped>
.msg-row {
  display: flex;
  gap: 10px;
  padding: 6px 20px;
  animation: msgSlideIn 0.35s cubic-bezier(0.22, 1, 0.36, 1);
}

.msg-row.user {
  flex-direction: row-reverse;
}

.msg-row.grouped {
  padding-top: 2px;
}

.msg-row.grouped .msg-meta {
  display: none;
}

.msg-avatar {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 600;
  flex-shrink: 0;
  margin-top: 2px;
  user-select: none;
}

.msg-row.assistant .msg-avatar,
.msg-row.system .msg-avatar {
  background: linear-gradient(135deg, #e8f0fe, #ede9fe);
  color: #5b4dff;
}

.msg-row.user .msg-avatar {
  background: linear-gradient(135deg, #0066ff, #7c3aed);
  color: #fff;
}

.msg-main {
  max-width: 78%;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.msg-row.user .msg-main {
  align-items: flex-end;
}

.msg-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
  padding: 0 4px;
}

.msg-sender {
  font-size: 12px;
  font-weight: 600;
  color: #6e6e73;
}

.msg-time {
  font-size: 11px;
  color: #aeaeb2;
}

.msg-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 6px;
}

.msg-att {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 8px;
  font-size: 12px;
  background: rgba(0, 102, 255, 0.06);
  border: 1px solid rgba(0, 102, 255, 0.1);
  color: #1d1d1f;
}

.msg-row.user .msg-att {
  background: rgba(255, 255, 255, 0.15);
  border-color: rgba(255, 255, 255, 0.2);
  color: rgba(255, 255, 255, 0.9);
}

.att-size {
  opacity: 0.5;
  font-size: 11px;
}

.msg-bubble {
  padding: 10px 16px;
  border-radius: 16px;
  font-size: 15px;
  line-height: 1.7;
  word-break: break-word;
  position: relative;
  transition: border-radius 0.2s;
}

.msg-bubble.assistant,
.msg-bubble.system {
  background: #f2f2f7;
  color: #1d1d1f;
  border-bottom-left-radius: 4px;
}

.msg-bubble.user {
  background: linear-gradient(135deg, #0066ff, #5b4dff);
  color: #fff;
  border-bottom-right-radius: 4px;
}

.msg-bubble.streaming {
  border-bottom-left-radius: 16px;
}

.msg-actions {
  display: flex;
  gap: 4px;
  margin-top: 4px;
  padding: 0 4px;
  opacity: 0;
  transition: opacity 0.2s;
}

.msg-row:hover .msg-actions {
  opacity: 1;
}

.msg-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #86868b;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.msg-action-btn:hover {
  background: rgba(0, 0, 0, 0.06);
  color: #1d1d1f;
}

.msg-action-btn.copied {
  color: #34c759;
}

/* V4 反馈按钮 */
.msg-action-btn.fb-btn {
  padding: 4px 6px;
}

.msg-action-btn.fb-btn.active {
  color: #007aff;
  background: rgba(0, 122, 255, 0.1);
}

.msg-action-btn.fb-btn.active svg {
  fill: currentColor;
  stroke: currentColor;
}

.msg-action-btn.fb-btn.locked {
  cursor: default;
  opacity: 0.85;
}

.msg-action-btn.fb-btn.locked:hover {
  background: rgba(0, 122, 255, 0.1);
}

/* ── 消息内容样式 ── */
.msg-text :deep(p) {
  margin: 0;
}

.msg-text :deep(p + p) {
  margin-top: 8px;
}

.msg-text :deep(h2) {
  font-size: 18px;
  font-weight: 700;
  margin: 16px 0 8px;
  color: #1d1d1f;
  letter-spacing: -0.01em;
}

.msg-text :deep(h3) {
  font-size: 16px;
  font-weight: 600;
  margin: 14px 0 6px;
  color: #1d1d1f;
}

.msg-text :deep(h4) {
  font-size: 15px;
  font-weight: 600;
  margin: 12px 0 4px;
  color: #1d1d1f;
}

.msg-text :deep(h5) {
  font-size: 14px;
  font-weight: 600;
  margin: 10px 0 4px;
  color: #424245;
}

.msg-bubble.user .msg-text :deep(h2),
.msg-bubble.user .msg-text :deep(h3),
.msg-bubble.user .msg-text :deep(h4),
.msg-bubble.user .msg-text :deep(h5) {
  color: #fff;
}

.msg-text :deep(ul),
.msg-text :deep(ol) {
  margin: 6px 0;
  padding-left: 20px;
}

.msg-text :deep(li) {
  margin: 3px 0;
  line-height: 1.6;
}

.msg-text :deep(li::marker) {
  color: #86868b;
}

.msg-bubble.user .msg-text :deep(li::marker) {
  color: rgba(255, 255, 255, 0.6);
}

.msg-text :deep(blockquote) {
  margin: 8px 0;
  padding: 8px 14px;
  border-left: 3px solid #0066ff;
  background: rgba(0, 102, 255, 0.04);
  border-radius: 0 8px 8px 0;
}

.msg-text :deep(blockquote p) {
  margin: 0;
  color: #424245;
  font-style: italic;
}

.msg-bubble.user .msg-text :deep(blockquote) {
  border-left-color: rgba(255, 255, 255, 0.5);
  background: rgba(255, 255, 255, 0.1);
}

.msg-bubble.user .msg-text :deep(blockquote p) {
  color: rgba(255, 255, 255, 0.9);
}

.msg-text :deep(hr) {
  border: none;
  border-top: 1px solid rgba(0, 0, 0, 0.08);
  margin: 14px 0;
}

.msg-bubble.user .msg-text :deep(hr) {
  border-top-color: rgba(255, 255, 255, 0.2);
}

.msg-text :deep(strong) {
  font-weight: 600;
}

.msg-text :deep(em) {
  font-style: italic;
}

.msg-text :deep(a) {
  color: #0066ff;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.msg-bubble.user .msg-text :deep(a) {
  color: #fff;
}

.msg-text :deep(code.inline-code) {
  background: rgba(0, 0, 0, 0.06);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 13px;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace;
  color: #d63384;
}

.msg-bubble.user .msg-text :deep(code.inline-code) {
  background: rgba(255, 255, 255, 0.18);
  color: #fff;
}

/* ── 代码块 ── */
.msg-text :deep(.code-block) {
  margin: 10px 0;
  border-radius: 10px;
  overflow: hidden;
  background: #1d1d1f;
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.msg-bubble.user .msg-text :deep(.code-block) {
  background: rgba(0, 0, 0, 0.3);
  border-color: rgba(255, 255, 255, 0.1);
}

.msg-text :deep(.code-head) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 14px;
  background: rgba(255, 255, 255, 0.04);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.msg-text :deep(.code-lang) {
  font-size: 11px;
  font-weight: 600;
  color: #86868b;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.msg-text :deep(.code-copy-btn) {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: rgba(255, 255, 255, 0.08);
  color: #aeaeb2;
  padding: 3px 8px;
  border-radius: 5px;
  cursor: pointer;
  font-size: 11px;
  transition: all 0.15s;
}

.msg-text :deep(.code-copy-btn:hover) {
  background: rgba(255, 255, 255, 0.16);
  color: #fff;
}

.msg-text :deep(pre) {
  margin: 0;
  padding: 14px;
  overflow-x: auto;
}

.msg-text :deep(pre code) {
  color: #f5f5f7;
  font-size: 13px;
  line-height: 1.6;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace;
}

/* ── 表格 ── */
.msg-text :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 10px 0;
  font-size: 13px;
}

.msg-text :deep(th) {
  background: rgba(0, 0, 0, 0.04);
  padding: 8px 12px;
  text-align: left;
  font-weight: 600;
  border-bottom: 2px solid rgba(0, 0, 0, 0.08);
}

.msg-text :deep(td) {
  padding: 8px 12px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}

.msg-bubble.user .msg-text :deep(th) {
  background: rgba(255, 255, 255, 0.1);
  border-bottom-color: rgba(255, 255, 255, 0.2);
}

.msg-bubble.user .msg-text :deep(td) {
  border-bottom-color: rgba(255, 255, 255, 0.1);
}

/* ── 光标闪烁 ── */
.cursor-blink {
  display: inline;
  color: #0066ff;
  font-weight: 300;
  animation: cursorBlink 0.8s step-end infinite;
  margin-left: 1px;
}

/* ── 动画 ── */
@keyframes msgSlideIn {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes cursorBlink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

/* P0-C：降级提示徽章 */
.msg-bubble.degraded {
  border-left: 3px solid #f59e0b;
}
.degraded-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 8px;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 500;
  color: #b45309;
  background: #fef3c7;
  border: 1px solid #fbbf24;
  border-radius: 999px;
  cursor: help;
  user-select: none;
}
.degraded-badge:hover {
  background: #fde68a;
}
</style>