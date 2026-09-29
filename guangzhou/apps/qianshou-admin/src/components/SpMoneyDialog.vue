<script setup lang="ts">
/** Enter the reason and duration before authoritative preview; no hidden expiry or retry policy. */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { session } from '@/session/store'
import { applyWorkbench, checkWorkbench, previewWorkbench, type WorkbenchAction, type WorkbenchPreview } from '@/api/modules/workbench'
import { rememberWorkbenchOperation, workbenchRecovery, completeWorkbenchRecovery } from '@/api/modules/workbench-recovery'
import { formatTime } from '@/utils/format'
import DiffView from './DiffView.vue'
import ErrorAlert from './ErrorAlert.vue'
const props = defineProps<{ modelValue: boolean; action: WorkbenchAction; accountId?: string; tier?: string; tiers?: readonly { id: string; label: string }[] }>()
const emit = defineEmits<{ (event: 'update:modelValue', value: boolean): void; (event: 'applied'): void; (event: 'receipt', text: string): void }>()
const visible = computed({ get: () => props.modelValue, set: value => emit('update:modelValue', value) })
const account = ref(''); const delta = ref(''); const bucket = ref('recharge'); const tier = ref('')
const from = ref(''); const to = ref(''); const permanent = ref(false); const reason = ref('')
const preview = ref<WorkbenchPreview>(); const busy = ref(false); const error = ref<Error>(); const outcome = ref('')
const applied = ref(false); const uncertain = ref(false); const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
let generation = 0
const operationId = computed(() => String(preview.value?.diff.after.ref ?? ''))
const canApply = computed(() => preview.value !== undefined && preview.value.expiresAt > now.value && !busy.value && !applied.value && !uncertain.value)
const localDate = (stamp = Date.now()) => {
  const value = new Date(stamp); const pad = (n: number) => String(n).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`
}
const business = computed(() => preview.value?.diff.after ?? {})
const before = computed(() => preview.value?.diff.before ?? {})
const sp = (value: unknown): string => typeof value === 'number' && Number.isFinite(value)
  ? value.toLocaleString('zh-CN', { maximumFractionDigits: 6 }) : '—'
const tierLabel = computed(() => {
  const id = String(business.value.tier ?? '')
  return props.tiers?.find(item => item.id === id)?.label
    ?? ({ free: '免费版', basic: '普通版', plus: '高级版', max: 'Max 版' } as Record<string, string>)[id] ?? id
})
const moneyChange = computed(() => {
  const value = business.value.deltaSp
  return typeof value === 'number' ? `${value > 0 ? '补入' : '扣回'} ${sp(Math.abs(value))} SP` : '—'
})
const dateLabel = (value: unknown) => value === null ? '不过期（本次明确选择）' : typeof value === 'number' ? formatTime(value) : '—'
const asError = (value: unknown) => value instanceof Error ? value : new Error('工作台请求失败。')
function stop(): void { if (timer) clearInterval(timer); timer = undefined }
watch(() => props.modelValue, (open) => {
  generation++; stop()
  if (!open) return
  const recovery = workbenchRecovery(props.action)
  if (recovery !== undefined) {
    preview.value = { token: '', expiresAt: 0, diff: recovery.diff }; uncertain.value = true; applied.value = false
    account.value = String(recovery.diff.after.accountId ?? ''); reason.value = String(recovery.diff.after.reason ?? '')
    delta.value = typeof recovery.diff.after.deltaSp === 'number' ? String(recovery.diff.after.deltaSp) : ''
    bucket.value = String(recovery.diff.after.bucket ?? 'recharge'); tier.value = String(recovery.diff.after.tier ?? '')
    from.value = typeof recovery.diff.after.from === 'number' ? localDate(recovery.diff.after.from) : ''
    permanent.value = recovery.diff.after.to === null
    to.value = typeof recovery.diff.after.to === 'number' ? localDate(recovery.diff.after.to) : ''
    outcome.value = `操作 ${recovery.ref} 已发起但仍需核查；当前只可核查原操作。`
    emit('receipt', outcome.value)
  }
  if (uncertain.value && preview.value !== undefined) {
    busy.value = false; now.value = Date.now(); timer = setInterval(() => { now.value = Date.now() }, 1000); return
  }
  account.value = props.accountId ?? ''; tier.value = props.tier ?? ''; delta.value = ''; bucket.value = 'recharge'
  from.value = localDate(); to.value = ''; permanent.value = false; reason.value = ''; preview.value = undefined
  busy.value = false; error.value = undefined; outcome.value = ''; applied.value = false; uncertain.value = false
  timer = setInterval(() => { now.value = Date.now() }, 1000)
}, { immediate: true })
watch(() => session.admin?.accountId, () => { generation++; preview.value = undefined; visible.value = false; stop() })
onBeforeUnmount(() => { generation++; stop() })
async function prepare(): Promise<void> {
  if (busy.value) return
  const request = generation; error.value = undefined; busy.value = true
  try {
    if (!account.value.trim() || reason.value.trim().length < 4) throw new Error('请填写目标账号和至少 4 字的操作原因。')
    const draft: Record<string, unknown> = { accountId: account.value.trim(), reason: reason.value.trim() }
    if (props.action === 'adjustment') {
      const value = Number(delta.value)
      if (!Number.isFinite(value) || value === 0) throw new Error('请填写非零 SP 增量，正数补入、负数扣回。')
      Object.assign(draft, { deltaSp: value, bucket: bucket.value })
    } else {
      const start = new Date(from.value).getTime(); const end = permanent.value ? null : new Date(to.value).getTime()
      if (!tier.value || !Number.isFinite(start) || (end !== null && (!Number.isFinite(end) || end <= start))) throw new Error('请选择档位及明确的生效和到期时间；不过期须单独勾选。')
      Object.assign(draft, { tier: tier.value, from: start, to: end })
    }
    const result = await previewWorkbench(props.action, draft)
    if (request !== generation) return
    preview.value = result; now.value = Date.now(); emit('receipt', `已预览操作 ${String(result.diff.after.ref)}，尚未执行。`)
  } catch (cause) { if (request === generation) error.value = asError(cause) }
  finally { if (request === generation) busy.value = false }
}
async function apply(): Promise<void> {
  if (!canApply.value || preview.value === undefined) return
  const request = generation; busy.value = true; error.value = undefined
  const operator = session.admin?.accountId ?? ''; const operation = operationId.value
  rememberWorkbenchOperation(props.action, preview.value)
  try {
    await applyWorkbench(props.action, preview.value)
    completeWorkbenchRecovery(props.action, operation, operator)
    if (request !== generation) return
    applied.value = true; outcome.value = props.action === 'adjustment' ? '工作台已确认本次 SP 调整。' : '工作台已确认本次订阅变更。'
    emit('receipt', `工作台已确认操作 ${operationId.value}。`); emit('applied')
  } catch (cause) {
    if (request !== generation) return
    error.value = asError(cause); uncertain.value = true
    emit('receipt', `操作 ${operationId.value} 未收到可确认的成功结果；请使用原操作号核查，勿另建重复操作。`)
  } finally { if (request === generation) busy.value = false }
}
async function check(): Promise<void> {
  if (busy.value || preview.value === undefined) return
  const request = generation; busy.value = true; error.value = undefined
  const operator = session.admin?.accountId ?? ''; const operation = operationId.value
  try {
    const result = await checkWorkbench(props.action, preview.value)
    if (result.recorded) completeWorkbenchRecovery(props.action, operation, operator)
    if (request !== generation) return
    outcome.value = result.recorded ? `工作台已记录操作 ${result.ref}。` : `工作台当前未报告操作 ${result.ref} 已记录；本次核查未提交修改。`
    if (result.recorded) { applied.value = true; emit('applied') }
    emit('receipt', outcome.value)
  } catch (cause) { if (request === generation) error.value = asError(cause) }
  finally { if (request === generation) busy.value = false }
}
</script>
<template>
  <el-dialog v-model="visible" class="qs-sp-money-dialog" top="20px" :title="action === 'adjustment' ? '调整 SP 额度' : '开通或变更订阅'" width="680px" :show-close="!busy" :close-on-click-modal="false" :close-on-press-escape="!busy">
    <p>填写后先向工作台预览真实状态，再确认执行。操作原因与金额、期限会一起绑定确认。</p>
    <el-form v-if="!preview" label-position="top" :disabled="busy || preview !== undefined">
      <el-form-item label="目标账号"><el-input v-model="account" aria-label="目标账号" /></el-form-item>
      <template v-if="action === 'adjustment'">
        <el-form-item label="SP 增量（正数补入，负数扣回）"><el-input v-model="delta" aria-label="SP 增量" /></el-form-item>
        <el-form-item label="余额类型"><el-select v-model="bucket" aria-label="余额类型"><el-option value="recharge" label="充值余额" /><el-option value="earning" label="收益余额" /></el-select></el-form-item>
      </template>
      <template v-else>
        <el-form-item label="档位"><el-select v-model="tier" aria-label="订阅档位"><el-option v-for="item in tiers ?? []" :key="item.id" :label="item.label" :value="item.id" /></el-select></el-form-item>
        <el-form-item label="生效时间（当前设备时区）"><el-input v-model="from" type="datetime-local" aria-label="生效时间" /></el-form-item>
        <el-form-item label="到期时间（当前设备时区）"><el-input v-model="to" :disabled="permanent" type="datetime-local" aria-label="到期时间" /></el-form-item>
        <el-checkbox v-model="permanent" aria-label="明确设为不过期">明确设为不过期</el-checkbox>
      </template>
      <el-form-item label="操作原因（至少 4 字）"><el-input v-model="reason" aria-label="操作原因" type="textarea" :maxlength="200" /></el-form-item>
    </el-form>
    <ErrorAlert v-if="error" :error="error" />
    <template v-if="preview">
      <el-descriptions :column="1" border size="small" class="sp-summary" aria-label="本次操作摘要">
        <el-descriptions-item label="目标账号">{{ business.accountId }}</el-descriptions-item>
        <template v-if="action === 'adjustment'">
          <el-descriptions-item label="本次调整"><strong>{{ moneyChange }}</strong></el-descriptions-item>
          <el-descriptions-item label="余额类型">{{ business.bucket === 'earning' ? '收益余额' : '充值余额' }}</el-descriptions-item>
          <el-descriptions-item label="预览时总可用 SP">{{ sp(before.purchasableSp) }} SP</el-descriptions-item>
        </template>
        <template v-else>
          <el-descriptions-item label="订阅档位">{{ tierLabel }}</el-descriptions-item>
          <el-descriptions-item label="生效时间">{{ dateLabel(business.from) }}</el-descriptions-item>
          <el-descriptions-item label="到期时间">{{ dateLabel(business.to) }}</el-descriptions-item>
        </template>
        <el-descriptions-item label="操作原因">{{ business.reason }}</el-descriptions-item>
      </el-descriptions>
      <p v-if="action === 'subscription'">时间按当前设备时区显示。</p>
      <p class="sp-operation-ref">操作号：{{ operationId }}</p>
      <p>{{ applied ? '操作已确认' : uncertain ? '原操作待核查，不能再次执行' : preview.expiresAt > now ? '请核对以上内容，再确认执行' : '确认已过期，请关闭后重新填写' }}</p>
      <el-collapse><el-collapse-item title="查看技术原始差异" name="technical"><DiffView :before="preview.diff.before" :after="preview.diff.after" /></el-collapse-item></el-collapse>
    </template>
    <el-alert v-if="uncertain" type="warning" :closable="false" title="请核查原操作；当前不会自动重试，不能以新操作号重复提交。" />
    <p v-if="outcome" class="sp-operation-ref">{{ outcome }}</p>
    <template #footer>
      <el-button :disabled="busy" @click="visible = false">关闭</el-button>
      <el-button v-if="!preview" :loading="busy" @click="prepare">请求真实预览</el-button>
      <el-button v-if="preview" :disabled="busy" @click="check">核查同一操作</el-button>
      <el-button v-if="preview" type="primary" :disabled="!canApply" :loading="busy" @click="apply">确认执行</el-button>
    </template>
  </el-dialog>
</template>

<style>
.qs-sp-money-dialog.el-dialog {
  max-width: calc(100vw - 24px);
  max-height: calc(100dvh - 40px);
  display: flex;
  flex-direction: column;
  margin-bottom: 20px;
}
.qs-sp-money-dialog .el-dialog__header,
.qs-sp-money-dialog .el-dialog__footer { flex-shrink: 0; }
.qs-sp-money-dialog .el-dialog__body { min-height: 0; overflow: auto; }
.qs-sp-money-dialog .el-dialog__footer { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; padding-top: 16px; }
.qs-sp-money-dialog .el-dialog__footer .el-button + .el-button { margin-left: 0; }
.qs-sp-money-dialog .sp-operation-ref,
.qs-sp-money-dialog .sp-summary .el-descriptions__cell { overflow-wrap: anywhere; word-break: break-word; }
.qs-sp-money-dialog .sp-summary .el-descriptions__label { width: 132px; }
@media (max-width: 480px) {
  .qs-sp-money-dialog .sp-summary .el-descriptions__label { width: 112px; }
}
</style>
