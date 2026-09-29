<template>
  <div class="account-panel">
  <div class="account-content account-content-wide">
    <div v-if="profileLoading" class="loading-state section-loading">正在加载账户资料...</div>
    <div v-else-if="profileError" class="section-error" role="alert">
      <div><strong>账户资料加载失败</strong><p>{{ profileError }}</p></div>
      <button class="btn-ghost" @click="emit('retry-profile')">重试</button>
    </div>
    <section class="panel security-overview">
      <header class="panel-head">
        <div>
          <h3>🛡️ 保护您的账户</h3>
          <p class="panel-description">完成以下安全措施，降低账户被盗风险</p>
        </div>
      </header>
      <div class="security-score">
        <div class="score-ring" :style="{ '--score': `${securityScore * 3.6}deg` }">
          <div><strong>{{ securityScore }}%</strong><span>安全度</span></div>
        </div>
        <div class="security-checks">
          <div v-for="item in securityChecks" :key="item.label" :class="{ complete: item.complete }">
            <span>{{ item.complete ? '✓' : '○' }}</span>
            <div>
              <strong>{{ item.label }}</strong>
              <small>{{ item.description }}</small>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="panel">
      <header class="panel-head panel-head-row">
        <div>
          <h3>🕘 登录记录</h3>
          <p class="panel-description">检查最近的账户访问活动</p>
        </div>
        <button class="btn-ghost" @click="focusPassword">发现异常？修改密码</button>
      </header>
      <div class="login-event">
        <div class="login-status-icon">✓</div>
        <div>
          <strong>登录成功</strong>
          <p>{{ formatDateTime(profile?.last_login_at) }}</p>
          <small>{{ profile?.profile?.last_login_location || '本地环境' }}</small>
        </div>
        <span class="status-safe">正常</span>
      </div>
      <p class="history-note">仅显示当前可用的最近登录记录。</p>
    </section>

    <section ref="loginSessionsSection" class="panel">
      <header class="panel-head panel-head-row">
        <div>
          <h3>💻 历史登录设备</h3>
          <p class="panel-description">同一浏览器或客户端重复登录会合并显示；可远程退出不再使用的设备</p>
        </div>
        <button
          class="btn-danger-outline"
          :disabled="sessionsBusy || sessionsLoading || !!sessionsError || activeOtherSessionCount === 0"
          @click="emit('revoke-other-sessions')"
        >
          退出其他设备<span v-if="activeOtherSessionCount">（{{ activeOtherSessionCount }}）</span>
        </button>
      </header>

      <div
        v-if="!totpLoading && !totpError && !totpStatus.enabled"
        class="trust-management-note"
      >
        <span>i</span>
        启用身份验证器后，才能设置或取消可信设备。
      </div>

      <div v-if="sessionsLoading" class="loading-state section-loading">正在加载登录设备...</div>
      <div v-else-if="sessionsError" class="section-error compact" role="alert">
        <div><strong>登录设备加载失败</strong><p>{{ sessionsError }}</p></div>
        <button class="btn-ghost" @click="emit('reload-sessions')">重试</button>
      </div>
      <div v-else-if="devicesForDisplay.length" class="session-list">
        <article
          v-for="item in visibleLoginSessions"
          :key="item.session_id"
          class="session-item"
          :class="{
            revoked: item.status === 'revoked',
            expired: item.status === 'expired',
          }"
        >
          <div class="session-device-icon">{{ deviceIcon(item.device_type) }}</div>
          <div class="session-copy">
            <div class="session-title">
              <strong>{{ item.device_name }}</strong>
              <span
                v-if="item.is_current && item.status === 'active'"
                class="session-badge current"
              >当前设备</span>
              <span v-else class="session-badge" :class="item.status">
                {{ sessionStatusLabel(item.status) }}
              </span>
              <span class="trust-badge" :class="trustBadge(item).tone">
                {{ trustBadge(item).label }}
              </span>
            </div>
            <p>{{ item.browser }} · {{ item.os }} · {{ item.client_ip || '未知 IP' }}</p>
            <small>
              首次登录 {{ formatDateTime(item.created_at) }} ·
              最近活动 {{ formatDateTime(item.last_seen_at) }}
            </small>
            <span
              v-if="item.status === 'active' && !item.is_trusted && !item.trust_eligible"
              class="session-trust-note"
            >
              此设备需要重新登录后，才能设为可信设备。
            </span>
          </div>
          <div
            v-if="item.is_trusted || item.status === 'active'"
            class="session-actions"
          >
            <button
              v-if="item.is_trusted"
              class="btn-trust-cancel"
              :disabled="sessionsBusy || trustBusy || !totpStatus.enabled"
              :title="totpStatus.enabled ? '取消此设备的信任状态' : '请先启用两步验证'"
              @click="emit('cancel-session-trust', item)"
            >
              取消信任
            </button>
            <button
              v-else-if="item.status === 'active' && item.trust_eligible"
              class="btn-ghost"
              :disabled="sessionsBusy || trustBusy || !totpStatus.enabled"
              :title="totpStatus.enabled ? '设置可信时长' : '请先启用两步验证'"
              @click="emit('open-trust-dialog', item)"
            >
              设为可信
            </button>
            <button
              v-if="item.status === 'active' && !item.is_current"
              class="btn-ghost"
              :disabled="sessionsBusy || trustBusy"
              @click="emit('revoke-session', item)"
            >
              退出设备
            </button>
            <span
              v-else-if="item.is_current && item.status === 'active'"
              class="current-device-note"
            >正在使用</span>
          </div>
        </article>
        <button
          v-if="devicesForDisplay.length > 3"
          type="button"
          class="session-expand-button"
          :aria-expanded="sessionsExpanded"
          @click="sessionsExpanded = !sessionsExpanded"
        >
          <span>{{ sessionsExpanded ? '收起设备列表' : `展开全部设备（${devicesForDisplay.length}）` }}</span>
          <span class="session-expand-icon" :class="{ expanded: sessionsExpanded }">⌄</span>
        </button>
      </div>
      <div v-else class="empty-sessions">
        <span>💻</span>
        <div>
          <strong>暂无登录设备记录</strong>
          <p>重新登录后，设备会显示在这里。</p>
        </div>
      </div>
    </section>

    <section class="panel">
      <header class="panel-head">
        <div>
          <h3>🔑 密码设置</h3>
          <p class="panel-description">定期更换高强度密码，避免与其他网站重复使用</p>
        </div>
      </header>
      <div ref="passwordSection" class="form-grid">
        <div class="form-row form-row-full">
          <label>当前密码</label>
          <input
            :value="passwordForm.old"
            type="password"
            autocomplete="current-password"
            placeholder="请输入当前密码"
            @input="updatePasswordForm('old', $event)"
          />
        </div>
        <div class="form-row">
          <label>新密码</label>
          <input
            :value="passwordForm.new"
            type="password"
            autocomplete="new-password"
            placeholder="至少 8 位"
            @input="updatePasswordForm('new', $event)"
          />
        </div>
        <div class="form-row">
          <label>确认密码</label>
          <input
            :value="passwordForm.confirm"
            type="password"
            autocomplete="new-password"
            placeholder="再次输入新密码"
            @input="updatePasswordForm('confirm', $event)"
          />
        </div>
      </div>
      <div class="form-actions">
        <button class="btn-primary" :disabled="passwordBusy" @click="emit('change-password')">
          {{ passwordBusy ? '正在修改...' : '🔑 修改密码' }}
        </button>
      </div>
    </section>

    <section class="panel">
      <header class="panel-head panel-head-row two-factor-head">
        <div>
          <h3>📲 两步验证</h3>
          <p class="panel-description">登录时增加一次身份验证，建议优先使用身份验证器</p>
        </div>
        <div class="two-factor-master">
          <div>
            <strong>{{ totpStatus.enabled ? '保护已开启' : '保护已关闭' }}</strong>
            <small>{{ totpStatus.enabled ? '身份验证器正在保护账户' : '开启后需完成身份验证器绑定' }}</small>
          </div>
          <label class="toggle" :class="{ 'is-disabled': totpBusy }">
            <input
              type="checkbox"
              :checked="totpStatus.enabled"
              :disabled="totpBusy"
              aria-label="两步验证总开关"
              @change="handleTwoFactorToggle"
            >
            <span class="slider"></span>
          </label>
        </div>
      </header>
      <div v-if="totpLoading" class="loading-state section-loading">正在加载两步验证状态...</div>
      <div v-else-if="totpError" class="section-error compact" role="alert">
        <div><strong>两步验证状态加载失败</strong><p>{{ totpError }}</p></div>
        <button class="btn-ghost" @click="emit('reload-totp')">重试</button>
      </div>
      <template v-else>
        <div class="two-factor-link-note" :class="{ active: totpStatus.enabled }">
          <span>{{ totpStatus.enabled ? '✓' : 'i' }}</span>
          {{ totpStatus.enabled
            ? '总开关已开启；登录时只会显示已启用的验证方式，身份验证器停用后会同步关闭。'
            : '开启总开关将进入身份验证器绑定流程；完成验证前不会改变当前状态。' }}
        </div>
        <div class="method-grid">
          <article class="security-method recommended">
            <div class="method-icon">APP</div>
            <div class="method-title">
              <strong>身份验证器</strong>
              <span>推荐</span>
            </div>
            <p>通过手机身份验证器生成动态验证码。</p>
            <div class="method-footer">
              <div>
                <b :class="{ 'is-active': totpStatus.enabled }">
                  {{ totpStatus.enabled ? '已启用' : '未启用' }}
                </b>
                <small v-if="totpStatus.enabled_at">启用于 {{ formatDateTime(totpStatus.enabled_at) }}</small>
              </div>
              <button class="btn-ghost" @click="handleAuthenticatorAction">
                {{ totpStatus.enabled ? '停用' : '启用' }}
              </button>
            </div>
          </article>
          <article class="security-method" :class="{ 'method-disabled': !totpStatus.enabled }">
            <div class="method-icon">邮箱</div>
            <div class="method-title"><strong>邮箱验证</strong></div>
            <p>验证码将发送到当前登录邮箱。</p>
            <div class="method-footer">
              <b>未启用</b>
              <button class="btn-ghost" disabled>即将开放</button>
            </div>
          </article>
          <article class="security-method" :class="{ 'method-disabled': !totpStatus.enabled }">
            <div class="method-icon">短信</div>
            <div class="method-title"><strong>短信验证</strong></div>
            <p>通过绑定手机号接收一次性验证码。</p>
            <div class="method-footer">
              <b>{{ profileForm.phone ? '号码已绑定 · 未启用' : '未绑定' }}</b>
              <button class="btn-ghost" disabled>启用</button>
            </div>
          </article>
          <article class="security-method" :class="{ 'method-disabled': !totpStatus.enabled }">
            <div class="method-icon">设备</div>
            <div class="method-title"><strong>可信设备</strong></div>
            <p>可信设备可减少重复的两步验证。</p>
            <div class="method-footer">
              <b>{{ totpStatus.enabled ? `${trustedDeviceCount} 台设备` : '两步验证关闭' }}</b>
              <button
                class="btn-ghost"
                :disabled="!totpStatus.enabled"
                @click="focusLoginSessions"
              >
                管理
              </button>
            </div>
          </article>
        </div>
      </template>
    </section>

    <section class="panel">
      <header class="panel-head">
        <div>
          <h3>📞 手机号码</h3>
          <p class="panel-description">用于身份验证、找回账户和接收安全提醒</p>
        </div>
      </header>
      <div class="setting-row phone-row">
        <div class="setting-icon">+86</div>
        <div class="setting-copy">
          <strong>{{ profileForm.phone || '尚未绑定手机号码' }}</strong>
          <small>{{ profileForm.phone ? '手机号码已添加到账户' : '添加手机号码可进一步提高账户安全性' }}</small>
        </div>
        <button class="btn-ghost" disabled>{{ profileForm.phone ? '编辑' : '添加' }}</button>
      </div>
    </section>

    <section class="panel danger-zone">
      <header class="panel-head">
        <h3>⚠️ 危险操作</h3>
      </header>
      <div class="danger-item">
        <div>
          <strong>退出登录</strong>
          <p class="muted">退出当前账户,清除本地令牌</p>
        </div>
        <button class="btn-danger-outline" @click="emit('logout')">退出登录</button>
      </div>
      <div class="danger-item">
        <div>
          <strong>注销账户</strong>
          <p class="muted">永久删除账户、节点和所有数据(不可恢复)</p>
        </div>
        <button class="btn-danger-outline" disabled>申请注销</button>
      </div>
    </section>
  </div>
  </div>

  <ElDialog
    :model-value="totpSetupVisible"
    title="启用身份验证器"
    width="520px"
    append-to-body
    destroy-on-close
    @update:model-value="emit('update:totp-setup-visible', $event)"
    @closed="emit('reset-totp-setup')"
  >
    <div class="account-panel">
    <div v-if="!totpSetupData" class="totp-password-step">
      <p class="dialog-intro">请先验证当前密码，然后使用 Microsoft Authenticator 等应用扫描二维码。</p>
      <div class="form-row">
        <label>当前密码</label>
        <input
          :value="totpSetupPassword"
          type="password"
          autocomplete="current-password"
          placeholder="请输入当前密码"
          @input="emitInput('update:totp-setup-password', $event)"
          @keyup.enter="emit('start-totp-setup')"
        />
      </div>
    </div>

    <div v-else class="totp-setup-step">
      <div class="totp-qr-wrap">
        <img v-if="totpQrUrl" :src="totpQrUrl" alt="身份验证器二维码" />
        <span v-else>二维码生成中...</span>
      </div>
      <div class="totp-instructions">
        <strong>1. 扫描二维码</strong>
        <p>在身份验证器应用中添加新账户并扫描上方二维码。</p>
        <strong>2. 无法扫码时手动输入</strong>
        <div class="manual-secret">
          <code>{{ totpSetupData.secret }}</code>
          <button class="btn-ghost btn-small" @click="emit('copy-totp-secret')">复制</button>
        </div>
        <strong>3. 输入 6 位动态码</strong>
        <input
          :value="totpCode"
          class="totp-code-input"
          inputmode="numeric"
          autocomplete="one-time-code"
          maxlength="6"
          placeholder="000000"
          @input="updateTotpCode('setup', $event)"
          @keyup.enter="emit('confirm-totp-setup')"
        />
        <p class="setup-expiry">绑定信息将在 {{ Math.ceil(totpSetupData.expires_in / 60) }} 分钟后过期。</p>
      </div>
    </div>
    </div>

    <template #footer>
      <div class="account-panel">
      <button class="btn-ghost" @click="emit('update:totp-setup-visible', false)">取消</button>
      <button
        v-if="!totpSetupData"
        class="btn-primary"
        :disabled="totpBusy || !totpSetupPassword"
        @click="emit('start-totp-setup')"
      >
        {{ totpBusy ? '正在生成...' : '下一步' }}
      </button>
      <button
        v-else
        class="btn-primary"
        :disabled="totpBusy || totpCode.length !== 6"
        @click="emit('confirm-totp-setup')"
      >
        {{ totpBusy ? '正在验证...' : '确认启用' }}
      </button>
      </div>
    </template>
  </ElDialog>

  <ElDialog
    :model-value="totpDisableVisible"
    title="停用身份验证器"
    width="460px"
    append-to-body
    destroy-on-close
    @update:model-value="emit('update:totp-disable-visible', $event)"
    @closed="emit('reset-totp-disable')"
  >
    <div class="account-panel">
    <p class="dialog-intro">停用后账户将不再显示身份验证器保护状态。请再次验证密码和当前动态码。</p>
    <div class="form-row">
      <label>当前密码</label>
      <input
        :value="totpDisablePassword"
        type="password"
        autocomplete="current-password"
        placeholder="请输入当前密码"
        @input="emitInput('update:totp-disable-password', $event)"
      />
    </div>
    <div class="form-row">
      <label>6 位动态验证码</label>
      <input
        :value="totpDisableCode"
        class="totp-code-input"
        inputmode="numeric"
        autocomplete="one-time-code"
        maxlength="6"
        placeholder="000000"
        @input="updateTotpCode('disable', $event)"
        @keyup.enter="emit('disable-totp')"
      />
    </div>
    </div>
    <template #footer>
      <div class="account-panel">
      <button class="btn-ghost" @click="emit('update:totp-disable-visible', false)">取消</button>
      <button
        class="btn-danger-outline"
        :disabled="totpBusy || !totpDisablePassword || totpDisableCode.length !== 6"
        @click="emit('disable-totp')"
      >
        {{ totpBusy ? '正在停用...' : '确认停用' }}
      </button>
      </div>
    </template>
  </ElDialog>

  <ElDialog
    :model-value="trustDialogVisible"
    title="设为可信设备"
    width="500px"
    append-to-body
    destroy-on-close
    :close-on-click-modal="!trustBusy"
    :close-on-press-escape="!trustBusy"
    :show-close="!trustBusy"
    @update:model-value="emit('update:trust-dialog-visible', $event)"
    @closed="emit('reset-trust-dialog')"
  >
    <div class="account-panel">
    <div class="trust-dialog-hero">
      <div class="trust-dialog-icon">🛡️</div>
      <div>
        <strong>{{ selectedTrustSession?.device_name || '所选设备' }}</strong>
        <p>
          在所选期限内，{{ selectedTrustSession?.is_current ? '当前浏览器' : '该设备' }}
          登录时可减少重复的两步验证。
        </p>
      </div>
    </div>

    <div class="form-row">
      <label>信任时长</label>
      <ElRadioGroup
        :model-value="trustDuration"
        class="trust-duration-group"
        @update:model-value="updateTrustDuration"
      >
        <ElRadioButton
          v-for="option in trustDurationOptions"
          :key="option.value"
          :label="option.value"
        >
          {{ option.label }}
        </ElRadioButton>
      </ElRadioGroup>
      <p class="field-hint">
        信任设置仅对“{{ selectedTrustSession?.device_name || '所选设备' }}”的安全凭据生效。
      </p>
    </div>

    <div class="trust-verification-grid">
      <div class="form-row">
        <label>当前密码</label>
        <input
          :value="trustPassword"
          type="password"
          autocomplete="current-password"
          placeholder="请输入当前密码"
          @input="emitInput('update:trust-password', $event)"
        />
      </div>
      <div class="form-row">
        <label>6 位动态验证码</label>
        <input
          :value="trustCode"
          class="totp-code-input trust-code-input"
          inputmode="numeric"
          autocomplete="one-time-code"
          maxlength="6"
          placeholder="000000"
          @input="updateTrustCode"
          @keyup.enter="emit('submit-session-trust')"
        />
      </div>
    </div>
    </div>

    <template #footer>
      <div class="account-panel">
      <button
        class="btn-ghost"
        :disabled="trustBusy"
        @click="emit('update:trust-dialog-visible', false)"
      >
        取消
      </button>
      <button
        class="btn-primary"
        :disabled="trustBusy || !trustPassword || trustCode.length !== 6"
        @click="emit('submit-session-trust')"
      >
        {{ trustBusy ? '正在验证...' : '确认信任' }}
      </button>
      </div>
    </template>
  </ElDialog>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElDialog, ElRadioGroup, ElRadioButton } from 'element-plus'
import type {
  MyProfile,
  TotpSetupResponse,
  TotpStatus,
  TrustDeviceDuration,
  UserSession,
} from '../../services/api'
import type {
  AccountProfileForm,
  PasswordField,
  PasswordForm,
} from './types'

const props = defineProps<{
  profile: MyProfile | null
  profileForm: AccountProfileForm
  profileLoading: boolean
  profileError: string
  passwordForm: PasswordForm
  passwordBusy: boolean
  totpStatus: TotpStatus
  totpLoading: boolean
  totpError: string
  totpSetupVisible: boolean
  totpDisableVisible: boolean
  totpSetupPassword: string
  totpDisablePassword: string
  totpSetupData: TotpSetupResponse | null
  totpQrUrl: string
  totpCode: string
  totpDisableCode: string
  totpBusy: boolean
  loginSessions: UserSession[]
  sessionsLoading: boolean
  sessionsError: string
  sessionsBusy: boolean
  trustDialogVisible: boolean
  selectedTrustSession: UserSession | null
  trustDuration: TrustDeviceDuration
  trustPassword: string
  trustCode: string
  trustBusy: boolean
  trustDurationOptions: Array<{ value: TrustDeviceDuration; label: string }>
}>()

const emit = defineEmits<{
  'retry-profile': []
  'reload-sessions': []
  'revoke-other-sessions': []
  'cancel-session-trust': [session: UserSession]
  'open-trust-dialog': [session: UserSession]
  'revoke-session': [session: UserSession]
  'update-password-form': [field: PasswordField, value: string]
  'change-password': []
  'reload-totp': []
  'open-totp-setup': []
  'open-totp-disable': []
  logout: []
  'update:totp-setup-visible': [value: boolean]
  'update:totp-disable-visible': [value: boolean]
  'update:totp-setup-password': [value: string]
  'update:totp-disable-password': [value: string]
  'update:totp-code': [value: string]
  'update:totp-disable-code': [value: string]
  'reset-totp-setup': []
  'reset-totp-disable': []
  'start-totp-setup': []
  'copy-totp-secret': []
  'confirm-totp-setup': []
  'disable-totp': []
  'update:trust-dialog-visible': [value: boolean]
  'update:trust-duration': [value: TrustDeviceDuration]
  'update:trust-password': [value: string]
  'update:trust-code': [value: string]
  'reset-trust-dialog': []
  'submit-session-trust': []
}>()

type StringUpdateEvent =
  | 'update:totp-setup-password'
  | 'update:totp-disable-password'
  | 'update:trust-password'

const passwordSection = ref<HTMLElement | null>(null)
const loginSessionsSection = ref<HTMLElement | null>(null)
const sessionsExpanded = ref(false)

const trustedDeviceCount = computed(() => new Set(
  props.loginSessions
    .filter((item) => item.is_trusted)
    .map((item) => item.device_id || item.session_id)
).size)

/** 同一可信设备只展示最新一条，避免每次登录都看起来像「新增同名设备」。 */
const devicesForDisplay = computed(() => {
  const bestByDevice = new Map<string, UserSession>()
  const orphans: UserSession[] = []

  const prefer = (current: UserSession, candidate: UserSession): UserSession => {
    if (candidate.is_current && !current.is_current) return candidate
    if (current.is_current && !candidate.is_current) return current
    const rank = (item: UserSession) => {
      if (item.status === 'active') return 3
      if (item.status === 'expired') return 2
      return 1
    }
    const candidateRank = rank(candidate)
    const currentRank = rank(current)
    if (candidateRank !== currentRank) {
      return candidateRank > currentRank ? candidate : current
    }
    return Date.parse(candidate.last_seen_at) > Date.parse(current.last_seen_at)
      ? candidate
      : current
  }

  for (const item of props.loginSessions) {
    if (!item.device_id) {
      orphans.push(item)
      continue
    }
    const existing = bestByDevice.get(item.device_id)
    bestByDevice.set(
      item.device_id,
      existing ? prefer(existing, item) : item,
    )
  }

  return [...bestByDevice.values(), ...orphans].sort((a, b) => {
    if (a.is_current !== b.is_current) return a.is_current ? -1 : 1
    return Date.parse(b.last_seen_at) - Date.parse(a.last_seen_at)
  })
})

const activeOtherSessionCount = computed(
  () => devicesForDisplay.value.filter((item) => item.status === 'active' && !item.is_current).length
)
const visibleLoginSessions = computed(() =>
  sessionsExpanded.value ? devicesForDisplay.value : devicesForDisplay.value.slice(0, 3)
)
const hasVerifiedLoginEmail = computed(() => {
  const email = props.profile?.email?.trim() || ''
  return Boolean(email) && !/@local$/i.test(email)
})
const securityChecks = computed(() => [
  { label: '验证登录邮箱', description: '确保可以接收安全通知', complete: hasVerifiedLoginEmail.value },
  { label: '添加手机号码', description: '用于找回账户和短信验证', complete: Boolean(props.profileForm.phone) },
  { label: '启用两步验证', description: '使用身份验证器保护登录', complete: props.totpStatus.enabled },
  { label: '注册可信设备', description: '管理经常使用的登录设备', complete: trustedDeviceCount.value > 0 },
])
const securityScore = computed(() => {
  const completed = securityChecks.value.filter((item) => item.complete).length
  return Math.round((completed / securityChecks.value.length) * 100)
})

const updatePasswordForm = (field: PasswordField, event: Event) => {
  emit('update-password-form', field, (event.target as HTMLInputElement).value)
}

const emitInput = (eventName: StringUpdateEvent, event: Event) => {
  const value = (event.target as HTMLInputElement).value
  if (eventName === 'update:totp-setup-password') {
    emit(eventName, value)
  } else if (eventName === 'update:totp-disable-password') {
    emit(eventName, value)
  } else {
    emit(eventName, value)
  }
}

const updateTotpCode = (target: 'setup' | 'disable', event: Event) => {
  const input = event.target as HTMLInputElement
  const value = input.value.replace(/\D/g, '').slice(0, 6)
  input.value = value
  if (target === 'setup') {
    emit('update:totp-code', value)
  } else {
    emit('update:totp-disable-code', value)
  }
}

const updateTrustCode = (event: Event) => {
  const input = event.target as HTMLInputElement
  const value = input.value.replace(/\D/g, '').slice(0, 6)
  input.value = value
  emit('update:trust-code', value)
}

const updateTrustDuration = (value: string | number | boolean | undefined) => {
  emit('update:trust-duration', value as TrustDeviceDuration)
}

const handleTwoFactorToggle = (event: Event) => {
  const checkbox = event.target as HTMLInputElement
  checkbox.checked = props.totpStatus.enabled
  if (props.totpBusy) return
  handleAuthenticatorAction()
}

const handleAuthenticatorAction = () => {
  if (props.totpStatus.enabled) {
    emit('open-totp-disable')
  } else {
    emit('open-totp-setup')
  }
}

const focusPassword = () => {
  passwordSection.value?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  window.setTimeout(() => passwordSection.value?.querySelector('input')?.focus(), 350)
}

const focusLoginSessions = () => {
  loginSessionsSection.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

const deviceIcon = (type: UserSession['device_type']) => {
  const icons: Record<string, string> = {
    desktop: '🖥️',
    mobile: '📱',
    tablet: '📟',
    client: '⚡',
    unknown: '💻',
  }
  return icons[type || 'unknown'] || '💻'
}

const trustBadge = (item: UserSession) => {
  if (item.is_trusted && item.trust_permanent) {
    return { label: '永久信任', tone: 'permanent' }
  }
  if (item.is_trusted && item.trusted_until) {
    return {
      label: `信任至 ${formatTrustDate(item.trusted_until)}`,
      tone: 'trusted',
    }
  }
  if (item.is_trusted) {
    return { label: '可信设备', tone: 'trusted' }
  }
  return { label: '未信任', tone: 'untrusted' }
}

const sessionStatusLabel = (status: UserSession['status']) => {
  const labels: Record<string, string> = {
    active: '已登录',
    expired: '已过期',
    revoked: '已退出',
  }
  return labels[status || ''] || '未知状态'
}

const formatTrustDate = (value: string) => {
  try {
    return new Date(value).toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
  } catch {
    return value
  }
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
