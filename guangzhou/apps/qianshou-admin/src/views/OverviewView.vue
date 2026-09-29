<script setup lang="ts">
/**
 * 总览：模块就绪度矩阵（契约 §3 + §9）。
 *
 * 三色矩阵严格按服务端 `status` 渲染：
 * `ready` / `read-only` / `dependency-unavailable`。
 * 「缺哪些接口」直接来自服务端 `missing[]`，前端不推断、不补全。
 * 页脚附带 `POST health` 的真实结果，便于判断「页面打不开是前端还是服务端」。
 */
import { computed, onMounted } from 'vue'
import { useAsyncData } from '@/utils/async-state'
import { moduleStatusMeta, sortModules } from '@/utils/module-status'
import { fetchHealth, fetchModules } from '@/api/modules/modules'
import { session } from '@/session/store'
import type { ReadinessEntry } from '@/api/types'
import ErrorAlert from '@/components/ErrorAlert.vue'
import { formatDuration, formatTime } from '@/utils/format'

const modulesState = useAsyncData<readonly ReadinessEntry[]>(fetchModules)
const healthState = useAsyncData(fetchHealth)

onMounted(() => {
  void modulesState.run()
  void healthState.run()
})

/**
 * 就绪度以 `modules` 为准；若它不可用则退回 `session/me` 的 readiness，
 * 保证总览在权限受限时依然能显示服务端已知的缺口。
 */
const entries = computed<readonly ReadinessEntry[]>(() => {
  const fromModules = modulesState.data.value
  if (fromModules !== undefined && fromModules.length > 0) return sortModules(fromModules)
  return sortModules(session.readiness)
})

const source = computed(() => {
  const fromModules = modulesState.data.value
  return fromModules !== undefined && fromModules.length > 0
    ? 'POST /modules（服务端实时就绪度）'
    : 'session/me → readiness（modules 接口不可用时的回退视图）'
})

const counts = computed(() => {
  const result = { ready: 0, 'read-only': 0, 'dependency-unavailable': 0 }
  for (const entry of entries.value) {
    if (entry.status === 'ready') result.ready += 1
    else if (entry.status === 'read-only') result['read-only'] += 1
    else result['dependency-unavailable'] += 1
  }
  return result
})

const identity = computed(() => session.admin)
</script>

<template>
  <div class="qs-page">
    <div class="qs-page__head">
      <div>
        <h2 class="qs-page__title">总览</h2>
        <p class="qs-page__desc">
          这里只回答一个问题：每个模块的接口现在到底能不能用。数据来源：{{ source }}。
        </p>
      </div>
      <div class="actions">
        <el-button :loading="modulesState.loading.value" @click="modulesState.run">刷新就绪度</el-button>
      </div>
    </div>

    <el-card class="qs-card" shadow="never">
      <template #header>当前身份（来自 session/me）</template>
      <el-descriptions v-if="identity" :column="3" border size="small">
        <el-descriptions-item label="管理员">{{ identity.displayName }}</el-descriptions-item>
        <el-descriptions-item label="accountId">
          <span class="qs-mono">{{ identity.accountId }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="角色">
          {{ identity.roleName }}（<span class="qs-mono">{{ identity.roleId }}</span>，{{ identity.roleKind === 'builtin' ? '内置' : '自定义' }}）
        </el-descriptions-item>
        <el-descriptions-item label="数据范围">
          {{ identity.scope === 'all' ? '全部（all）' : '仅自己经办（self）' }}
        </el-descriptions-item>
        <el-descriptions-item label="surface">
          <span class="qs-mono">{{ identity.surface }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="服务端看到的来源 IP">
          <span class="qs-mono">{{ session.clientIp || '—' }}</span>
        </el-descriptions-item>
      </el-descriptions>
      <p v-else class="qs-empty-hint">尚未取得身份信息。</p>
    </el-card>

    <el-card class="qs-card" shadow="never">
      <template #header>
        <div class="card-head">
          <span>模块就绪度矩阵</span>
          <div class="legend">
            <el-tag type="success" size="small">可用 ready · {{ counts.ready }}</el-tag>
            <el-tag type="warning" size="small">只读 read-only · {{ counts['read-only'] }}</el-tag>
            <el-tag type="danger" size="small">
              依赖未就绪 dependency-unavailable · {{ counts['dependency-unavailable'] }}
            </el-tag>
          </div>
        </div>
      </template>

      <ErrorAlert v-if="modulesState.error.value && session.readiness.length === 0" :error="modulesState.error.value" />
      <el-alert v-else-if="modulesState.error.value" type="info" :closable="false" show-icon
        title="/modules 接口不可用，正在显示 session/me 的 readiness 回退数据" />

      <el-table :data="[...entries]" border size="small">
        <el-table-column label="模块" min-width="200">
          <template #default="{ row }">
            <div class="module-cell">
              <div class="module-cell__title">{{ row.title }}</div>
              <div class="qs-mono module-cell__key">{{ row.key }}</div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="140">
          <template #default="{ row }">
            <el-tag :type="moduleStatusMeta(row.status).tagType" effect="dark">
              {{ moduleStatusMeta(row.status).label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="服务端说明" min-width="260">
          <template #default="{ row }">
            <span>{{ row.summary || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="缺哪些接口" min-width="320">
          <template #default="{ row }">
            <div v-if="row.missing && row.missing.length > 0">
              <div v-for="item in row.missing" :key="item.interface" class="missing-row">
                <span class="qs-mono">{{ item.interface }}</span>
                <span class="missing-row__why">{{ item.why }}</span>
              </div>
            </div>
            <span v-else class="qs-empty-hint">无缺失接口（服务端 missing 为空）</span>
          </template>
        </el-table-column>
      </el-table>

      <el-empty v-if="entries.length === 0 && !modulesState.loading.value" description="服务端未返回任何模块就绪度条目" />
    </el-card>

    <el-card class="qs-card" shadow="never">
      <template #header>
        <div class="card-head">
          <span>管理台服务自检（POST /health）</span>
          <el-button size="small" :loading="healthState.loading.value" @click="healthState.run">重新自检</el-button>
        </div>
      </template>
      <ErrorAlert v-if="healthState.error.value" :error="healthState.error.value" />
      <el-descriptions v-else-if="healthState.data.value" :column="3" border size="small">
        <el-descriptions-item label="service">
          <span class="qs-mono">{{ healthState.data.value.service }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="version">
          <span class="qs-mono">{{ healthState.data.value.version }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="已运行">
          {{ formatDuration(healthState.data.value.uptimeMs) }}
        </el-descriptions-item>
      </el-descriptions>
      <p v-else class="qs-empty-hint">尚未取得自检结果。检查时间：{{ formatTime(Date.now()) }}</p>
    </el-card>
  </div>
</template>

<style scoped>
.card-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.module-cell__title {
  font-weight: 600;
}

.module-cell__key {
  color: #909399;
}

.missing-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  line-height: 1.6;
}

.missing-row__why {
  color: #909399;
}

.actions {
  display: flex;
  gap: 8px;
}
</style>
