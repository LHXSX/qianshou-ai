<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { listMarketplaceReviews, moderateMarketplaceReview, reviewAuthorityHint, shanghaiReviewWritable, type MarketplaceReviewItem } from '@/api/modules/marketplace'
import { session } from '@/session/store'
import { useAsyncData } from '@/utils/async-state'
import ErrorAlert from '@/components/ErrorAlert.vue'
import OrderPublicationManagementPanel from '@/components/OrderPublicationManagementPanel.vue'
import OrderPublicationReviewPanel from '@/components/OrderPublicationReviewPanel.vue'
import OrderAdapterProductReviewPanel from '@/components/OrderAdapterProductReviewPanel.vue'

const mode = ref<'order' | 'order-product' | 'product' | 'manage'>('order')
const listState = useAsyncData(() => listMarketplaceReviews(50))
const items = computed(() => listState.data.value?.items ?? [])
const countLabel = computed(() => listState.loading.value ? '读取中' : listState.error.value ? '读取失败，数量未知'
  : !listState.loaded.value || !listState.data.value ? '尚未读取' : String(items.value.length))
const selected = ref<MarketplaceReviewItem>()
const note = ref('')
const acting = ref(false)
const actionError = ref('')
const localCanReview = computed(() => session.permissions.includes('market.review') && session.admin?.scope === 'all')
const shanghaiCanReview = computed(() => !listState.error.value && shanghaiReviewWritable(listState.data.value))
const canReview = computed(() => localCanReview.value && shanghaiCanReview.value)
const validNote = computed(() => note.value.trim().length >= 4 && note.value.trim().length <= 500)
const reviewPermissionHint = computed(() => localCanReview.value
  ? reviewAuthorityHint(listState.data.value)
  : '当前广州管理员账号缺少 market.review 权限或全部数据范围，不能提交审核。')

function open(item: MarketplaceReviewItem): void { selected.value = item; note.value = ''; actionError.value = '' }
function close(): void { selected.value = undefined; note.value = ''; actionError.value = '' }
function price(item: MarketplaceReviewItem): string {
  if (item.pricing_model === 'free' || Number(item.price ?? 0) === 0) return '免费'
  const amount = Number(item.price)
  return Number.isFinite(amount) ? `${amount.toFixed(2)} 元` : '待核价'
}
function kind(value: string | undefined): string {
  return ({ webview: '网页应用', plugin: '本机插件', workload: '接单任务', deep_link: '外部入口' } as Record<string, string>)[value ?? ''] ?? '未分类'
}
async function review(action: 'approve' | 'reject'): Promise<void> {
  const item = selected.value
  const reason = note.value.trim()
  if (!item || acting.value || !canReview.value || item.status !== 'review') return
  if (reason.length < 4 || reason.length > 500) { actionError.value = '请填写 4–500 字审核原因。'; return }
  if (action === 'approve' && (!item.can_approve || item.review_issues.length)) {
    actionError.value = '平台仍有阻断项，不能审核通过。'; return
  }
  try {
    await ElMessageBox.confirm(`${action === 'approve' ? '通过' : '驳回'}“${item.name}”？本次审核会写入中央服务器与广州审计。`,
      '确认审核', { confirmButtonText: '确认提交', cancelButtonText: '返回', type: action === 'approve' ? 'warning' : 'info' })
  } catch { return }
  acting.value = true
  actionError.value = ''
  try {
    const result = await moderateMarketplaceReview(item.id, action, reason)
    ElMessage.success(`${result.item.name} 已${action === 'approve' ? '通过' : '驳回'}审核`)
    close()
    await listState.run()
  } catch (error) { actionError.value = error instanceof Error ? error.message : '审核结果不确定，请刷新队列核对。' }
  finally { acting.value = false }
}

onMounted(() => { if (mode.value === 'product' && session.admin && session.permissions.includes('market.read')) void listState.run() })
watch(mode, value => { if (value === 'product' && session.admin && session.permissions.includes('market.read')) void listState.run() })
watch(() => session.admin?.accountId, (current, previous) => {
  if (current === previous) return
  close(); listState.data.value = undefined
  if (current && mode.value === 'product' && session.permissions.includes('market.read')) void listState.run()
})
</script>

<template>
  <section class="market-page qs-page">
    <header class="qs-page__head">
      <div>
        <p class="market-page__eyebrow">广州管理员入口 · 中央服务器审核队列</p>
        <h1 class="qs-page__title">插件市场审核</h1>
        <p class="qs-page__desc">平台自动核验技能包、样例和价格；广州审核一次，通过后自动发布到技能市场。</p>
      </div>
      <el-button v-if="mode === 'product'" :loading="listState.loading.value" @click="listState.run()">刷新商品待审</el-button>
    </header>
    <ol class="market-page__flow" aria-label="接单技能审核流程">
      <li><span>01</span><div><strong>核验接单技能</strong><p>检查发布包、适用任务的媒体结果、人民币价格和独立审查回执。</p></div></li>
      <li><span>02</span><div><strong>广州审核一次</strong><p>核验完成后点击通过；平台自动验签，广州保存审计记录。驳回时填写原因。</p></div></li>
      <li><span>03</span><div><strong>自动发布到市场</strong><p>包含售价的新投稿通过后自动上架；用户下载后可自用，或开启接单。旧投稿可在商品管理补充上架。</p></div></li>
    </ol>
    <div class="market-page__tabs" role="tablist" aria-label="审核类型">
      <button type="button" role="tab" :aria-selected="mode === 'order'" :class="{ active: mode === 'order' }" @click="mode = 'order'">接单技能审核</button>
      <button type="button" role="tab" :aria-selected="mode === 'manage'" :class="{ active: mode === 'manage' }" @click="mode = 'manage'">发布记录管理</button>
      <button type="button" role="tab" :aria-selected="mode === 'order-product'" :class="{ active: mode === 'order-product' }" @click="mode = 'order-product'">历史商品管理</button>
      <button type="button" role="tab" :aria-selected="mode === 'product'" :class="{ active: mode === 'product' }" @click="mode = 'product'">插件商品审核</button>
    </div>
    <OrderPublicationManagementPanel v-if="mode === 'manage'" />
    <OrderPublicationReviewPanel v-if="mode === 'order'" />
    <OrderAdapterProductReviewPanel v-if="mode === 'order-product'" />
    <ErrorAlert v-if="mode === 'product' && listState.error.value" :error="listState.error.value" />
    <el-alert v-if="mode === 'product' && listState.data.value && !shanghaiCanReview"
      :title="reviewAuthorityHint(listState.data.value)" type="warning" show-icon :closable="false" class="market-page__access" />
    <div v-if="mode === 'product'" class="market-page__surface">
      <div class="market-page__summary"><strong>待审核投稿：{{ countLabel }}</strong><span>数据来自中央服务器 · 审核留痕</span></div>
      <el-table v-if="!listState.error.value" v-loading="listState.loading.value" :data="items" empty-text="目前没有待审核投稿" class="market-page__table">
        <el-table-column prop="name" label="名称" min-width="210" show-overflow-tooltip />
        <el-table-column label="类型" min-width="110"><template #default="scope">{{ kind(scope.row.launch_kind) }}</template></el-table-column>
        <el-table-column prop="author_name" label="作者" min-width="130" show-overflow-tooltip />
        <el-table-column label="售价" min-width="105"><template #default="scope">{{ price(scope.row) }}</template></el-table-column>
        <el-table-column label="审核条件" min-width="140"><template #default="scope">
          <el-tag :type="shanghaiCanReview && scope.row.can_approve && !scope.row.review_issues.length ? 'success' : 'warning'" effect="plain" size="small">
            {{ !shanghaiCanReview ? '仅可查看队列' : scope.row.can_approve && !scope.row.review_issues.length ? '可审核' : `${scope.row.review_issues.length} 项待补` }}
          </el-tag>
        </template></el-table-column>
        <el-table-column label="操作" width="112" fixed="right"><template #default="scope"><el-button link type="primary" @click="open(scope.row)">查看审核</el-button></template></el-table-column>
      </el-table>
    </div>
    <el-drawer v-if="mode === 'product'" :model-value="selected !== undefined" title="审核投稿" size="min(620px, 100%)" append-to-body @close="close">
      <div v-if="selected" class="market-page__detail">
        <p class="market-page__meta">投稿 #{{ selected.id }} · {{ kind(selected.launch_kind) }} · {{ price(selected) }}</p>
        <h2>{{ selected.name }}</h2>
        <p>{{ selected.summary || '作者没有填写简介。' }}</p>
        <dl>
          <div><dt>作者</dt><dd>{{ selected.author_name || '未填写' }}</dd></div>
          <div><dt>分类</dt><dd>{{ selected.category || '未分类' }}</dd></div>
          <div><dt>任务类型</dt><dd>{{ selected.task_type || '非任务应用' }}</dd></div>
          <div><dt>版本摘要</dt><dd class="market-page__digest">{{ selected.sha256 || '未提交' }}</dd></div>
        </dl>
        <section class="market-page__issues">
          <h3>平台审核条件</h3>
          <p v-if="!selected.review_issues.length">当前没有阻断项；最终以中央服务器返回的状态为准。</p>
          <ul v-else><li v-for="issue in selected.review_issues" :key="issue">{{ issue }}</li></ul>
        </section>
        <label class="market-page__label" for="market-review-note">审核原因</label>
        <el-input id="market-review-note" v-model="note" type="textarea" :rows="4" maxlength="500" show-word-limit
          :disabled="!canReview" placeholder="说明通过或驳回的依据，至少 4 个字" />
        <el-alert v-if="!canReview" :title="reviewPermissionHint" type="warning" show-icon :closable="false" class="market-page__error" />
        <el-alert v-if="actionError" :title="actionError" type="error" show-icon :closable="false" class="market-page__error" />
        <div class="market-page__actions">
          <el-button :disabled="!canReview || selected.status !== 'review' || acting" :loading="acting" @click="review('reject')">驳回投稿</el-button>
          <el-button type="primary" :disabled="!canReview || selected.status !== 'review' || !validNote || !selected.can_approve || !!selected.review_issues.length || acting"
            :loading="acting" @click="review('approve')">通过审核</el-button>
        </div>
      </div>
    </el-drawer>
  </section>
</template>

<style scoped>
.market-page { max-width: 1320px; margin: 0 auto; }
.market-page__eyebrow { margin: 0 0 8px; color: var(--el-color-primary); font-size: 12px; font-weight: 700; letter-spacing: .06em; }
.market-page__surface { overflow: hidden; border: 1px solid var(--el-border-color-light); border-radius: 14px; background: var(--el-bg-color); }
.market-page__access { margin-bottom: 14px; }
.market-page__flow { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; list-style: none; padding: 0; margin: 0 0 18px; }
.market-page__flow li { display: flex; gap: 12px; min-width: 0; padding: 14px 16px; border: 1px solid var(--el-border-color-light); border-radius: 12px; background: var(--el-bg-color); }
.market-page__flow li > span { color: var(--el-color-primary); font-weight: 700; font-size: 13px; }
.market-page__flow strong { font-size: 14px; }
.market-page__flow p { margin: 4px 0 0; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.5; }
.market-page__tabs { display: flex; gap: 8px; margin: 0 0 16px; }
.market-page__tabs button { border: 1px solid var(--el-border-color); border-radius: 9px; background: var(--el-bg-color); color: var(--el-text-color-secondary); cursor: pointer; padding: 9px 15px; font: inherit; }
.market-page__tabs button.active { color: var(--el-color-primary); border-color: var(--el-color-primary); font-weight: 700; }
.market-page__summary { display: flex; justify-content: space-between; gap: 16px; padding: 18px 20px; border-bottom: 1px solid var(--el-border-color-lighter); color: var(--el-text-color-secondary); font-size: 13px; }
.market-page__summary strong { color: var(--el-text-color-primary); font-size: 16px; }
.market-page__table { width: 100%; }
.market-page__detail h2 { margin: 8px 0 18px; }
.market-page__meta { color: var(--el-text-color-secondary); font-size: 13px; }
.market-page__detail dl { margin: 20px 0; border-top: 1px solid var(--el-border-color-lighter); }
.market-page__detail dl > div { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 16px; padding: 11px 0; border-bottom: 1px solid var(--el-border-color-lighter); }
.market-page__detail dt { color: var(--el-text-color-secondary); }
.market-page__detail dd { margin: 0; overflow-wrap: anywhere; }
.market-page__digest { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; }
.market-page__issues { padding: 16px; background: var(--el-fill-color-light); border-radius: 10px; }
.market-page__issues h3 { margin: 0 0 10px; font-size: 14px; }
.market-page__issues ul { margin: 0; padding-left: 20px; line-height: 1.7; }
.market-page__label { display: block; margin: 20px 0 8px; font-weight: 600; }
.market-page__error { margin-top: 12px; }
.market-page__actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
@media (max-width: 900px) { .market-page__flow { grid-template-columns: 1fr; } }
@media (max-width: 700px) { .market-page__summary { flex-direction: column; padding: 14px; } }
</style>
