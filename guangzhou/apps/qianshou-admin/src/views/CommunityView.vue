<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { session } from '@/session/store'
import {
  createCommunityAnnouncement, listCommunity, moderateCommunity, resolveCommunityReport,
  type CommunityReport, type CommunityTopic,
} from '@/api/modules/community'

const loading = ref(false)
const saving = ref(false)
const error = ref('')
const topics = ref<CommunityTopic[]>([])
const reports = ref<CommunityReport[]>([])
const tab = ref<'topics' | 'reports'>('topics')
const selected = ref<CommunityTopic | null>(null)
const action = ref<'hide' | 'restore' | 'pin' | 'unpin' | 'dismiss' | 'report-hide' | null>(null)
const report = ref<CommunityReport | null>(null)
const reason = ref('')
const announcementOpen = ref(false)
const announcement = ref({ title: '', content: '', relatedKind: '', relatedId: '' })
const canManage = computed(() => session.permissions.includes('community.manage'))
const categoryNames: Record<CommunityTopic['category'], string> = {
  help: '问题求助', skills: '技能交流', works: '作品分享', activities: '活动公告',
}

function datetime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

async function refresh(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const result = await listCommunity()
    topics.value = result.topics
    reports.value = result.reports
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取讨论区失败。'
  } finally {
    loading.value = false
  }
}

function openAction(topic: CommunityTopic, next: 'hide' | 'restore' | 'pin' | 'unpin'): void {
  selected.value = topic
  report.value = null
  action.value = next
  reason.value = ''
}

function openReportAction(item: CommunityReport, next: 'dismiss' | 'report-hide'): void {
  selected.value = null
  report.value = item
  action.value = next
  reason.value = ''
}

async function submitAction(): Promise<void> {
  if (!action.value || reason.value.trim().length < 4) return
  saving.value = true
  try {
    if (report.value) await resolveCommunityReport(report.value.id, action.value === 'report-hide' ? 'hide' : 'dismiss', reason.value.trim())
    else if (selected.value && action.value !== 'dismiss' && action.value !== 'report-hide') {
      await moderateCommunity(selected.value.id, action.value, reason.value.trim())
    }
    action.value = null
    ElMessage.success('处理完成，已写入审核记录')
    await refresh()
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '提交失败，请刷新后重试。')
  } finally {
    saving.value = false
  }
}

async function publishAnnouncement(): Promise<void> {
  const title = announcement.value.title.trim()
  const content = announcement.value.content.trim()
  if (title.length < 4 || content.length < 10) return
  const kind = announcement.value.relatedKind
  const id = announcement.value.relatedId.trim()
  const related = kind && id ? { kind: kind as 'skill' | 'product', id } : null
  saving.value = true
  try {
    await createCommunityAnnouncement(title, content, related)
    announcementOpen.value = false
    announcement.value = { title: '', content: '', relatedKind: '', relatedId: '' }
    ElMessage.success('活动公告已发布')
    await refresh()
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '发布失败。')
  } finally {
    saving.value = false
  }
}

onMounted(() => { void refresh() })
</script>

<template>
  <section class="community qs-page">
    <header class="qs-page__head community__head">
      <div>
        <p class="community__eyebrow">用户交流 · 广州内容管理</p>
        <h1 class="qs-page__title">讨论区</h1>
        <p class="qs-page__desc">查看话题、处理举报、发布活动。用户发帖复用千手账号身份。</p>
      </div>
      <div class="community__actions">
        <el-button :loading="loading" @click="refresh">刷新</el-button>
        <el-button v-if="canManage" type="primary" @click="announcementOpen = true">发布活动</el-button>
      </div>
    </header>

    <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="community__error" />
    <el-tabs v-model="tab" class="community__tabs">
      <el-tab-pane :label="`全部话题 ${topics.length}`" name="topics">
        <el-table v-loading="loading" :data="topics" empty-text="暂无讨论" class="community__table">
          <el-table-column label="话题" min-width="290">
            <template #default="scope">
              <div class="community__topic-title">{{ scope.row.title }}</div>
              <div class="community__meta">{{ categoryNames[scope.row.category as CommunityTopic['category']] }} · {{ scope.row.authorName }} · {{ datetime(scope.row.createdAt) }}</div>
              <div v-if="scope.row.related" class="community__meta">关联{{ scope.row.related.kind === 'product' ? '商品' : '技能' }}：{{ scope.row.related.id }}</div>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="160">
            <template #default="scope">
              <el-tag :type="scope.row.visibility === 'hidden' ? 'danger' : 'success'" size="small">{{ scope.row.visibility === 'hidden' ? '已隐藏' : '可见' }}</el-tag>
              <el-tag v-if="scope.row.status === 'solved'" size="small" type="info">已解决</el-tag>
              <el-tag v-if="scope.row.pinned" size="small" type="warning">置顶</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="回复" prop="replyCount" width="75" />
          <el-table-column label="更新时间" width="175"><template #default="scope">{{ datetime(scope.row.updatedAt) }}</template></el-table-column>
          <el-table-column v-if="canManage" label="操作" width="210" fixed="right">
            <template #default="scope">
              <el-button link type="primary" @click="openAction(scope.row, scope.row.visibility === 'hidden' ? 'restore' : 'hide')">{{ scope.row.visibility === 'hidden' ? '恢复' : '隐藏' }}</el-button>
              <el-button link @click="openAction(scope.row, scope.row.pinned ? 'unpin' : 'pin')">{{ scope.row.pinned ? '取消置顶' : '置顶' }}</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
      <el-tab-pane :label="`待处理举报 ${reports.length}`" name="reports">
        <el-table v-loading="loading" :data="reports" empty-text="没有待处理举报">
          <el-table-column label="举报对象" width="155"><template #default="scope">{{ scope.row.targetKind === 'topic' ? '话题' : '回复' }} · {{ scope.row.targetId.slice(0, 8) }}</template></el-table-column>
          <el-table-column label="原因" prop="reason" min-width="260" />
          <el-table-column label="举报人" prop="reporterId" width="115" />
          <el-table-column label="时间" width="175"><template #default="scope">{{ datetime(scope.row.createdAt) }}</template></el-table-column>
          <el-table-column v-if="canManage" label="处理" width="180" fixed="right">
            <template #default="scope">
              <el-button link type="danger" @click="openReportAction(scope.row, 'report-hide')">隐藏内容</el-button>
              <el-button link @click="openReportAction(scope.row, 'dismiss')">驳回举报</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="announcementOpen" title="发布活动公告" width="min(620px, 96%)">
      <el-form label-position="top">
        <el-form-item label="标题（4–100 字）"><el-input v-model="announcement.title" maxlength="100" show-word-limit /></el-form-item>
        <el-form-item label="正文（至少 10 字）"><el-input v-model="announcement.content" type="textarea" :rows="7" maxlength="10000" show-word-limit /></el-form-item>
        <div class="community__related">
          <el-form-item label="关联内容（可选）"><el-select v-model="announcement.relatedKind" clearable placeholder="不关联"><el-option label="技能" value="skill" /><el-option label="市场商品" value="product" /></el-select></el-form-item>
          <el-form-item label="技能 / 商品 ID"><el-input v-model="announcement.relatedId" :disabled="!announcement.relatedKind" placeholder="使用已上架的 ID" /></el-form-item>
        </div>
      </el-form>
      <template #footer><el-button @click="announcementOpen = false">取消</el-button><el-button type="primary" :loading="saving" :disabled="announcement.title.trim().length < 4 || announcement.content.trim().length < 10" @click="publishAnnouncement">发布</el-button></template>
    </el-dialog>

    <el-dialog :model-value="action !== null" title="确认处理" width="min(480px, 96%)" @close="action = null">
      <p class="community__dialog-text">{{ report ? `举报：${report.reason}` : selected?.title }}</p>
      <el-input v-model="reason" type="textarea" :rows="3" maxlength="500" show-word-limit placeholder="填写至少 4 字处理依据，供审核留痕" />
      <template #footer><el-button @click="action = null">取消</el-button><el-button type="primary" :loading="saving" :disabled="reason.trim().length < 4" @click="submitAction">确认处理</el-button></template>
    </el-dialog>
  </section>
</template>

<style scoped>
.community { max-width: 1440px; margin: 0 auto; }
.community__head, .community__actions, .community__related { display: flex; align-items: center; gap: 12px; }
.community__head { justify-content: space-between; }
.community__eyebrow { color: #179489; font-size: 12px; font-weight: 700; margin: 0 0 8px; }
.community__error { margin: 20px 0; }
.community__tabs { margin-top: 24px; padding: 12px 20px 20px; background: #fff; border: 1px solid #e4e8ec; border-radius: 14px; }
.community__topic-title { font-weight: 650; color: #18243b; line-height: 1.4; }
.community__meta { color: #83909e; font-size: 12px; margin-top: 6px; overflow-wrap: anywhere; }
.community__related > * { flex: 1; }
.community__dialog-text { margin: 0 0 16px; font-weight: 600; }
@media (max-width: 760px) { .community__head, .community__related { align-items: stretch; flex-direction: column; } }
</style>
