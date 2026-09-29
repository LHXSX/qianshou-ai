<template>
  <section class="recharge-panel">
    <header class="recharge-head">
      <div><span class="recharge-eyebrow">账户充值</span><h3>微信扫码支付</h3><p>创建人民币充值单后，用微信扫一扫付款。到账状态以平台订单和账本为准。</p></div>
      <span class="recharge-channel" :class="{ ready: wechatAvailable }">{{ channelsLoading ? '正在检查通道' : wechatAvailable ? '微信支付可用' : '通道未开通' }}</span>
    </header>
    <div v-if="channelError" class="recharge-error" role="alert">{{ channelError }} <button type="button" @click="loadChannels">重试</button></div>
    <div v-else-if="!channelsLoading && !wechatAvailable" class="recharge-note">{{ channelReason || '微信支付尚未配置完成，暂时无法创建充值单。' }}</div>

    <div class="recharge-entry">
      <label for="recharge-amount">充值金额 <span>人民币 CNY</span></label>
      <div class="recharge-input"><span>¥</span><input id="recharge-amount" v-model="amount" inputmode="decimal" placeholder="输入金额" :disabled="!wechatAvailable || submitting || Boolean(currentOrder) || Boolean(pendingMarker)" /><button type="button" :disabled="!wechatAvailable || submitting || Boolean(currentOrder) || Boolean(pendingMarker)" @click="createOrder">{{ submitting ? '正在创建…' : '生成付款二维码' }}</button></div>
      <small>页面不会在扫码后直接记为已付款，需等待服务器确认。</small>
    </div>

    <div v-if="error" class="recharge-error" role="alert">{{ error }}</div>
    <div v-if="pendingMarker && (!currentOrder || !markerMatches(currentOrder))" class="recharge-warning" role="alert">上一次充值申请结果尚未确认，已停止重复创建。请先刷新下方订单记录；仍找不到原单时联系平台核对。<button type="button" @click="loadOrders">核对订单</button></div>
    <div v-if="currentOrder" class="recharge-order">
      <div class="recharge-order-meta"><div><strong>原订单 {{ currentOrder.order_no }}</strong><span>¥{{ currentOrder.amount }} · {{ orderLabel(currentOrder.status) }}</span></div><button v-if="(currentOrder.status === 'pending' || currentOrder.status === 'expired') && currentOrder.provider_state !== 'CLOSED'" type="button" @click="checkStatus(true)" :disabled="checking">{{ checking ? '核对中…' : '核对付款结果' }}</button><button v-else-if="!pendingMarker" type="button" @click="startNewOrder">新建充值单</button></div>
      <div v-if="currentOrder.provider_state === 'CLOSED'" class="recharge-note">微信已确认关闭这笔订单，可以重新创建充值单。</div>
      <div v-else-if="currentOrder.status === 'pending'" class="recharge-pay-content">
        <img v-if="qrImage" :src="qrImage" alt="微信支付二维码" width="210" height="210" />
        <div class="recharge-pay-info"><strong>{{ qrImage ? '使用微信扫一扫' : '请重新获取原订单二维码' }}</strong><p>请确认微信收银台金额与这里的 ¥{{ currentOrder.amount }} 一致，再完成支付。</p><p v-if="currentOrder.expired_at">订单有效期至 {{ formatTime(currentOrder.expired_at) }}</p><button v-if="!qrImage" type="button" :disabled="checking" @click="retryOriginal">重新获取此单二维码</button></div>
      </div>
      <div v-else-if="currentOrder.status === 'paid'" class="recharge-paid" role="status">平台已确认入账。请刷新余额和流水核对。</div>
      <div v-else class="recharge-note">此单在平台显示{{ orderLabel(currentOrder.status) }}，微信交易仍需核对。确认入账或微信已关闭之前，不能重复创建充值单。</div>
      <p v-if="statusError" class="recharge-error" role="alert">{{ statusError }}</p>
    </div>

    <div class="recharge-history-head"><div><h3>充值记录</h3><p>仅展示服务器返回的真实订单状态</p></div><button type="button" :disabled="ordersLoading" @click="loadOrders">{{ ordersLoading ? '读取中…' : '刷新记录' }}</button></div>
    <div v-if="ordersError" class="recharge-error" role="alert">{{ ordersError }}</div>
    <div v-else-if="!ordersLoading && !orders.length" class="recharge-empty">暂无充值订单</div>
    <div v-else class="recharge-list"><button v-for="item in orders.slice(0, 10)" :key="item.order_no" type="button" @click="selectOrder(item)"><span><strong>¥{{ item.amount }}</strong><small>{{ formatTime(item.created_at) }} · {{ item.order_no }}</small></span><span :class="`status-${item.status}`">{{ orderLabel(item.status) }}</span></button></div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import QRCode from 'qrcode'
import { auth } from '../../services/api'
import { errorMessage } from '../../services/identityContract'
import { paymentClient, type PaymentChannel, type RechargeOrder } from '../../services/paymentClient'

const emit = defineEmits<{ paid: [] }>()
const accountId = auth.getUser()?.id
const markerKey = `qs.recharge-unconfirmed:${accountId || 'unavailable'}`
interface Marker { startedAt: number; amount: string; orderNo?: string }

const channels = ref<PaymentChannel[]>([])
const channelsLoading = ref(true)
const channelError = ref('')
const wechat = computed(() => channels.value.find(item => item.gateway === 'wechat_pay'))
const wechatAvailable = computed(() => wechat.value?.available === true && wechat.value.mode === 'wechat_native')
const channelReason = computed(() => wechat.value?.reason || '')
const amount = ref('')
const submitting = ref(false)
const error = ref('')
const currentOrder = ref<RechargeOrder | null>(null)
const qrImage = ref('')
const checking = ref(false)
const statusError = ref('')
const orders = ref<RechargeOrder[]>([])
const ordersLoading = ref(true)
const ordersError = ref('')
const pendingMarker = ref<Marker | null>(readMarker())
let pollTimer: ReturnType<typeof setInterval> | undefined
let disposed = false

function readMarker(): Marker | null {
  try {
    const raw = localStorage.getItem(markerKey)
    if (!raw) return null
    const data = JSON.parse(raw) as Marker
    return Number.isFinite(data.startedAt) && typeof data.amount === 'string' ? data : null
  } catch { return null }
}
function saveMarker(marker: Marker) {
  localStorage.setItem(markerKey, JSON.stringify(marker))
  if (localStorage.getItem(markerKey) !== JSON.stringify(marker)) throw new Error('无法保护充值订单状态，请允许本站存储后再试。')
  pendingMarker.value = marker
}
function clearMarker() { try { localStorage.removeItem(markerKey) } catch { /* marker stays visible until next load */ } pendingMarker.value = readMarker() }
function markerMatches(order: RechargeOrder) {
  const marker = pendingMarker.value
  return Boolean(marker && (marker.orderNo === order.order_no || (!marker.orderNo && order.gateway === 'wechat_pay'
    && order.amount === marker.amount && Date.parse(order.created_at) >= marker.startedAt - 5000)))
}
function startNewOrder() { if (!pendingMarker.value) { currentOrder.value = null; qrImage.value = ''; statusError.value = '' } }

function orderLabel(status: string) {
  return ({ pending: '待付款', paid: '已入账', expired: '已过期', cancelled: '已取消', failed: '失败' } as Record<string, string>)[status] || status
}
function formatTime(raw: string) {
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? raw : date.toLocaleString('zh-CN', { hour12: false })
}
function moneyInput() {
  const raw = amount.value.trim()
  if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(raw)) throw new Error('请输入最多两位小数的人民币金额。')
  const cents = Math.round(Number(raw) * 100)
  if (cents < 1 || cents > 100_000_000) throw new Error('充值金额需在 ¥0.01 至 ¥1,000,000.00 之间。')
  return (cents / 100).toFixed(2)
}
async function applyOrder(order: RechargeOrder, fromProviderRefresh = false) {
  // GET /orders returns status only. Keep the QR from this same pending order
  // while polling; never carry it over to another order or a closed trade.
  const existingQr = currentOrder.value?.order_no === order.order_no
    && order.status === 'pending' && order.provider_state !== 'CLOSED' ? qrImage.value : ''
  currentOrder.value = order
  statusError.value = ''
  qrImage.value = existingQr
  if (order.status === 'pending' && order.payment?.mode === 'wechat_native' && order.payment.code_url?.startsWith('weixin://')) {
    qrImage.value = await QRCode.toDataURL(order.payment.code_url, { width: 220, margin: 1 })
  }
  if (order.status === 'paid') {
    if (markerMatches(order)) clearMarker()
    emit('paid')
  } else if (fromProviderRefresh && order.provider_state === 'CLOSED' && markerMatches(order)) {
    // Local expiry is not proof that WeChat has stopped accepting payment.
    // The owner-only refresh endpoint verifies the provider signature first.
    clearMarker()
  }
}
async function loadChannels() {
  channelsLoading.value = true; channelError.value = ''
  try { channels.value = await paymentClient.channels() }
  catch (e) { channels.value = []; channelError.value = errorMessage(e, '支付通道状态暂时不可用。') }
  finally { channelsLoading.value = false }
}
async function loadOrders() {
  ordersLoading.value = true; ordersError.value = ''
  try {
    orders.value = await paymentClient.listOrders()
    const marker = pendingMarker.value
    if (marker && !currentOrder.value) {
      const found = orders.value.find(order => order.order_no === marker.orderNo) || orders.value.find(order =>
        order.gateway === 'wechat_pay' && order.amount === marker.amount && Date.parse(order.created_at) >= marker.startedAt - 5000)
      if (found) await applyOrder(found)
    }
  } catch (e) { ordersError.value = errorMessage(e, '充值记录暂时不可用，请重试。') }
  finally { ordersLoading.value = false }
}
async function createOrder() {
  if (submitting.value || currentOrder.value || pendingMarker.value || !wechatAvailable.value) return
  error.value = ''
  let normalized: string
  try { normalized = moneyInput() }
  catch (e) { error.value = errorMessage(e, '请检查金额。'); return }
  if (!accountId || !navigator.locks?.request) { error.value = '当前浏览器无法保护充值订单，请重新登录并使用新版浏览器。'; return }
  submitting.value = true
  try {
    await navigator.locks.request(`qs-recharge-${accountId}`, { mode: 'exclusive' }, async () => {
      if (readMarker()) { pendingMarker.value = readMarker(); throw new Error('已有待核对的充值申请，请先查询原订单。') }
      const marker = { startedAt: Date.now(), amount: normalized }
      saveMarker(marker)
      try {
        const order = await paymentClient.createWechatOrder(normalized)
        saveMarker({ ...marker, orderNo: order.order_no })
        await applyOrder(order)
        await loadOrders()
      } catch (e) {
        const detail = (e as { response?: { data?: { detail?: { order_no?: string } }; status?: number } }).response?.data?.detail
        if (typeof detail?.order_no === 'string') saveMarker({ ...marker, orderNo: detail.order_no })
        const status = Number((e as { response?: { status?: number } }).response?.status)
        if ([400, 401, 403, 404, 409, 422, 503].includes(status)) clearMarker()
        throw e
      }
    })
  } catch (e) {
    error.value = pendingMarker.value
      ? '充值申请结果尚未确认，请核对原订单，避免重复创建。'
      : errorMessage(e, '无法创建充值单，请稍后重试。')
    if (pendingMarker.value) await loadOrders()
  } finally { submitting.value = false }
}
async function checkStatus(manual = false) {
  if (!currentOrder.value || checking.value) return
  checking.value = true; if (manual) statusError.value = ''
  try {
    const fromProviderRefresh = manual && currentOrder.value.status !== 'paid'
    const order = fromProviderRefresh
      ? await paymentClient.refreshWechatOrder(currentOrder.value.order_no)
      : await paymentClient.getOrder(currentOrder.value.order_no)
    if (disposed) return
    await applyOrder(order, fromProviderRefresh)
    if (order.status === 'paid') await loadOrders()
  } catch (e) { if (manual && !disposed) statusError.value = errorMessage(e, '暂时无法确认支付结果，请稍后查询原订单。') }
  finally { checking.value = false }
}
async function retryOriginal() {
  if (!currentOrder.value || currentOrder.value.status !== 'pending' || checking.value) return
  checking.value = true; statusError.value = ''
  try { await applyOrder(await paymentClient.retryPayment(currentOrder.value.order_no)) }
  catch (e) { statusError.value = errorMessage(e, '无法重新取得此单二维码，请稍后核对原订单。') }
  finally { checking.value = false }
}
async function selectOrder(order: RechargeOrder) {
  if (order.gateway !== 'wechat_pay') return
  await applyOrder(order)
}

onMounted(() => {
  void Promise.all([loadChannels(), loadOrders()])
  pollTimer = setInterval(() => {
    if (currentOrder.value?.status === 'pending' && currentOrder.value.provider_state !== 'CLOSED') void checkStatus()
  }, 5000)
})
onBeforeUnmount(() => { disposed = true; if (pollTimer) clearInterval(pollTimer) })
</script>

<style scoped>
.recharge-panel{margin-top:18px;padding:24px;border:1px solid #dbe5eb;border-radius:15px;background:#fff;box-shadow:0 2px 14px rgba(15,23,42,.05)}.recharge-head,.recharge-history-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}.recharge-eyebrow{color:#0b766f;font-size:11px;font-weight:700;letter-spacing:.08em}.recharge-head h3,.recharge-history-head h3{margin:4px 0 6px;color:#13242c;font-size:20px}.recharge-head p,.recharge-history-head p{margin:0;color:#63747e;font-size:12px;line-height:1.6}.recharge-channel{white-space:nowrap;padding:7px 10px;border-radius:999px;background:#f4f5f6;color:#697781;font-size:11px}.recharge-channel.ready{background:#e8f8f2;color:#087b55}.recharge-entry{margin-top:24px}.recharge-entry label{display:flex;justify-content:space-between;color:#273a43;font-size:13px;font-weight:600}.recharge-entry label span{color:#75848a;font-size:11px;font-weight:400}.recharge-input{display:flex;align-items:center;gap:10px;margin:10px 0 7px;padding:6px 7px 6px 14px;border:1px solid #cddcdf;border-radius:10px}.recharge-input>span{font-size:20px;color:#0b766f}.recharge-input input{flex:1;min-width:0;border:0;outline:0;color:#13242c;font-size:21px}.recharge-input button,.recharge-order-meta button,.recharge-history-head button,.recharge-pay-info button{padding:10px 14px;border:1px solid #abd1cb;border-radius:8px;background:#fff;color:#0b716a;font-size:12px;cursor:pointer}.recharge-input button{background:#087c73;color:#fff;border-color:#087c73}.recharge-input button:disabled,.recharge-order-meta button:disabled{opacity:.5;cursor:default}.recharge-entry small{color:#829096;font-size:11px}.recharge-error,.recharge-warning,.recharge-note,.recharge-paid{margin-top:15px;padding:12px;border-radius:9px;font-size:12px;line-height:1.6}.recharge-error{background:#fff1ef;color:#9d332e}.recharge-warning{background:#fff9eb;color:#765518}.recharge-note{background:#f3f6f7;color:#5e6c72}.recharge-paid{background:#eaf8f0;color:#087b55}.recharge-error button,.recharge-warning button{margin-left:9px;border:0;background:none;color:inherit;text-decoration:underline;cursor:pointer}.recharge-order{margin-top:19px;border:1px solid #b6d5d2;border-radius:12px;overflow:hidden}.recharge-order-meta{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:13px 15px;background:#f3faf8}.recharge-order-meta div{display:grid;gap:4px}.recharge-order-meta strong{font-size:12px;color:#1e3539}.recharge-order-meta span{font-size:12px;color:#64767a}.recharge-pay-content{display:flex;align-items:center;gap:18px;padding:18px}.recharge-pay-content img{flex:0 0 auto;border:1px solid #e4eeee;border-radius:8px}.recharge-pay-info strong{color:#143136;font-size:16px}.recharge-pay-info p{color:#64767a;font-size:12px;line-height:1.6}.recharge-history-head{align-items:center;margin:25px 0 12px}.recharge-history-head h3{font-size:16px}.recharge-list{display:grid;gap:6px}.recharge-list button{display:flex;justify-content:space-between;align-items:center;gap:12px;width:100%;padding:10px;border:1px solid #e5eced;border-radius:9px;background:#fff;text-align:left;cursor:pointer}.recharge-list button>span:first-child{display:grid;gap:3px}.recharge-list strong{color:#25383f;font-size:13px}.recharge-list small{color:#8a999d;font-size:10px;overflow-wrap:anywhere}.recharge-list button>span:last-child{white-space:nowrap;color:#64767a;font-size:11px}.recharge-list .status-paid{color:#0b8b5f!important}.recharge-empty{padding:22px;text-align:center;color:#8a999d;font-size:12px}@media(max-width:650px){.recharge-head{display:grid}.recharge-input{flex-wrap:wrap}.recharge-input input{width:calc(100% - 40px)}.recharge-input button{width:100%}.recharge-pay-content{display:grid;justify-items:center;text-align:center}.recharge-order-meta{align-items:flex-start;flex-direction:column}}
</style>
