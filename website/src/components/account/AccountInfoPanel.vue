<template>
  <div class="account-panel">
    <div v-if="loading" class="loading-state">正在加载账户资料...</div>
    <div v-else-if="error" class="section-error" role="alert">
      <div><strong>账户资料加载失败</strong><p>{{ error }}</p></div>
      <button class="btn-ghost" @click="emit('retry')">重试</button>
    </div>
    <template v-else>
    <section class="profile-hero">
      <div class="avatar-wrap">
        <div class="avatar" :class="{ 'has-image': !!avatarUrl }">
          <img v-if="avatarUrl" :src="avatarUrl" alt="账户头像" />
          <span v-else>{{ initial }}</span>
        </div>
      </div>
      <div class="profile-info">
        <h2>{{ profile?.username || '-' }}</h2>
        <p class="profile-meta">
          <span class="badge-role">{{ roleLabel(profile?.role) }}</span>
          <span>·</span>
          <span>{{ profile?.email || '-' }}</span>
        </p>
        <p class="profile-meta-sm">
          <span>🏆 Lv.{{ profile?.level || 1 }} · {{ tierLabel(profile?.tier) }}</span>
          <span>·</span>
          <span>💰 {{ Number(profile?.balance || 0).toFixed(2) }} EDG</span>
          <span>·</span>
          <span>📅 注册于 {{ profile?.registered_at?.slice(0, 10) || '-' }}</span>
        </p>
      </div>
    </section>

    <div class="account-content account-content-wide">
      <section class="panel">
        <header class="panel-head">
          <div>
            <h3>👤 公开资料</h3>
            <p class="panel-description">其他用户在千手算力中看到的账户身份</p>
          </div>
        </header>
        <div class="avatar-setting">
          <div class="avatar avatar-small" :class="{ 'has-image': !!avatarUrl }">
            <img v-if="avatarUrl" :src="avatarUrl" alt="账户头像" />
            <span v-else>{{ initial }}</span>
          </div>
          <div>
            <strong>账户头像</strong>
            <p class="muted">支持 JPG / PNG / WebP，上传后自动压缩，建议清晰正面照。</p>
          </div>
          <div class="avatar-actions">
            <button class="btn-ghost" :disabled="avatarBusy" @click="pickAvatar">
              {{ avatarBusy ? '上传中…' : '更换头像' }}
            </button>
            <button
              v-if="avatarUrl"
              class="btn-ghost"
              :disabled="avatarBusy"
              @click="emit('clear-avatar')"
            >
              移除
            </button>
          </div>
          <input
            ref="avatarInput"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            class="avatar-file-input"
            @change="onAvatarPicked"
          />
        </div>
        <div class="form-grid">
          <div class="form-row">
            <label>用户名</label>
            <input :value="form.username" placeholder="用户名" disabled />
            <p class="field-hint">登录用户名，暂不支持修改</p>
          </div>
          <div class="form-row">
            <label>用户 ID</label>
            <input :value="profile?.id" disabled />
            <p class="field-hint">系统生成，不可修改</p>
          </div>
        </div>
        <div class="account-badges">
          <span><b>账户类型</b>{{ roleLabel(profile?.role) }}</span>
          <span><b>账户状态</b>{{ statusLabel(profile?.status) }}</span>
        </div>
      </section>

      <section class="panel">
        <header class="panel-head panel-head-row">
          <div>
            <h3>✉️ 登录信息</h3>
            <p class="panel-description">用于登录、找回密码和接收安全通知</p>
          </div>
          <button class="btn-ghost" @click="emit('open-security')">前往安全性</button>
        </header>
        <div class="setting-row">
          <div class="setting-icon">邮</div>
          <div class="setting-copy">
            <strong>登录邮箱</strong>
            <p>{{ profile?.email || '-' }}</p>
            <small>修改邮箱后，需要重新验证新地址。</small>
          </div>
          <button class="btn-ghost" disabled>编辑</button>
        </div>
        <div class="setting-row">
          <div class="setting-icon">时</div>
          <div class="setting-copy">
            <strong>最近登录</strong>
            <p>{{ formatDateTime(profile?.last_login_at) }}</p>
            <small>如发现异常登录，请立即修改密码。</small>
          </div>
        </div>
      </section>

      <section class="panel">
        <header class="panel-head">
          <div>
            <h3>🪪 个人信息</h3>
            <p class="panel-description">完善资料以便获得更合适的服务体验</p>
          </div>
        </header>
        <div class="form-grid">
          <div class="form-row">
            <label>显示名称</label>
            <input
              :value="form.displayName"
              placeholder="请输入显示名称"
              @input="updateForm('displayName', $event)"
            />
          </div>
          <div class="form-row">
            <label>联系电话</label>
            <input :value="form.phone" placeholder="未设置" @input="updateForm('phone', $event)" />
          </div>
          <div class="form-row">
            <label>交流语言</label>
            <select :value="form.language" @change="updateForm('language', $event)">
              <option>简体中文</option>
              <option>繁體中文</option>
              <option>English</option>
            </select>
          </div>
          <div class="form-row">
            <label>国家 / 地区</label>
            <input :value="form.country" placeholder="未设置" @input="updateForm('country', $event)" />
          </div>
        </div>
        <div class="form-actions">
          <button class="btn-primary" :disabled="saving" @click="emit('save')">
            {{ saving ? '保存中…' : '💾 保存修改' }}
          </button>
        </div>
      </section>

      <section class="panel">
        <header class="panel-head">
          <div>
            <h3>🔗 关联账户与服务</h3>
            <p class="panel-description">管理允许访问千手算力账户的第三方服务</p>
          </div>
        </header>
        <div class="empty-service">
          <div class="empty-service-icon">⌁</div>
          <div>
            <strong>暂未关联其他服务</strong>
            <p class="muted">未来关联的企业账户、开发者服务将在这里显示。</p>
          </div>
          <span class="badge-coming">即将上线</span>
        </div>
      </section>
    </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { MyProfile } from '../../services/api'
import type { AccountProfileField, AccountProfileForm } from './types'

const props = defineProps<{
  profile: MyProfile | null
  form: AccountProfileForm
  loading: boolean
  error: string
  saving?: boolean
  avatarBusy?: boolean
}>()

const emit = defineEmits<{
  retry: []
  save: []
  'open-security': []
  'update-form': [field: AccountProfileField, value: string]
  'change-avatar': [dataUrl: string]
  'clear-avatar': []
}>()

const avatarInput = ref<HTMLInputElement | null>(null)

const initial = computed(() => (props.profile?.username || '?').slice(0, 1).toUpperCase())

const avatarUrl = computed(() => {
  const p = props.profile?.profile || {}
  const raw = String(p.avatar_url || p.avatar || '').trim()
  return raw || ''
})

const pickAvatar = () => {
  if (props.avatarBusy) return
  avatarInput.value?.click()
}

const onAvatarPicked = async (event: Event) => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    const dataUrl = await compressAvatarFile(file)
    emit('change-avatar', dataUrl)
  } catch (error: any) {
    ElMessage.error(error?.message || '无法处理该图片')
  }
}

async function compressAvatarFile(file: File): Promise<string> {
  const allowed = ['image/jpeg', 'image/png', 'image/webp']
  if (!allowed.includes(file.type)) {
    throw new Error('请选择 JPG / PNG / WebP 图片')
  }
  if (file.size > 5 * 1024 * 1024) {
    throw new Error('图片不能超过 5MB')
  }
  const bitmap = await createImageBitmap(file)
  const maxSide = 256
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('浏览器无法处理图片')
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  let quality = 0.85
  let dataUrl = canvas.toDataURL('image/jpeg', quality)
  while (dataUrl.length > 180_000 && quality > 0.45) {
    quality -= 0.1
    dataUrl = canvas.toDataURL('image/jpeg', quality)
  }
  if (dataUrl.length > 180_000) {
    throw new Error('压缩后仍过大，请换一张更简单的图片')
  }
  return dataUrl
}

const updateForm = (field: AccountProfileField, event: Event) => {
  emit('update-form', field, (event.target as HTMLInputElement | HTMLSelectElement).value)
}

const roleLabel = (role?: string) => {
  const labels: Record<string, string> = {
    admin: '管理员',
    personal: '个人',
    enterprise: '企业',
    user: '用户',
  }
  return labels[role || ''] || role || '-'
}

const statusLabel = (status?: string) => {
  const labels: Record<string, string> = {
    active: '正常',
    pending: '待验证',
    suspended: '已停用',
  }
  return labels[status || ''] || status || '-'
}

const tierLabel = (tier?: string) => {
  const labels: Record<string, string> = {
    basic: '入门',
    bronze: '青铜',
    silver: '白银',
    gold: '黄金',
    diamond: '钻石',
  }
  return labels[tier || ''] || '入门'
}

const formatDateTime = (value?: string | null) => {
  if (!value) return '暂无记录'
  try {
    return new Date(value).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return value
  }
}
</script>
