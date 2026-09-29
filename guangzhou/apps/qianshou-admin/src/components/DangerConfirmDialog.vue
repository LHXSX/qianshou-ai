<script setup lang="ts">
/**
 * 高危操作的二次确认弹窗（**与平常的两步确认弹窗长得不一样**）。
 *
 * 为什么单独做一份而不是复用 `ConfirmApplyDialog`：那个弹窗的确认按钮是普通主色，
 * 而"移除号池成员"会真的删掉凭据文件里的一行 —— 撤销按钮与平常按钮长一样，
 * 是把高危操作伪装成日常操作。这里三处刻意不同：
 *
 * 1. 确认按钮是 **danger 实心**，且文案写明动作（"确认移除"），不是"确定"；
 * 2. 预览结果先以**只读事实**摆出来（要删的是哪个号、什么身份、什么指纹），
 *    再让管理员填原因 —— 顺序与"先填表再确认"相反；
 * 3. 原因不足 4 字 / 令牌过期时按钮**点不动**（而不是点了才报错）。
 *
 * 与通用弹窗共享同一套契约顺序：`…/preflight` 拿令牌 → 填原因 → `…/apply`。
 * 权限判断全部在服务端；这里不做任何安全判断。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { AdminApiError } from '@/api/errors'
import { MIN_REASON_LENGTH } from '@/api/confirm'
import { fingerprintCell } from '@/api/modules/pool'
import type { PoolApplyResult, PoolPreview } from '@/api/modules/pool'
import ErrorAlert from '@/components/ErrorAlert.vue'

const props = defineProps<{
  modelValue: boolean
  title: string
  /** 要移除的号（ref），展示用。 */
  target: string
  description?: string
  confirmButtonText?: string
  /** 第一步：服务端返回令牌与差异（移除走 `pool/preflight` 的 `op: 'remove'` 分支）。 */
  preflightRequest: () => Promise<PoolPreview>
  /** 第二步：带令牌与原因执行。 */
  applyRequest: (token: string, reason: string) => Promise<PoolApplyResult>
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  (event: 'applied', result: PoolApplyResult): void
  (event: 'closed'): void
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
})

const preview = ref<PoolPreview | undefined>(undefined)
const reason = ref('')
const loadingPreview = ref(false)
const applying = ref(false)
const preflightError = ref<Error | undefined>(undefined)
const applyError = ref<Error | undefined>(undefined)
const nowMs = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | undefined

const reasonLength = computed(() => reason.value.trim().length)
const reasonOk = computed(() => reasonLength.value >= MIN_REASON_LENGTH)

/** 令牌剩余秒数：契约是 60 秒有效，到期必须重新预览。 */
const secondsLeft = computed(() => {
  if (preview.value === undefined) return 0
  return Math.max(0, Math.ceil((preview.value.expiresAt - nowMs.value) / 1000))
})

const canApply = computed(() => reasonOk.value && secondsLeft.value > 0 && !applying.value && preview.value !== undefined)

/** 预览里的"要删掉的那个号"：服务端 `op: 'remove'` 分支的 `diff.before`。 */
const before = computed(() => preview.value?.diff.before ?? undefined)
const beforeFingerprint = computed(() => fingerprintCell({ fingerprint: before.value?.fingerprint }).text)

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
  loadingPreview.value = true
  preflightError.value = undefined
  applyError.value = undefined
  preview.value = undefined
  try {
    preview.value = await props.preflightRequest()
    nowMs.value = Date.now()
    startTicker()
  } catch (error) {
    preflightError.value = error instanceof Error ? error : new Error(String(error))
  } finally {
    loadingPreview.value = false
  }
}

async function handleConfirm(): Promise<void> {
  if (preview.value === undefined) return
  if (!reasonOk.value) {
    ElMessage.warning(`请填写操作原因，至少 ${MIN_REASON_LENGTH} 个字。`)
    return
  }
  applying.value = true
  applyError.value = undefined
  try {
    const result = await props.applyRequest(preview.value.token, reason.value.trim())
    emit('applied', result)
    visible.value = false
  } catch (error) {
    applyError.value = error instanceof Error ? error : new Error(String(error))
    // 令牌问题必须重新预览：对着过期令牌反复点确认只会一直失败。
    const apiError = error instanceof AdminApiError ? error : undefined
    if (apiError !== undefined && (apiError.isConfirmTokenProblem || apiError.isVersionConflict)) {
      preview.value = undefined
      stopTicker()
    }
  } finally {
    applying.value = false
  }
}

function handleClosed(): void {
  stopTicker()
  preview.value = undefined
  reason.value = ''
  preflightError.value = undefined
  applyError.value = undefined
  emit('closed')
}

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
    void runPreflight()
  },
  { immediate: true },
)

/** 移除没有探测步骤：服务端明说 `probe: null` 是"不适用"，不是"通过"。 */
const probeNote = computed(() =>
  '移除不做探测：没有新凭据要验。这里的"没有探测结论"是不适用，不是"通过了"。',
)
</script>

<template>
  <el-dialog v-model="visible" :title="title" width="640px" :close-on-click-modal="false" @closed="handleClosed">
    <p v-if="description" class="intro">{{ description }}</p>

    <el-alert type="warning" :closable="false" show-icon class="danger-note"
      title="这一步会改真实凭据文件"
      description="写入协议是备份 → 跨进程写者锁 → 原子替换 → 权限复核 0600 → 失败回滚；但成功之后这个号就不再被网关取到了。" />

    <el-alert v-if="loadingPreview" type="info" :closable="false" show-icon
      title="正在向服务端请求预览（不会执行任何修改）…" />

    <ErrorAlert v-if="preflightError" :error="preflightError" />
    <el-button v-if="preflightError" size="small" @click="runPreflight">重新预览</el-button>

    <template v-if="preview !== undefined">
      <div class="token-row">
        <el-tag :type="secondsLeft > 0 ? 'success' : 'danger'" size="small">
          确认令牌 {{ secondsLeft > 0 ? `剩余 ${secondsLeft} 秒` : '已过期，请重新预览' }}
        </el-tag>
        <el-button size="small" @click="runPreflight">重新预览</el-button>
      </div>

      <div class="facts">
        <div class="facts__row">
          <span class="facts__key">要移除的号</span>
          <span class="facts__value qs-mono">{{ before?.ref ?? target }}</span>
        </div>
        <div class="facts__row">
          <span class="facts__key">标签</span>
          <span class="facts__value">{{ before === undefined ? '（服务端未返回）' : (before.label === '' ? '（未起名）' : before.label) }}</span>
        </div>
        <div class="facts__row">
          <span class="facts__key">身份</span>
          <span class="facts__value">
            <span class="qs-mono">{{ before?.authId ?? '（服务端未返回 authId）' }}</span>
            <span class="sub"> / {{ before?.email ?? '（服务端未返回邮箱）' }}</span>
          </span>
        </div>
        <div class="facts__row">
          <span class="facts__key">改前指纹</span>
          <span class="facts__value qs-mono">{{ beforeFingerprint }}</span>
        </div>
        <div class="facts__row">
          <span class="facts__key">改后</span>
          <span class="facts__value">{{ preview.diff.after === null ? 'null（凭据文件里那一行会被删掉，元数据也会清掉）' : String(preview.diff.after) }}</span>
        </div>
      </div>

      <p class="qs-empty-hint">{{ probeNote }}</p>
    </template>

    <el-divider content-position="left">操作原因（写入审计日志）</el-divider>
    <el-input v-model="reason" type="textarea" :rows="3" maxlength="200" show-word-limit
      :placeholder="`至少 ${MIN_REASON_LENGTH} 个字，例如「该号已停用，工单 #123 已核对」`" />
    <p class="reason-hint">
      <span :class="{ 'reason-hint--bad': !reasonOk }">已填 {{ reasonLength }} / 最少 {{ MIN_REASON_LENGTH }} 字</span>
      <span class="reason-hint__note">改前值、改后值与你的账号都会写进只追加的审计日志。</span>
    </p>

    <ErrorAlert v-if="applyError" :error="applyError" />

    <template #footer>
      <el-button @click="visible = false">取消（什么都不改）</el-button>
      <el-button type="danger" :loading="applying" :disabled="!canApply" @click="handleConfirm">
        {{ confirmButtonText ?? '确认移除' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.intro {
  margin: 0 0 16px;
  color: var(--el-text-color-regular);
  line-height: 1.6;
}

.danger-note {
  margin-bottom: 16px;
}

.token-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
}

.facts {
  margin-bottom: 8px;
}

.facts__row {
  display: flex;
  gap: 16px;
  padding: 8px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.facts__key {
  flex: 0 0 96px;
  color: var(--el-text-color-secondary);
}

.facts__value {
  flex: 1;
  word-break: break-all;
}

.sub {
  color: var(--el-text-color-secondary);
}

.reason-hint {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin: 8px 0 0;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.reason-hint--bad {
  color: var(--el-color-warning);
}

.reason-hint__note {
  text-align: right;
}
</style>
