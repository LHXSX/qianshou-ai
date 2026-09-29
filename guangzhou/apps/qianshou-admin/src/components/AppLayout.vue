<script setup lang="ts">
/**
 * 应用布局：侧栏菜单完全来自服务端 `session/me` 的 `menu`，顶栏展示身份与来源 IP。
 *
 * 关键约束：这里**没有任何角色/权限判断**，也不读本地常量菜单。
 * 服务端按角色过滤后的数组就是唯一来源；为空的菜单会渲染成明确的空状态提示。
 */
import { computed } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { SwitchButton } from '@element-plus/icons-vue'
import { logout, session } from '@/session/store'
import { routeNameForMenuKey } from '@/router'

const route = useRoute()
const router = useRouter()

interface MenuGroup {
  readonly group: string
  readonly items: (typeof session.menu)[number][]
}

/** 按服务端下发的 `group` 聚合，保持服务端顺序（不重排、不筛选）。 */
const menuGroups = computed<MenuGroup[]>(() => {
  const groups: MenuGroup[] = []
  for (const item of session.menu) {
    const last = groups[groups.length - 1]
    if (last !== undefined && last.group === item.group) {
      last.items.push(item)
      continue
    }
    const existing = groups.find((group) => group.group === item.group)
    if (existing !== undefined) {
      existing.items.push(item)
      continue
    }
    groups.push({ group: item.group, items: [item] })
  }
  return groups
})

/** 服务端菜单项 → 前端路由名；未实现路由的 key 会显式暴露出来而不是静默忽略。 */
function menuTarget(key: string): string | undefined {
  return routeNameForMenuKey(key)
}

const activeMenu = computed(() => (typeof route.name === 'string' ? route.name : ''))

async function handleLogout(): Promise<void> {
  try {
    await ElMessageBox.confirm('退出后需要重新输入账号密码与动态验证码，确认退出？', '退出登录', {
      confirmButtonText: '退出',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return
  }
  try {
    await logout()
    ElMessage.success('已退出登录')
  } catch (error) {
    ElMessage.warning(error instanceof Error ? error.message : '退出请求失败，本地会话已清理')
  }
  await router.replace({ name: 'login' })
}
</script>

<template>
  <el-container class="layout">
    <el-aside width="232px" class="layout__aside">
      <div class="brand">
        <div class="brand__name">千手 AI 运营管理台</div>
        <div class="brand__sub">admin.qianshousuanli.com</div>
      </div>
      <el-scrollbar>
        <el-menu :default-active="activeMenu" router class="layout__menu" background-color="#1f2d3d" text-color="#c3ccd8"
          active-text-color="#ffffff">
          <template v-for="group in menuGroups" :key="group.group">
            <div class="layout__group">{{ group.group }}</div>
            <el-menu-item v-for="item in group.items" :key="item.key"
              :index="menuTarget(item.key) ?? `unrouted:${item.key}`"
              :disabled="menuTarget(item.key) === undefined"
              :route="menuTarget(item.key) !== undefined ? { name: menuTarget(item.key) } : undefined">
              <span>{{ item.title }}</span>
              <el-tag v-if="menuTarget(item.key) === undefined" size="small" type="danger" effect="dark"
                class="layout__missing">前端未实现</el-tag>
            </el-menu-item>
          </template>
        </el-menu>
        <el-empty v-if="menuGroups.length === 0" description="服务端未下发任何菜单项" :image-size="72" />
      </el-scrollbar>
    </el-aside>

    <el-container>
      <el-header height="56px" class="layout__header">
        <div class="identity">
          <span class="identity__name">{{ session.admin?.displayName ?? '—' }}</span>
          <el-tag v-if="session.admin" size="small" type="info">账号 {{ session.admin.accountId }}</el-tag>
          <el-tag v-if="session.admin" size="small" type="primary">{{ session.admin.roleName }}</el-tag>
          <el-tag v-if="session.admin" size="small" effect="plain">
            {{ session.admin.roleKind === 'builtin' ? '内置角色' : '自定义角色' }}
          </el-tag>
          <el-tag v-if="session.admin" size="small" effect="plain">
            数据范围 {{ session.admin.scope === 'all' ? '全部（all）' : '仅自己经办（self）' }}
          </el-tag>
        </div>
        <div class="identity identity--right">
          <span class="identity__ip">
            服务端看到的来源 IP：<span class="qs-mono">{{ session.clientIp || '—' }}</span>
          </span>
          <el-button :icon="SwitchButton" text @click="handleLogout">退出登录</el-button>
        </div>
      </el-header>
      <el-main class="layout__main">
        <RouterView />
      </el-main>
    </el-container>
  </el-container>
</template>

<style scoped>
.layout {
  height: 100vh;
}

.layout__aside {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--qs-admin-sidebar-bg);
}

.brand {
  padding: 16px 18px 12px;
  border-bottom: 1px solid rgb(255 255 255 / 8%);
}

.brand__name {
  color: #fff;
  font-size: 15px;
  font-weight: 600;
}

.brand__sub {
  margin-top: 4px;
  color: #8b98a8;
  font-size: 12px;
}

.layout__menu {
  border-right: none;
}

.layout__group {
  padding: 14px 18px 6px;
  color: #7d8a99;
  font-size: 12px;
  letter-spacing: 0.05em;
}

.layout__missing {
  margin-left: 8px;
}

.layout__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  background: var(--qs-admin-header-bg);
  border-bottom: 1px solid #e4e7ed;
}

.identity {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.identity--right {
  justify-content: flex-end;
}

.identity__name {
  font-weight: 600;
}

.identity__ip {
  color: #606266;
  font-size: 13px;
}

.layout__main {
  padding: 0;
  overflow: auto;
}
</style>
