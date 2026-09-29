<template>
  <div class="account-page">
    <header class="page-head">
      <div>
        <h1>{{ sectionMeta.icon }} {{ sectionMeta.title }}</h1>
        <p class="sub">{{ sectionMeta.description }}</p>
      </div>
    </header>

    <AccountInfoPanel
      v-if="section === 'info'"
      :profile="profile"
      :form="form"
      :loading="profileLoading"
      :error="profileError"
      :saving="profileSaving"
      :avatar-busy="avatarBusy"
      @retry="loadProfile"
      @save="saveProfile"
      @open-security="router.push('/account/security')"
      @update-form="updateProfileForm"
      @change-avatar="uploadAvatar"
      @clear-avatar="clearAvatar"
    />

    <SecurityPanel
      v-else-if="section === 'security'"
      :profile="profile"
      :profile-form="form"
      :profile-loading="profileLoading"
      :profile-error="profileError"
      :password-form="pwForm"
      :password-busy="passwordBusy"
      :totp-status="totpStatus"
      :totp-loading="totpLoading"
      :totp-error="totpError"
      v-model:totp-setup-visible="totpSetupVisible"
      v-model:totp-disable-visible="totpDisableVisible"
      v-model:totp-setup-password="totpSetupPassword"
      v-model:totp-disable-password="totpDisablePassword"
      :totp-setup-data="totpSetupData"
      :totp-qr-url="totpQrUrl"
      v-model:totp-code="totpCode"
      v-model:totp-disable-code="totpDisableCode"
      :totp-busy="totpBusy"
      :login-sessions="loginSessions"
      :sessions-loading="sessionsLoading"
      :sessions-error="sessionsError"
      :sessions-busy="sessionsBusy"
      v-model:trust-dialog-visible="trustDialogVisible"
      :selected-trust-session="selectedTrustSession"
      v-model:trust-duration="trustDuration"
      v-model:trust-password="trustPassword"
      v-model:trust-code="trustCode"
      :trust-busy="trustBusy"
      :trust-duration-options="trustDurationOptions"
      @retry-profile="loadProfile"
      @reload-sessions="reloadSessions"
      @revoke-other-sessions="revokeOtherLoginSessions"
      @cancel-session-trust="cancelSessionTrust"
      @open-trust-dialog="openTrustDialog"
      @revoke-session="revokeLoginSession"
      @update-password-form="updatePasswordForm"
      @change-password="changePassword"
      @reload-totp="loadTotpStatus"
      @open-totp-setup="openTotpSetup"
      @open-totp-disable="openTotpDisable"
      @logout="logout"
      @reset-totp-setup="resetTotpSetup"
      @reset-totp-disable="resetTotpDisable"
      @start-totp-setup="startTotpSetup"
      @copy-totp-secret="copyTotpSecret"
      @confirm-totp-setup="confirmTotpSetup"
      @disable-totp="disableTotp"
      @reset-trust-dialog="resetTrustDialog"
      @submit-session-trust="submitSessionTrust"
    />

    <div v-else-if="profileLoading" class="qs-panel" role="status">正在读取通知偏好…</div>
    <div v-else-if="profileError" class="qs-error" role="alert">{{ profileError }}<button @click="loadProfile">重新加载</button></div>
    <NotificationsPanel
      v-else
      :preferences="prefs"
      @update-preference="updatePreference"
      @save="savePrefs"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import QRCode from 'qrcode'
import AccountInfoPanel from '../components/account/AccountInfoPanel.vue'
import NotificationsPanel from '../components/account/NotificationsPanel.vue'
import SecurityPanel from '../components/account/SecurityPanel.vue'
import type {
  AccountProfileField,
  AccountProfileForm,
  NotificationPreferenceField,
  NotificationPreferences,
  PasswordField,
  PasswordForm,
} from '../components/account/types'
import {
  myApi,
  auth,
  type MyProfile,
  type TotpSetupResponse,
  type TotpStatus,
  type TrustDeviceDuration,
  type UserSession,
} from '../services/api'

const router = useRouter()
const route = useRoute()

type AccountSection = 'info' | 'security' | 'notifications'
const accountSectionMeta: Record<AccountSection, { icon: string; title: string; description: string }> = {
  info: { icon: '👤', title: '账户信息', description: '查看并维护个人账户资料' },
  security: { icon: '🔐', title: '安全性', description: '管理密码、两步验证与登录设备' },
  notifications: { icon: '🔔', title: '通知中心', description: '管理节点、收益与系统通知偏好' },
}
const section = computed<AccountSection>(() => {
  const raw = String(route.params.section || route.meta.accountSection || '')
  if (raw === 'security' || raw === 'notifications' || raw === 'info') return raw
  if (route.path.includes('/security')) return 'security'
  if (route.path.includes('/notifications')) return 'notifications'
  return 'info'
})
const sectionMeta = computed(() => accountSectionMeta[section.value])

const profile = ref<MyProfile | null>(null)
const profileLoading = ref(true)
const profileError = ref('')
const totpStatus = ref<TotpStatus>({ ok: true, enabled: false, enabled_at: null })
const totpLoading = ref(true)
const totpError = ref('')
const totpSetupVisible = ref(false)
const totpDisableVisible = ref(false)
const totpSetupPassword = ref('')
const totpDisablePassword = ref('')
const totpSetupData = ref<TotpSetupResponse | null>(null)
const totpQrUrl = ref('')
const totpCode = ref('')
const totpDisableCode = ref('')
const totpBusy = ref(false)
const passwordBusy = ref(false)
const loginSessions = ref<UserSession[]>([])
const sessionsLoading = ref(true)
const sessionsError = ref('')
const sessionsBusy = ref(false)
const trustDialogVisible = ref(false)
const selectedTrustSession = ref<UserSession | null>(null)
const trustDuration = ref<TrustDeviceDuration>('30d')
const trustPassword = ref('')
const trustCode = ref('')
const trustBusy = ref(false)
const trustDurationOptions: Array<{ value: TrustDeviceDuration; label: string }> = [
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
  { value: '90d', label: '90 天' },
  { value: 'permanent', label: '永久' },
]

const form = reactive<AccountProfileForm>({
  username: '',
  displayName: '',
  phone: '',
  language: '简体中文',
  country: '中国',
})
const pwForm = reactive<PasswordForm>({ old: '', new: '', confirm: '' })
const prefs = reactive<NotificationPreferences>({
  notifyOffline: true,
  dailyReport: true,
  notifyFailed: true,
  systemNotice: false,
})

const activeOtherSessionCount = computed(
  () => loginSessions.value.filter((item) => item.status === 'active' && !item.is_current).length
)

const updateProfileForm = (field: AccountProfileField, value: string) => {
  form[field] = value
}

const updatePasswordForm = (field: PasswordField, value: string) => {
  pwForm[field] = value
}

const updatePreference = (field: NotificationPreferenceField, value: boolean) => {
  prefs[field] = value
}

const apiErrorMessage = (error: any, fallback: string) =>
  error?.response?.data?.detail ||
  error?.response?.data?.message ||
  error?.message ||
  fallback

const loadProfile = async () => {
  profileLoading.value = true
  profileError.value = ''
  try {
    const loadedProfile = await myApi.getProfile()
    profile.value = loadedProfile
    form.username = profile.value.username
    form.displayName = profile.value.profile?.display_name || profile.value.username
    form.phone = profile.value.profile?.phone || ''
    form.language = profile.value.profile?.language || '简体中文'
    form.country = profile.value.profile?.country || '中国'
    const np = (profile.value.profile as any)?.notification_prefs
    if (np && typeof np === 'object') {
      if (typeof np.notify_offline === 'boolean') prefs.notifyOffline = np.notify_offline
      if (typeof np.daily_report === 'boolean') prefs.dailyReport = np.daily_report
      if (typeof np.notify_failed === 'boolean') prefs.notifyFailed = np.notify_failed
      if (typeof np.system_notice === 'boolean') prefs.systemNotice = np.system_notice
    }
  } catch (error: any) {
    profileError.value = apiErrorMessage(error, '无法加载账户资料')
  } finally {
    profileLoading.value = false
  }
}

const loadTotpStatus = async () => {
  totpLoading.value = true
  totpError.value = ''
  try {
    totpStatus.value = await auth.getTotpStatus()
  } catch (error: any) {
    totpError.value = apiErrorMessage(error, '无法加载两步验证状态')
  } finally {
    totpLoading.value = false
  }
}

const loadData = async () => {
  await Promise.allSettled([
    loadProfile(),
    loadTotpStatus(),
    reloadSessions(),
  ])
}

const profileSaving = ref(false)
const avatarBusy = ref(false)

const saveProfile = async () => {
  const displayName = form.displayName.trim()
  if (!displayName) {
    ElMessage.warning('请填写显示名称')
    return
  }
  profileSaving.value = true
  try {
    const updated = await myApi.updateProfile({
      display_name: displayName,
      phone: form.phone.trim(),
      language: form.language,
      country: form.country.trim() || '中国',
    })
    profile.value = updated
    form.username = updated.username
    form.displayName = updated.profile?.display_name || updated.username
    form.phone = updated.profile?.phone || ''
    form.language = updated.profile?.language || '简体中文'
    form.country = updated.profile?.country || '中国'
    ElMessage.success('资料已保存')
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '无法保存账户资料'))
  } finally {
    profileSaving.value = false
  }
}

const uploadAvatar = async (dataUrl: string) => {
  avatarBusy.value = true
  try {
    const updated = await myApi.updateProfile({ avatar_url: dataUrl })
    profile.value = updated
    ElMessage.success('头像已更新')
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '无法更新头像'))
  } finally {
    avatarBusy.value = false
  }
}

const clearAvatar = async () => {
  avatarBusy.value = true
  try {
    const updated = await myApi.updateProfile({ avatar_url: '' })
    profile.value = updated
    ElMessage.success('头像已移除')
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '无法移除头像'))
  } finally {
    avatarBusy.value = false
  }
}


const reloadSessions = async () => {
  sessionsLoading.value = true
  sessionsError.value = ''
  try {
    const data = await auth.listSessions()
    loginSessions.value = data.sessions || []
  } catch (error: any) {
    sessionsError.value = apiErrorMessage(error, '无法加载登录设备')
    throw error
  } finally {
    sessionsLoading.value = false
  }
}

const openTrustDialog = (item: UserSession) => {
  if (!totpStatus.value.enabled) {
    return ElMessage.warning('请先启用身份验证器')
  }
  if (item.status !== 'active' || !item.trust_eligible || item.is_trusted) return
  resetTrustDialog()
  selectedTrustSession.value = item
  trustDialogVisible.value = true
}

const resetTrustDialog = () => {
  selectedTrustSession.value = null
  trustDuration.value = '30d'
  trustPassword.value = ''
  trustCode.value = ''
  trustBusy.value = false
}

const submitSessionTrust = async () => {
  const item = selectedTrustSession.value
  if (!totpStatus.value.enabled) {
    trustDialogVisible.value = false
    return ElMessage.warning('请先启用身份验证器')
  }
  if (!item || item.status !== 'active' || !item.trust_eligible || item.is_trusted) {
    return ElMessage.warning('该设备当前无法设为可信设备')
  }
  if (!trustPassword.value || trustCode.value.length !== 6) {
    return ElMessage.warning('请输入当前密码和 6 位动态验证码')
  }
  trustBusy.value = true
  try {
    await auth.trustSession(item.session_id, {
      duration: trustDuration.value,
      current_password: trustPassword.value,
      code: trustCode.value,
    })
    await reloadSessions()
    trustDialogVisible.value = false
    ElMessage.success('可信设备设置成功')
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '无法设置可信设备'))
  } finally {
    trustBusy.value = false
  }
}

const cancelSessionTrust = async (item: UserSession) => {
  if (!totpStatus.value.enabled) {
    return ElMessage.warning('请先启用身份验证器')
  }
  try {
    await ElMessageBox.confirm(
      `确认取消“${item.device_name}”的可信状态？下次登录将需要两步验证。`,
      '取消可信设备',
      { type: 'warning', confirmButtonText: '确认取消', cancelButtonText: '保留信任' }
    )
    trustBusy.value = true
    await auth.cancelSessionTrust(item.session_id)
    await reloadSessions()
    ElMessage.success('已取消该设备的信任状态')
  } catch (error: any) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(apiErrorMessage(error, '无法取消可信设备'))
  } finally {
    trustBusy.value = false
  }
}

const revokeLoginSession = async (item: UserSession) => {
  if (item.is_current) {
    return ElMessage.warning('当前设备请使用页面底部的“退出登录”操作')
  }
  if (item.status !== 'active') return
  try {
    await ElMessageBox.confirm(
      `确认让“${item.device_name}”退出登录？该设备需要重新验证身份。`,
      '退出登录设备',
      { type: 'warning', confirmButtonText: '确认退出', cancelButtonText: '取消' }
    )
    sessionsBusy.value = true
    await auth.revokeSession(item.session_id)
    await reloadSessions()
    ElMessage.success('该设备已退出登录')
  } catch (error: any) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(apiErrorMessage(error, '无法退出该设备'))
  } finally {
    sessionsBusy.value = false
  }
}

const revokeOtherLoginSessions = async () => {
  try {
    await ElMessageBox.confirm(
      `确认退出其他 ${activeOtherSessionCount.value} 个登录设备？当前设备不会受影响。`,
      '退出其他设备',
      { type: 'warning', confirmButtonText: '全部退出', cancelButtonText: '取消' }
    )
    sessionsBusy.value = true
    await auth.revokeOtherSessions()
    await reloadSessions()
    ElMessage.success('其他设备已全部退出')
  } catch (error: any) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(apiErrorMessage(error, '无法退出其他设备'))
  } finally {
    sessionsBusy.value = false
  }
}

const handleReloginRequired = (response: any, message: string) => {
  if (!auth.requiresRelogin(response)) return false
  auth.clearForRelogin()
  ElMessage.warning(message)
  router.replace('/login')
  return true
}

const reloadSessionsAfterSecurityChange = async () => {
  try {
    await reloadSessions()
  } catch {
    ElMessage.warning('安全设置已更新，但登录设备列表刷新失败，请点击重试')
  }
}

const openTotpSetup = () => {
  resetTotpSetup()
  totpSetupVisible.value = true
}

const openTotpDisable = () => {
  resetTotpDisable()
  totpDisableVisible.value = true
}

const resetTotpSetup = () => {
  totpSetupPassword.value = ''
  totpSetupData.value = null
  totpQrUrl.value = ''
  totpCode.value = ''
  totpBusy.value = false
}

const resetTotpDisable = () => {
  totpDisablePassword.value = ''
  totpDisableCode.value = ''
  totpBusy.value = false
}

const startTotpSetup = async () => {
  if (!totpSetupPassword.value) return ElMessage.warning('请输入当前密码')
  totpBusy.value = true
  try {
    const setup = await auth.setupTotp(totpSetupPassword.value)
    totpSetupData.value = setup
    totpQrUrl.value = await QRCode.toDataURL(setup.otpauth_uri, {
      width: 220,
      margin: 1,
      errorCorrectionLevel: 'M',
    })
    totpSetupPassword.value = ''
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '无法开始绑定身份验证器'))
  } finally {
    totpBusy.value = false
  }
}

const copyTotpSecret = async () => {
  const secret = totpSetupData.value?.secret
  if (!secret) return
  try {
    await navigator.clipboard.writeText(secret)
    ElMessage.success('手动密钥已复制')
  } catch {
    ElMessage.warning('复制失败，请手动选择密钥')
  }
}

const confirmTotpSetup = async () => {
  if (!totpSetupData.value || totpCode.value.length !== 6) {
    return ElMessage.warning('请输入 6 位动态验证码')
  }
  totpBusy.value = true
  try {
    const response = await auth.confirmTotp(
      totpSetupData.value.setup_token,
      totpCode.value,
    )
    if (handleReloginRequired(response, '身份验证器已启用，请重新登录以继续。')) return
    totpStatus.value = response
    totpError.value = ''
    await reloadSessionsAfterSecurityChange()
    totpSetupVisible.value = false
    ElMessage.success('身份验证器已启用')
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '动态验证码验证失败'))
  } finally {
    totpBusy.value = false
  }
}

const disableTotp = async () => {
  if (!totpDisablePassword.value || totpDisableCode.value.length !== 6) {
    return ElMessage.warning('请输入当前密码和 6 位动态验证码')
  }
  totpBusy.value = true
  try {
    const response = await auth.disableTotp(
      totpDisablePassword.value,
      totpDisableCode.value,
    )
    if (handleReloginRequired(response, '身份验证器已停用，请重新登录以继续。')) return
    totpStatus.value = response
    totpError.value = ''
    trustDialogVisible.value = false
    await reloadSessionsAfterSecurityChange()
    totpDisableVisible.value = false
    ElMessage.success('身份验证器已停用')
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '无法停用身份验证器'))
  } finally {
    totpBusy.value = false
  }
}

const changePassword = async () => {
  if (!pwForm.old || !pwForm.new) return ElMessage.warning('请输入完整信息')
  if (pwForm.new !== pwForm.confirm) return ElMessage.error('两次新密码不一致')
  if (pwForm.new.length < 8) return ElMessage.error('密码至少 8 位')
  passwordBusy.value = true
  try {
    const response = await auth.updateMe({
      old_password: pwForm.old,
      password: pwForm.new,
    })
    pwForm.old = ''
    pwForm.new = ''
    pwForm.confirm = ''
    if (handleReloginRequired(response, '密码已修改，请使用新密码重新登录。')) return
    await reloadSessionsAfterSecurityChange()
    ElMessage.success('密码修改成功')
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '无法修改密码'))
  } finally {
    passwordBusy.value = false
  }
}

const savePrefs = async () => {
  try {
    const updated = await myApi.updateProfile({
      notification_prefs: {
        notify_offline: prefs.notifyOffline,
        daily_report: prefs.dailyReport,
        notify_failed: prefs.notifyFailed,
        system_notice: prefs.systemNotice,
      },
    })
    profile.value = updated
    ElMessage.success('通知偏好已保存（发信通道尚未接入）')
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '无法保存通知偏好'))
  }
}

const logout = async () => {
  try {
    await ElMessageBox.confirm('确认退出登录?', '提示', { type: 'warning' })
    await auth.logout()
    router.replace('/login')
  } catch { /* cancelled */ }
}

onMounted(loadData)
</script>

<style src="../components/account/accountPanels.css"></style>

<style scoped>
.account-page {
  padding: 20px 24px;
  background: linear-gradient(180deg, #d8dfeb 0%, #c8d2e0 100%);
  color: #000000;
  min-height: 100vh;
}

.page-head { margin-bottom: 18px; }
.page-head h1 { margin: 0; font-size: 22px; font-weight: 900; }
.sub { color: #1e293b; margin: 4px 0 0; font-size: 13px; }
</style>
