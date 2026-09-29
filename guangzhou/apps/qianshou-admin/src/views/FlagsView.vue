<script setup lang="ts">
/**
 * 功能开关（契约 §6 + §9）。
 *
 * 开关状态与灰度百分比都是高危写操作，必须走两步确认：
 * `flags/preflight` 展示 before → after，填原因后 `flags/apply`。
 * `version` 用于乐观并发：服务端发现预览后目标被改动会回 `409 version_conflict`，
 * 弹窗会提示重新预览（由通用两步确认组件处理）。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { formatTime } from '@/utils/format'
import { applyFlag, fetchFlags, preflightFlag } from '@/api/modules/flags'
import { useAsyncData } from '@/utils/async-state'
import type { FlagRecord } from '@/api/types'
import ErrorAlert from '@/components/ErrorAlert.vue'
import ConfirmApplyDialog from '@/components/ConfirmApplyDialog.vue'

const listState = useAsyncData(fetchFlags)

onMounted(() => {
  void listState.run()
})

const flags = computed<readonly FlagRecord[]>(() => listState.data.value ?? [])

/** 编辑抽屉（填新值）与两步确认弹窗是两个界面状态。 */
const editorOpen = ref(false)
const confirmOpen = ref(false)
const applied = ref(false)

const draftKey = ref('')
const draftTitle = ref('')
const draftEnabled = ref(false)
const draftPercent = ref(0)
const draftDescription = ref('')
const isNew = ref(false)

function openEditor(flag: FlagRecord): void {
  isNew.value = false
  draftKey.value = flag.key
  draftTitle.value = flag.title
  draftEnabled.value = flag.enabled
  draftPercent.value = flag.rolloutPercent
  draftDescription.value = flag.description
  editorOpen.value = true
}

function openCreate(): void {
  isNew.value = true
  draftKey.value = ''
  draftTitle.value = ''
  draftEnabled.value = false
  draftPercent.value = 0
  draftDescription.value = ''
  editorOpen.value = true
}

/** 打开确认弹窗：默认把改动带进第一步预览。 */
function openConfirmForDraft(): void {
  editorOpen.value = false
  applied.value = false
  confirmOpen.value = true
}

function requestPreview() {
  return preflightFlag({
    key: draftKey.value.trim(),
    title: draftTitle.value.trim(),
    enabled: draftEnabled.value,
    rolloutPercent: draftPercent.value,
    description: draftDescription.value.trim(),
  })
}

async function refreshAfterApply(): Promise<void> {
  await listState.run()
}

function handleApplied(): void {
  applied.value = true
  void refreshAfterApply()
}

/** 取消关闭时把编辑器还给管理员，避免填了一半的参数被吞掉。 */
function handleConfirmClosed(): void {
  if (applied.value) {
    applied.value = false
    return
  }
  editorOpen.value = true
}

/** 快速切换：把「反选 enabled」的改动直接送进两步确认。 */
async function quickToggle(flag: FlagRecord): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `把开关 ${flag.key} 从「${flag.enabled ? '开启' : '关闭'}」改为「${flag.enabled ? '关闭' : '开启'}」？接下来仍会展示差异并要求填写原因。`,
      '调整功能开关',
      { confirmButtonText: '继续', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }
  openEditor(flag)
  draftEnabled.value = !flag.enabled
  openConfirmForDraft()
}

const editorValid = computed(() => draftKey.value.trim() !== '')
</script>

<template>
  <div class="qs-page">
    <div class="qs-page__head">
      <div>
        <h2 class="qs-page__title">功能开关</h2>
        <p class="qs-page__desc">
          开关与灰度百分比都是高危写操作：先由服务端给出 before → after 预览，填原因后才能执行，
          结果写入只追加的审计日志。
        </p>
      </div>
      <div class="actions">
        <el-button :loading="listState.loading.value" @click="listState.run">刷新</el-button>
        <el-button type="primary" @click="openCreate">新建开关</el-button>
      </div>
    </div>

    <ErrorAlert v-if="listState.error.value" :error="listState.error.value" />

    <el-card class="qs-card" shadow="never">
      <el-table v-loading="listState.loading.value" :data="[...flags]" border size="small">
        <el-table-column label="key" min-width="200">
          <template #default="{ row }">
            <span class="qs-mono">{{ row.key }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="title" label="名称" min-width="150" />
        <el-table-column label="开关" width="110">
          <template #default="{ row }">
            <el-tag :type="row.enabled ? 'success' : 'info'" size="small">{{ row.enabled ? '开启' : '关闭' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="灰度" width="180">
          <template #default="{ row }">
            <el-progress :percentage="row.rolloutPercent" :stroke-width="10" />
          </template>
        </el-table-column>
        <el-table-column prop="description" label="说明" min-width="200" />
        <el-table-column label="最近修改" min-width="180">
          <template #default="{ row }">
            <div>{{ formatTime(row.updatedAt) }}</div>
            <div class="qs-mono updater">{{ row.updatedBy }}</div>
          </template>
        </el-table-column>
        <el-table-column label="version" width="100" align="right">
          <template #default="{ row }">
            <span class="qs-mono">{{ row.version }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="170" fixed="right">
          <template #default="{ row }">
            <el-button link type="warning" @click="quickToggle(row)">
              {{ row.enabled ? '关闭' : '开启' }}
            </el-button>
            <el-button link type="primary" @click="openEditor(row)">修改</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="flags.length === 0 && !listState.loading.value" description="服务端未返回任何功能开关" />
    </el-card>

    <el-drawer v-model="editorOpen" :title="isNew ? '新建功能开关' : `修改开关 ${draftKey}`" size="520px">
      <el-form label-position="top">
        <el-form-item label="key">
          <el-input v-model="draftKey" class="qs-mono" :disabled="!isNew" placeholder="例如 feature.new-router" />
        </el-form-item>
        <el-form-item label="名称">
          <el-input v-model="draftTitle" />
        </el-form-item>
        <el-form-item label="开关">
          <el-switch v-model="draftEnabled" active-text="开启" inactive-text="关闭" inline-prompt />
        </el-form-item>
        <el-form-item :label="`灰度百分比：${draftPercent}%`">
          <el-slider v-model="draftPercent" :min="0" :max="100" :step="1" show-input />
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="draftDescription" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editorOpen = false">取消</el-button>
        <el-button type="primary" :disabled="!editorValid" @click="openConfirmForDraft">下一步：预览差异</el-button>
      </template>
    </el-drawer>

    <ConfirmApplyDialog v-model="confirmOpen" title="功能开关变更（两步确认）"
      description="服务端会把 enabled / rolloutPercent 的改动整理成 before → after。确认前请核对灰度范围，避免误放量。"
      :preflight-request="requestPreview" :apply-request="applyFlag" confirm-button-text="确认执行"
      @applied="handleApplied" @closed="handleConfirmClosed" />
  </div>
</template>

<style scoped>
.updater {
  color: #909399;
}

.actions {
  display: flex;
  gap: 8px;
}
</style>
