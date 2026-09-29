<script setup lang="ts">
/** Subscription changes require explicit dates and a confirmed workbench preview. */
import { computed, onMounted, ref, watch } from 'vue'
import { formatCny, formatNumber, formatTime } from '@/utils/format'
import {
  fetchSubscriptionList,
  fetchSubscriptionTiers,
} from '@/api/modules/subscriptions'
import { useAccountData } from '@/utils/workbench-read-state'
import type { SubscriptionRow } from '@/api/types'
import ErrorAlert from '@/components/ErrorAlert.vue'
import SpMoneyDialog from '@/components/SpMoneyDialog.vue'
import { session } from '@/session/store'

const PAGE_SIZE = 20

const query = ref('')
const offset = ref(0)

const listState = useAccountData(() => fetchSubscriptionList(query.value.trim(), PAGE_SIZE, offset.value))
const tiersState = useAccountData(fetchSubscriptionTiers)

const entries = computed<readonly SubscriptionRow[]>(() => listState.data.value?.entries ?? [])
const total = computed(() => listState.data.value?.total ?? 0)

onMounted(() => {
  void listState.run()
  void tiersState.run()
})

function search(): void {
  offset.value = 0
  void listState.run()
}

function changePage(page: number): void {
  offset.value = (page - 1) * PAGE_SIZE
  void listState.run()
}

/** 订阅是否已到期：只用于表格着色，不做任何业务判断。 */
function isExpired(row: SubscriptionRow): boolean {
  return typeof row.to === 'number' && row.to > 0 && row.to < Date.now()
}

// —— Explicit term and confirmed owner write ————————————————————————
const manageOpen = ref(false)
const manageTarget = ref('')
const manageTier = ref('')
const spReceipt = ref('')
const canManage = computed(() => session.permissions.includes('subscription.manage') && session.admin?.scope === 'all')
function openManage(row?: SubscriptionRow): void {
  manageTarget.value = row?.accountId ?? ''
  manageTier.value = row?.tier ?? ''
  manageOpen.value = true
}
watch(() => session.admin?.accountId, () => { manageOpen.value = false; spReceipt.value = '' })
</script>

<template>
  <div class="qs-page">
    <div class="qs-page__head">
      <div>
        <h2 class="qs-page__title">订阅与档位</h2>
        <p class="qs-page__desc">
          订阅记录与档位目录来自属主数据。选择明确的生效与到期时间，预览后确认；系统不默认永久订阅。
        </p>
      </div>
      <div class="actions"><el-button v-if="canManage" type="primary" @click="openManage()">开通订阅</el-button>
        <el-button :loading="listState.loading.value" @click="search">刷新</el-button>
      </div>
    </div>

    <el-alert class="qs-card" type="info" :closable="false" show-icon title="订阅变更由工作台记录"
      description="预览会验证真实工作台身份与当前状态。服务未就绪时明确报错；发生不确定结果时保留原操作号核查。" />

    <el-card class="qs-card" shadow="never">
      <template #header>
        <div class="card-head">
          <el-input v-model="query" placeholder="按 accountId 查询（留空为全部）" clearable class="search"
            @keyup.enter="search" />
          <el-button type="primary" :loading="listState.loading.value" @click="search">查询</el-button>
        </div>
      </template>

      <ErrorAlert v-if="listState.error.value" :error="listState.error.value" />

      <el-table v-loading="listState.loading.value" :data="[...entries]" border size="small">
        <el-table-column prop="accountId" label="accountId" min-width="120">
          <template #default="{ row }">
            <span class="qs-mono">{{ row.accountId }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="tier" label="档位" min-width="110" />
        <el-table-column label="生效时间" min-width="170">
          <template #default="{ row }">{{ formatTime(row.from) }}</template>
        </el-table-column>
        <el-table-column label="到期时间" min-width="170">
          <template #default="{ row }">
            <span :class="{ 'text-danger': isExpired(row) }">{{ formatTime(row.to) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="授予人" min-width="110">
          <template #default="{ row }">
            <span class="qs-mono">{{ row.grantedBy }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="reason" label="原因" min-width="180" />
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag :type="row.active ? 'success' : 'info'" size="small">
              {{ row.active ? '生效中' : '已结束' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="130" fixed="right">
          <template #default="{ row }">
            <el-button v-if="canManage" link type="warning" @click="openManage(row)">变更档位</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-empty v-if="!listState.loading.value && entries.length === 0 && listState.error.value === undefined"
        description="服务端未返回任何订阅记录" />

      <div class="qs-pager">
        <el-pagination :current-page="Math.floor(offset / PAGE_SIZE) + 1" :page-size="PAGE_SIZE" :total="total"
          layout="total, prev, pager, next" @current-change="changePage" />
      </div>
    </el-card>

    <el-card class="qs-card" shadow="never">
      <template #header>
        <div class="card-head">
          <span>档位目录（只读）</span>
          <span v-if="tiersState.data.value" class="source">
            source：<span class="qs-mono">{{ tiersState.data.value.source }}</span>
          </span>
        </div>
      </template>

      <ErrorAlert v-if="tiersState.error.value" :error="tiersState.error.value" />

      <el-table v-loading="tiersState.loading.value" :data="tiersState.data.value ? [...tiersState.data.value.tiers] : []"
        border size="small">
        <el-table-column prop="id" label="档位 id" min-width="140">
          <template #default="{ row }">
            <span class="qs-mono">{{ row.id }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="label" label="名称" min-width="140" />
        <el-table-column label="每月 SP" min-width="120" align="right">
          <template #default="{ row }">{{ formatNumber(row.monthlySp) }}</template>
        </el-table-column>
        <el-table-column label="价格" min-width="120" align="right">
          <template #default="{ row }">{{ formatCny(row.priceCny) }}</template>
        </el-table-column>
      </el-table>
      <el-empty v-if="tiersState.data.value && tiersState.data.value.tiers.length === 0"
        description="服务端返回的档位目录为空" />
    </el-card>

    <el-alert v-if="spReceipt" :title="spReceipt" type="info" :closable="false" />
    <SpMoneyDialog v-model="manageOpen" action="subscription" :account-id="manageTarget" :tier="manageTier"
      :tiers="tiersState.data.value?.tiers ?? []" @receipt="value => spReceipt = value" @applied="search" />
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

.search {
  max-width: 280px;
}

.source {
  color: #909399;
  font-size: 12px;
}

.text-danger {
  color: #f56c6c;
}

.actions {
  display: flex;
  gap: 8px;
}
</style>
