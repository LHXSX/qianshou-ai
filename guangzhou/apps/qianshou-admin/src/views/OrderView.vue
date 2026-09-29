<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { session } from '@/session/store'
import { getPaymentOrder, listPaymentOrders, listPaymentWithdrawals, paymentConfirmation, type PaymentDraft, type PaymentOrder, type PaymentWithdrawal } from '@/api/modules/payments'
import ErrorAlert from '@/components/ErrorAlert.vue'
import ConfirmApplyDialog from '@/components/ConfirmApplyDialog.vue'

const orders = ref<PaymentOrder[]>([])
const withdrawals = ref<PaymentWithdrawal[]>([])
const total = ref(0)
const offset = ref(0)
const filterAccount = ref('')
const filterStatus = ref('')
const filterGateway = ref('')
const error = ref<Error>()
const withdrawalError = ref<Error>()
const loading = ref(false)
const selected = ref<PaymentOrder>()
const accountId = ref('')
const amount = ref('')
const transaction = ref('')
const confirmOpen = ref(false)
const confirmation = ref<ReturnType<typeof paymentConfirmation>>()
const confirmTitle = ref('')
const lastResult = ref<unknown>()
const canManage = computed(() => session.permissions.includes('payment.manage') && session.admin?.scope === 'all')
let generation = 0
let detailGeneration = 0
const failure = (value: unknown) => value instanceof Error ? value : new Error('查询失败，请刷新重试。')
async function load(): Promise<void> {
  const request = ++generation
  loading.value = true; error.value = undefined; withdrawalError.value = undefined
  const outcomes = await Promise.allSettled([
    listPaymentOrders({ account_id: filterAccount.value, status: filterStatus.value, gateway: filterGateway.value, offset: offset.value, limit: 30 }),
    listPaymentWithdrawals(),
  ])
  if (request !== generation) return
  const [list, queue] = outcomes
  if (list.status === 'fulfilled') { orders.value = list.value.items; total.value = list.value.total }
  else { orders.value = []; total.value = 0; error.value = failure(list.reason) }
  if (queue.status === 'fulfilled') withdrawals.value = queue.value.items
  else { withdrawals.value = []; withdrawalError.value = failure(queue.reason) }
  loading.value = false
}
async function detail(orderNo: string): Promise<void> {
  const request = ++detailGeneration
  selected.value = undefined; transaction.value = ''; error.value = undefined
  try { const result = await getPaymentOrder(orderNo); if (request === detailGeneration) selected.value = result.order }
  catch (cause) { if (request === detailGeneration) error.value = failure(cause) }
}
function prepare(draft: PaymentDraft, title: string): void {
  if (!canManage.value || confirmOpen.value) return
  confirmation.value = paymentConfirmation(draft); confirmTitle.value = title; confirmOpen.value = true
}
function refresh(): void { selected.value = undefined; detailGeneration++; void load() }
function page(delta: number): void { offset.value = Math.max(0, offset.value + delta); refresh() }
watch(() => [session.admin?.accountId, session.admin?.scope, session.permissions.join(',')], () => {
  generation++; detailGeneration++; orders.value = []; withdrawals.value = []; selected.value = undefined; lastResult.value = undefined; total.value = 0; confirmOpen.value = false; confirmation.value = undefined
  loading.value = false; accountId.value = ''; amount.value = ''; transaction.value = ''
  filterAccount.value = ''; filterStatus.value = ''; filterGateway.value = ''; offset.value = 0
  if (session.admin && session.permissions.includes('payment.read')) void load()
}, { immediate: true })
onBeforeUnmount(() => { generation++; detailGeneration++ })
</script>

<template>
  <section class="payment-view">
    <h1>支付订单与提现</h1>
    <p>查询上海全局充值订单和审批队列。金额按上海返回的币种展示；本页不修改 SP 额度。</p>
    <el-alert type="info" :closable="false" title="退款和工单服务尚未开放。提现审批不等于打款；登记打款只记录已经完成的转账。" />
    <div class="payment-tools">
      <el-input v-model="filterAccount" aria-label="筛选账号 ID" placeholder="账号 ID" />
      <el-input v-model="filterStatus" aria-label="筛选状态" placeholder="状态，如 pending" />
      <el-input v-model="filterGateway" aria-label="筛选支付渠道" placeholder="渠道，如 admin_manual" />
      <el-button :loading="loading" @click="offset = 0; refresh()">查询</el-button>
    </div>
    <ErrorAlert v-if="error" :error="error" />
    <el-table v-if="!error" v-loading="loading" :data="orders" empty-text="当前查询没有订单">
      <el-table-column prop="order_no" label="订单号" min-width="170" />
      <el-table-column prop="account_id" label="账号" />
      <el-table-column prop="amount" label="金额" />
      <el-table-column prop="currency" label="币种" />
      <el-table-column prop="gateway" label="渠道" min-width="135" />
      <el-table-column prop="status" label="状态" />
      <el-table-column label="查看"><template #default="scope"><el-button link @click="detail(scope.row.order_no)">详情</el-button></template></el-table-column>
    </el-table>
    <div v-if="!error" class="payment-tools"><span>共 {{ total }} 条，第 {{ Math.floor(offset / 30) + 1 }} 页</span><el-button :disabled="offset === 0 || loading" @click="page(-30)">上一页</el-button><el-button :disabled="offset + 30 >= total || loading" @click="page(30)">下一页</el-button></div>
    <article v-if="selected" class="payment-card">
      <h2>订单 {{ selected.order_no }}</h2>
      <p>账号 {{ selected.account_id }} · {{ selected.amount }} {{ selected.currency }} · {{ selected.status }}</p>
      <p>创建 {{ selected.created_at }} · 支付 {{ selected.paid_at || '尚未支付' }} · 账本 {{ selected.ledger_id || '尚未返回' }}</p>
      <p>渠道 {{ selected.gateway }} · 交易流水 {{ selected.gateway_tx_id || '尚未返回' }} · {{ selected.remark }}</p>
      <template v-if="canManage && selected.status === 'pending' && ['admin_manual', 'bank_transfer'].includes(selected.gateway)">
        <el-input v-model="transaction" aria-label="入账交易流水号" placeholder="核实后的交易流水号" />
        <el-button @click="prepare({ op: 'confirm', order_no: selected.order_no, gateway_tx_id: transaction }, '确认手工订单入账')">预览手工确认</el-button>
      </template>
    </article>
    <article v-if="canManage" class="payment-card">
      <h2>手动充值</h2>
      <p>直接增加上海账号余额。余额预览暂不可用；执行后展示上海结果。网络结果不确定时先核查账本，不得重复提交。</p>
      <div class="payment-tools"><el-input v-model="accountId" aria-label="充值账号 ID" placeholder="账号 ID" /><el-input v-model="amount" aria-label="充值金额" placeholder="人民币金额，最多两位小数" /><el-button @click="prepare({ op: 'recharge', account_id: accountId, amount }, '手动充值')">预览充值</el-button></div>
    </article>
    <article v-if="lastResult" class="payment-card"><h2>上海执行结果</h2><pre>{{ JSON.stringify(lastResult, null, 2) }}</pre></article>
    <h2>提现审批队列</h2>
    <el-alert type="warning" :closable="false" title="提现打款登记暂未开放：等待上海资金锁修复与审查。当前页面不会提交打款登记。" />
    <p>展示最多 200 条待审批或已批准记录；已打款记录由上海保存。收款信息仅展示上海脱敏摘要。</p>
    <ErrorAlert v-if="withdrawalError" :error="withdrawalError" />
    <el-table v-if="!withdrawalError" v-loading="loading" :data="withdrawals" empty-text="当前队列没有提现申请">
      <el-table-column prop="request_no" label="提现单号" min-width="170" /><el-table-column prop="account_id" label="账号" />
      <el-table-column prop="amount" label="金额" /><el-table-column prop="currency" label="币种" /><el-table-column prop="status" label="状态" /><el-table-column prop="kyc_status" label="实名状态" />
      <el-table-column label="收款摘要"><template #default="scope">{{ scope.row.payee_info.account_no || '未返回' }}</template></el-table-column>
      <el-table-column label="操作" min-width="180"><template #default="scope"><template v-if="canManage">
        <el-button v-if="scope.row.status === 'pending'" link @click="prepare({ op: 'approve', request_no: scope.row.request_no }, '批准提现')">批准</el-button>
        <el-button link @click="prepare({ op: 'reject', request_no: scope.row.request_no }, '拒绝提现')">拒绝</el-button>
      </template></template></el-table-column>
    </el-table>
    <ConfirmApplyDialog v-if="confirmation" v-model="confirmOpen" :title="confirmTitle" description="核对目标、金额与状态后填写原因。确认将提交上海；未知结果须先核查，不能自动重试。" :preflight-request="confirmation.preflight" :apply-request="confirmation.apply" @applied="result => { lastResult = result.result; refresh() }" />
  </section>
</template>

<style scoped>
.payment-view { padding: 24px; }
.payment-tools { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin: 16px 0; }
.payment-tools .el-input { width: 220px; }
.payment-card { border: 1px solid var(--el-border-color); border-radius: 8px; margin: 20px 0; padding: 16px; }
.payment-card > .el-input { max-width: 400px; margin-right: 12px; }
</style>
