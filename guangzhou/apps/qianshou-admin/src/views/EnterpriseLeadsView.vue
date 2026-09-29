<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { getEnterpriseLead, listEnterpriseLeads, type EnterpriseLeadSummary } from '@/api/modules/enterprise-leads'
import { session } from '@/session/store'
import { useAsyncData } from '@/utils/async-state'
import ErrorAlert from '@/components/ErrorAlert.vue'

const PAGE_SIZE = 30
const offset = ref(0)
const selectedId = ref<number>()
const drawerOpen = ref(false)
const listState = useAsyncData(() => listEnterpriseLeads(offset.value, PAGE_SIZE))
const detailState = useAsyncData(() => getEnterpriseLead(selectedId.value ?? 0))
const items = computed(() => listState.data.value?.items ?? [])
const total = computed(() => listState.data.value?.total ?? 0)
const selected = computed(() => {
  const lead = detailState.data.value?.lead
  return lead?.id === selectedId.value ? lead : undefined
})

function formatDate(value: string | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false })
}

function label(value: string | undefined): string { return value?.trim() || '未填写' }
const useCases: Record<string, string> = {
  '3d-render': '3D 渲染 / 视频转码',
  'ai-inference': 'AI 推理 / 数据标注',
  'data-eng': '数据 ETL / 清洗',
  research: '科研 / 学术计算',
  other: '其他',
}
const budgets: Record<string, string> = {
  'lt-1k': '小于 ¥1,000 / 月',
  '1k-5k': '¥1,000–5,000 / 月',
  '5k-30k': '¥5,000–30,000 / 月',
  '30k+': '¥30,000 以上 / 月',
}
const statuses: Record<string, string> = { new: '新申请' }
function named(value: string | undefined, names: Record<string, string>): string { return value ? names[value] ?? value : '未填写' }
function openDetail(row: EnterpriseLeadSummary): void {
  selectedId.value = row.id
  drawerOpen.value = true
  void detailState.run()
}
function page(delta: number): void {
  offset.value = Math.max(0, offset.value + delta)
  drawerOpen.value = false
  selectedId.value = undefined
  void listState.run()
}

onMounted(() => { if (session.admin && session.permissions.includes('enterprise.read')) void listState.run() })
watch(() => session.admin?.accountId, (now, previous) => {
  if (now === previous) return
  drawerOpen.value = false
  selectedId.value = undefined
  listState.data.value = undefined
  detailState.data.value = undefined
  if (now && session.permissions.includes('enterprise.read')) void listState.run()
})
</script>

<template>
  <section class="leads-page qs-page">
    <header class="qs-page__head">
      <div>
        <p class="leads-page__eyebrow">官网 · Beta Program</p>
        <h1 class="qs-page__title">企业咨询</h1>
        <p class="qs-page__desc">查看官网收到的申请及联系信息。这里仅供查阅，后续沟通与合作安排以正式回复为准。</p>
      </div>
      <el-button :loading="listState.loading.value" @click="listState.run()">刷新列表</el-button>
    </header>

    <ErrorAlert v-if="listState.error.value" :error="listState.error.value" />
    <div v-if="!listState.error.value" class="leads-page__surface">
      <div class="leads-page__summary">
        <div><span class="leads-page__caption">咨询记录</span><strong>{{ total }}</strong></div>
        <span class="leads-page__page">第 {{ Math.floor(offset / PAGE_SIZE) + 1 }} 页 · 每页 {{ PAGE_SIZE }} 条</span>
      </div>
      <el-table v-loading="listState.loading.value" :data="items" empty-text="目前没有企业咨询记录" class="leads-page__table">
        <el-table-column label="收到时间" min-width="170"><template #default="scope">{{ formatDate(scope.row.created_at) }}</template></el-table-column>
        <el-table-column prop="company" label="公司 / 团队" min-width="220" show-overflow-tooltip />
        <el-table-column prop="contact" label="联系人" min-width="130" show-overflow-tooltip />
        <el-table-column prop="phone" label="联系方式" min-width="200" show-overflow-tooltip />
        <el-table-column label="需求方向" min-width="160"><template #default="scope">{{ named(scope.row.use_case, useCases) }}</template></el-table-column>
        <el-table-column label="状态" min-width="100"><template #default="scope"><el-tag size="small" effect="plain">{{ named(scope.row.status, statuses) }}</el-tag></template></el-table-column>
        <el-table-column label="" width="92" fixed="right"><template #default="scope"><el-button link type="primary" @click="openDetail(scope.row)">查看详情</el-button></template></el-table-column>
      </el-table>
      <footer class="leads-page__footer">
        <span>共 {{ total }} 条</span>
        <div><el-button :disabled="offset === 0 || listState.loading.value" @click="page(-PAGE_SIZE)">上一页</el-button><el-button :disabled="offset + PAGE_SIZE >= total || listState.loading.value" @click="page(PAGE_SIZE)">下一页</el-button></div>
      </footer>
    </div>

    <el-drawer v-model="drawerOpen" title="企业咨询详情" size="min(560px, 100%)" append-to-body>
      <ErrorAlert v-if="detailState.error.value" :error="detailState.error.value" />
      <div v-loading="detailState.loading.value" class="leads-page__detail">
        <template v-if="selected">
          <div class="leads-page__detail-head"><span>申请 #{{ selected.id }}</span><el-tag size="small" effect="plain">{{ named(selected.status, statuses) }}</el-tag></div>
          <h2>{{ selected.company }}</h2>
          <p class="leads-page__received">收到于 {{ formatDate(selected.created_at) }}</p>
          <dl>
            <div><dt>联系人</dt><dd>{{ selected.contact }}</dd></div>
            <div><dt>联系方式</dt><dd>{{ selected.phone }}</dd></div>
            <div><dt>团队规模</dt><dd>{{ label(selected.size) }}</dd></div>
            <div><dt>需求方向</dt><dd>{{ named(selected.use_case, useCases) }}</dd></div>
            <div><dt>预计预算</dt><dd>{{ named(selected.budget, budgets) }}</dd></div>
            <div><dt>提交时间</dt><dd>{{ formatDate(selected.submitted_at) }}</dd></div>
          </dl>
          <section class="leads-page__note"><h3>需求说明</h3><p>{{ label(selected.note) }}</p></section>
          <p class="leads-page__meta">来源：{{ selected.source }} · 来源 IP：{{ selected.source_ip || '未记录' }}</p>
        </template>
      </div>
    </el-drawer>
  </section>
</template>

<style scoped>
.leads-page { max-width: 1320px; margin: 0 auto; }
.leads-page__eyebrow { margin: 0 0 8px; color: var(--el-color-primary); font-size: 12px; font-weight: 700; letter-spacing: .08em; }
.leads-page__surface { overflow: hidden; border: 1px solid var(--el-border-color-light); border-radius: 14px; background: var(--el-bg-color); }
.leads-page__summary, .leads-page__footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 20px; }
.leads-page__summary { border-bottom: 1px solid var(--el-border-color-lighter); }
.leads-page__summary > div { display: flex; align-items: baseline; gap: 12px; }
.leads-page__summary strong { font-size: 24px; line-height: 1; font-variant-numeric: tabular-nums; }
.leads-page__caption, .leads-page__page, .leads-page__footer, .leads-page__received, .leads-page__meta { color: var(--el-text-color-secondary); font-size: 13px; }
.leads-page__table { width: 100%; }
.leads-page__footer { border-top: 1px solid var(--el-border-color-lighter); }
.leads-page__detail-head { display: flex; align-items: center; justify-content: space-between; color: var(--el-text-color-secondary); font-size: 12px; }
.leads-page__detail h2 { margin: 16px 0 4px; font-size: 22px; }
.leads-page__detail dl { margin: 28px 0; border-top: 1px solid var(--el-border-color-lighter); }
.leads-page__detail dl > div { display: grid; grid-template-columns: 96px minmax(0,1fr); gap: 16px; padding: 13px 0; border-bottom: 1px solid var(--el-border-color-lighter); }
.leads-page__detail dt { color: var(--el-text-color-secondary); }
.leads-page__detail dd { margin: 0; overflow-wrap: anywhere; }
.leads-page__note { padding: 16px; border-radius: 10px; background: var(--el-fill-color-light); }
.leads-page__note h3 { margin: 0 0 8px; font-size: 14px; }
.leads-page__note p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.65; }
.leads-page__meta { margin-top: 20px; overflow-wrap: anywhere; }
@media (max-width: 700px) { .leads-page__summary, .leads-page__footer { padding: 14px; } .leads-page__page { display: none; } }
</style>
