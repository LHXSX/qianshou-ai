<script setup lang="ts">
/** Account snapshots are read locally; confirmed SP changes execute through the workbench owner. */
import { computed, onMounted, ref, watch } from 'vue'
import { formatNumber, formatSignedSp, formatTime } from '@/utils/format'
import {
  fetchAccountDetail,
  fetchAccountLedger,
  fetchAccountList,
} from '@/api/modules/accounts'
import { useAccountData } from '@/utils/workbench-read-state'
import type { AccountRow, LedgerRow } from '@/api/types'
import ErrorAlert from '@/components/ErrorAlert.vue'
import SpMoneyDialog from '@/components/SpMoneyDialog.vue'
import { session } from '@/session/store'

const PAGE_SIZE = 20

const query = ref('')
const offset = ref(0)

const listState = useAccountData(() => fetchAccountList(query.value.trim(), PAGE_SIZE, offset.value))

const accounts = computed<readonly AccountRow[]>(() => listState.data.value?.accounts ?? [])
const total = computed(() => listState.data.value?.total ?? 0)

onMounted(() => {
  void listState.run()
})

function search(): void {
  offset.value = 0
  void listState.run()
}

function changePage(page: number): void {
  offset.value = (page - 1) * PAGE_SIZE
  void listState.run()
}

// —— 详情抽屉 ——————————————————————————————————————————————

const drawerOpen = ref(false)
const drawerAccountId = ref('')
const detailState = useAccountData(() => fetchAccountDetail(drawerAccountId.value))
const ledgerOffset = ref(0)
const ledgerState = useAccountData(() => fetchAccountLedger(drawerAccountId.value, PAGE_SIZE, ledgerOffset.value))

const ledgerRows = computed<readonly LedgerRow[]>(() => ledgerState.data.value?.entries ?? [])
const ledgerTotal = computed(() => ledgerState.data.value?.total ?? 0)
const reservations = computed(() => detailState.data.value?.reservations ?? [])

function openDetail(row: AccountRow): void {
  drawerAccountId.value = row.accountId
  ledgerOffset.value = 0
  drawerOpen.value = true
  void detailState.run()
  void ledgerState.run()
}

function changeLedgerPage(page: number): void {
  ledgerOffset.value = (page - 1) * PAGE_SIZE
  void ledgerState.run()
}

// —— Confirmed workbench adjustment ———————————————————————————————
const adjustOpen = ref(false)
const adjustTarget = ref('')
const spReceipt = ref('')
const canAdjust = computed(() => session.permissions.includes('account.charge.adjust') && session.admin?.scope === 'all')
function openAdjust(row?: AccountRow): void {
  adjustTarget.value = row?.accountId ?? drawerAccountId.value
  adjustOpen.value = true
}
function adjusted(): void {
  void listState.run()
  if (drawerOpen.value) { void detailState.run(); void ledgerState.run() }
}
watch(() => session.admin?.accountId, () => { adjustOpen.value = false; drawerOpen.value = false; drawerAccountId.value = ''; adjustTarget.value = ''; spReceipt.value = '' })
</script>

<template>
  <div class="qs-page">
    <div class="qs-page__head">
      <div>
        <h2 class="qs-page__title">账号与额度</h2>
        <p class="qs-page__desc">
          额度、调用次数与流水来自账本快照。SP 调整先查询工作台实时预览，再确认执行；结果不确定时按原操作号核查。
        </p>
      </div>
      <el-button v-if="canAdjust" type="warning" plain @click="openAdjust()">异常扣费处理</el-button>
    </div>

    <el-card class="qs-card" shadow="never">
      <template #header>
        <div class="card-head">
          <el-input v-model="query" placeholder="按 accountId 查询（留空为全部）" clearable class="search"
            @keyup.enter="search" />
          <el-button type="primary" :loading="listState.loading.value" @click="search">查询</el-button>
        </div>
      </template>

      <ErrorAlert v-if="listState.error.value" :error="listState.error.value" />

      <el-table v-loading="listState.loading.value" :data="[...accounts]" border size="small">
        <el-table-column prop="accountId" label="accountId" min-width="120">
          <template #default="{ row }">
            <span class="qs-mono">{{ row.accountId }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="tier" label="档位" min-width="100" />
        <el-table-column label="授予 SP" min-width="110" align="right">
          <template #default="{ row }">{{ formatNumber(row.grantedSp) }}</template>
        </el-table-column>
        <el-table-column label="已用 SP" min-width="110" align="right">
          <template #default="{ row }">{{ formatNumber(row.usedSp) }}</template>
        </el-table-column>
        <el-table-column label="剩余 SP" min-width="110" align="right">
          <template #default="{ row }">
            <span :class="{ 'text-danger': typeof row.remainingSp === 'number' && row.remainingSp < 0 }">
              {{ formatNumber(row.remainingSp) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="调用次数" min-width="100" align="right">
          <template #default="{ row }">{{ formatNumber(row.callCount) }}</template>
        </el-table-column>
        <el-table-column label="最近调用" min-width="170">
          <template #default="{ row }">{{ formatTime(row.lastCallAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="160" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openDetail(row)">详情</el-button>
            <el-button v-if="canAdjust" link type="warning" @click="openAdjust(row)">异常扣费处理</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-empty v-if="!listState.loading.value && accounts.length === 0 && listState.error.value === undefined"
        description="服务端未返回任何账号" />

      <div class="qs-pager">
        <el-pagination :current-page="Math.floor(offset / PAGE_SIZE) + 1" :page-size="PAGE_SIZE"
          :total="total" layout="total, prev, pager, next" @current-change="changePage" />
      </div>
    </el-card>

    <el-drawer v-model="drawerOpen" :title="`账号 ${drawerAccountId}`" size="640px">
      <ErrorAlert v-if="detailState.error.value" :error="detailState.error.value" />

      <el-descriptions v-if="detailState.data.value" :column="2" border size="small" class="qs-card">
        <el-descriptions-item label="accountId">
          <span class="qs-mono">{{ detailState.data.value.account.accountId }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="档位">{{ detailState.data.value.account.tier }}</el-descriptions-item>
        <el-descriptions-item label="授予 SP">{{ formatNumber(detailState.data.value.account.grantedSp) }}</el-descriptions-item>
        <el-descriptions-item label="已用 SP">{{ formatNumber(detailState.data.value.account.usedSp) }}</el-descriptions-item>
        <el-descriptions-item label="剩余 SP">{{ formatNumber(detailState.data.value.account.remainingSp) }}</el-descriptions-item>
        <el-descriptions-item label="调用次数">{{ formatNumber(detailState.data.value.account.callCount) }}</el-descriptions-item>
        <el-descriptions-item label="最近调用" :span="2">{{ formatTime(detailState.data.value.account.lastCallAt) }}</el-descriptions-item>
      </el-descriptions>

      <el-divider content-position="left">预留（reservations）</el-divider>
      <p v-if="reservations.length === 0" class="qs-empty-hint">
        服务端返回的 reservations 为空数组，说明当前没有预留中的额度。
      </p>
      <el-table v-else :data="[...reservations]" size="small" border>
        <el-table-column v-for="key in Object.keys(reservations[0] ?? {})" :key="key" :prop="key" :label="key" />
      </el-table>

      <el-divider content-position="left">额度流水（account/ledger）</el-divider>
      <ErrorAlert v-if="ledgerState.error.value" :error="ledgerState.error.value" />
      <el-table v-loading="ledgerState.loading.value" :data="[...ledgerRows]" size="small" border>
        <el-table-column label="时间" min-width="170">
          <template #default="{ row }">{{ formatTime(row.at) }}</template>
        </el-table-column>
        <el-table-column prop="model" label="模型" min-width="140">
          <template #default="{ row }">
            <span class="qs-mono">{{ row.model }}</span>
          </template>
        </el-table-column>
        <el-table-column label="输入 tokens" min-width="110" align="right">
          <template #default="{ row }">{{ formatNumber(row.inputTokens) }}</template>
        </el-table-column>
        <el-table-column label="输出 tokens" min-width="110" align="right">
          <template #default="{ row }">{{ formatNumber(row.outputTokens) }}</template>
        </el-table-column>
        <el-table-column label="SP" min-width="100" align="right">
          <template #default="{ row }">
            <span :class="typeof row.sp === 'number' && row.sp < 0 ? 'text-danger' : ''">{{ formatSignedSp(row.sp) }}</span>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!ledgerState.loading.value && ledgerRows.length === 0 && ledgerState.error.value === undefined"
        description="服务端未返回流水记录" />
      <div class="qs-pager">
        <el-pagination :current-page="Math.floor(ledgerOffset / PAGE_SIZE) + 1" :page-size="PAGE_SIZE"
          :total="ledgerTotal" layout="total, prev, pager, next" @current-change="changeLedgerPage" />
      </div>

      <template #footer>
        <el-button v-if="canAdjust" type="warning" plain @click="openAdjust()">异常扣费处理</el-button>
      </template>
    </el-drawer>

    <el-alert v-if="spReceipt" :title="spReceipt" type="info" :closable="false" />
    <SpMoneyDialog v-model="adjustOpen" action="adjustment" :account-id="adjustTarget"
      @receipt="value => spReceipt = value" @applied="adjusted" />
  </div>
</template>

<style scoped>
.card-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

.search {
  max-width: 280px;
}

.text-danger {
  color: #f56c6c;
  font-weight: 600;
}

.adjust-form {
  margin-bottom: 8px;
}

.adjust-form__hint {
  margin-left: 10px;
  color: #909399;
  font-size: 12px;
}
</style>
