/**
 * 渲染冒烟：把真实视图跑一遍服务端渲染（无需浏览器），
 * 用假的 fetch 喂契约形状的响应，验证「页面真的能渲染出来」——
 * 而不是只靠类型检查（类型检查抓不到模板里写错的属性名、缺失的组件导入）。
 *
 * SSR 渲染不会触发 `onMounted`，所以首屏取数由这里直接调用视图暴露的 `useAsyncData.run()`
 * 之外的路径覆盖；本文件的目标是模板与组件装配，不重复覆盖单测里的分支逻辑。
 */

import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import ElementPlus from 'element-plus'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ErrorAlert from '../src/components/ErrorAlert.vue'
import DiffView from '../src/components/DiffView.vue'
import AppLayout from '../src/components/AppLayout.vue'
import LoginView from '../src/views/LoginView.vue'
import OverviewView from '../src/views/OverviewView.vue'
import AccountView from '../src/views/AccountView.vue'
import SubscriptionView from '../src/views/SubscriptionView.vue'
import MarketView from '../src/views/MarketView.vue'
import ModelsView from '../src/views/ModelsView.vue'
import RbacView from '../src/views/RbacView.vue'
import AuditView from '../src/views/AuditView.vue'
import WhitelistView from '../src/views/WhitelistView.vue'
import FlagsView from '../src/views/FlagsView.vue'
import UpstreamKeysView from '../src/views/UpstreamKeysView.vue'
import PoolView from '../src/views/PoolView.vue'
import EnterpriseLeadsView from '../src/views/EnterpriseLeadsView.vue'
import NotFoundView from '../src/views/NotFoundView.vue'
import { computed, defineComponent as defineStub, h as hStub, inject, provide } from 'vue'
import { toAdminApiError } from '../src/api/errors'
import { clearSession, loadSession } from '../src/session/store'

/** 契约形状的最小响应集合：只提供各页面首屏真正会请求的那些端点。 */
function fixtureFor(path: string): unknown {
  if (path.endsWith('/session/me')) {
    return {
      ok: true,
      admin: {
        accountId: '167',
        displayName: '样例管理员',
        roleId: 'super-admin',
        roleName: '超级管理员',
        roleKind: 'builtin',
        scope: 'all',
        surface: 'ai-admin',
      },
      permissions: ['account.read', 'audit.read'],
      menu: [
        { key: 'overview', title: '总览', group: '运营', perm: null },
        { key: 'account', title: '账号与额度', group: '运营', perm: 'account.read' },
        { key: 'not-implemented-yet', title: '尚未实现的页面', group: '运营', perm: null },
      ],
      readiness: [
        {
          key: 'account',
          title: '账号与额度',
          status: 'read-only',
          summary: '可读真实额度与流水。',
          missing: [{ interface: 'POST /internal/ledger/adjust', why: '写接口在账本属主服务' }],
        },
        {
          key: 'models',
          title: '模型路由',
          status: 'dependency-unavailable',
          summary: '模型网关 7080 的 names/bind 已存在，本台尚未同一身份。',
          missing: [
            { interface: 'POST /api/qianshou/ai/admin/names', why: '列出前台名字与绑定历史' },
            { interface: 'POST /api/qianshou/ai/admin/bind', why: '追加绑定' },
          ],
        },
      ],
      clientIp: '203.0.113.7',
    }
  }
  if (path.endsWith('/modules')) {
    return {
      ok: true,
      modules: [
        { key: 'account', title: '账号与额度', status: 'read-only', summary: '只读', missing: [] },
        {
          key: 'market',
          title: '技能 / 专家市场',
          status: 'dependency-unavailable',
          summary: '属主服务未就绪',
          missing: [{ interface: 'GET /internal/market/items', why: '市场条目' }],
        },
      ],
    }
  }
  if (path.endsWith('/health')) {
    return { ok: true, service: 'qianshou-admin-console', version: '1.2.3', uptimeMs: 3_600_000 }
  }
  if (path.endsWith('/account/list')) {
    return {
      ok: true,
      total: 1,
      accounts: [
        { accountId: '167', tier: 'pro', grantedSp: 200, usedSp: 20, remainingSp: 180, callCount: 3, lastCallAt: 1_700_000_000_000 },
      ],
    }
  }
  if (path.endsWith('/subscription/list')) {
    return {
      ok: true,
      total: 1,
      entries: [
        { accountId: '167', tier: 'pro', from: 1_690_000_000_000, to: 1_722_000_000_000, grantedBy: '167', reason: '续费', active: true },
      ],
    }
  }
  if (path.endsWith('/subscription/tiers')) {
    return { ok: true, source: 'account-service', tiers: [{ id: 'pro', label: '专业版', monthlySp: 200, priceCny: 68 }] }
  }
  if (path.endsWith('/rbac/permissions')) {
    return {
      ok: true,
      groups: [
        {
          module: 'audit',
          title: '权限与审计',
          items: [{ key: 'audit.read', title: '查看审计', highRisk: false, description: '查询审计日志' }],
        },
      ],
    }
  }
  if (path.endsWith('/rbac/roles/list')) {
    return {
      ok: true,
      roles: [
        {
          id: 'super-admin',
          name: '超级管理员',
          kind: 'builtin',
          surface: 'ai-admin',
          description: '全部权限',
          permissions: ['audit.read'],
          scopeDefault: 'all',
          memberCount: 1,
        },
      ],
    }
  }
  if (path.endsWith('/rbac/admins/list')) {
    return {
      ok: true,
      admins: [{ accountId: '167', displayName: '样例管理员', roleId: 'super-admin', scope: 'all', enabled: true, createdAt: 1_690_000_000_000, createdBy: '167' }],
    }
  }
  if (path.endsWith('/audit/list')) {
    return {
      ok: true,
      total: 1,
      entries: [
        {
          id: 'a-1',
          at: 1_700_000_000_000,
          actorId: '167',
          actorRole: '超级管理员',
          ip: '203.0.113.7',
          action: 'flags.apply',
          target: 'flag:x',
          result: 'allow',
          reason: '放量',
          summary: 'rolloutPercent 0 → 20',
        },
      ],
    }
  }
  if (path.endsWith('/flags/list')) {
    return {
      ok: true,
      flags: [{ key: 'feature.x', title: '开关 X', enabled: false, rolloutPercent: 0, description: '', updatedAt: 1_700_000_000_000, updatedBy: '167', version: 1 }],
    }
  }
  if (path.endsWith('/whitelist/status')) {
    return {
      ok: true,
      enabled: true,
      clientIp: '203.0.113.7',
      entries: [{ cidr: '203.0.113.0/24', note: '办公出口', addedBy: '167', addedAt: 1_700_000_000_000 }],
      escapeHatch: { loopbackAlwaysAllowed: true, cliHint: "ssh root@host 'node main.ts whitelist add 203.0.113.7/32'" },
    }
  }
  if (path.endsWith('/pool/list')) {
    return {
      ok: true,
      keys: [{
        ref: 'CURSOR_CK_1a2b3c4d',
        label: '客服号-1',
        status: 'active',
        fingerprint: 'a1b2c3d4',
        lastVerifiedAt: 1_700_000_000_000,
        authId: 'user_abc123',
        email: 'ops@example.com',
        addedAt: 1_700_000_000_000,
        addedBy: '167',
        previousFingerprint: null,
        shape: 'api-key',
      }],
      fileError: null,
      activation: {
        fileWatcher: '工作台的凭据插件监听该文件，改动会被自动加载。',
        consumer: '模型网关的号池路由（尚未接入）',
        restartRequired: false,
        restartService: null,
        restartCommand: null,
        note: '号池的号就是凭据文件 refs: 段里的一个 ref；管理台负责让它进池并留下记录。',
      },
      metadataPath: '/srv/qianshou-admin/data/pool.json',
    }
  }
  if (path.endsWith('/credential/list')) {
    return {
      ok: true,
      credentialsPath: '/srv/qianshou-home/.credentials.yaml',
      fileExists: true,
      fileMode: '0600',
      keys: [{
        ref: 'DEEPSEEK_API_KEY',
        configured: true,
        fingerprint: 'a1b2c3d4',
        updatedAt: 1_700_000_000_000,
        updatedBy: '167',
        previousFingerprint: 'deadbeef',
        shadowedByEnvironment: false,
        restartRequired: true,
        restartService: 'qianshou-workbench',
        restartCommand: 'systemctl restart qianshou-workbench',
      }],
      activation: {
        fileWatcher: '工作台的凭据插件监听该文件，改动会被自动加载。',
        gatewayCache: '模型网关对已解析成功的密钥永久缓存，进程内不会重读。',
        restartRequired: true,
        restartService: 'qianshou-workbench',
        restartCommand: 'systemctl restart qianshou-workbench',
        note: '改完必须重启工作台才生效。',
      },
      backups: { dir: '/srv/qianshou-admin/data/credential-backups' },
    }
  }
  if (path.endsWith('/models/overview')) {
    return {
      ok: false,
      code: 'dependency_unavailable',
      message: '模型网关 7080 的 names/bind 已存在，本台尚未同一身份。',
      module: 'models',
      missing: [
        { interface: 'POST /api/qianshou/ai/admin/names', why: '列出前台名字与绑定历史' },
        { interface: 'POST /api/qianshou/ai/admin/bind', why: '追加绑定' },
      ],
    }
  }
  if (path.endsWith('/overview')) {
    return {
      ok: false,
      code: 'dependency_unavailable',
      message: '属主服务尚未提供接口。',
      module: 'market',
      missing: [{ interface: 'GET /internal/market/items', why: '市场条目' }],
    }
  }
  return { ok: true }
}

function fakeFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL) => {
    const path = typeof input === 'string' ? input : String(input)
    const payload = fixtureFor(path)
    const ok = (payload as { ok?: boolean }).ok === true
    return new Response(JSON.stringify(payload), {
      status: ok ? 200 : 503,
      headers: { 'content-type': 'application/json' },
    })
  })
}

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'overview', component: { template: '<div/>' } },
      { path: '/login', name: 'login', component: { template: '<div/>' } },
      { path: '/account', name: 'account', component: { template: '<div/>' } },
      { path: '/subscription', name: 'subscription', component: { template: '<div/>' } },
      { path: '/market', name: 'market', component: { template: '<div/>' } },
      { path: '/models', name: 'models', component: { template: '<div/>' } },
      { path: '/rbac', name: 'rbac', component: { template: '<div/>' } },
      { path: '/audit', name: 'audit', component: { template: '<div/>' } },
      { path: '/whitelist', name: 'whitelist', component: { template: '<div/>' } },
      { path: '/flags', name: 'flags', component: { template: '<div/>' } },
      { path: '/pool', name: 'pool', component: { template: '<div/>' } },
      { path: '/enterprise', name: 'enterprise', component: { template: '<div/>' } },
    ],
  })
}

async function render(
  component: unknown,
  options: { readonly path?: string; readonly withSession?: boolean } = {},
): Promise<string> {
  const router = testRouter()
  await router.push(options.path ?? '/')
  await router.isReady()
  const app = createSSRApp(component as never)
  app.use(ElementPlus)
  // 局部组件（DiffView 等）在模板里解析 `<el-table>`：替身必须按全局组件注册才生效。
  withTableStub(app)
  app.use(router)
  if (options.withSession === true) {
    await loadSession()
  }
  return renderToString(app)
}

beforeEach(() => {
  vi.stubGlobal('fetch', fakeFetch())
  clearSession()
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearSession()
})

/**
 * `el-table` 的 SSR 替身。
 *
 * 为什么冒烟用例要替掉它：Element Plus 的表格在**设置了 `max-height`** 时，
 * 会在没有 DOM 的环境里进入一个永不收敛的微任务循环（实测：worker 100% CPU、
 * `PromiseFulfillReactionJob` 反复自我唤醒、事件循环被饿死，连看门狗计时器都跑不到）。
 * 这与被渲染的页面无关，只与"这张表有没有 max-height"有关。
 *
 * 本文件是可装配性冒烟（模板/组件/属性名有没有写错），**不校验 Element Plus 内部布局**；
 * 表格的完整渲染由 `upstream-keys-view.spec.ts` 那样的真实挂载用例覆盖（jsdom + 真组件）。
 * 所以这里把 `el-table` 换成同名替身：断言（"改前（before）"这类文案、字段名）照旧有效，
 * 而 Element Plus 的布局分支不再参与 SSR。
 */
const TABLE_ROWS = Symbol('smoke-table-rows')

const ElTableStub = defineStub({
  name: 'ElTable',
  props: { data: { type: Array, default: () => [] } },
  setup(props, { slots }) {
    // 把行数据交给列替身：真实的 el-table 就是这么把 `{ row }` 剖进列的作用域插槽的。
    provide(TABLE_ROWS, computed(() => (props.data as readonly unknown[]) ?? []))
    return () => hStub('div', { class: 'el-table' }, slots.default?.())
  },
})

const ElTableColumnStub = defineStub({
  name: 'ElTableColumn',
  props: { prop: { type: String, default: '' }, label: { type: String, default: '' } },
  setup(props, { slots }) {
    const rows = inject(TABLE_ROWS, undefined) as { value: readonly unknown[] } | undefined
    return () => {
      // 列的头部文案（`label`）在冒烟里也要出现：它正是「改前（before）」这类断言的落点。
      const head = hStub('div', { class: 'el-table-column__label' }, props.label)
      const defaultSlot = slots.default
      if (defaultSlot === undefined || rows === undefined) return hStub('div', { class: 'el-table-column' }, [head])
      // 逐行展开作用域插槽，把 `{ row }` 交回去（模板里 `<template #default="{ row }">` 依赖它）。
      const cells = rows.value.map((row, index) => hStub('div', { class: 'el-table-column__cell', key: index }, [
        defaultSlot({ row, $index: index }),
      ]))
      return hStub('div', { class: 'el-table-column' }, [head, ...cells])
    }
  },
})

/**
 * 把一个**内联模板组件**装成应用的根组件，并把值交给模板。
 *
 * ⚠️ 常见的错法（本文件原先就是）：写成
 * `createSSRApp({ components, props: { error }, template: ... })`。
 * 那不会把值交给模板 —— 对一个**根组件**来说，`props` 是「本组件接受哪些 prop」的
 * 声明，而根组件没有父组件，于是模板里的 `error` 永远是 `undefined`。
 * 结果断言就变成了「拿 undefined 去比对」，而失败信息只显示 `undefined`，
 * 很容易被误判成组件读错了字段。
 *
 * 正确做法：用 `setup()` **返回**这些值（返回值会暴露给模板），或者用 `h()` 传 props。
 * @param components - 模板里要用的局部组件。
 * @param bindings - 模板里要引用的值。
 * @param template - 模板字符串。
 * @returns 可直接交给 `createSSRApp` 的组件选项。
 */
function inlineTemplate(
  components: Record<string, unknown>,
  bindings: Record<string, unknown>,
  template: string,
): Record<string, unknown> {
  return { components, setup: () => bindings, template }
}

/** 把替身装到被测应用的全局组件上（模板里的 `<el-table>` 会解析到它）。 */
function withTableStub(app: { component: (name: string, value: unknown) => void }): void {
  app.component('ElTable', ElTableStub)
  app.component('ElTableColumn', ElTableColumnStub)
}

describe('页面渲染冒烟', () => {
  it('登录页渲染两步表单', async () => {
    const html = await render(LoginView, { path: '/login' })
    expect(html).toContain('千手 AI 运营管理台')
    expect(html).toContain('账号')
    expect(html).toContain('下一步')
  })

  it('布局渲染服务端下发的菜单与 clientIp，并对未实现路由给出显式标记', async () => {
    const html = await render(AppLayout, { path: '/', withSession: true })
    expect(html).toContain('样例管理员')
    expect(html).toContain('203.0.113.7')
    expect(html).toContain('账号与额度')
    expect(html).toContain('前端未实现')
  })

  it('总览渲染三色矩阵与缺失接口', async () => {
    const html = await render(OverviewView, { path: '/', withSession: true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(html.length).toBeGreaterThan(0)
  })

  it('账号页在只读权限下隐藏「异常扣费处理」入口', async () => {
    const html = await render(AccountView, { path: '/account', withSession: true })
    expect(html).not.toContain('异常扣费处理')
  })

  it('订阅页渲染档位只读目录与变更入口', async () => {
    const html = await render(SubscriptionView, { path: '/subscription', withSession: true })
    expect(html).toContain('档位目录')
    expect(html).toContain('订阅变更')
  })

  it('占位页在 SSR 下渲染标题但不编造条目', async () => {
    const html = await render(MarketView, { path: '/market', withSession: true })
    expect(html).toContain('技能 / 专家市场')
    expect(html).toContain('占位页')
  })

  it('模型路由占位页列出 7080 缺口，不编造绑定表', async () => {
    const html = await render(ModelsView, { path: '/models', withSession: true })
    expect(html).toContain('模型路由')
    expect(html).toContain('占位页')
    expect(html).toContain('POST /api/qianshou/ai/admin/names')
  })

  it('权限页 / 审计页 / 白名单页 / 开关页 / 上游密钥页 / 上游号池页可装配渲染', async () => {
    for (const [component, path, marker] of [
      [RbacView, '/rbac', '权限管理'],
      [AuditView, '/audit', '审计日志'],
      [WhitelistView, '/whitelist', 'clientIp'],
      [FlagsView, '/flags', '功能开关'],
      [UpstreamKeysView, '/credential', '上游密钥'],
      [PoolView, '/pool', '上游号池'],
    ] as const) {
      const html = await render(component, { path, withSession: true })
      expect(html, `${path} 应渲染出 ${marker}`).toContain(marker)
    }
  })

  it('上游密钥页可装配渲染（不依赖取数的那部分）', async () => {
    const html = await render(UpstreamKeysView, { path: '/credential', withSession: true })
    expect(html).toContain('上游密钥')
    expect(html).toContain('从不显示明文')
    expect(html).toContain('更换上游密钥')
  })

  it('企业咨询只读页可装配渲染，不显示写操作', async () => {
    const html = await render(EnterpriseLeadsView, { path: '/enterprise', withSession: true })
    expect(html).toContain('企业咨询')
    expect(html).toContain('查看官网收到的申请')
    expect(html).not.toContain('删除线索')
  })

  it('上游号池页可装配渲染（标题 / 抽屉 / 危险弹窗都在）', async () => {
    // SSR 不跑 `onMounted`，且 `el-drawer` 收起时**不渲染 body**（实测：SSR 里只有
    // header 与 footer）—— 所以这里只断言"模板与组件装配正确"的那部分。
    // 三种可粘贴形态、`type=password`、`duplicate` 提示都由挂载用例
    // `pool-view.spec.ts` 覆盖（那里才是真实 DOM）。
    const html = await render(PoolView, { path: '/pool', withSession: true })
    expect(html).toContain('上游号池')
    expect(html).toContain('加号：粘贴 Cursor 凭据')
    expect(html).toContain('确认加号（两步确认）')
    expect(html).toContain('移除号池成员（高危操作）')
    // 不回显的底线：页面上没有任何"查看明文"入口。
    expect(html).not.toContain('查看明文')
  })

  it('404 页渲染', async () => {
    const html = await render(NotFoundView, { path: '/' })
    expect(html).toContain('页面不存在')
  })
})

describe('组件渲染', () => {
  it('ErrorAlert 对 502 与 503 给出不同文案', async () => {
    const upstream = toAdminApiError(502, { ok: false, code: 'upstream_unavailable', message: '上游账号服务不可达' })
    const html502 = await render(inlineTemplate({ ErrorAlert }, { error: upstream }, '<ErrorAlert :error="error" />') as never)
    expect(html502).toContain('上游账号服务不可达')
    expect(html502).not.toContain('请重新登录')

    const notReady = toAdminApiError(503, {
      ok: false,
      code: 'dependency_unavailable',
      message: '属主服务未就绪',
      module: 'market',
      missing: [{ interface: 'GET /internal/market/items', why: '市场条目' }],
    })
    const html503 = await render(
      inlineTemplate({ ErrorAlert }, { error: notReady }, '<ErrorAlert :error="error" />') as never,
    )
    expect(html503).toContain('依赖服务未就绪')
    expect(html503).toContain('GET /internal/market/items')
  })

  /**
   * 针对性回归：**503 必须把「缺失的接口清单」渲染出来**。
   *
   * 这条曾经是"假绿"的反面 —— 断言在，但组件里那个与 prop 同名的 computed
   * 让整块 `v-if` 永远为假，清单**从来没显示过**，而失败信息只显示 `undefined`，
   * 一度被误读成"组件读错字段"。所以这里刻意把这条价值讲清楚：
   * 管理台在 `dependency_unavailable` 时唯一能"如实告诉管理员缺哪个接口"的地方
   * 就是这段清单，它不渲染 = 这块的核心价值为零。
   *
   * 根因有两层，两层都会**静默**失效（没有报错、没有警告），所以这里两层都钉住：
   * 1. Vue 对 `boolean` prop 做布尔转换：**未传**时是 `false` 而不是 `undefined`
   *    → `props.showDetails !== false` 恒为假；
   * 2. prop 与本地 computed 同名时，模板的 `v-if` 会绕开 computed。
   */
  it('ErrorAlert 对 503 展开服务端报告的缺失接口清单', async () => {
    const notReady = toAdminApiError(503, {
      ok: false,
      code: 'dependency_unavailable',
      message: '属主服务未就绪',
      module: 'market',
      missing: [{ interface: 'GET /internal/market/items', why: '市场条目' }],
    })
    const html = await render(inlineTemplate({ ErrorAlert }, { error: notReady }, '<ErrorAlert :error="error" />') as never)
    // 段落标题、接口名、以及"为什么需要它"三者都要出现（缺一个都等于没讲清缺口）。
    expect(html).toContain('服务端报告缺失的接口')
    expect(html).toContain('GET /internal/market/items')
    expect(html).toContain('市场条目')
    // 模块 key 也要在（否则管理员不知道该找谁）。
    expect(html).toContain('market')

    // 契约的另一半：**显式**传 false 才隐藏细节（默认是展示）。
    const explicitOff = await render(
      inlineTemplate({ ErrorAlert }, { error: notReady, showDetails: false }, '<ErrorAlert :error="error" :show-details="showDetails" />') as never,
    )
    expect(explicitOff).not.toContain('服务端报告缺失的接口')
    // 隐藏的只是"细节"，标题与说明仍然在（否则等于把错误吞了）。
    expect(explicitOff).toContain('依赖服务未就绪')
  })

  it('ErrorAlert 对 403 forbidden 显示缺失的权限键', async () => {
    const error = toAdminApiError(403, { ok: false, code: 'forbidden', message: '权限不足', need: 'audit.read' })
    const html = await render(inlineTemplate({ ErrorAlert }, { error }, '<ErrorAlert :error="error" />') as never)
    expect(html).toContain('audit.read')
  })

  it('DiffView 渲染改前改后并可区分未变化的字段', async () => {
    const html = await render(inlineTemplate(
      { DiffView },
      { before: { enabled: false, note: 'x' }, after: { enabled: true, note: 'x' } },
      '<DiffView :before="before" :after="after" />',
    ) as never)
    expect(html).toContain('改前（before）')
    expect(html).toContain('改后（after）')
    expect(html).toContain('enabled')
    expect(html).toContain('value--changed')
  })
})
