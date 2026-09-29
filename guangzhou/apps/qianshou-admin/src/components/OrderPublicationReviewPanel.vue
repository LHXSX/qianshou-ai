<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { reviewOrderPublication, reviewAuthorityHint, shanghaiReviewWritable, type OrderPublicationReviewItem } from '@/api/modules/marketplace'
import { session } from '@/session/store'
import { usePublicationReviewRefresh } from '@/utils/publication-review-refresh'
import ErrorAlert from '@/components/ErrorAlert.vue'

const busy = ref(false)
const state = usePublicationReviewRefresh({
  owner: () => session.admin?.accountId,
  canRead: () => session.permissions.includes('market.read'),
  paused: () => busy.value,
})
const items = computed(() => state.data.value?.items ?? [])
const countLabel = computed(() => state.loading.value ? '读取中' : state.error.value ? '读取失败，数量未知'
  : !state.loaded.value || !state.data.value ? '尚未读取' : String(items.value.length))
const selected = ref<OrderPublicationReviewItem>()
const note = ref('')
const actionError = ref('')
const localCanReview = computed(() => session.permissions.includes('market.review') && session.admin?.scope === 'all')
const shanghaiCanReview = computed(() => !state.error.value && shanghaiReviewWritable(state.data.value))
const canReview = computed(() => localCanReview.value && shanghaiCanReview.value)
const reviewPermissionHint = computed(() => localCanReview.value
  ? reviewAuthorityHint(state.data.value)
  : '当前广州管理员账号缺少 market.review 权限或全部数据范围，不能提交审核。')
function taskName(taskType: string): string {
  return ({ bar_chart_svg_v1: 'SVG 图表转视频', word_count: '文字统计' } as Record<string, string>)[taskType]
    ?? taskType
}
const evidenceNames: Record<string, { title: string; owner: string; detail: string }> = {
  package: { title: '技能包来源与验包', owner: '广州验包服务', detail: '锁定安装包，核对作者签名、不可变归档与执行版本。' },
  sample: { title: '隔离执行样本核验', owner: '广州隔离执行服务', detail: '实际运行同一锁定版本并核对样本结构；结构核验不代表结果语义已获买方认可。' },
  media: { title: '媒体结果独立核验', owner: '广州媒体核验服务', detail: '核对订单绑定的 GIF、MP4 实际输出与完整动效。' },
  pricing: { title: '人民币服务端定价', owner: '中央服务器定价服务', detail: '核对任务价目、投稿报价与价格配置版本。' },
  review: { title: '独立安全与合同审查', owner: '独立审查服务', detail: '核对技能安全、任务合同与署名审查回执。' },
}
const evidence = computed(() => {
  const item = selected.value
  return (item?.required_evidence ?? []).map(kind => ({
    kind,
    title: evidenceNames[kind]?.title ?? `其他受信回执：${kind}`,
    owner: evidenceNames[kind]?.owner ?? '平台受信服务',
    detail: evidenceNames[kind]?.detail ?? '请由平台受信服务核实并回传此项回执。',
    status: item?.evidence_status?.[kind] ?? 'missing',
  }))
})
const pendingEvidence = computed(() => evidence.value.filter(entry => entry.status !== 'valid'))
const platformIssues = computed(() => (selected.value?.review_reasons ?? [])
  .filter(reason => {
    const kind = /^(package|sample|media|pricing|review):\s/.exec(reason)?.[1]
    return !kind || selected.value?.evidence_status?.[kind] === 'valid'
  })
  .map(reason => reason.replace(/^(package|sample|media|pricing|review):\s/, (_prefix, kind: string) =>
    `${evidenceNames[kind]?.title ?? '平台核验'}：`)))
const evidenceReady = computed(() => !!selected.value?.required_evidence?.length
  && evidence.value.every(entry => entry.status === 'valid'))
function approvalReady(item: OrderPublicationReviewItem): boolean {
  return item.status === 'review' && item.can_approve === true && item.review_reasons.length === 0
    && !!item.required_evidence?.length
    && item.required_evidence.every(kind => item.evidence_status?.[kind] === 'valid')
}
const canApprove = computed(() => !!selected.value && selected.value.status === 'review'
  && approvalReady(selected.value) && evidenceReady.value)
function open(item: OrderPublicationReviewItem): void { selected.value = item; note.value = ''; actionError.value = '' }
function close(): void { selected.value = undefined; note.value = ''; actionError.value = '' }
const canSubmitApproval = computed(() => canReview.value && !busy.value && canApprove.value)
watch(state.data, queue => {
  if (selected.value === undefined || busy.value) return
  const latest = queue?.items.find(item => item.id === selected.value?.id)
  if (latest === undefined) close()
  else selected.value = latest
})
async function approve(): Promise<void> {
  const item = selected.value
  if (!item || busy.value) return
  if (!canReview.value || !canApprove.value) {
    actionError.value = '平台受信证据尚未齐备，暂不能审核通过。'; return
  }
  busy.value = true
  actionError.value = ''
  try {
    const result = await reviewOrderPublication(item.id, 'approve', '广州审核员已核对平台真实验证结果，批准技能及本次投稿的售价与安装归档。')
    if (result.item.status !== 'approved') throw new Error('中央服务器未确认审核通过，请刷新队列核对。')
    ElMessage.success(result.item.market_product_status === 'published' ? '技能已审核通过并发布到市场' : '技能已审核通过；旧投稿可在历史商品管理补充上架')
    close(); await state.run()
  } catch (error) { actionError.value = error instanceof Error ? error.message : '审核状态不确定，请刷新队列核对。' }
  finally { busy.value = false }
}
async function reject(): Promise<void> {
  const item = selected.value
  const reason = note.value.trim()
  if (!item || item.status !== 'review' || busy.value || !canReview.value) return
  if (reason.length < 4 || reason.length > 500) { actionError.value = '请填写 4–500 字审核原因。'; return }
  try {
    await ElMessageBox.confirm(`驳回“${item.name}”的接单技能投稿？本次操作会写入中央服务器和广州审计。`,
      '确认驳回', { confirmButtonText: '确认驳回', cancelButtonText: '返回', type: 'warning' })
  } catch { return }
  busy.value = true
  actionError.value = ''
  try {
    await reviewOrderPublication(item.id, 'reject', reason)
    ElMessage.success('已驳回接单技能投稿')
    close(); await state.run()
  } catch (error) { actionError.value = error instanceof Error ? error.message : '审核状态不确定，请刷新队列核对。' }
  finally { busy.value = false }
}
watch(() => session.admin?.accountId, (current, previous) => {
  if (current === previous) return
  close()
})
</script>

<template>
  <div class="order-review">
    <div class="order-review__head">
      <div><strong>接单技能待审：{{ countLabel }}</strong><p>平台服务自动收集并校验发布证据；等待期间本页自动读取进度，条件齐备后由管理员审核。</p></div>
      <el-button :loading="state.loading.value" @click="state.run()">刷新状态</el-button>
    </div>
    <ErrorAlert v-if="state.error.value" :error="state.error.value" />
    <el-alert v-if="state.data.value && !shanghaiCanReview" :title="reviewAuthorityHint(state.data.value)"
      type="warning" show-icon :closable="false" class="order-review__access" />
    <el-table v-if="!state.error.value" v-loading="state.loading.value" :data="items" empty-text="目前没有接单技能投稿">
      <el-table-column prop="name" label="技能名称" min-width="210" show-overflow-tooltip />
      <el-table-column label="接单类型" min-width="170" show-overflow-tooltip><template #default="scope">{{ taskName(scope.row.task_type) }}</template></el-table-column>
      <el-table-column label="商品售价 / 执行价" min-width="130"><template #default="scope">{{ scope.row.sale_price_yuan != null ? scope.row.sale_price_yuan + ' 元 / ' : '' }}{{ scope.row.price_yuan ?? '—' }} 元</template></el-table-column>
      <el-table-column label="审核条件" min-width="130"><template #default="scope">
        <el-tag :type="shanghaiCanReview && approvalReady(scope.row) ? 'success' : 'warning'" effect="plain" size="small">
          {{ !shanghaiCanReview ? '仅可查看队列' : approvalReady(scope.row) ? '可审核' : '等待平台核验' }}
        </el-tag>
      </template></el-table-column>
      <el-table-column label="操作" width="112" fixed="right"><template #default="scope"><el-button link type="primary" @click="open(scope.row)">查看审核</el-button></template></el-table-column>
    </el-table>
    <el-drawer :model-value="selected !== undefined" title="接单技能审核" size="min(760px, 100%)" append-to-body @close="close">
      <div v-if="selected" class="order-review__detail">
        <div class="order-review__status" :class="{ 'order-review__status--ready': canApprove && canReview }">
          <strong>{{ !canReview ? '当前只能查看，不能提交审核' : canApprove ? '已具备审核条件' : '等待平台完成核验' }}</strong>
          <span>{{ !canReview ? reviewPermissionHint : canApprove ? '审核员点击一次通过，平台自动验签并发布本次含售价的技能。' : '证据由平台受信服务生成；审核员无需手工收集或上传回执。' }}</span>
        </div>
        <h2>{{ selected.name }}</h2>
        <p>{{ selected.description || '未填写用途说明。' }}</p>
        <p class="order-review__price">每次执行价：<strong>{{ selected.price_yuan ?? '—' }} 元人民币</strong></p>
        <p v-if="selected.sale_price_yuan != null" class="order-review__price">商品一次买断售价：<strong>{{ selected.sale_price_yuan }} 元人民币</strong>；通过审核后自动上架。</p>
        <section class="order-review__issues">
          <h3>平台待处理事项</h3>
          <p v-if="canApprove">当前核验已完成，审核时平台自动复核同一版本。</p>
          <p v-else-if="!selected.required_evidence?.length">中央服务器未返回必需回执清单。请刷新队列并核对接口，审批保持禁用。</p>
          <p v-else-if="!pendingEvidence.length && !platformIssues.length">中央服务器仍未允许审核，请刷新状态并由平台排查。</p>
          <ul v-if="pendingEvidence.length || platformIssues.length">
            <li v-for="entry in pendingEvidence" :key="entry.kind">{{ entry.owner }}：{{ entry.title }}{{ entry.status === 'invalid' ? '回执无效或超过大小限制，需重新核验' : '等待自动验证回执，尚未完成' }}</li>
            <li v-for="reason in platformIssues" :key="reason">{{ reason }}</li>
          </ul>
        </section>
        <section class="order-review__checks" aria-label="平台核验进度">
          <div class="order-review__checks-head"><h3>平台核验进度</h3><span>由相应服务生成回执</span></div>
          <div v-for="entry in evidence" :key="entry.kind" class="order-review__check">
            <div class="order-review__check-title">
              <strong>{{ entry.title }}</strong>
              <el-tag :type="entry.status === 'valid' ? 'success' : entry.status === 'invalid' ? 'danger' : 'warning'" effect="plain" size="small">
                {{ entry.status === 'valid' ? '已核验' : entry.status === 'invalid' ? '回执无效，需重新核验' : '等待自动验证回执' }}
              </el-tag>
            </div>
            <p>{{ entry.owner }} · {{ entry.detail }}</p>
          </div>
        </section>
        <details class="order-review__technical">
          <summary>查看投稿与验签详情</summary>
          <dl>
            <div><dt>受理编号</dt><dd><code>{{ selected.id }}</code></dd></div>
            <div><dt>提交账号</dt><dd>{{ selected.owner_id }}</dd></div>
            <div><dt>任务类型</dt><dd>{{ selected.task_type }}</dd></div>
            <div><dt>结果类型</dt><dd>{{ selected.output_kind || '未声明' }}</dd></div>
            <div><dt>分类</dt><dd>{{ selected.category || '未分类' }}</dd></div>
            <div><dt>执行摘要</dt><dd><code>{{ selected.artifact_digest || '未提交' }}</code></dd></div>
          </dl>
          <h3>中央服务器原始阻断信息</h3>
          <p v-if="!selected.review_reasons.length">当前无阻断项。</p>
          <ul v-else><li v-for="reason in selected.review_reasons" :key="reason">{{ reason }}</li></ul>
        </details>
        <label for="order-review-note">驳回原因（仅驳回时填写）</label>
        <el-input id="order-review-note" v-model="note" type="textarea" :rows="3" maxlength="500" show-word-limit
          :disabled="!canReview" placeholder="需驳回时填写至少 4 字原因；审核通过无需手填" />
        <p class="order-review__hint">审核结果保存到广州审计；平台自动验证同一版本，含售价的新稿通过后自动上架。</p>
        <el-alert v-if="!canReview" :title="reviewPermissionHint" type="warning" show-icon :closable="false" class="order-review__error" />
        <el-alert v-if="actionError" :title="actionError" type="error" show-icon :closable="false" class="order-review__error" />
        <div class="order-review__actions">
          <el-button :disabled="!canReview || selected.status !== 'review' || busy" :loading="busy" @click="reject">驳回投稿</el-button>
          <el-button type="primary" :disabled="!canSubmitApproval" :loading="busy" @click="approve">审核通过</el-button>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.order-review { border: 1px solid var(--el-border-color-light); border-radius: 14px; background: var(--el-bg-color); overflow: hidden; }
.order-review__head { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 18px 20px; border-bottom: 1px solid var(--el-border-color-lighter); }
.order-review__head strong { font-size: 16px; }
.order-review__head p, .order-review__hint { color: var(--el-text-color-secondary); font-size: 13px; margin: 6px 0 0; }
.order-review__access { margin: 12px 16px 0; width: auto; }
.order-review__detail h2 { margin: 10px 0 16px; }
.order-review__detail dl { border-top: 1px solid var(--el-border-color-lighter); margin: 20px 0; }
.order-review__detail dl > div { display: grid; grid-template-columns: 90px minmax(0, 1fr); gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--el-border-color-lighter); }
.order-review__detail dt { color: var(--el-text-color-secondary); }
.order-review__detail dd { margin: 0; overflow-wrap: anywhere; }
.order-review__issues { padding: 16px; border-radius: 10px; background: var(--el-fill-color-light); }
.order-review__issues h3 { margin: 0 0 10px; font-size: 14px; }
.order-review__issues ul { padding-left: 20px; line-height: 1.7; }
.order-review__status { display: flex; flex-direction: column; gap: 4px; padding: 14px 16px; border: 1px solid var(--el-color-warning-light-5); border-radius: 10px; background: var(--el-color-warning-light-9); }
.order-review__status--ready { border-color: var(--el-color-success-light-5); background: var(--el-color-success-light-9); }
.order-review__status span, .order-review__checks-head span, .order-review__check p { color: var(--el-text-color-secondary); font-size: 13px; }
.order-review__checks { margin-top: 18px; }
.order-review__checks-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.order-review__checks-head h3 { margin: 0 0 10px; font-size: 15px; }
.order-review__missing { padding: 14px; border: 1px solid var(--el-color-danger-light-5); border-radius: 10px; color: var(--el-color-danger); }
.order-review__check { margin-top: 8px; padding: 13px 15px; border: 1px solid var(--el-border-color-light); border-radius: 10px; }
.order-review__check-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.order-review__check p { margin: 7px 0 0; line-height: 1.5; }
.order-review__detail label { display: block; margin: 20px 0 8px; font-weight: 600; }
.order-review__error { margin-top: 12px; }
.order-review__actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
@media (max-width: 700px) { .order-review__head, .order-review__check-title { flex-direction: column; align-items: start; } }
</style>
