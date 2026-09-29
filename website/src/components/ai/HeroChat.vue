<template>
  <div class="hero-chat" :class="{ expanded: chat.chatExpanded.value }">
    <!-- 折叠态：大输入框 + 建议 -->
    <div v-if="!chat.chatExpanded.value" class="chat-collapsed">
      <div class="input-wrapper" :class="{ focused: isFocused }">
        <div class="input-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
          </svg>
        </div>
        <textarea
          ref="inputRef"
          v-model="chat.input.value"
          class="chat-input"
          :placeholder="placeholderText"
          rows="1"
          @keydown.enter.exact.prevent="handleSend()"
          @input="autoResize"
          @focus="isFocused = true"
          @blur="isFocused = false"
        ></textarea>
        <div class="input-actions">
          <input
            ref="fileInput"
            type="file"
            multiple
            accept=".csv,.json,.pdf,.txt,.py,.js,.ts,.md,.log,.xml,.yaml,.yml,.toml,.ini,.cfg,.env,.html,.css,.svg,.png,.jpg,.jpeg,.gif,.webp"
            style="display:none"
            @change="onFilesSelected"
          />
          <button class="action-btn" title="上传文件" @click="($refs.fileInput as HTMLInputElement).click()">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
            </svg>
          </button>
          <button
            class="send-btn"
            :class="{ active: chat.input.value.trim() && !chat.loading.value }"
            :disabled="!chat.input.value.trim() || chat.loading.value"
            @click="handleSend()"
          >
            <svg v-if="!chat.loading.value" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"/>
              <polyline points="5 12 12 19 19 12"/>
            </svg>
            <span v-else class="mini-spinner"></span>
          </button>
        </div>
      </div>

      <div v-if="chat.attachments.value.length" class="attachments-row">
        <div v-for="att in chat.attachments.value" :key="att.id" class="att-chip">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
            <polyline points="13 2 13 9 20 9"/>
          </svg>
          <span class="att-name">{{ att.name }}</span>
          <span class="att-size">{{ chat.formatFileSize(att.size) }}</span>
          <button class="att-remove" @click="chat.removeAttachment(att.id)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </div>

      <div class="suggestions">
        <button v-for="s in suggestions" :key="s.label" class="sug-chip" @click="useSuggestion(s.prompt)">
          <span class="sug-icon">{{ s.icon }}</span>
          <span class="sug-label">{{ s.label }}</span>
        </button>
      </div>
    </div>

    <!-- 展开态：对话框 -->
    <div v-else class="chat-dialog">
      <div class="dialog-head">
        <div class="dialog-head-left">
          <div class="dialog-avatar">🧠</div>
          <div>
            <div class="dialog-title">千手问道</div>
            <div class="dialog-subtitle">千手执棋 · 分布式算力调度</div>
          </div>
        </div>
        <div class="dialog-head-actions">
          <button class="dialog-head-btn" @click="chat.clearHistory()" title="清空对话">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
          <button class="dialog-head-btn" @click="chat.collapseChat()" title="收起">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="18 15 12 9 6 15"/>
            </svg>
          </button>
        </div>
      </div>

      <div class="dialog-body" ref="threadRef">
        <div v-if="chat.messages.value.length === 0" class="dialog-empty">
          <div class="empty-icon">🧠</div>
          <div class="empty-title">千手问道</div>
          <div class="empty-desc">千手执棋，万象皆算。我可以帮你分析数据、编写代码、搜索信息、调度任务。</div>
          <div class="empty-suggestions">
            <button v-for="s in quickStarts" :key="s.label" class="empty-sug" @click="useSuggestion(s.prompt)">
              <span>{{ s.icon }}</span>
              <span>{{ s.label }}</span>
            </button>
          </div>
        </div>

        <HeroChatMessage
          v-for="(msg, idx) in chat.messages.value"
          :key="msg.id"
          :msg="msg"
          :grouped="groupedIndices.has(idx)"
        />

        <div v-if="chat.loading.value && !chat.lastAssistantMsg.value?.streaming" class="dialog-typing">
          <span class="typing-dot"></span>
          <span class="typing-dot"></span>
          <span class="typing-dot"></span>
        </div>

        <div v-if="chat.error.value" class="dialog-error">
          <span>⚠️ {{ chat.error.value }}</span>
          <button @click="chat.sendMessage()">重试</button>
        </div>
      </div>

      <div class="dialog-foot">
        <div v-if="chat.attachments.value.length" class="foot-attachments">
          <div v-for="att in chat.attachments.value" :key="att.id" class="foot-att">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
              <polyline points="13 2 13 9 20 9"/>
            </svg>
            <span>{{ att.name }}</span>
            <button @click="chat.removeAttachment(att.id)">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="foot-input-row">
          <input
            ref="fileInput2"
            type="file"
            multiple
            accept=".csv,.json,.pdf,.txt,.py,.js,.ts,.md,.log,.xml,.yaml,.yml,.toml,.ini,.cfg,.env,.html,.css,.svg,.png,.jpg,.jpeg,.gif,.webp"
            style="display:none"
            @change="onFilesSelected"
          />
          <button class="foot-attach-btn" @click="($refs.fileInput2 as HTMLInputElement).click()">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 5v14M5 12h14"/>
            </svg>
          </button>
          <textarea
            ref="dialogInputRef"
            v-model="chat.input.value"
            class="foot-input"
            placeholder="输入消息..."
            rows="1"
            @keydown.enter.exact.prevent="handleSend()"
            @input="autoResizeDialog"
          ></textarea>
          <button
            class="foot-send-btn"
            :class="{ active: chat.input.value.trim() && !chat.loading.value }"
            :disabled="!chat.input.value.trim() || chat.loading.value"
            @click="handleSend()"
          >
            <svg v-if="!chat.loading.value" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"/>
              <polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </svg>
            <span v-else class="mini-spinner"></span>
          </button>
        </div>
        <div class="foot-hint">
          <span>Enter 发送 · Shift+Enter 换行</span>
          <span>千手问道 · 千手执棋</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted } from 'vue'
import { useAIChat } from '../../composables/useAIChat'
import HeroChatMessage from './HeroChatMessage.vue'

const chat = useAIChat()
const isFocused = ref(false)
const inputRef = ref<HTMLTextAreaElement | null>(null)
const dialogInputRef = ref<HTMLTextAreaElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const fileInput2 = ref<HTMLInputElement | null>(null)
const threadRef = ref<HTMLElement | null>(null)

// ── 音效系统 ──
const AudioCtx = window.AudioContext || (window as any).webkitAudioContext
let _audioCtx: AudioContext | null = null
function getAudioCtx(): AudioContext {
  if (!_audioCtx) _audioCtx = new AudioCtx()
  return _audioCtx
}
function playTone(freq: number, duration: number, vol = 0.12, type: OscillatorType = 'sine') {
  try {
    const ctx = getAudioCtx()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(freq, ctx.currentTime)
    gain.gain.setValueAtTime(vol, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration)
    osc.connect(gain).connect(ctx.destination)
    osc.start(ctx.currentTime)
    osc.stop(ctx.currentTime + duration)
  } catch { /* silent */ }
}
function playSendSound() {
  playTone(880, 0.08, 0.1)
  setTimeout(() => playTone(1100, 0.1, 0.08), 60)
}
function playReceiveSound() {
  playTone(660, 0.1, 0.08, 'triangle')
  setTimeout(() => playTone(880, 0.12, 0.06, 'triangle'), 80)
}
function playExpandSound() {
  playTone(520, 0.06, 0.06)
  setTimeout(() => playTone(660, 0.06, 0.06), 50)
  setTimeout(() => playTone(880, 0.08, 0.06), 100)
}

const groupedIndices = computed(() => {
  const indices = new Set<number>()
  const msgs = chat.messages.value
  for (let i = 1; i < msgs.length; i++) {
    if (msgs[i].role === msgs[i - 1].role && msgs[i].role !== 'system') {
      indices.add(i)
    }
  }
  return indices
})

const placeholderText = '向千手问道，千手为你执棋...'

const suggestions = [
  { icon: '📊', label: '分析 CSV 数据', prompt: '帮我分析这份 CSV 文件，统计各列的基本信息，找出异常值和缺失值' },
  { icon: '🐍', label: '写 Python 脚本', prompt: '帮我写一个 Python 脚本，用于批量处理文件夹中的图片，统一调整为 800x600 并压缩' },
  { icon: '🔍', label: '搜索最新技术', prompt: '搜索 2025 年分布式计算领域的最新进展和趋势' },
  { icon: '📝', label: '解析 PDF 文档', prompt: '帮我解析 PDF 文档内容，提取关键信息并生成摘要' },
]

const quickStarts = [
  { icon: '📊', label: '分析数据', prompt: '帮我分析这份 CSV 文件，统计各列的基本信息，找出异常值和缺失值' },
  { icon: '🐍', label: '写代码', prompt: '帮我写一个 Python 脚本，用于批量处理文件夹中的图片' },
  { icon: '🔍', label: '搜索信息', prompt: '搜索 2025 年分布式计算领域的最新进展和趋势' },
  { icon: '📝', label: '解析文档', prompt: '帮我解析 PDF 文档内容，提取关键信息并生成摘要' },
]

function autoResize() {
  nextTick(() => {
    const el = inputRef.value
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  })
}

function autoResizeDialog() {
  nextTick(() => {
    const el = dialogInputRef.value
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 120) + 'px'
  })
}

function handleSend() {
  if (!chat.input.value.trim() || chat.loading.value) return
  playSendSound()
  chat.sendMessage()
  nextTick(() => {
    const el = inputRef.value || dialogInputRef.value
    if (el) {
      el.style.height = 'auto'
      el.focus()
    }
  })
}

function useSuggestion(prompt: string) {
  chat.input.value = prompt
  nextTick(() => {
    autoResize()
    autoResizeDialog()
    inputRef.value?.focus()
  })
}

function onFilesSelected(e: Event) {
  const files = (e.target as HTMLInputElement).files
  if (!files) return
  for (let i = 0; i < files.length; i++) {
    chat.addAttachment(files[i])
  }
  ;(e.target as HTMLInputElement).value = ''
}

let _prevMsgCount = chat.messages.value.length
watch(() => chat.messages.value.length, (len) => {
  nextTick(() => {
    if (threadRef.value) {
      threadRef.value.scrollTop = threadRef.value.scrollHeight
    }
  })
  if (len > _prevMsgCount) {
    const last = chat.messages.value[len - 1]
    if (last?.role === 'assistant' && !last.streaming) playReceiveSound()
  }
  _prevMsgCount = len
})

watch(() => chat.chatExpanded.value, (expanded) => {
  if (expanded) {
    playExpandSound()
    nextTick(() => {
      if (threadRef.value) {
        threadRef.value.scrollTop = threadRef.value.scrollHeight
      }
    })
  }
})

// play receive sound when streaming finishes
watch(
  () => chat.lastAssistantMsg.value?.streaming,
  (streaming, prev) => {
    if (prev === true && streaming === false) playReceiveSound()
  }
)

function handleCodeCopy(e: Event) {
  const btn = (e.target as HTMLElement).closest('.code-copy-btn') as HTMLElement | null
  if (!btn) return
  const code = btn.getAttribute('data-code')
  if (!code) return
  const decoded = code.replace(/&#10;/g, '\n').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  navigator.clipboard.writeText(decoded).then(() => {
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> 已复制'
    btn.classList.add('copied')
    setTimeout(() => {
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> 复制'
      btn.classList.remove('copied')
    }, 2000)
  }).catch(() => {})
}

onMounted(() => {
  threadRef.value?.addEventListener('click', handleCodeCopy)
})
</script>

<style scoped>
.hero-chat {
  width: 100%;
  max-width: 780px;
  margin: 0 auto;
  animation: heroFadeUp 0.8s cubic-bezier(0.22, 1, 0.36, 1) both;
  animation-delay: 0.3s;
}
.hero-chat:not(.expanded) {
  transform: scale(1);
  transition: transform 0.4s cubic-bezier(0.22, 1, 0.36, 1);
}
.hero-chat:not(.expanded):focus-within {
  transform: scale(1.015);
}
@keyframes heroFadeUp {
  from { opacity: 0; transform: translateY(24px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ===== 折叠态 ===== */
.chat-collapsed {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.input-wrapper {
  position: relative;
  display: flex;
  align-items: flex-end;
  gap: 12px;
  background: rgba(255, 255, 255, 0.85);
  backdrop-filter: blur(20px) saturate(1.8);
  -webkit-backdrop-filter: blur(20px) saturate(1.8);
  border: 1.5px solid rgba(255, 255, 255, 0.6);
  border-radius: 28px;
  padding: 16px 20px;
  transition: all 0.4s cubic-bezier(0.22, 1, 0.36, 1);
  box-shadow:
    0 2px 8px rgba(0, 0, 0, 0.04),
    0 8px 32px rgba(0, 0, 0, 0.06),
    0 20px 60px rgba(0, 102, 255, 0.08);
}

.input-wrapper::before {
  content: '';
  position: absolute;
  inset: -2px;
  border-radius: 30px;
  padding: 2px;
  background: linear-gradient(135deg, rgba(0, 102, 255, 0.15), rgba(124, 58, 237, 0.15), rgba(0, 102, 255, 0.05));
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  opacity: 0;
  transition: opacity 0.4s;
  pointer-events: none;
}

.input-wrapper.focused {
  border-color: rgba(0, 102, 255, 0.3);
  background: rgba(255, 255, 255, 0.95);
  box-shadow:
    0 2px 8px rgba(0, 0, 0, 0.04),
    0 12px 40px rgba(0, 102, 255, 0.12),
    0 24px 80px rgba(0, 102, 255, 0.1),
    0 0 0 4px rgba(0, 102, 255, 0.06);
}

.input-wrapper.focused::before {
  opacity: 1;
  animation: borderGlow 3s ease-in-out infinite alternate;
}

@keyframes borderGlow {
  0% { background: linear-gradient(135deg, rgba(0, 102, 255, 0.3), rgba(124, 58, 237, 0.1), rgba(0, 102, 255, 0.05)); }
  100% { background: linear-gradient(135deg, rgba(0, 102, 255, 0.05), rgba(124, 58, 237, 0.3), rgba(0, 102, 255, 0.1)); }
}

.input-icon {
  color: #86868b;
  display: flex;
  align-items: center;
  padding-bottom: 2px;
  flex-shrink: 0;
}

.chat-input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 18px;
  line-height: 1.55;
  color: #1d1d1f;
  resize: none;
  min-height: 30px;
  max-height: 160px;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'PingFang SC', sans-serif;
  letter-spacing: -0.01em;
}

.chat-input::placeholder { color: #b0b0b5; font-weight: 400; letter-spacing: 0; }

.input-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.action-btn {
  width: 38px;
  height: 38px;
  border: none;
  border-radius: 12px;
  background: transparent;
  color: #86868b;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}

.action-btn:hover {
  background: rgba(0, 0, 0, 0.05);
  color: #1d1d1f;
}

.send-btn {
  width: 42px;
  height: 42px;
  border: none;
  border-radius: 14px;
  background: rgba(0, 0, 0, 0.06);
  color: #aeaeb2;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.3s cubic-bezier(0.22, 1, 0.36, 1);
  position: relative;
  overflow: hidden;
}

.send-btn.active {
  background: linear-gradient(135deg, #0066ff, #5b21b6);
  color: #fff;
  box-shadow:
    0 4px 16px rgba(0, 102, 255, 0.4),
    0 0 24px rgba(0, 102, 255, 0.15);
  animation: sendPulse 2s ease-in-out infinite;
}

.send-btn.active:hover {
  transform: scale(1.1);
  box-shadow:
    0 6px 24px rgba(0, 102, 255, 0.5),
    0 0 40px rgba(0, 102, 255, 0.2);
}

.send-btn.active:active {
  transform: scale(0.95);
}

@keyframes sendPulse {
  0%, 100% { box-shadow: 0 4px 16px rgba(0, 102, 255, 0.4), 0 0 24px rgba(0, 102, 255, 0.15); }
  50% { box-shadow: 0 4px 20px rgba(0, 102, 255, 0.5), 0 0 32px rgba(0, 102, 255, 0.2); }
}

.mini-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(0, 102, 255, 0.2);
  border-top-color: #0066ff;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

.attachments-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.att-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: rgba(0, 102, 255, 0.06);
  border: 1px solid rgba(0, 102, 255, 0.12);
  border-radius: 10px;
  padding: 6px 10px;
  font-size: 13px;
  color: #1d1d1f;
  animation: chipIn 0.2s ease-out;
}

.att-name {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.att-size { color: #86868b; font-size: 11px; }

.att-remove {
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: #86868b;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}

.att-remove:hover {
  background: rgba(0, 0, 0, 0.08);
  color: #1d1d1f;
}

.suggestions {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
}
@media (max-width: 480px) {
  .suggestions { grid-template-columns: 1fr; }
}

.sug-chip {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 18px;
  border: 1px solid rgba(255, 255, 255, 0.5);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.6);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  font-size: 14px;
  color: #424245;
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.22, 1, 0.36, 1);
  text-align: left;
  animation: sugFadeIn 0.5s cubic-bezier(0.22, 1, 0.36, 1) both;
}
.sug-chip:nth-child(1) { animation-delay: 0.5s; }
.sug-chip:nth-child(2) { animation-delay: 0.6s; }
.sug-chip:nth-child(3) { animation-delay: 0.7s; }
.sug-chip:nth-child(4) { animation-delay: 0.8s; }

@keyframes sugFadeIn {
  from { opacity: 0; transform: translateY(12px) scale(0.96); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

.sug-chip:hover {
  border-color: rgba(0, 102, 255, 0.3);
  background: rgba(255, 255, 255, 0.9);
  color: #0066ff;
  transform: translateY(-3px) scale(1.02);
  box-shadow:
    0 8px 24px rgba(0, 102, 255, 0.1),
    0 0 0 1px rgba(0, 102, 255, 0.1);
}

.sug-chip:active {
  transform: translateY(-1px) scale(0.98);
}

.sug-icon {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  background: linear-gradient(135deg, rgba(0, 102, 255, 0.08), rgba(124, 58, 237, 0.06));
  font-size: 18px;
  flex-shrink: 0;
  transition: all 0.3s;
}
.sug-chip:hover .sug-icon {
  background: linear-gradient(135deg, rgba(0, 102, 255, 0.15), rgba(124, 58, 237, 0.1));
  transform: scale(1.1);
}

/* ===== 展开态：对话框 ===== */
.chat-dialog {
  background: rgba(255, 255, 255, 0.92);
  backdrop-filter: blur(24px) saturate(1.8);
  -webkit-backdrop-filter: blur(24px) saturate(1.8);
  border-radius: 28px;
  overflow: hidden;
  box-shadow:
    0 4px 24px rgba(0, 0, 0, 0.06),
    0 12px 48px rgba(0, 0, 0, 0.08),
    0 24px 80px rgba(0, 102, 255, 0.06),
    0 0 0 1px rgba(255, 255, 255, 0.5);
  display: flex;
  flex-direction: column;
  max-height: min(720px, calc(100vh - 140px));
  animation: dialogIn 0.45s cubic-bezier(0.22, 1, 0.36, 1);
}

.dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.05);
  background: rgba(250, 250, 250, 0.8);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  flex-shrink: 0;
}

.dialog-head-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dialog-avatar {
  width: 38px;
  height: 38px;
  border-radius: 12px;
  background: linear-gradient(135deg, #0066ff, #5b21b6);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  color: #fff;
  box-shadow: 0 2px 12px rgba(0, 102, 255, 0.3);
  animation: avatarGlow 3s ease-in-out infinite alternate;
}

@keyframes avatarGlow {
  0% { box-shadow: 0 2px 12px rgba(0, 102, 255, 0.3); }
  100% { box-shadow: 0 2px 20px rgba(124, 58, 237, 0.4); }
}

.dialog-title {
  font-size: 15px;
  font-weight: 700;
  color: #1d1d1f;
  letter-spacing: -0.01em;
}

.dialog-subtitle {
  font-size: 11px;
  color: #aeaeb2;
  margin-top: 1px;
}

.dialog-head-actions {
  display: flex;
  gap: 2px;
}

.dialog-head-btn {
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #aeaeb2;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}

.dialog-head-btn:hover {
  background: rgba(0, 0, 0, 0.06);
  color: #424245;
}

.dialog-body {
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 8px 0;
  background: #fff;
  scroll-behavior: smooth;
}

.dialog-body::-webkit-scrollbar { width: 5px; }
.dialog-body::-webkit-scrollbar-track { background: transparent; }
.dialog-body::-webkit-scrollbar-thumb { background: rgba(0, 0, 0, 0.12); border-radius: 3px; }
.dialog-body::-webkit-scrollbar-thumb:hover { background: rgba(0, 0, 0, 0.2); }

.dialog-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 48px 24px;
  text-align: center;
}

.empty-icon {
  width: 56px;
  height: 56px;
  border-radius: 16px;
  background: linear-gradient(135deg, rgba(0, 102, 255, 0.08), rgba(124, 58, 237, 0.08));
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
  margin-bottom: 16px;
}

.empty-title { font-size: 18px; font-weight: 700; color: #1d1d1f; margin-bottom: 8px; letter-spacing: -0.01em; }
.empty-desc { font-size: 14px; color: #86868b; max-width: 380px; line-height: 1.7; margin-bottom: 24px; }

.empty-suggestions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
}

.empty-sug {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px;
  border: 1px solid #e5e5ea;
  border-radius: 100px;
  background: #fff;
  font-size: 13px;
  color: #424245;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}

.empty-sug:hover {
  border-color: #0066ff;
  color: #0066ff;
  background: rgba(0, 102, 255, 0.04);
  transform: translateY(-1px);
  box-shadow: 0 2px 8px rgba(0, 102, 255, 0.08);
}

.dialog-typing {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 12px 24px;
}

.typing-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #aeaeb2;
  animation: dotBounce 1.4s infinite;
}

.typing-dot:nth-child(2) { animation-delay: 0.2s; }
.typing-dot:nth-child(3) { animation-delay: 0.4s; }

.dialog-error {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 8px 20px;
  padding: 10px 16px;
  font-size: 13px;
  color: #dc2626;
  background: rgba(220, 38, 38, 0.04);
  border-radius: 10px;
  border: 1px solid rgba(220, 38, 38, 0.1);
}

.dialog-error button {
  border: none;
  background: #fff;
  color: #dc2626;
  padding: 4px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  border: 1px solid rgba(220, 38, 38, 0.2);
  transition: all 0.15s;
}

.dialog-error button:hover {
  background: #dc2626;
  color: #fff;
}

.dialog-foot {
  border-top: 1px solid rgba(0, 0, 0, 0.06);
  padding: 10px 16px 12px;
  background: #fafafa;
  flex-shrink: 0;
}

.foot-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}

.foot-att {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  background: rgba(0, 102, 255, 0.05);
  border: 1px solid rgba(0, 102, 255, 0.1);
  border-radius: 8px;
  font-size: 12px;
  color: #1d1d1f;
}
.foot-att button {
  width: 16px;
  height: 16px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: #aeaeb2;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.15s;
}
.foot-att button:hover {
  color: #424245;
}

.foot-hint {
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
  font-size: 11px;
  color: #aeaeb2;
  padding: 0 4px;
}

.foot-input-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  background: #fff;
  border: 1.5px solid #e5e5ea;
  border-radius: 16px;
  padding: 8px 12px;
  transition: all 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}

.foot-input-row:focus-within {
  border-color: rgba(0, 102, 255, 0.35);
  box-shadow: 0 0 0 3px rgba(0, 102, 255, 0.06);
}

.foot-attach-btn {
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #aeaeb2;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all 0.15s;
}

.foot-attach-btn:hover {
  background: rgba(0, 0, 0, 0.05);
  color: #424245;
}

.foot-input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  padding: 4px 0;
  font-size: 15px;
  line-height: 1.5;
  color: #1d1d1f;
  resize: none;
  min-height: 22px;
  max-height: 120px;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'PingFang SC', sans-serif;
}

.foot-input::placeholder { color: #aeaeb2; }

.foot-send-btn {
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.06);
  color: #aeaeb2;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}

.foot-send-btn.active {
  background: linear-gradient(135deg, #0066ff, #7c3aed);
  color: #fff;
  box-shadow: 0 2px 8px rgba(0, 102, 255, 0.3);
}

.foot-send-btn.active:hover {
  transform: scale(1.05);
  box-shadow: 0 4px 16px rgba(0, 102, 255, 0.4);
}

@keyframes dialogIn {
  from { opacity: 0; transform: translateY(20px) scale(0.95); filter: blur(4px); }
  to { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
}

@keyframes chipIn {
  from { opacity: 0; transform: scale(0.9); }
  to { opacity: 1; transform: scale(1); }
}

@keyframes dotBounce {
  0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
  40% { transform: scale(1); opacity: 1; }
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>