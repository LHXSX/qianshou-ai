<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { listOrderAdapterProducts, reviewOrderAdapterProduct, reviewAuthorityHint, shanghaiReviewWritable, type OrderAdapterProductReviewItem } from '@/api/modules/marketplace'
import { session } from '@/session/store'
import { useAsyncData } from '@/utils/async-state'
import ErrorAlert from '@/components/ErrorAlert.vue'

const state = useAsyncData(listOrderAdapterProducts)
const items = computed(() => state.data.value?.items ?? [])
const countLabel = computed(() => state.loading.value ? '读取中' : state.error.value ? '读取失败，数量未知'
  : !state.loaded.value || !state.data.value ? '尚未读取' : String(items.value.length))
const selected = ref<OrderAdapterProductReviewItem>()
const note = ref('')
const busy = ref(false)
const actionError = ref('')
const localCanReview = computed(() => session.permissions.includes('market.review') && session.admin?.scope === 'all')
const productReviewReady = computed(() => state.data.value?.reviewActionsAvailable === true)
const shanghaiCanReview = computed(() => !state.error.value && shanghaiReviewWritable(state.data.value) && productReviewReady.value)
const canReview = computed(() => localCanReview.value && shanghaiCanReview.value)
const reviewPermissionHint = computed(() => localCanReview.value
  ? state.data.value && !productReviewReady.value
    ? '中央服务器商品审核写接口尚未上线；当前仅可查看待审商品，通过与驳回均不可提交。'
    : reviewAuthorityHint(state.data.value)
  : '当前广州管理员账号缺少 market.review 权限或全部数据范围，不能提交审核。')
const validNote = computed(() => note.value.trim().length >= 4 && note.value.trim().length <= 500)
const archivePresent = computed(() => !!selected.value?.archive_digest
  && typeof selected.value.archive_size_bytes === 'number' && selected.value.archive_size_bytes > 0)
const canApprove = computed(() => canReview.value && !!selected.value && !busy.value && validNote.value
  && selected.value.status === 'review' && selected.value.can_approve === true
  && selected.value.review_reasons.length === 0 && archivePresent.value)
function open(item: OrderAdapterProductReviewItem): void { selected.value = item; note.value = ''; actionError.value = '' }
function close(): void { selected.value = undefined; note.value = ''; actionError.value = '' }
async function review(action: 'approve' | 'reject'): Promise<void> {
  const item = selected.value
  if (!item || item.status !== 'review' || busy.value || !canReview.value) return
  if (!validNote.value) { actionError.value = '请填写 4–500 字审核依据。'; return }
  if (action === 'approve' && !canApprove.value) { actionError.value = '归档和平台接单状态尚未通过受信核验。'; return }
  try {
    await ElMessageBox.confirm(`${action === 'approve' ? '上架' : '驳回'}“${item.name}”？中央服务器会再次核对接单技能及锁定归档。`,
      '确认商品审核', { confirmButtonText: '确认提交', cancelButtonText: '返回', type: 'warning' })
  } catch { return }
  busy.value = true; actionError.value = ''
  try {
    const result = await reviewOrderAdapterProduct(item.id, action, note.value.trim())
    const expected = action === 'approve' ? 'published' : 'rejected'
    if (result.item.status !== expected) throw new Error('中央服务器未确认商品审核结果，请刷新队列核对。')
    ElMessage.success(action === 'approve' ? '接单技能商品已上架' : '接单技能商品已驳回')
    close(); await state.run()
  } catch (error) { actionError.value = error instanceof Error ? error.message : '审核状态不确定，请刷新核对。' }
  finally { busy.value = false }
}
onMounted(() => { if (session.admin && session.permissions.includes('market.read')) void state.run() })
watch(() => session.admin?.accountId, (current, previous) => {
  if (current === previous) return
  close(); state.data.value = undefined
  if (current && session.permissions.includes('market.read')) void state.run()
})
</script>

<template>
  <div class="product-review">
    <div class="product-review__head">
      <div><strong>接单技能商品待审：{{ countLabel }}</strong><p>先核对已审投稿、锁定归档和人民币售价。上架后购买与安装仍由平台单独验证。</p></div>
      <el-button :loading="state.loading.value" @click="state.run()">刷新商品</el-button>
    </div>
    <ErrorAlert v-if="state.error.value" :error="state.error.value" />
    <el-alert v-if="state.data.value && !canReview" :title="reviewPermissionHint"
      type="warning" show-icon :closable="false" class="product-review__access" />
    <el-table v-if="!state.error.value" v-loading="state.loading.value" :data="items" empty-text="暂无商品待审；卖家需先通过接单技能审核，再提交可验签的商品归档">
      <el-table-column prop="name" label="技能商品" min-width="210" show-overflow-tooltip />
      <el-table-column prop="task_type" label="任务类型" min-width="160" show-overflow-tooltip />
      <el-table-column label="售价" min-width="100"><template #default="scope">{{ scope.row.sale_price_yuan ?? '—' }} 元</template></el-table-column>
      <el-table-column label="审核条件" min-width="145"><template #default="scope">
        <el-tag :type="shanghaiCanReview && scope.row.can_approve && !scope.row.review_reasons.length ? 'success' : 'warning'" effect="plain" size="small">
          {{ !shanghaiCanReview ? '仅可查看队列' : scope.row.can_approve && !scope.row.review_reasons.length ? '可审核' : `${scope.row.review_reasons.length} 项待核验` }}
        </el-tag>
      </template></el-table-column>
      <el-table-column label="操作" width="110" fixed="right"><template #default="scope"><el-button link type="primary" @click="open(scope.row)">查看审核</el-button></template></el-table-column>
    </el-table>
    <el-drawer :model-value="selected !== undefined" title="接单技能商品审核" size="min(760px, 100%)" append-to-body @close="close">
      <div v-if="selected" class="product-review__detail">
        <div class="product-review__status" :class="{ 'product-review__status--ready': canApprove }">
          <strong>{{ !canReview ? '当前只能查看，不能提交商品审核' : selected.can_approve && !selected.review_reasons.length && archivePresent ? '中央服务器允许进入商品审核' : '商品暂不可上架' }}</strong>
          <span>{{ !canReview ? reviewPermissionHint : '商品审核与接单技能审核分开进行；通过审核不代表购买和安装已开通。' }}</span>
        </div>
        <h2>{{ selected.name }}</h2>
        <p>{{ selected.description || '未填写商品介绍。' }}</p>
        <dl>
          <div><dt>商品编号</dt><dd>{{ selected.id }}</dd></div>
          <div><dt>接单投稿</dt><dd>{{ selected.publication_id }}</dd></div>
          <div><dt>任务类型</dt><dd>{{ selected.task_type }}</dd></div>
          <div><dt>版本</dt><dd>{{ selected.version || '未声明' }}</dd></div>
          <div><dt>售价</dt><dd>{{ selected.sale_price_yuan ?? '—' }} 元人民币</dd></div>
          <div><dt>归档摘要</dt><dd>{{ selected.archive_digest || '尚未存证' }}</dd></div>
          <div><dt>归档大小</dt><dd>{{ selected.archive_size_bytes ?? '—' }} 字节</dd></div>
        </dl>
        <section class="product-review__checks" aria-label="商品上架检查">
          <h3>上架前核对</h3>
          <div><strong>来源投稿</strong><p>中央服务器需确认接单技能已审、当前可派发，且商品作者和投稿作者一致。</p></div>
          <div><strong>锁定归档</strong><p>{{ archivePresent ? '中央服务器已返回归档摘要和大小；审批时仍会重新验签。' : '中央服务器尚未返回可用归档摘要和大小。请由发布与验包服务锁定实际安装包。' }}</p></div>
          <div><strong>人民币售价</strong><p>{{ selected.sale_price_yuan ?? '—' }} 元人民币；结算与购买状态由中央服务器单独控制。</p></div>
        </section>
        <section class="product-review__issues">
          <h3>平台阻断项</h3>
          <p v-if="!selected.review_reasons.length">当前无阻断项；提交后中央服务器仍会实时复核。</p>
          <ul v-else><li v-for="reason in selected.review_reasons" :key="reason">{{ reason }}</li></ul>
        </section>
        <label for="order-product-note">审核依据</label>
        <el-input id="order-product-note" v-model="note" type="textarea" :rows="3" maxlength="500" show-word-limit
          :disabled="!canReview" placeholder="填写审核依据，至少 4 个字" />
        <el-alert v-if="!canReview" :title="reviewPermissionHint" type="warning" show-icon :closable="false" class="product-review__error" />
        <el-alert v-if="actionError" :title="actionError" type="error" show-icon :closable="false" class="product-review__error" />
        <div class="product-review__actions">
          <el-button :disabled="!canReview || selected.status !== 'review' || busy" :loading="busy" @click="review('reject')">驳回商品</el-button>
          <el-button type="primary" :disabled="!canApprove" :loading="busy" @click="review('approve')">审核并上架</el-button>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.product-review { border: 1px solid var(--el-border-color-light); border-radius: 14px; background: var(--el-bg-color); overflow: hidden; }
.product-review__head { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 18px 20px; border-bottom: 1px solid var(--el-border-color-lighter); }
.product-review__head strong { font-size: 16px; }
.product-review__head p, .product-review__detail p { color: var(--el-text-color-secondary); font-size: 13px; margin: 6px 0 0; }
.product-review__access { margin: 12px 16px 0; width: auto; }
.product-review__detail h2 { margin: 0 0 12px; }
.product-review__status { display: flex; flex-direction: column; gap: 5px; padding: 14px 16px; margin-bottom: 16px; border: 1px solid var(--el-color-warning-light-5); border-radius: 10px; background: var(--el-color-warning-light-9); }
.product-review__status--ready { border-color: var(--el-color-success-light-5); background: var(--el-color-success-light-9); }
.product-review__status span, .product-review__hint { color: var(--el-text-color-secondary); font-size: 13px; }
.product-review__detail dl { margin: 20px 0; border-top: 1px solid var(--el-border-color-lighter); }
.product-review__detail dl > div { display: grid; grid-template-columns: 90px minmax(0, 1fr); gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--el-border-color-lighter); }
.product-review__detail dt { color: var(--el-text-color-secondary); }
.product-review__detail dd { margin: 0; overflow-wrap: anywhere; }
.product-review__checks { margin: 18px 0; }
.product-review__checks h3 { margin: 0 0 10px; font-size: 15px; }
.product-review__checks > div { padding: 11px 14px; margin-top: 8px; border: 1px solid var(--el-border-color-light); border-radius: 10px; }
.product-review__checks p { margin: 5px 0 0; }
.product-review__issues { padding: 16px; border-radius: 10px; background: var(--el-fill-color-light); }
.product-review__issues h3 { margin: 0 0 10px; font-size: 14px; }
.product-review__issues ul { padding-left: 20px; line-height: 1.7; }
.product-review__detail label { display: block; margin: 20px 0 8px; font-weight: 600; }
.product-review__error { margin-top: 12px; }
.product-review__actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
@media (max-width: 700px) { .product-review__head { flex-direction: column; align-items: start; } }
</style>
