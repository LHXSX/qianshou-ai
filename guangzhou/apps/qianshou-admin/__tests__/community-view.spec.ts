import { createApp, type App } from 'vue'
import ElementPlus from 'element-plus'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CommunityView from '../src/views/CommunityView.vue'
import { clearSession, loadSession } from '../src/session/store'
import { router, routeNameForMenuKey } from '../src/router'

let app: App | undefined
let permissions: string[]
beforeEach(() => {
  clearSession()
  permissions = ['community.read', 'community.manage']
  document.body.innerHTML = '<div id="app"></div>'
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async (input) => {
    const path = String(input)
    const payload = path.endsWith('/session/me') ? {
      ok: true, admin: { accountId: '6', displayName: 'admin', roleId: 'super-admin', roleName: '超级管理员',
        roleKind: 'builtin', scope: 'all', surface: 'ai-admin' }, permissions,
      menu: [{ key: 'community', title: '讨论区', group: '运营', perm: 'community.read' }], readiness: [], clientIp: '127.0.0.1',
    } : path.endsWith('/community/list') ? { ok: true, topics: [{ id: 'topic-1', category: 'help', title: '技能安装后如何使用',
      content: '在对话中找不到技能', authorId: '101', authorName: 'Alice', status: 'open', related: null,
      replyCount: 2, createdAt: '2026-09-26T01:00:00.000Z', updatedAt: '2026-09-26T02:00:00.000Z',
      pinned: false, official: false, visibility: 'visible' }], reports: [] } : { ok: true }
    return new Response(JSON.stringify(payload), { status: 200 })
  }))
})
afterEach(() => { app?.unmount(); app = undefined; clearSession(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Guangzhou community review view', () => {
  it('maps the server community menu to the actual discussion view', async () => {
    await loadSession()
    expect(routeNameForMenuKey('community')).toBe('community')
    await router.push('/community')
    expect(router.currentRoute.value.name).toBe('community')
    expect(router.currentRoute.value.matched.at(-1)?.components?.default).toBe(CommunityView)
  })
  it('shows real topic fields and authorizes moderator actions from the session permission', async () => {
    await loadSession()
    app = createApp(CommunityView)
    app.use(ElementPlus)
    app.mount('#app')
    await vi.waitFor(() => expect(document.body.textContent).toContain('技能安装后如何使用'))
    expect(document.body.textContent).toContain('问题求助')
    expect(document.body.textContent).toContain('Alice')
    expect(document.body.textContent).toContain('发布活动')
    expect(document.body.textContent).toContain('隐藏')
  })
  it('keeps moderation controls absent for read-only operators', async () => {
    permissions = ['community.read']
    await loadSession()
    app = createApp(CommunityView)
    app.use(ElementPlus)
    app.mount('#app')
    await vi.waitFor(() => expect(document.body.textContent).toContain('技能安装后如何使用'))
    const buttons = [...document.querySelectorAll('button')].map(button => button.textContent?.trim())
    expect(buttons).not.toContain('发布活动')
    expect(buttons).not.toContain('隐藏')
  })
})
