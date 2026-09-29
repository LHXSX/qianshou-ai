<script setup lang="ts">
/**
 * 审计日志（契约 §5 + §9）。
 *
 * 过滤维度：时间区间 / 操作人 / 动作前缀 / 结果（allow|deny）；分页由 `limit/offset` 驱动。
 * 详情展示服务端给的 `before` / `after` 与结构化 `diff[]`。
 * 审计是只追加的 JSONL，前端只读，不提供任何编辑入口。
 */
import { computed, onMounted, ref } from 'vue'
import { formatTime } from '@/utils/format'
import { fetchAuditDetail, fetchAuditList } from '@/api/modules/audit'
import { useAsyncData } from '@/utils/async-state'
import type { AuditEntry, AuditEntryDetail, AuditResult } from '@/api/types'
import ErrorAlert from '@/components/ErrorAlert.vue'
import DiffView from '@/components/DiffView.vue'

const PAGE_SIZE = 50

const actorId = ref('')
const actionPrefix = ref('')
const resultFilter = ref<'' | AuditResult>('')
/** Element Plus 的日期区间选择器给的是 [开始, 结束] 时间戳数组。 */
const range = ref<[number, number] | undefined>(undefined)
const offset = ref(0)

const listState = useAsyncData(() =>
  fetchAuditList({
    ...(actorId.value.trim() === '' ? {} : { actorId: actorId.value.trim() }),
    ...(actionPrefix.value.trim() === '' ? {} : { actionPrefix: actionPrefix.value.trim() }),
    ...(resultFilter.value === '' ? {} : { result: resultFilter.value }),
    ...(range.value === undefined ? {} : { from: range.value[0], to: range.value[1] }),
    limit: PAGE_SIZE,
    offset: offset.value,
  }),
)

const entries = computed<readonly AuditEntry[]>(() => listState.data.value?.entries ?? [])
const total = computed(() => listState.data.value?.total ?? 0)

/** 动作前缀候选：只来自当前已取到的记录，绝不硬编码业务前缀清单。 */
const prefixCandidates = computed(() => {
  const prefixes = new Set<string>()
  for (const entry of entries.value) {
    const dot = entry.action.indexOf('.')
    prefixes.add(dot === -1 ? entry.action : entry.action.slice(0, dot + 1))
  }
  return [...prefixes].sort((left, right) => left.localeCompare(right))
})

/** 前缀输入建议项（el-autocomplete 需要 { value } 形状）。 */
function suggestPrefixes(query: string, callback: (items: { value: string }[]) => void): void {
  const matched = prefixCandidates.value.filter((prefix) => query === '' || prefix.includes(query))
  callback(matched.map((prefix) => ({ value: prefix })))
}

onMounted(() => {
  void listState.run()
})

function search(): void {
  offset.value = 0
  void listState.run()
}

function resetFilters(): void {
  actorId.value = ''
  actionPrefix.value = ''
  resultFilter.value = ''
  range.value = undefined
  search()
}

function changePage(page: number): void {
  offset.value = (page - 1) * PAGE_SIZE
  void listState.run()
}

// —— 详情 ——————————————————————————————————————————————

const drawerOpen = ref(false)
const detailId = ref('')
const detailState = useAsyncData<AuditEntryDetail>(() => fetchAuditDetail(detailId.value))

function openDetail(entry: AuditEntry): void {
  detailId.value = entry.id
  drawerOpen.value = true
  void detailState.run()
}
</script>

<template>
  <div class="qs-page">
    <div class="qs-page__head">
      <div>
        <h2 class="qs-page__title">审计日志</h2>
        <p class="qs-page__desc">
          登录成功/失败、被拒的越权请求、白名单拒绝与全部写操作都在这里留痕。
          日志只追加，页面不提供修改或删除。数据范围（all / self）由服务端裁剪。
        </p>
      </div>
      <el-button :loading="listState.loading.value" @click="search">刷新</el-button>
    </div>

    <el-card class="qs-card" shadow="never">
      <div class="filters">
        <el-date-picker v-model="range" type="datetimerange" range-separator="→" start-placeholder="开始时间"
          end-placeholder="结束时间" :default-time="[new Date(2000, 0, 1, 0, 0, 0), new Date(2000, 0, 1, 23, 59, 59)]" />
        <el-input v-model="actorId" placeholder="操作人 accountId" clearable class="filter-input" />
        <el-autocomplete v-model="actionPrefix" :fetch-suggestions="suggestPrefixes" placeholder="动作前缀，例如 admin."
          clearable class="filter-input" />
        <el-select v-model="resultFilter" placeholder="结果（全部）" clearable class="filter-select">
          <el-option label="allow（放行）" value="allow" />
          <el-option label="deny（拒绝）" value="deny" />
        </el-select>
        <el-button type="primary" :loading="listState.loading.value" @click="search">查询</el-button>
        <el-button @click="resetFilters">重置</el-button>
      </div>

      <ErrorAlert v-if="listState.error.value" :error="listState.error.value" />

      <el-table v-loading="listState.loading.value" :data="[...entries]" border size="small">
        <el-table-column label="时间" min-width="170">
          <template #default="{ row }">{{ formatTime(row.at) }}</template>
        </el-table-column>
        <el-table-column label="操作人" min-width="110">
          <template #default="{ row }">
            <span class="qs-mono">{{ row.actorId }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="actorRole" label="角色" min-width="120" />
        <el-table-column label="来源 IP" min-width="140">
          <template #default="{ row }">
            <span class="qs-mono">{{ row.ip }}</span>
          </template>
        </el-table-column>
        <el-table-column label="动作" min-width="200">
          <template #default="{ row }">
            <span class="qs-mono">{{ row.action }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="target" label="目标" min-width="160" />
        <el-table-column label="结果" width="100">
          <template #default="{ row }">
            <el-tag :type="row.result === 'allow' ? 'success' : 'danger'" size="small">
              {{ row.result }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="reason" label="原因" min-width="160" />
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openDetail(row)">详情</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-empty v-if="!listState.loading.value && entries.length === 0 && listState.error.value === undefined"
        description="当前过滤条件下没有审计记录" />

      <div class="qs-pager">
        <el-pagination :current-page="Math.floor(offset / PAGE_SIZE) + 1" :page-size="PAGE_SIZE" :total="total"
          layout="total, prev, pager, next" @current-change="changePage" />
      </div>
    </el-card>

    <el-drawer v-model="drawerOpen" title="审计详情" size="720px">
      <ErrorAlert v-if="detailState.error.value" :error="detailState.error.value" />
      <template v-if="detailState.data.value">
        <el-descriptions :column="2" border size="small" class="qs-card">
          <el-descriptions-item label="记录 id">
            <span class="qs-mono">{{ detailState.data.value.id }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="时间">{{ formatTime(detailState.data.value.at) }}</el-descriptions-item>
          <el-descriptions-item label="操作人">
            <span class="qs-mono">{{ detailState.data.value.actorId }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="角色">{{ detailState.data.value.actorRole }}</el-descriptions-item>
          <el-descriptions-item label="来源 IP">
            <span class="qs-mono">{{ detailState.data.value.ip }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="结果">
            <el-tag :type="detailState.data.value.result === 'allow' ? 'success' : 'danger'" size="small">
              {{ detailState.data.value.result }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="动作">
            <span class="qs-mono">{{ detailState.data.value.action }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="目标">{{ detailState.data.value.target }}</el-descriptions-item>
          <el-descriptions-item label="原因" :span="2">{{ detailState.data.value.reason || '—' }}</el-descriptions-item>
          <el-descriptions-item label="摘要" :span="2">{{ detailState.data.value.summary || '—' }}</el-descriptions-item>
        </el-descriptions>

        <el-divider content-position="left">改前 → 改后</el-divider>
        <DiffView :before="detailState.data.value.before" :after="detailState.data.value.after"
          :rows="detailState.data.value.diff" />
        <p v-if="detailState.data.value.diff && detailState.data.value.diff.length === 0" class="qs-empty-hint">
          该记录没有结构化 diff（例如登录、拒绝类事件只记录动作本身）。
        </p>
      </template>
      <el-empty v-else-if="!detailState.loading.value" description="未取得详情" />
    </el-drawer>
  </div>
</template>

<style scoped>
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 16px;
}

.filter-input {
  width: 220px;
}

.filter-select {
  width: 170px;
}
</style>
