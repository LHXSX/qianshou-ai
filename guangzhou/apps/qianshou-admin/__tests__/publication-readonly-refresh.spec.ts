/** Fictional read responses exercise polling and never call a review mutation. */
import { createApp, nextTick, type App } from 'vue'
import ElementPlus from 'element-plus'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import OrderPublicationReviewPanel from '../src/components/OrderPublicationReviewPanel.vue'
import { clearSession, loadSession } from '../src/session/store'

let app: App | undefined
let account = '167'
let row: Record<string, unknown>
let reads = 0
let delayed: Promise<Response> | undefined
let fail = false
const mutations: string[] = []
const queue = () => ({ ok: true, items: [row], reviewAuthorized: true, readDelegated: false })
function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label)
  if (found === undefined) throw new Error(`Missing button ${label}`)
  return found
}
async function mount(): Promise<void> {
  await loadSession()
  app = createApp(OrderPublicationReviewPanel)
  app.use(ElementPlus)
  app.mount('#app')
}

beforeEach(() => {
  clearSession(); reads = 0; account = '167'; delayed = undefined; fail = false; mutations.length = 0
  row = { id: 'fictional-publication', owner_id: 167, name: '虚构反转技能', task_type: 'text_reverse_test_v1',
    status: 'review', can_approve: false, review_reasons: ['sample: 可信回执缺失或过大', 'review: 可信回执缺失或过大'],
    required_evidence: ['package', 'sample', 'pricing', 'review'],
    evidence_status: { package: 'valid', sample: 'missing', pricing: 'valid', review: 'invalid' } }
  document.body.innerHTML = '<div id="app"></div>'
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (target) => {
    const path = target instanceof Request ? target.url : String(target)
    if (path.endsWith('/session/me')) return Response.json({ ok: true,
      admin: { accountId: account, displayName: 'fixture', roleId: 'super-admin', roleName: 'admin',
        roleKind: 'builtin', scope: 'all', surface: 'ai-admin' },
      permissions: ['market.read', 'market.review'], menu: [], readiness: [], clientIp: '127.0.0.1' })
    if (path.endsWith('/market/order-publications')) {
      reads += 1
      if (delayed !== undefined) { const pending = delayed; delayed = undefined; return pending }
      if (fail) return Response.json({ ok: false, code: 'unavailable', message: '虚构读取失败' }, { status: 503 })
      return Response.json(queue())
    }
    mutations.push(path)
    throw new Error('Unexpected non-read request')
  }))
})
afterEach(() => {
  app?.unmount(); app = undefined; clearSession()
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})

it('updates the open exact-publication drawer and preserves notes while distinguishing missing and invalid receipts', async () => {
  vi.useFakeTimers()
  await mount()
  await vi.waitFor(() => expect(document.body.textContent).toContain('虚构反转技能'))
  button('查看审核').click(); await nextTick()
  expect(document.body.textContent).toContain('广州隔离执行服务：隔离执行样本核验等待自动验证回执，尚未完成')
  expect(document.body.textContent).toContain('回执无效或超过大小限制，需重新核验')
  expect(button('审核通过').disabled).toBe(true)
  const note = document.querySelector<HTMLTextAreaElement>('#order-review-note')
  if (note === null) throw new Error('Missing review note')
  note.value = '保留审核员未提交的说明'; note.dispatchEvent(new Event('input', { bubbles: true })); await nextTick()
  row = { ...row, can_approve: true, review_reasons: [],
    evidence_status: { package: 'valid', sample: 'valid', pricing: 'valid', review: 'valid' } }
  await vi.advanceTimersByTimeAsync(15_000); await nextTick()
  expect(reads).toBe(2)
  expect(document.body.textContent).toContain('已具备审核条件')
  expect(note.value).toBe('保留审核员未提交的说明')
  expect(button('审核通过').disabled).toBe(false)
  expect(mutations).toEqual([])
})

it('discards a late prior-account response and serially reads the current account', async () => {
  let finish!: (response: Response) => void
  delayed = new Promise(resolve => { finish = resolve })
  await mount()
  await vi.waitFor(() => expect(reads).toBe(1))
  account = '168'; await loadSession(); await nextTick()
  const old = queue()
  row = { ...row, id: 'current-account-publication', owner_id: 168, name: '新账号虚构技能' }
  finish(Response.json(old))
  await vi.waitFor(() => expect(document.body.textContent).toContain('新账号虚构技能'))
  expect(reads).toBe(2)
  expect(document.body.textContent).not.toContain('虚构反转技能')
  expect(mutations).toEqual([])
})

it('never overlaps evidence reads and pauses hidden pages', async () => {
  vi.useFakeTimers()
  await mount()
  await vi.waitFor(() => expect(document.body.textContent).toContain('虚构反转技能'))
  let finish!: (response: Response) => void
  delayed = new Promise(resolve => { finish = resolve })
  await vi.advanceTimersByTimeAsync(15_000)
  expect(reads).toBe(2)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(reads).toBe(2)
  finish(Response.json(queue())); await vi.advanceTimersByTimeAsync(0)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(60_000)
  expect(reads).toBe(2)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(15_000)
  expect(reads).toBe(3)
  expect(mutations).toEqual([])
})

it('recovers a failed evidence read without approving and stops when no pending queue remains', async () => {
  vi.useFakeTimers()
  await mount()
  await vi.waitFor(() => expect(document.body.textContent).toContain('虚构反转技能'))
  fail = true
  await vi.advanceTimersByTimeAsync(15_000)
  expect(document.body.textContent).toContain('读取失败，数量未知')
  fail = false
  row = { ...row, status: 'approved' }
  await vi.advanceTimersByTimeAsync(15_000)
  expect(reads).toBe(3)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(reads).toBe(3)
  expect(mutations).toEqual([])
})

it('stops pending refresh when the panel is unmounted', async () => {
  vi.useFakeTimers()
  await mount()
  await vi.waitFor(() => expect(document.body.textContent).toContain('虚构反转技能'))
  app?.unmount(); app = undefined
  await vi.advanceTimersByTimeAsync(60_000)
  expect(reads).toBe(1)
  expect(mutations).toEqual([])
})
