/**
 * 路由表。
 *
 * 硬边界：路由**不挂权限元数据**，也不在前端做「哪个角色能看哪个页面」的判断。
 * 服务端 `session/me` 返回的 `menu` 才是可见性来源；侧栏只渲染它，
 * 未在菜单里的路由即使被直接访问，服务端接口也会按权限返回 `403 forbidden`。
 */

import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { loadSession, session } from '@/session/store'

/** 路由名与契约菜单 key 的对应关系（菜单 key 由服务端下发）。 */
export const ROUTE_NAMES = {
  apiConnections: 'apiConnections',
  overview: 'overview',
  account: 'account',
  subscription: 'subscription',
  models: 'models',
  market: 'market',
  community: 'community',
  discovery: 'discovery',
  order: 'order',
  enterprise: 'enterprise',
  rbac: 'rbac',
  audit: 'audit',
  whitelist: 'whitelist',
  flags: 'flags',
  credential: 'credential',
  pool: 'pool',
} as const

const routes: readonly RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
    meta: { public: true, title: '登录' },
  },
  {
    path: '/',
    component: () => import('@/components/AppLayout.vue'),
    children: [
      {
        path: 'api-connections',
        name: ROUTE_NAMES.apiConnections,
        component: () => import('@/views/ApiConnectionsView.vue'),
        meta: { title: 'API 管理' },
      },
      { path: '', redirect: { name: ROUTE_NAMES.overview } },
      {
        path: 'overview',
        name: ROUTE_NAMES.overview,
        component: () => import('@/views/OverviewView.vue'),
        meta: { title: '总览' },
      },
      {
        path: 'account',
        name: ROUTE_NAMES.account,
        component: () => import('@/views/AccountView.vue'),
        meta: { title: '账号与额度' },
      },
      {
        path: 'subscription',
        name: ROUTE_NAMES.subscription,
        component: () => import('@/views/SubscriptionView.vue'),
        meta: { title: '订阅与档位' },
      },
      {
        path: 'models',
        name: ROUTE_NAMES.models,
        component: () => import('@/views/ModelsView.vue'),
        meta: { title: '模型路由' },
      },
      {
        path: 'market',
        name: ROUTE_NAMES.market,
        component: () => import('@/views/MarketReviewView.vue'),
        meta: { title: '技能 / 专家市场' },
      },
      {
        path: 'community',
        name: ROUTE_NAMES.community,
        component: () => import('@/views/CommunityView.vue'),
        meta: { title: '讨论区' },
      },
      {
        path: 'discovery',
        name: ROUTE_NAMES.discovery,
        component: () => import('@/views/DiscoveryView.vue'),
        meta: { title: '发现页内容' },
      },
      {
        path: 'order',
        name: ROUTE_NAMES.order,
        component: () => import('@/views/OrderView.vue'),
        meta: { title: '支付订单与提现' },
      },
      {
        path: 'enterprise',
        name: ROUTE_NAMES.enterprise,
        component: () => import('@/views/EnterpriseLeadsView.vue'),
        meta: { title: '企业咨询' },
      },
      {
        path: 'rbac',
        name: ROUTE_NAMES.rbac,
        component: () => import('@/views/RbacView.vue'),
        meta: { title: '权限管理' },
      },
      {
        path: 'audit',
        name: ROUTE_NAMES.audit,
        component: () => import('@/views/AuditView.vue'),
        meta: { title: '审计日志' },
      },
      {
        path: 'whitelist',
        name: ROUTE_NAMES.whitelist,
        component: () => import('@/views/WhitelistView.vue'),
        meta: { title: '白名单' },
      },
      {
        path: 'flags',
        name: ROUTE_NAMES.flags,
        component: () => import('@/views/FlagsView.vue'),
        meta: { title: '功能开关' },
      },
      {
        path: 'credential',
        name: ROUTE_NAMES.credential,
        component: () => import('@/views/UpstreamKeysView.vue'),
        meta: { title: '上游密钥' },
      },
      {
        // 侧栏入口由服务端 `rbac.ts` 的 `MENU` 下发（key 为 `pool`），前端只把它映射到本路由。
        // 这里**不加**菜单项：再加一条同 key 的会让侧栏出现两个相同入口。
        path: 'pool',
        name: ROUTE_NAMES.pool,
        component: () => import('@/views/PoolView.vue'),
        meta: { title: '上游号池' },
      },
    ],
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/NotFoundView.vue'),
    meta: { public: true, title: '页面不存在' },
  },
]

export const router = createRouter({
  // 生产挂在域名根路径（vite base 为 `/`），因此使用 history 模式。
  history: createWebHistory('/'),
  routes: [...routes],
})

/** 供侧栏渲染：服务端菜单 key → 前端路由名。契约 key 与路由名一致，改契约时这里必须同步。 */
export function routeNameForMenuKey(key: string): string | undefined {
  return key in ROUTE_NAMES ? ROUTE_NAMES[key as keyof typeof ROUTE_NAMES] : undefined
}

/** 跳登录页，并记住原始目标；供 401 钩子复用。 */
export async function redirectToLogin(reason: 'expired' | 'required' = 'required'): Promise<void> {
  const current = router.currentRoute.value
  if (current.name === 'login') return
  await router.replace({
    name: 'login',
    query: { reason, redirect: current.fullPath },
  })
}

router.beforeEach(async (to) => {
  const isPublic = to.meta.public === true
  if (isPublic) {
    // 已登录时不必再进登录页。
    if (to.name === 'login' && session.ready) return { name: ROUTE_NAMES.overview }
    return true
  }

  if (!session.ready) {
    try {
      await loadSession()
    } catch {
      // 具体原因（401/403/502/503）由 session 拉取的错误分类决定；
      // 引导到登录页由那里统一处理，这里只保证当前路由不被困住。
      return { name: 'login', query: { reason: 'required', redirect: to.fullPath } }
    }
  }
  return true
})
