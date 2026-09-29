<template>
  <Teleport to="body">
    <Transition name="panel">
      <div v-if="chat.panelOpen.value" class="ai-panel-overlay" @click.self="chat.closePanel()">
        <div class="ai-panel" :class="{ fullscreen: isFullscreen }">
          <div class="panel-head">
            <div class="head-left">
              <div class="head-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
                </svg>
              </div>
              <div>
                <div class="head-title">千手问道</div>
                <div class="head-sub">千手执棋 · 分布式算力调度</div>
              </div>
            </div>
            <div class="head-actions">
              <button class="head-btn" title="清空对话" @click="chat.clearHistory()">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
              </button>
              <button class="head-btn" :title="isFullscreen ? '退出全屏' : '全屏'" @click="isFullscreen = !isFullscreen">
                <svg v-if="!isFullscreen" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
                </svg>
                <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="4 8 4 4 8 4"/><polyline points="20 16 20 20 16 20"/><line x1="4" y1="4" x2="9" y2="9"/><line x1="20" y1="20" x2="15" y2="15"/>
                </svg>
              </button>
              <button class="head-btn" title="关闭" @click="chat.closePanel()">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          </div>

          <div class="panel-body" ref="bodyRef">
            <HeroChatMessage
              v-for="(msg, idx) in chat.messages.value"
              :key="msg.id"
              :msg="msg"
              :grouped="groupedIndices.has(idx)"
            />

            <div v-if="chat.loading.value && !chat.lastAssistantMsg.value?.streaming" class="msg-loading">
              <span class="dot"></span><span class="dot"></span><span class="dot"></span>
            </div>

            <div v-if="chat.error.value" class="msg-error">
              <span>⚠️ {{ chat.error.value }}</span>
              <button @click="chat.sendMessage()">重试</button>
            </div>
          </div>

          <div class="panel-foot">
            <div v-if="chat.attachments.value.length" class="foot-attachments">
              <div v-for="att in chat.attachments.value" :key="att.id" class="foot-att-chip">
                <span class="foot-att-icon">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
                    <polyline points="13 2 13 9 20 9"/>
                  </svg>
                </span>
                <span class="foot-att-name">{{ att.name }}</span>
                <button class="foot-att-remove" @click="chat.removeAttachment(att.id)">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              </div>
            </div>
            <div class="foot-input-row">
              <input
                ref="fileInput"
                type="file"
                multiple
                accept=".csv,.json,.pdf,.txt,.py,.js,.ts,.md,.log,.xml,.yaml,.yml,.toml,.ini,.cfg,.env,.html,.css,.svg,.png,.jpg,.jpeg,.gif,.webp"
                style="display:none"
                @change="onFilesSelected"
              />
              <button class="foot-attach-btn" title="上传文件" @click="($refs.fileInput as HTMLInputElement).click()">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                </svg>
              </button>
              <textarea
                ref="inputRef"
                v-model="chat.input.value"
                class="foot-input"
                placeholder="输入你的需求..."
                rows="1"
                @keydown.enter.exact.prevent="chat.sendMessage()"
                @input="autoResize"
              ></textarea>
              <button
                class="foot-send"
                :class="{ active: chat.input.value.trim() && !chat.loading.value }"
                :disabled="!chat.input.value.trim() || chat.loading.value"
                @click="chat.sendMessage()"
              >
                <svg v-if="!chat.loading.value" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
                </svg>
                <span v-else class="send-spinner"></span>
              </button>
            </div>
            <div class="foot-hint">
              <span>Enter 发送 · Shift+Enter 换行</span>
              <span>千手问道 · 千手执棋</span>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted } from 'vue'
import { useAIChat } from '../../composables/useAIChat'
import HeroChatMessage from './HeroChatMessage.vue'

const chat = useAIChat()
const isFullscreen = ref(false)

// ── 音效 ──
const AudioCtx = window.AudioContext || (window as any).webkitAudioContext
let _audioCtx: AudioContext | null = null
function getAudioCtx(): AudioContext {
  if (!_audioCtx) _audioCtx = new AudioCtx()
  return _audioCtx
}
function playTone(freq: number, dur: number, vol = 0.1, type: OscillatorType = 'sine') {
  try {
    const ctx = getAudioCtx()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = type; osc.frequency.setValueAtTime(freq, ctx.currentTime)
    gain.gain.setValueAtTime(vol, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur)
    osc.connect(gain).connect(ctx.destination)
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + dur)
  } catch { /* silent */ }
}
function playOpenSound() {
  playTone(440, 0.06, 0.08)
  setTimeout(() => playTone(660, 0.06, 0.08), 40)
  setTimeout(() => playTone(880, 0.08, 0.06), 80)
}
function playReceiveSound() {
  playTone(660, 0.1, 0.06, 'triangle')
  setTimeout(() => playTone(880, 0.12, 0.05, 'triangle'), 80)
}
const bodyRef = ref<HTMLElement | null>(null)
const inputRef = ref<HTMLTextAreaElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

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

function autoResize() {
  nextTick(() => {
    const el = inputRef.value
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 140) + 'px'
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

watch(() => chat.messages.value.length, () => {
  nextTick(() => {
    if (bodyRef.value) {
      bodyRef.value.scrollTop = bodyRef.value.scrollHeight
    }
  })
})

watch(() => chat.panelOpen.value, (open) => {
  if (open) {
    playOpenSound()
    nextTick(() => {
      if (bodyRef.value) {
        bodyRef.value.scrollTop = bodyRef.value.scrollHeight
      }
      inputRef.value?.focus()
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
  bodyRef.value?.addEventListener('click', handleCodeCopy)
})
</script>

<style scoped>
.ai-panel-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0, 0, 0, 0.25);
  backdrop-filter: blur(12px) saturate(1.5);
  -webkit-backdrop-filter: blur(12px) saturate(1.5);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.ai-panel {
  width: 100%;
  max-width: 760px;
  height: 88vh;
  max-height: 860px;
  background: rgba(255, 255, 255, 0.92);
  backdrop-filter: blur(24px) saturate(1.8);
  -webkit-backdrop-filter: blur(24px) saturate(1.8);
  border-radius: 28px;
  border: 1px solid rgba(255, 255, 255, 0.5);
  box-shadow:
    0 12px 48px rgba(0, 0, 0, 0.12),
    0 4px 16px rgba(0, 0, 0, 0.06),
    0 0 0 1px rgba(0, 0, 0, 0.03),
    0 0 120px rgba(0, 102, 255, 0.06);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: all 0.4s cubic-bezier(0.22, 1, 0.36, 1);
}

.ai-panel.fullscreen {
  max-width: none;
  width: 100vw;
  height: 100vh;
  max-height: none;
  border-radius: 0;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 24px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.05);
  flex-shrink: 0;
  background: rgba(250, 250, 250, 0.8);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

.head-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.head-icon {
  width: 38px;
  height: 38px;
  border-radius: 12px;
  background: linear-gradient(135deg, #0066ff, #5b21b6);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 12px rgba(0, 102, 255, 0.3);
  animation: iconGlow 3s ease-in-out infinite alternate;
}

@keyframes iconGlow {
  0% { box-shadow: 0 2px 12px rgba(0, 102, 255, 0.3); }
  100% { box-shadow: 0 2px 20px rgba(124, 58, 237, 0.4); }
}

.head-title {
  font-size: 15px;
  font-weight: 700;
  color: #1d1d1f;
  line-height: 1.2;
  letter-spacing: -0.01em;
}

.head-sub {
  font-size: 11px;
  color: #aeaeb2;
  margin-top: 1px;
}

.head-actions {
  display: flex;
  gap: 2px;
}

.head-btn {
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

.head-btn:hover {
  background: rgba(0, 0, 0, 0.06);
  color: #424245;
}

.panel-body {
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
  scroll-behavior: smooth;
  padding: 8px 0;
}

.panel-body::-webkit-scrollbar {
  width: 5px;
}

.panel-body::-webkit-scrollbar-track {
  background: transparent;
}

.panel-body::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.12);
  border-radius: 3px;
}

.panel-body::-webkit-scrollbar-thumb:hover {
  background: rgba(0, 0, 0, 0.2);
}

.msg-loading {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 16px 24px;
}

.msg-loading .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #aeaeb2;
  animation: dotBounce 1.4s infinite;
}

.msg-loading .dot:nth-child(2) { animation-delay: 0.2s; }
.msg-loading .dot:nth-child(3) { animation-delay: 0.4s; }

.msg-error {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 8px 20px;
  padding: 10px 16px;
  font-size: 13px;
  color: #dc2626;
  background: rgba(220, 38, 38, 0.04);
  border-radius: 10px;
  border: 1px solid rgba(220, 38, 38, 0.1);
}

.msg-error button {
  padding: 4px 12px;
  border: 1px solid rgba(220, 38, 38, 0.2);
  border-radius: 6px;
  background: #fff;
  color: #dc2626;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}

.msg-error button:hover {
  background: #dc2626;
  color: #fff;
}

.panel-foot {
  padding: 14px 20px 16px;
  border-top: 1px solid rgba(0, 0, 0, 0.05);
  flex-shrink: 0;
  background: rgba(250, 250, 250, 0.8);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

.foot-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}

.foot-att-chip {
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

.foot-att-icon {
  display: flex;
  align-items: center;
  color: #0066ff;
  flex-shrink: 0;
}

.foot-att-name {
  font-size: 12px;
  color: #1d1d1f;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.foot-att-remove {
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

.foot-att-remove:hover {
  color: #424245;
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
  min-height: 24px;
  max-height: 140px;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'PingFang SC', 'HarmonyOS Sans', sans-serif;
}

.foot-input::placeholder {
  color: #aeaeb2;
}

.foot-send {
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.06);
  color: #aeaeb2;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all 0.3s cubic-bezier(0.22, 1, 0.36, 1);
}

.foot-send.active {
  background: linear-gradient(135deg, #0066ff, #5b21b6);
  color: #fff;
  box-shadow:
    0 4px 16px rgba(0, 102, 255, 0.4),
    0 0 20px rgba(0, 102, 255, 0.12);
}

.foot-send.active:hover {
  transform: scale(1.08);
  box-shadow:
    0 6px 24px rgba(0, 102, 255, 0.5),
    0 0 32px rgba(0, 102, 255, 0.15);
}

.foot-send.active:active {
  transform: scale(0.95);
}

.send-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(0, 102, 255, 0.2);
  border-top-color: #0066ff;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

.foot-hint {
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
  font-size: 11px;
  color: #aeaeb2;
  padding: 0 4px;
}

.panel-enter-active {
  transition: all 0.45s cubic-bezier(0.22, 1, 0.36, 1);
}

.panel-leave-active {
  transition: all 0.25s cubic-bezier(0.4, 0, 1, 1);
}

.panel-enter-from {
  opacity: 0;
}

.panel-enter-from .ai-panel {
  transform: scale(0.92) translateY(30px);
  opacity: 0;
  filter: blur(8px);
}

.panel-leave-to {
  opacity: 0;
}

.panel-leave-to .ai-panel {
  transform: scale(0.95) translateY(16px);
  opacity: 0;
  filter: blur(4px);
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@keyframes dotBounce {
  0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
  40% { transform: scale(1); opacity: 1; }
}
</style>