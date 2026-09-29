<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import { listManagedOrderPublications, manageOrderPublication, shanghaiReviewWritable,
  type ManagedOrderPublication, type PublicationLifecycleAction } from '@/api/modules/marketplace'
import { session } from '@/session/store'

const items = ref<readonly ManagedOrderPublication[]>([])
const loading = ref(false), busy = ref(false), archived = ref(false), error = ref(''), writable = ref(false)
let generation = 0, mounted = true
const actor = () => session.admin?.accountId
const canManage = computed(() => session.permissions.includes('market.review') && session.admin?.scope === 'all' && writable.value)
const visible = computed(() => items.value.filter(item => item.lifecycle.archived === archived.value))
const labels: Record<PublicationLifecycleAction, string> = { withdraw: '撤回投稿', delist: '下架', archive: '归档记录', restore: '恢复记录' }
const reasons = (item: ManagedOrderPublication): string => item.lifecycle.blocking_reasons.map(reason =>
  reason === 'active-orders' ? '存在在途或待审核订单' : '存在待安装购买权益').join('；')
async function load(): Promise<void> {
  const ticket = ++generation, account = actor()
  items.value = []; writable.value = false; error.value = ''; loading.value = true
  try {
    const queue = await listManagedOrderPublications()
    if (!mounted || ticket !== generation || actor() !== account) return
    items.value = queue.items; writable.value = shanghaiReviewWritable(queue)
  } catch (caught) {
    if (mounted && ticket === generation && actor() === account) error.value = caught instanceof Error ? caught.message : '发布记录读取失败'
  } finally { if (ticket === generation) loading.value = false }
}
async function act(item: ManagedOrderPublication, action: PublicationLifecycleAction): Promise<void> {
  if (!canManage.value || busy.value || !item.lifecycle.allowed_actions.includes(action)) return
  const account = actor(), revision = item.lifecycle.revision, id = item.publication_id
  try {
    await ElMessageBox.confirm(`${labels[action]}“${item.name}”（作者账号 ${item.owner_id}）？归档会停止新购买与接单；现有合同、订单、权益和账本保留。恢复仅恢复列表显示，不会自动重新上架。`,
      `确认${labels[action]}`, { confirmButtonText: `确认${labels[action]}`, cancelButtonText: '返回', type: 'warning' })
  } catch { return }
  if (actor() !== account || !canManage.value || busy.value) return
  const current = items.value.find(row => row.publication_id === id)
  if (!current || current.lifecycle.revision !== revision || !current.lifecycle.allowed_actions.includes(action)) return
  busy.value = true; error.value = ''
  try {
    const result = await manageOrderPublication(id, action, revision, `管理员确认${labels[action]}：${item.name}`)
    if (result.item.publication_id !== id || result.item.lifecycle.revision !== revision + 1) throw new Error('结果无法确认，请刷新核对')
    if (actor() === account) await load()
  } catch (caught) {
    if (actor() === account) error.value = caught instanceof Error ? caught.message : '管理状态不确定，请刷新核对，勿重复提交'
  } finally { if (actor() === account) busy.value = false }
}
watch(actor, () => { busy.value = false; void load() })
onMounted(() => { void load() })
onUnmounted(() => { mounted = false; generation += 1 })
</script>
<template>
  <section class="publication-management">
    <div class="publication-management__toolbar">
      <el-radio-group v-model="archived"><el-radio-button :value="false">当前发布记录</el-radio-button><el-radio-button :value="true">已归档</el-radio-button></el-radio-group>
      <el-button :disabled="busy" :loading="loading" @click="load">刷新记录</el-button>
    </div>
    <p>撤回、下架和归档均保留历史。存在在途订单或待安装权益时，服务器会阻止下架和归档。</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <el-table v-loading="loading" :data="visible" empty-text="没有这一状态的发布记录">
      <el-table-column prop="name" label="技能名称" min-width="180" />
      <el-table-column prop="owner_id" label="作者账号" width="110" />
      <el-table-column label="状态" min-width="120"><template #default="scope">
        {{ scope.row.lifecycle.archived ? '已归档' : scope.row.lifecycle.state === 'withdrawn' ? '已撤回' : scope.row.lifecycle.state === 'delisted' ? '已下架' : scope.row.status === 'approved' ? '已审核' : scope.row.status === 'review' ? '待审核' : '已驳回' }}
      </template></el-table-column>
      <el-table-column label="订单保护" min-width="180"><template #default="scope">{{ reasons(scope.row) || '无在途阻断' }}</template></el-table-column>
      <el-table-column label="操作" min-width="220"><template #default="scope">
        <el-button v-for="action in scope.row.lifecycle.allowed_actions" :key="action" link type="primary" :disabled="!canManage || busy" @click="act(scope.row, action)">{{ labels[action as PublicationLifecycleAction] }}</el-button>
      </template></el-table-column>
    </el-table>
  </section>
</template>
<style scoped>
.publication-management__toolbar { display: flex; justify-content: space-between; gap: 16px; }
.publication-management p { color: var(--el-text-color-secondary); line-height: 1.7; }
</style>
