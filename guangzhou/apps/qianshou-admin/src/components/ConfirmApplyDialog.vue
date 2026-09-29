<script setup lang="ts">
/**
 * 两步确认弹窗（API.md §1.3 的通用实现）。
 *
 * 第一步 `…/preflight` → 展示 `before → after` 差异；
 * 第二步 `…/apply` → 带一次性令牌 + 原因（≥4 字）执行。
 *
 * 契约允许某些写接口只有 preflight（属主服务尚未开放写接口），
 * 这时 `applyRequest` 省略不传，弹窗会如实说明「当前没有可执行的第二步」。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { AdminApiError, errorHint } from '@/api/errors'
import { MIN_REASON_LENGTH } from '@/api/confirm'
import type { ApplyResult, ConfirmPreview } from '@/api/types'
import DiffView from '@/components/DiffView.vue'
import ErrorAlert from '@/components/ErrorAlert.vue'

const props = defineProps<{
  modelValue: boolean
  title: string
  /** 弹窗开场的说明文字：告诉管理员这次操作会动什么。 */
  description?: string
  confirmButtonText?: string
  /** 第一步：服务端返回令牌与差异。省略表示该操作当前没有第一步（直接执行）。 */
  preflightRequest?: () => Promise<ConfirmPreview>
  /** 第二步：带令牌与原因执行。省略表示属主服务未开放写接口。 */
  applyRequest?: (token: string, reason: string) => Promise<ApplyResult>
  /** 已确认按钮（无 preflight/apply 时用于「我知道了」这类关闭动作）。 */
  acknowledgeOnly?: boolean
  /**
   * 调用方在看过预览之后禁止执行（默认不禁止）。
   *
   * 存在的理由是一个真实的误解：号池的 `duplicate` 表示"这个号**已经在池子里了**"，
   * 运营的意图已经达成 —— 这时按下去既没有意义，又会让人怀疑"是不是加了两个号"。
   * 所以调用方在拿到预览（`@previewed`）之后可以把按钮封住，并给出 `disabledReason`。
   *
   * 注意：**这不是权限判断**（权限一律由服务端判定）；它只表达"这次动作不需要执行"。
   */
  disabled?: boolean
  /** `disabled` 为真时显示在按钮旁的一句人话（说明"为什么按不动"）。 */
  disabledReason?: string
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  (event: 'applied', result: ApplyResult): void
  (event: 'closed'): void
  /**
   * 预览拿到了。调用方据此决定"这一屏该说什么"（例如号池的 `duplicate`：
   * 这个号已经在池子里了，界面必须显眼提示，而不是让运营以为加了两个号）。
   */
  (event: 'previewed', preview: ConfirmPreview): void
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
})

const preview = ref<ConfirmPreview | undefined>(undefined)
const reason = ref('')
const loadingPreview = ref(false)
const applying = ref(false)
const preflightError = ref<AdminApiError | Error | undefined>(undefined)
const applyError = ref<AdminApiError | Error | undefined>(undefined)
const nowMs = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | undefined
let previewGeneration = 0
let applyGeneration = 0

const needsApply = computed(() => props.applyRequest !== undefined)
const hasPreflight = computed(() => props.preflightRequest !== undefined)
const reasonLength = computed(() => reason.value.trim().length)
const reasonOk = computed(() => reasonLength.value >= MIN_REASON_LENGTH)

/** 令牌剩余秒数：契约是 60 秒有效，到期必须重新预览。 */
const tokenSecondsLeft = computed(() => {
  if (preview.value === undefined) return 0
  return Math.max(0, Math.ceil((preview.value.expiresAt - nowMs.value) / 1000))
})

const canApply = computed(() =>
  reasonOk.value && tokenSecondsLeft.value > 0 && !applying.value && !props.disabled)

function startTicker(): void {
  stopTicker()
  ticker = setInterval(() => {
    nowMs.value = Date.now()
  }, 1000)
}

function stopTicker(): void {
  if (ticker !== undefined) {
    clearInterval(ticker)
    ticker = undefined
  }
}

async function runPreflight(): Promise<void> {
  if (props.preflightRequest === undefined) return
  const generation = ++previewGeneration
  loadingPreview.value = true
  preflightError.value = undefined
  applyError.value = undefined
  preview.value = undefined
  try {
    const result = await props.preflightRequest()
    if (generation !== previewGeneration || !props.modelValue) return
    preview.value = result
    nowMs.value = Date.now()
    startTicker()
    // 只发一次：调用方要在同一屏上（差异上方）说清"这次动作是什么、会不会重复"。
    emit('previewed', preview.value)
  } catch (error) {
    if (generation !== previewGeneration || !props.modelValue) return
    preflightError.value = error instanceof Error ? error : new Error(String(error))
  } finally {
    if (generation === previewGeneration) loadingPreview.value = false
  }
}

async function handleConfirm(): Promise<void> {
  if (applying.value) return
  if (!needsApply.value) {
    visible.value = false
    return
  }
  if (props.disabled) return
  if (props.applyRequest === undefined || preview.value === undefined) return
  if (!reasonOk.value) {
    ElMessage.warning(`请填写操作原因，至少 ${MIN_REASON_LENGTH} 个字。`)
    return
  }
  applying.value = true
  const generation = ++applyGeneration
  applyError.value = undefined
  try {
    const result = await props.applyRequest(preview.value.token, reason.value.trim())
    if (generation !== applyGeneration || !props.modelValue) return
    ElMessage.success('已执行并写入审计日志')
    emit('applied', result)
    visible.value = false
  } catch (error) {
    if (generation !== applyGeneration || !props.modelValue) return
    applyError.value = error instanceof Error ? error : new Error(String(error))
    // 令牌问题/版本冲突必须重新预览，避免管理员对着过期差异反复点确认。
    const apiError = error instanceof AdminApiError ? error : undefined
    if (apiError !== undefined && (apiError.isConfirmTokenProblem || apiError.isVersionConflict)) {
      preview.value = undefined
      stopTicker()
    }
  } finally {
    if (generation === applyGeneration) applying.value = false
  }
}

function handleClosed(): void {
  previewGeneration++
  applyGeneration++
  loadingPreview.value = false
  applying.value = false
  stopTicker()
  preview.value = undefined
  reason.value = ''
  preflightError.value = undefined
  applyError.value = undefined
  emit('closed')
}
onBeforeUnmount(() => {
  previewGeneration++
  applyGeneration++
  stopTicker()
})

/** 每次打开都重新走一遍第一步，绝不复用上一轮的令牌。 */
watch(
  () => props.modelValue,
  (open) => {
    if (!open) {
      handleClosed()
      return
    }
    reason.value = ''
    applyError.value = undefined
    if (hasPreflight.value) {
      void runPreflight()
    } else {
      preview.value = undefined
      startTicker()
    }
  },
  { immediate: true },
)
</script>

<template>
  <el-dialog v-model="visible" :title="title" width="640px" :close-on-click-modal="false"
    @closed="handleClosed">
    <p v-if="description" class="intro">{{ description }}</p>

    <el-alert v-if="hasPreflight && loadingPreview" type="info" :closable="false" show-icon
      title="正在向服务端请求预览（不会执行任何修改）…" />

    <ErrorAlert v-if="preflightError" :error="preflightError" />

    <template v-if="preview !== undefined">
      <div class="token-row">
        <el-tag :type="tokenSecondsLeft > 0 ? 'success' : 'danger'" size="small">
          确认令牌 {{ tokenSecondsLeft > 0 ? `剩余 ${tokenSecondsLeft} 秒` : '已过期' }}
        </el-tag>
        <el-button v-if="hasPreflight" size="small" @click="runPreflight">重新预览</el-button>
      </div>
      <DiffView :before="preview.diff.before" :after="preview.diff.after" />
    </template>

    <el-alert v-if="!hasPreflight && !acknowledgeOnly" type="info" :closable="false" show-icon
      title="本操作没有预览步骤，直接执行" />

    <!-- 调用方补充的表单：放在预览下方，让管理员先看到差异再填参数。 -->
    <slot />

    <template v-if="needsApply">
      <el-divider content-position="left">操作原因（写入审计日志）</el-divider>
      <el-input v-model="reason" type="textarea" :rows="3" maxlength="200" show-word-limit
        :placeholder="`至少 ${MIN_REASON_LENGTH} 个字，例如「工单 #123 用户申诉已核对」`" />
      <p class="reason-hint">
        <span :class="{ 'reason-hint--bad': !reasonOk }">已填 {{ reasonLength }} / 最少 {{ MIN_REASON_LENGTH }} 字</span>
        <span class="reason-hint__note">原因、改前值、改后值与你的账号都会写进只追加的审计日志。</span>
      </p>
    </template>

    <ErrorAlert v-if="applyError" :error="applyError" />

    <el-alert v-if="hasPreflight && !needsApply && !acknowledgeOnly" type="warning" :closable="false" show-icon
      title="属主服务尚未提供写接口，当前只能预览，无法执行"
      description="左侧提示区会列出缺失的接口；这不是权限问题，重复点击确认不会有任何效果。" />

    <template #footer>
      <span v-if="disabled && disabledReason" class="disabled-reason">{{ disabledReason }}</span>
      <el-button @click="visible = false">{{ acknowledgeOnly ? '我知道了' : '取消' }}</el-button>
      <el-button v-if="!acknowledgeOnly" type="primary" :loading="applying" :disabled="!canApply"
        :data-disabled-by-caller="String(disabled === true)" @click="handleConfirm">
        {{ confirmButtonText ?? '确认执行' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.intro {
  margin: 0 0 12px;
  color: #606266;
  line-height: 1.6;
}

.token-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.reason-hint {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin: 8px 0 0;
  color: #909399;
  font-size: 12px;
}

.reason-hint--bad {
  color: #e6a23c;
}

.reason-hint__note {
  text-align: right;
}

.disabled-reason {
  margin-right: auto;
  color: var(--el-color-warning);
  font-size: 12px;
}
</style>
