/**
 * 会话状态（登录态、身份、菜单、就绪度）。
 *
 * 刻意不引入 pinia：这里只是一个 `reactive` 单例，
 * 依赖比状态管理库小得多，也避免把「服务端才是安全边界」的判断搬到前端。
 */

import { computed, reactive, readonly } from 'vue'
import { fetchMe, logout as logoutRequest } from '@/api/modules/session'
import type { AdminIdentity, ReadinessEntry, SessionMe } from '@/api/types'

export interface SessionState {
  /** 是否已通过 `session/me` 确认身份。 */
  ready: boolean
  loading: boolean
  admin: AdminIdentity | undefined
  permissions: readonly string[]
  menu: SessionMe['menu']
  readiness: readonly ReadinessEntry[]
  clientIp: string
}

const state = reactive<SessionState>({
  ready: false,
  loading: false,
  admin: undefined,
  permissions: [],
  menu: [],
  readiness: [],
  clientIp: '',
})

/** 供视图读取的只读快照。 */
export const session = readonly(state)

/** 最近一次 `session/me` 的原始结果。 */
let lastMe: SessionMe | undefined

/**
 * 拉取当前身份。菜单与权限由服务端按角色过滤后下发：
 * 前端把它们当成**唯一来源**，不自行判断「哪个角色能看哪个菜单」。
 */
export async function loadSession(): Promise<SessionMe> {
  state.loading = true
  try {
    const me = await fetchMe()
    lastMe = me
    state.admin = me.admin
    state.permissions = me.permissions
    state.menu = me.menu
    state.readiness = me.readiness
    state.clientIp = me.clientIp
    state.ready = true
    return me
  } finally {
    state.loading = false
  }
}

/** 清空本地会话快照（401、退出登录、切换账号时调用）。 */
export function clearSession(): void {
  lastMe = undefined
  state.ready = false
  state.loading = false
  state.admin = undefined
  state.permissions = []
  state.menu = []
  state.readiness = []
  state.clientIp = ''
}

/** 退出登录：先吊销服务端会话，无论成败都清空本地快照。 */
export async function logout(): Promise<void> {
  try {
    await logoutRequest()
  } finally {
    clearSession()
  }
}

/** 当前管理员展示名（顶栏用）。 */
export const displayName = computed(() => state.admin?.displayName ?? '')
