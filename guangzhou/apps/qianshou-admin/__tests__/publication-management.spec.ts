import { createApp, nextTick, type App } from 'vue'
import ElementPlus from 'element-plus'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const confirm = vi.hoisted(() => vi.fn<(message: string, title: string, options: object) => Promise<void>>(async () => {}))
vi.mock('element-plus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('element-plus')>()
  return { ...actual, ElMessageBox: { ...actual.ElMessageBox, confirm } }
})
import Panel from '../src/components/OrderPublicationManagementPanel.vue'
import { clearSession, loadSession } from '../src/session/store'
let app: App | undefined
let account = '6', delegated = false
let row: Record<string, unknown>
const writes: Record<string, unknown>[] = []
const queue = () => ({ ok: true, items: [row], reviewAuthorized: !delegated, readDelegated: delegated })
const button = (label: string) => {
  const result = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label)
  if (!result) throw new Error(`missing ${label}`)
  return result
}
async function mount() { await loadSession(); app = createApp(Panel); app.use(ElementPlus); app.mount('#app'); await vi.waitFor(() => expect(document.body.textContent).toContain('虚构旧测试')) }
beforeEach(() => {
  confirm.mockReset(); confirm.mockResolvedValue(undefined)
  clearSession(); account = '6'; delegated = false; writes.length = 0
  row = { publication_id: '5533b344-256b-44ce-8677-a3082f44d93e', owner_id: 167, name: '虚构旧测试', task_type: 'fictional', status: 'rejected',
    lifecycle: { state: 'active', archived: false, revision: 0, allowed_actions: ['archive'], blocking_reasons: [] } }
  document.body.innerHTML = '<div id="app"></div>'
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (target, init) => {
    const path = target instanceof Request ? target.url : target instanceof URL ? target.href : target
    if (path.endsWith('/session/me')) return Response.json({ ok: true, admin: { accountId: account, roleId: 'super-admin', roleKind: 'builtin', scope: 'all' }, permissions: ['market.read', 'market.review'], menu: [], readiness: [] })
    if (path.endsWith('/market/order-publications/managed')) return Response.json(queue())
    if (path.endsWith('/market/order-publication/lifecycle')) {
      const body = JSON.parse(init?.body as string); writes.push(body)
      row = { ...row, lifecycle: { state: 'delisted', archived: true, revision: 1, allowed_actions: ['restore'], blocking_reasons: [] } }
      return Response.json({ ok: true, item: row, auditId: 1 })
    }
    throw new Error('unexpected request')
  }))
})
afterEach(() => { app?.unmount(); app = undefined; clearSession(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
it('shows named server actions and sends a captured revision without owner', async () => {
  await mount(); confirm.mockResolvedValue(undefined)
  button('归档记录').click(); await vi.waitFor(() => expect(writes).toHaveLength(1))
  expect(confirm.mock.calls[0]?.[0]).toContain('虚构旧测试')
  expect(writes[0]).toEqual({ publicationId: row.publication_id, action: 'archive', expectedRevision: 0, note: '管理员确认归档记录：虚构旧测试' })
  await nextTick(); expect(document.body.textContent).not.toContain('虚构旧测试')
})
it('never grants delegated read-only visibility a mutation', async () => {
  delegated = true; await mount(); expect(button('归档记录').disabled).toBe(true); expect(writes).toEqual([])
})
it('does not show an invented action when a pending install blocks hiding', async () => {
  row = { ...row, lifecycle: { state: 'active', archived: false, revision: 0, allowed_actions: [], blocking_reasons: ['pending-install'] } }
  await mount(); expect(document.body.textContent).toContain('存在待安装购买权益')
  expect(() => button('归档记录')).toThrow(); expect(writes).toEqual([])
})
it('discards a confirmation after switching the administrator account', async () => {
  await mount(); let done: (() => void) | undefined
  confirm.mockImplementation(() => new Promise(resolve => { done = () => resolve() }))
  button('归档记录').click(); await nextTick(); account = '7'; await loadSession(); await nextTick(); done?.()
  await nextTick(); expect(writes).toEqual([])
})
