import { createApp, type App } from 'vue'
import ElementPlus from 'element-plus'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MarketReviewView from '../src/views/MarketReviewView.vue'
import { clearSession, loadSession } from '../src/session/store'

let app: App | undefined
let queueStatus: 'forbidden' | 'empty'

function tab(label: string): HTMLButtonElement {
  const node = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find(item => item.textContent?.trim() === label)
  if (!node) throw new Error(`Missing tab: ${label}`)
  return node
}

beforeEach(() => {
  clearSession()
  queueStatus = 'forbidden'
  document.body.innerHTML = '<div id="app"></div>'
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    if (path.endsWith('/session/me')) {
      return new Response(JSON.stringify({
        ok: true,
        admin: { accountId: '167', displayName: 'admin', roleId: 'super-admin',
          roleName: 'admin', roleKind: 'builtin', scope: 'all', surface: 'ai-admin' },
        permissions: ['market.read', 'market.review'], menu: [], readiness: [], clientIp: '127.0.0.1',
      }), { status: 200 })
    }
    if (path.endsWith('/market/order-publications')
      || path.endsWith('/market/order-adapter-products')
      || path.endsWith('/market/reviews')) {
      return queueStatus === 'forbidden'
        ? new Response(JSON.stringify({ ok: false, code: 'forbidden', message: '上海队列无权限' }), { status: 403 })
        : new Response(JSON.stringify({ ok: true, items: [] }), { status: 200 })
    }
    throw new Error(`Unexpected request: ${path}`)
  }))
})

afterEach(() => {
  app?.unmount()
  app = undefined
  clearSession()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function mountPage(): Promise<void> {
  await loadSession()
  app = createApp(MarketReviewView)
  app.use(ElementPlus)
  app.mount('#app')
}

describe('market review counts when queues fail', () => {
  it('shows unknown count and the actual 403 in all three queues', async () => {
    await mountPage()
    await vi.waitFor(() => expect(document.body.textContent).toContain('接单技能待审：读取失败，数量未知'))
    expect(document.body.textContent).toContain('上海队列无权限')
    expect(document.body.textContent).not.toContain('接单技能待审：0')

    tab('历史商品管理').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('接单技能商品待审：读取失败，数量未知'))
    expect(document.body.textContent).toContain('上海队列无权限')
    expect(document.body.textContent).not.toContain('接单技能商品待审：0')

    tab('插件商品审核').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('待审核投稿：读取失败，数量未知'))
    expect(document.body.textContent).toContain('上海队列无权限')
    expect(document.body.textContent).not.toContain('目前没有待审核投稿')
  })

  it('reserves zero for an actual successful empty response', async () => {
    queueStatus = 'empty'
    await mountPage()
    await vi.waitFor(() => expect(document.body.textContent).toContain('接单技能待审：0'))
    tab('历史商品管理').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('接单技能商品待审：0'))
    tab('插件商品审核').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('待审核投稿：0'))
    expect(document.body.textContent).not.toContain('读取失败，数量未知')
  })
})
