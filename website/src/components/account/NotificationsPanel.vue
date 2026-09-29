<template>
  <div class="account-panel">
    <div class="account-content">
      <section class="panel">
      <header class="panel-head">
        <h3>🔔 通知中心</h3>
      </header>
      <div class="toggle-row">
        <div>
          <strong>节点离线告警</strong>
          <p class="muted">节点超过 5 分钟未在线时提醒（偏好已存档，发信通道尚未接入）</p>
        </div>
        <label class="toggle">
          <input
            type="checkbox"
            :checked="preferences.notifyOffline"
            @change="updatePreference('notifyOffline', $event)"
          >
          <span class="slider"></span>
        </label>
      </div>
      <div class="toggle-row">
        <div>
          <strong>每日收益报表</strong>
          <p class="muted">每天早上 8 点发送昨日收益总结</p>
        </div>
        <label class="toggle">
          <input
            type="checkbox"
            :checked="preferences.dailyReport"
            @change="updatePreference('dailyReport', $event)"
          >
          <span class="slider"></span>
        </label>
      </div>
      <div class="toggle-row">
        <div>
          <strong>任务失败提醒</strong>
          <p class="muted">任务失败时立即推送</p>
        </div>
        <label class="toggle">
          <input
            type="checkbox"
            :checked="preferences.notifyFailed"
            @change="updatePreference('notifyFailed', $event)"
          >
          <span class="slider"></span>
        </label>
      </div>
      <div class="toggle-row">
        <div>
          <strong>系统公告</strong>
          <p class="muted">接收新功能上线、维护通知</p>
        </div>
        <label class="toggle">
          <input
            type="checkbox"
            :checked="preferences.systemNotice"
            @change="updatePreference('systemNotice', $event)"
          >
          <span class="slider"></span>
        </label>
      </div>
      <div class="form-actions">
        <button class="btn-ghost" @click="emit('save')">保存偏好</button>
      </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import type {
  NotificationPreferenceField,
  NotificationPreferences,
} from './types'

defineProps<{
  preferences: NotificationPreferences
}>()

const emit = defineEmits<{
  save: []
  'update-preference': [field: NotificationPreferenceField, value: boolean]
}>()

const updatePreference = (field: NotificationPreferenceField, event: Event) => {
  emit('update-preference', field, (event.target as HTMLInputElement).checked)
}
</script>
