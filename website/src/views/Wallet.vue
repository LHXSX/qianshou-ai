<template>
  <div class="wallet-v2">
    <header class="page-head">
      <div>
        <h1>收益钱包</h1>
        <p class="sub">查看余额、流水与提现</p>
      </div>
      <button class="btn-ghost" @click="loadData" :disabled="loading">刷新数据</button>
    </header>

    <div v-if="withdrawUncertain" class="portal-error" role="alert">
      <span>{{ uncertaintyMessage }}<br />请发送账号、提交时间和金额至 <a :href="`mailto:${OFFICIAL_LINKS.supportEmail}`">{{ OFFICIAL_LINKS.supportEmail }}</a> 申请人工核对。</span><button class="btn-ghost" :disabled="withdrawalLoading" @click="reviewWithdrawals">核对提现记录</button>
    </div>
    <div v-if="loading" class="loading-state">加载中...</div>

    <div v-else-if="loadError" class="portal-error" role="alert">{{ loadError }}<button class="btn-ghost" @click="loadData">重新加载</button></div>

    <template v-else-if="wallet">
      <!-- 余额大卡 -->
      <section class="balance-hero">
        <div class="balance-main">
          <div class="balance-label">可用余额</div>
          <div class="balance-amount">
            {{ wallet.wallet.balance.toFixed(2) }}
            <span class="balance-unit">EDG</span>
          </div>
          <div class="balance-meta">
            <span>Lv.{{ wallet.level.current }} · {{ tierLabel(wallet.level.tier) }}</span>
            <span>·</span>
            <span>收益倍率 ×{{ wallet.level.tier_multiplier }}</span>
          </div>
        </div>
        <div class="balance-actions">
          <button class="btn-primary" @click="openWithdraw">提现</button>
          <router-link to="/level" class="btn-ghost">查看等级权益</router-link>
        </div>
      </section>

      <!-- 统计 KPI -->
      <section class="kpi-row">
        <div class="kpi-box">
          <div class="kpi-label">累计入账</div>
          <div class="kpi-val income">+{{ wallet.wallet.total_earned.toFixed(2) }}</div>
        </div>
        <div class="kpi-box">
          <div class="kpi-label">累计支出</div>
          <div class="kpi-val expense">-{{ wallet.wallet.total_withdrawn.toFixed(2) }}</div>
        </div>
        <div class="kpi-box">
          <div class="kpi-label">待结算</div>
          <div class="kpi-val pending unavailable-value">暂未接入</div>
        </div>
        <div class="kpi-box">
          <div class="kpi-label">30 天笔数</div>
          <div class="kpi-val">{{ wallet.wallet.recent_transactions_30d }}</div>
        </div>
      </section>

      <!-- 流水 -->
      <section class="panel">
        <header class="panel-head">
          <h3>收益流水</h3>
          <div class="tabs">
            <button
              v-for="t in tabs" :key="t.value"
              class="tab" :class="{ active: txType === t.value }"
              @click="changeType(t.value)"
            >{{ t.label }}</button>
          </div>
        </header>

        <div v-if="txLoading" class="loading-state">加载流水...</div>

        <div v-else-if="txError" class="portal-error" role="alert">{{ txError }}<button class="btn-ghost" @click="loadTxs">重新加载流水</button></div>

        <div v-else-if="!txs.length" class="empty-mini">
          暂无流水记录
        </div>

        <div v-else class="portal-table-scroll"><table class="tx-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>类型</th>
              <th>备注</th>
              <th class="right">金额</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in txs" :key="t.id">
              <td><code class="small">{{ formatTime(t.created_at) }}</code></td>
              <td>
                <span class="type-tag" :class="t.type.toLowerCase()">{{ typeLabel(t.type) }}</span>
              </td>
              <td>
                <div>{{ t.note }}</div>
                <small v-if="t.metadata?.skill" class="muted">{{ t.metadata.skill }}</small>
              </td>
              <td class="right">
                <strong :class="t.amount > 0 ? 'income' : 'expense'">
                  {{ t.amount > 0 ? '+' : '' }}{{ t.amount.toFixed(4) }}
                </strong>
                <small class="muted">{{ t.currency }}</small>
              </td>
            </tr>
          </tbody>
        </table></div>

        <div v-if="txTotal > pageSize" class="pagination">
          <button :disabled="page <= 1" @click="changePage(page - 1)">‹ 上一页</button>
          <span>{{ page }} / {{ Math.ceil(txTotal / pageSize) }}</span>
          <button :disabled="page >= Math.ceil(txTotal / pageSize)" @click="changePage(page + 1)">下一页 ›</button>
        </div>
      </section>
      <section class="panel" style="margin-top: 18px">
        <header class="panel-head"><h3>提现申请</h3><button class="btn-ghost" :disabled="withdrawalLoading" @click="loadWithdrawals">刷新申请</button></header>
        <p class="muted">显示最近 100 笔申请。审核通过和已打款为不同状态。</p>
        <div v-if="withdrawalLoading" class="loading-state">读取提现申请…</div>
        <div v-else-if="withdrawalError" class="portal-error" role="alert">{{ withdrawalError }}</div>
        <div v-else-if="!withdrawals.length" class="empty-mini">暂无提现申请</div>
        <div v-else class="portal-table-scroll"><table class="tx-table"><thead><tr><th>申请编号</th><th>金额</th><th>状态</th><th>申请时间</th><th>审核说明</th></tr></thead><tbody><tr v-for="item in withdrawals" :key="item.request_no"><td>{{ item.request_no }}</td><td>{{ item.amount }} {{ item.currency }}</td><td>{{ withdrawalLabel(item.status) }}</td><td>{{ formatTime(item.created_at) }}</td><td>{{ item.review_note || '—' }}</td></tr></tbody></table></div>
      </section>
    </template>

    <RechargePanel @paid="loadData" />

    <!-- 提现对话框 (S3-T6 · 接真 /payment/withdraw) -->
    <div v-if="withdrawDialog" class="dialog-mask" @click="!submittingWithdraw && (withdrawDialog = false)">
      <div class="dialog" @click.stop>
        <h3>提现申请</h3>
        <p class="muted">这里提交提现申请；可提现额度与实际到账金额以平台核对和审核结果为准。单笔申请 100–100000 元。</p>
        <div class="form-row">
          <label>金额</label>
          <input type="number" min="100" step="0.01" v-model="withdrawAmount" :max="wallet?.wallet.balance || 0" placeholder="100" />
          <small>可用余额: {{ wallet?.wallet.balance.toFixed(2) }} EDG</small>
        </div>
        <div class="form-row">
          <label>收款方式</label>
          <select v-model="payeeKind">
            <option value="alipay">支付宝</option>
            <option value="wechat">微信</option>
            <option value="bank">银行卡</option>
          </select>
        </div>
        <div class="form-row">
          <label>收款账号</label>
          <input v-model="payeeAccount" placeholder="支付宝账号 / 微信号 / 银行卡号" />
        </div>
        <div class="form-row">
          <label>持卡人姓名</label>
          <input v-model="payeeHolder" placeholder="实名(用于核验)" />
        </div>
        <div class="form-row" v-if="payeeKind === 'bank'">
          <label>开户行</label>
          <input v-model="payeeBank" placeholder="如:招商银行北京分行" />
        </div>
        <div class="dialog-tips">
          提交后进入审核 · 审核通过并完成打款后到账 · 单笔上限 ¥100000
        </div>
        <div v-if="withdrawUncertain" class="portal-error" role="alert"><span>{{ uncertaintyMessage }}<br />联系 <a :href="`mailto:${OFFICIAL_LINKS.supportEmail}`">{{ OFFICIAL_LINKS.supportEmail }}</a>，提供账号、提交时间和金额申请核对。</span></div>
        <div class="dialog-actions">
          <button v-if="withdrawUncertain" class="btn-ghost" @click="reviewWithdrawals">核对提现记录</button>
          <button class="btn-ghost" @click="!submittingWithdraw && (withdrawDialog = false)">取消</button>
          <button class="btn-primary" @click="submitWithdraw" :disabled="submittingWithdraw || withdrawUncertain">
            {{ withdrawUncertain ? '待核实，不能提交' : submittingWithdraw ? '提交中...' : '提交申请' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { OFFICIAL_LINKS } from '../config/site'
import RechargePanel from '../components/account/RechargePanel.vue'
import { errorMessage } from '../services/identityContract'
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage } from 'element-plus'
import { myApi, httpClient, auth, type MyWallet, type MyTransaction } from '../services/api'

const withdrawals = ref<Array<{request_no: string; amount: string; currency: string; status: string; created_at: string; review_note?: string}>>([])
const withdrawalError = ref('')
const withdrawalLoading = ref(false)
const withdrawalLabel = (status: string) => ({pending: '待审核', approved: '审核通过', rejected: '已驳回', paid: '已打款', cancelled: '已取消'}[status] || status)
async function loadWithdrawals() {
  if (withdrawalLoading.value) return
  withdrawalLoading.value = true
  withdrawalError.value = ''
  try {
    const r = await httpClient.get('/payment/withdraw', {params: {limit: 100}})
    if (r.data?.ok !== true || !Array.isArray(r.data.items)) throw new Error('提现记录格式不完整')
    withdrawals.value = r.data.items
  } catch {
    withdrawals.value = []
    withdrawalError.value = '暂时无法读取提现申请，请重试。'
  } finally { withdrawalLoading.value = false }
}
const wallet = ref<MyWallet | null>(null)
const loading = ref(false)
const loadError = ref('')

const txs = ref<MyTransaction[]>([])
const txLoading = ref(false)
const txError = ref('')
let txRequest = 0
onBeforeUnmount(() => { txRequest++ })
const txType = ref<'all' | 'income' | 'expense'>('all')
const page = ref(1)
const pageSize = 20
const txTotal = ref(0)

const withdrawDialog = ref(false)
const withdrawAmount = ref('')
const payeeKind = ref<'alipay' | 'wechat' | 'bank'>('alipay')
const payeeAccount = ref('')
const payeeHolder = ref('')
const payeeBank = ref('')
const submittingWithdraw = ref(false)
// Account-scoped, non-sensitive marker survives closing/reopening this page. Reading
// history alone does not prove a timed-out POST was rejected, so it never unlocks it.
const withdrawalGuardKey = `qs.withdrawal-unconfirmed:${auth.getUser()?.id || 'unavailable'}`
const withdrawUncertain = ref(false)
try { withdrawUncertain.value = localStorage.getItem(withdrawalGuardKey) === '1' } catch { /* checked before submit */ }
const uncertaintyMessage = '无法确定这笔提现是否已经提交成功。已停止重复提交，请核对下方申请记录；记录暂未出现也不能确认提交失败，请联系平台核实。'
function markWithdrawalPending() {
  if (localStorage.getItem(withdrawalGuardKey) === '1') {
    withdrawUncertain.value = true
    throw new Error(uncertaintyMessage)
  }
  localStorage.setItem(withdrawalGuardKey, '1')
  if (localStorage.getItem(withdrawalGuardKey) !== '1') throw new Error('无法保存提现提交状态，请允许本站存储后再操作。')
}
function clearWithdrawalGuard() { localStorage.removeItem(withdrawalGuardKey) }
function reviewWithdrawals() { withdrawDialog.value = false; void loadWithdrawals() }

const tabs = [
  { label: '全部', value: 'all' as const },
  { label: '收入', value: 'income' as const },
  { label: '支出', value: 'expense' as const },
]

const loadData = async () => {
  if (loading.value) return
  loading.value = true
  loadError.value = ''
  try {
    wallet.value = await myApi.getMyWallet()
    await Promise.all([loadTxs(), loadWithdrawals()])
  } catch (e: any) {
    loadError.value = '暂时无法读取钱包，请重试。'
    ElMessage.error(errorMessage(e, '钱包加载失败，请稍后重试。'))
  } finally {
    loading.value = false
  }
}

const loadTxs = async () => {
  const currentRequest = ++txRequest
  txLoading.value = true
  txError.value = ''
  try {
    const r = await myApi.getMyTransactions({ type: txType.value, page: page.value, size: pageSize })
    if (currentRequest !== txRequest) return
    if (!r.ok || !Array.isArray(r.items)) throw new Error('流水数据格式不完整')
    txs.value = r.items
    txTotal.value = r.total
  } catch (e: any) {
    if (currentRequest !== txRequest) return
    txs.value = []
    txTotal.value = 0
    txError.value = '暂时无法读取收益流水，请重试。'
    ElMessage.error(errorMessage(e, '流水加载失败，请稍后重试。'))
  } finally {
    if (currentRequest === txRequest) txLoading.value = false
  }
}

const changeType = (t: 'all' | 'income' | 'expense') => {
  txType.value = t
  page.value = 1
  loadTxs()
}

const changePage = (p: number) => {
  page.value = p
  loadTxs()
}

const openWithdraw = () => {
  withdrawDialog.value = true
  if (!withdrawUncertain.value) withdrawAmount.value = ''
}

// S3-T6 · 2026-06-07 · 接真 /payment/withdraw
const submitWithdraw = async () => {
  if (submittingWithdraw.value || withdrawUncertain.value) return
  const amt = Number(withdrawAmount.value)
  if (!Number.isFinite(amt) || amt < 100) {
    ElMessage.warning('单笔最低 100 元')
    return
  }
  if (amt > 100000 || Math.abs(amt * 100 - Math.round(amt * 100)) > 0.000001) {
    ElMessage.warning('金额最多保留两位小数，单笔不超过 100000 元')
    return
  }
  if (amt > (wallet.value?.wallet.balance || 0)) {
    ElMessage.warning('超过可用余额')
    return
  }
  if (!payeeAccount.value.trim() || !payeeHolder.value.trim()) {
    ElMessage.warning('请填写收款账号与持卡人姓名')
    return
  }
  if (payeeKind.value === 'bank' && !payeeBank.value.trim()) {
    ElMessage.warning('银行卡提现需填开户行')
    return
  }
  try { markWithdrawalPending() } catch {
    if (withdrawUncertain.value) {
      ElMessage.error(uncertaintyMessage)
      await loadWithdrawals()
      return
    }
    ElMessage.error('无法保存提现提交状态，尚未发送申请。请允许本站存储后再操作。')
    return
  }
  submittingWithdraw.value = true
  try {
    const payee: any = {
      kind: payeeKind.value,
      account_no: payeeAccount.value.trim(),
      holder_name: payeeHolder.value.trim(),
    }
    if (payeeKind.value === 'bank') payee.bank_name = payeeBank.value.trim()
    const response = await httpClient.post('/payment/withdraw', {
      amount: amt,
      payee_info: payee,
      remark: '个人账户提现',
    })
    if (!response.data?.request_no || !response.data?.status) throw new Error('服务器未返回申请编号，请先核对提现记录，避免重复提交。')
    clearWithdrawalGuard()
    ElMessage.success(`提现申请 ${response.data.request_no} 已提交，等待审核`)
    withdrawDialog.value = false
    payeeAccount.value = ''
    payeeHolder.value = ''
    payeeBank.value = ''
    withdrawAmount.value = ''
    await loadData()
  } catch (e: any) {
    const status = Number(e?.response?.status)
    const explicitlyRejected = status >= 400 && status < 500 && status !== 408 && status !== 499
    if (explicitlyRejected) {
      clearWithdrawalGuard()
      ElMessage.error(errorMessage(e, '申请已被拒绝，请检查填写内容后再提交。'))
    } else {
      withdrawUncertain.value = true
      ElMessage.error(uncertaintyMessage)
      await loadWithdrawals()
    }
  } finally {
    submittingWithdraw.value = false
  }
}

const tierLabel = (tier: string) => {
  const map: any = { basic: '入门', bronze: '青铜', silver: '白银', gold: '黄金', diamond: '钻石' }
  return map[tier] || '入门'
}

const typeLabel = (t: string) => {
  const map: any = {
    EARN: '收益', WITHDRAW: '提现',
    BONUS: '奖励', PENALTY: '扣款',
    income: '收入', expense: '支出',
  }
  return map[t] || t
}

const formatTime = (iso: string | null) => {
  if (!iso) return '—'
  return iso.replace('T', ' ').slice(0, 19)
}

onMounted(loadData)
</script>

<style scoped>
.wallet-v2 {
  padding: 20px 24px;
  background: linear-gradient(180deg, #d8dfeb 0%, #c8d2e0 100%);
  color: #000000;
  min-height: 100vh;
}

.page-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 18px;
}
.page-head h1 { margin: 0; font-size: 24px; font-weight: 900; color: #000; }
.sub { color: #1e293b; margin: 4px 0 0; font-size: 13px; }

.btn-ghost {
  background: transparent;
  color: #1e293b;
  border: 1px solid #e2e8f0;
  padding: 8px 18px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  text-decoration: none;
}
.btn-ghost:hover { border-color: #3b82f6; color: #3b82f6; }
.btn-primary {
  background: #3b82f6;
  color: #fff;
  border: none;
  padding: 8px 18px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
}
.btn-primary:hover { background: #2563eb; }

.balance-hero {
  background: linear-gradient(135deg, #22c55e 0%, #15803d 100%);
  border-radius: 16px;
  padding: 28px;
  margin-bottom: 18px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  box-shadow: 0 10px 30px rgba(34,197,94,0.2);
}
.balance-label { font-size: 14px; opacity: 0.9; }
.balance-amount {
  font-size: 48px;
  font-weight: 700;
  margin: 8px 0;
  font-family: 'JetBrains Mono', monospace;
}
.balance-unit { font-size: 22px; opacity: 0.8; margin-left: 6px; }
.balance-meta {
  font-size: 13px;
  opacity: 0.95;
  display: flex;
  gap: 6px;
}
.balance-actions { display: flex; flex-direction: column; gap: 8px; align-items: end; }
.balance-actions .btn-primary {
  background: rgba(255,255,255,0.2);
  border: 1px solid rgba(255,255,255,0.4);
}
.balance-actions .btn-primary:hover { background: rgba(255,255,255,0.3); }
.balance-actions .btn-ghost {
  color: rgba(255,255,255,0.9);
  border-color: rgba(255,255,255,0.4);
}

.kpi-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
  margin-bottom: 18px;
}
.kpi-box {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 16px;
}
.kpi-label { color: #1e293b; font-size: 12px; }
.kpi-val {
  font-size: 22px;
  font-weight: 700;
  margin-top: 4px;
  font-family: 'JetBrains Mono', monospace;
}
.income { color: #22c55e; }
.expense { color: #ef4444; }
.pending { color: #fbbf24; }

.panel {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 14px;
  padding: 20px;
}
.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}
.panel-head h3 { margin: 0; font-size: 15px; color: #000000; }
.tabs { display: flex; gap: 4px; background: #f8fafc; padding: 4px; border-radius: 6px; }
.tab {
  background: transparent;
  border: none;
  color: #1e293b;
  padding: 5px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}
.tab.active { background: #3b82f6; color: #fff; }

.tx-table {
  width: 100%;
  border-collapse: collapse;
}
.tx-table th {
  text-align: left;
  font-size: 12px;
  color: #1e293b;
  font-weight: 500;
  padding: 10px;
  border-bottom: 1px solid #f1f5f9;
}
.tx-table th.right, .tx-table td.right { text-align: right; }
.tx-table td {
  padding: 12px 10px;
  border-bottom: 1px solid #f1f5f9;
  font-size: 13px;
  color: #0f172a;
}
.tx-table tr:hover { background: rgba(59,130,246,0.04); }
.tx-table strong {
  font-size: 14px;
  font-family: 'JetBrains Mono', monospace;
}
.tx-table small { display: block; }
.muted { color: #334155; }
code.small { color: #1e293b; font-size: 11px; font-family: 'JetBrains Mono', monospace; }

.type-tag {
  font-size: 11px;
  padding: 2px 10px;
  border-radius: 6px;
  background: #f1f5f9;
  color: #1e293b;
}
.type-tag.earn { background: rgba(34,197,94,0.12); color: #22c55e; }
.type-tag.withdraw { background: rgba(239,68,68,0.12); color: #ef4444; }

.pagination {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 12px;
  margin-top: 14px;
  font-size: 13px;
  color: #1e293b;
}
.pagination button {
  background: transparent;
  border: 1px solid #e2e8f0;
  color: #1e293b;
  padding: 5px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
}
.pagination button:disabled { opacity: 0.4; cursor: not-allowed; }
.pagination button:not(:disabled):hover { border-color: #3b82f6; color: #3b82f6; }

.empty-mini { text-align: center; padding: 40px 0; color: #334155; }
.loading-state { text-align: center; padding: 40px; color: #334155; }

/* 对话框 */
.dialog-mask {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.6);
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
}
.dialog {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 24px;
  width: 440px;
  max-width: 90vw;
}
.dialog h3 { margin: 0 0 6px 0; color: #000000; }
.dialog p { margin: 0 0 18px 0; font-size: 13px; }

.form-row label { display: block; font-size: 12px; color: #1e293b; margin-bottom: 4px; }
.form-row input {
  width: 100%;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  color: #000000;
  padding: 10px;
  border-radius: 6px;
  font-size: 14px;
  font-family: 'JetBrains Mono', monospace;
  outline: none;
  box-sizing: border-box;
}
.form-row input:focus { border-color: #3b82f6; }
.form-row small { color: #334155; font-size: 11px; }

.dialog-tips {
  background: rgba(251,191,36,0.1);
  color: #fbbf24;
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 12px;
  margin: 14px 0;
}
.dialog-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}

@media (max-width: 768px) {
  .balance-hero { flex-direction: column; gap: 18px; align-items: stretch; }
  .balance-actions { flex-direction: row; }
  .kpi-row { grid-template-columns: repeat(2, 1fr); }
}

/* ─── 浅色主题阴影增强 v2 (立体感) ─── */
.kpi-card, .kpi-box, .panel, .node-card, .market-card, .model-card,
.balance-hero, .level-hero, .welcome-bar, .filter-bar, .nodes-grid > article {
  box-shadow:
    0 1px 2px rgba(15, 23, 42, 0.04),
    0 4px 16px rgba(15, 23, 42, 0.06),
    0 1px 0 rgba(255, 255, 255, 0.9) inset;
  transition: box-shadow 0.25s, transform 0.25s;
}
.kpi-card:hover, .node-card:hover, .market-card:hover, .model-card:hover {
  box-shadow: 0 6px 20px rgba(59, 130, 246, 0.12), 0 2px 6px rgba(15, 23, 42, 0.04);
}

</style>
