import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const script = readFileSync(new URL('../src/components/account/RechargePanel.vue', import.meta.url), 'utf8')
  .split('<script setup lang="ts">')[1].split('</script>')[0]
  .replace(/^import .*$/gm, '')
const markerKey = 'qs.recharge-unconfirmed:17'
const order = { order_no: 'PAY_1700000000_12345678', account_id: 17, gateway: 'wechat_pay',
  amount: '10.00', currency: 'CNY', status: 'expired', created_at: '2026-09-23T00:00:00Z',
  expired_at: '2026-09-23T00:15:00Z', paid_at: null }

function harness() {
  const saved = new Map([[markerKey, JSON.stringify({ startedAt: 1, amount: '10.00', orderNo: order.order_no })]])
  let refreshResult = null
  let refreshError = null
  let created = 0
  let paidEvents = 0
  const context = {
    auth: { getUser: () => ({ id: 17 }) },
    localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
    paymentClient: {
      refreshWechatOrder: async () => { if (refreshError) throw refreshError; return refreshResult },
      getOrder: async () => order,
      createWechatOrder: async () => { created++; return { ...order, status: 'pending' } },
    },
    errorMessage: error => error.message,
    ref: value => ({ value }),
    computed: calculate => ({ get value() { return calculate() } }),
    onMounted() {}, onBeforeUnmount() {},
    defineEmits: () => name => { if (name === 'paid') paidEvents++ },
    QRCode: { toDataURL: async () => 'data:image/png;base64,test' },
  }
  vm.createContext(context)
  const code = ts.transpile(script + '\nglobalThis.exposed = { applyOrder, checkStatus, startNewOrder, currentOrder, pendingMarker, statusError, qrImage }', {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None,
  })
  vm.runInContext(code, context)
  return { state: context.exposed, saved,
    setRefresh: value => { refreshResult = value; refreshError = null },
    failRefresh: error => { refreshError = error },
    get created() { return created }, get paidEvents() { return paidEvents } }
}

test('polling the same pending order keeps its QR and another order cannot inherit it', async () => {
  const h = harness()
  const pending = { ...order, status: 'pending', payment: { mode: 'wechat_native', code_url: 'weixin://wxpay/example' } }
  await h.state.applyOrder(pending)
  assert.equal(h.state.qrImage.value, 'data:image/png;base64,test')
  await h.state.applyOrder({ ...pending, payment: undefined })
  assert.equal(h.state.qrImage.value, 'data:image/png;base64,test')
  await h.state.applyOrder({ ...pending, order_no: 'PAY_1700000000_OTHER', payment: undefined })
  assert.equal(h.state.qrImage.value, '')
})

test('local expired, list result and unverified CLOSED never release an unconfirmed recharge', async () => {
  const h = harness()
  await h.state.applyOrder(order)
  assert.equal(h.saved.has(markerKey), true)
  await h.state.applyOrder({ ...order, provider_state: 'CLOSED' })
  assert.equal(h.saved.has(markerKey), true)
  h.state.startNewOrder()
  assert.equal(h.state.currentOrder.value.order_no, order.order_no)
  assert.equal(h.created, 0)
})

test('signed NOTPAY or failed provider query keeps the original order locked', async () => {
  const h = harness()
  await h.state.applyOrder(order)
  h.setRefresh({ ...order, provider_state: 'NOTPAY' })
  await h.state.checkStatus(true)
  assert.equal(h.saved.has(markerKey), true)
  h.failRefresh(new Error('provider unavailable'))
  await h.state.checkStatus(true)
  assert.equal(h.saved.has(markerKey), true)
  assert.equal(h.state.statusError.value, 'provider unavailable')
})

test('only a signed CLOSED query or an atomically paid order releases the marker', async () => {
  const closed = harness()
  await closed.state.applyOrder(order)
  closed.setRefresh({ ...order, provider_state: 'CLOSED' })
  await closed.state.checkStatus(true)
  assert.equal(closed.saved.has(markerKey), false)
  closed.state.startNewOrder()
  assert.equal(closed.state.currentOrder.value, null)

  const paid = harness()
  await paid.state.applyOrder({ ...order, status: 'paid' })
  assert.equal(paid.saved.has(markerKey), false)
  assert.equal(paid.paidEvents, 1)
})
