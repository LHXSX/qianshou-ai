<template>
  <div class="msg" :class="[msg.role, { streaming: msg.streaming }]">
    <div class="msg-avatar">
      <span v-if="msg.role === 'user'">👤</span>
      <span v-else-if="msg.role === 'system'">🤖</span>
      <span v-else>🧠</span>
    </div>
    <div class="msg-body">
      <div class="msg-role">
        {{ msg.role === 'user' ? '你' : msg.role === 'system' ? '千手问道' : '千手执棋' }}
      </div>
      <div class="msg-content" v-html="rendered"></div>
      <span v-if="msg.streaming" class="cursor-blink">|</span>
      <!-- P0-C：降级提示徽章。聚合超时/失败时显示橙色 chip + hover 显示原因 -->
      <div v-if="msg.degraded" class="degraded-badge" :title="msg.degradedReason || '部分流程降级'">
        ⚠️ 结果可能不完整（{{ shortReason }}）
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { ChatMessage } from '../../composables/useAIChat'

const props = defineProps<{ msg: ChatMessage }>()

const rendered = computed(() => {
  let text = props.msg.content
  text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>')
  text = text.replace(/\n/g, '<br>')
  return text
})

// P0-C：把后端的 degraded_reason（aggregate_timeout_60s / aggregate_exception:xxx）
// 简化成一个友好的中文短语；详细原因在 title 提示里
const shortReason = computed(() => {
  const r = props.msg.degradedReason || ''
  if (r.startsWith('aggregate_timeout')) return '聚合超时'
  if (r.startsWith('aggregate_exception')) return '聚合服务异常'
  if (r.startsWith('aggregator_failed')) return '主模型聚合失败'
  return '部分流程降级'
})
</script>

<style scoped>
.msg {
  display: flex;
  gap: 12px;
  padding: 16px 20px;
  animation: msgIn 0.25s ease-out;
}

.msg.user {
  flex-direction: row-reverse;
}

.msg.system {
  background: linear-gradient(135deg, #f0f4ff 0%, #faf5ff 100%);
  border-bottom: 1px solid rgba(0, 102, 255, 0.08);
}

.msg-avatar {
  width: 32px;
  height: 32px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  flex-shrink: 0;
  background: #f3f4f6;
}

.msg.user .msg-avatar {
  background: linear-gradient(135deg, #0066ff, #7c3aed);
}

.msg-body {
  max-width: 75%;
  min-width: 0;
}

.msg.user .msg-body {
  text-align: right;
}

.msg-role {
  font-size: 12px;
  font-weight: 600;
  color: #86868b;
  margin-bottom: 4px;
}

.msg-content {
  font-size: 15px;
  line-height: 1.65;
  color: #1d1d1f;
  word-break: break-word;
}

.msg.user .msg-content {
  background: linear-gradient(135deg, #0066ff, #7c3aed);
  color: #fff;
  padding: 12px 16px;
  border-radius: 18px 18px 4px 18px;
  display: inline-block;
  text-align: left;
}

.msg-content :deep(strong) {
  font-weight: 600;
  color: #0066ff;
}

.msg.user .msg-content :deep(strong) {
  color: #fff;
}

.msg-content :deep(code) {
  background: rgba(0, 0, 0, 0.06);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 13px;
  font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
}

.msg.user .msg-content :deep(code) {
  background: rgba(255, 255, 255, 0.2);
}

.cursor-blink {
  display: inline-block;
  color: #0066ff;
  font-weight: 700;
  animation: blink 0.8s infinite;
}

@keyframes msgIn {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

/* P0-C：降级提示徽章 */
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