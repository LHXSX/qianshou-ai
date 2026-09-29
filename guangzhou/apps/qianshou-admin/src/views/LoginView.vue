<script setup lang="ts">
/**
 * 登录页（契约 §2.2 + §9）。
 *
 * 两步入：`session/login`（账号密码）→ 需要时 `session/login-totp`（动态验证码）。
 * 错误文案严格按 `code` 分流，其中三件事**必须**互不混淆：
 * - `401 invalid_credentials`：账号或密码不正确；
 * - `403 not_an_admin`：账号密码对，但这个账号没有被授予管理台角色；
 * - `502 upstream_unavailable`：上游账号服务不可达 —— 不是让你重新登录。
 */
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { AdminApiError } from '@/api/errors'
import { login, loginTotp } from '@/api/modules/session'
import { loadSession } from '@/session/store'
import ErrorAlert from '@/components/ErrorAlert.vue'

const route = useRoute()
const router = useRouter()

const step = ref<'credentials' | 'totp'>('credentials')
const username = ref('')
const password = ref('')
const code = ref('')
const trustDevice = ref(false)
const challengeToken = ref('')
const submitting = ref(false)
const error = ref<Error | undefined>(undefined)

const redirectTarget = computed(() => {
  const value = route.query.redirect
  return typeof value === 'string' && value.startsWith('/') ? value : '/'
})

const reasonHint = computed(() => {
  const reason = route.query.reason
  if (reason === 'expired') return '会话已失效（服务重启也会使全部管理台会话失效），请重新登录。'
  return ''
})

async function enterConsole(): Promise<void> {
  try {
    await loadSession()
  } catch (caught) {
    // 登录成功但身份拉取失败：可能是被停用、或上游账号服务抖动，如实展示。
    error.value = caught instanceof Error ? caught : new Error(String(caught))
    return
  }
  ElMessage.success('已登录')
  await router.replace(redirectTarget.value)
}

async function submitCredentials(): Promise<void> {
  if (username.value.trim() === '' || password.value === '') {
    ElMessage.warning('请填写账号与密码')
    return
  }
  submitting.value = true
  error.value = undefined
  try {
    const result = await login({ username: username.value.trim(), password: password.value })
    if (result.twoFactor) {
      if (result.challengeToken === undefined) {
        error.value = new AdminApiError({
          status: 200,
          code: 'unexpected_response',
          message: '服务端要求第二步验证，但没有返回 challengeToken，无法继续。',
        })
        return
      }
      challengeToken.value = result.challengeToken
      step.value = 'totp'
      code.value = ''
      return
    }
    await enterConsole()
  } catch (caught) {
    error.value = caught instanceof Error ? caught : new Error(String(caught))
  } finally {
    submitting.value = false
  }
}

async function submitTotp(): Promise<void> {
  if (!/^\d{6}$/.test(code.value.trim())) {
    ElMessage.warning('请输入 6 位动态验证码')
    return
  }
  submitting.value = true
  error.value = undefined
  try {
    await loginTotp({ challengeToken: challengeToken.value, code: code.value.trim(), trustDevice: trustDevice.value })
    await enterConsole()
  } catch (caught) {
    error.value = caught instanceof Error ? caught : new Error(String(caught))
  } finally {
    submitting.value = false
  }
}

function backToCredentials(): void {
  step.value = 'credentials'
  challengeToken.value = ''
  code.value = ''
  error.value = undefined
}
</script>

<template>
  <div class="login">
    <el-card class="login__card" shadow="always">
      <h1 class="login__title">千手 AI 运营管理台</h1>
      <p class="login__sub">admin.qianshousuanli.com · 与 AI 客户端同一套账号体系</p>

      <el-alert v-if="reasonHint" class="login__hint" type="warning" :closable="false" show-icon :title="reasonHint" />

      <ErrorAlert v-if="error" :error="error" />

      <el-form v-if="step === 'credentials'" label-position="top" @submit.prevent="submitCredentials">
        <el-form-item label="账号">
          <el-input v-model="username" placeholder="与手机端/电脑端相同的账号" autocomplete="username" size="large"
            @keyup.enter="submitCredentials" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="password" type="password" show-password autocomplete="current-password" size="large"
            @keyup.enter="submitCredentials" />
        </el-form-item>
        <el-button type="primary" size="large" class="login__submit" :loading="submitting" @click="submitCredentials">
          下一步
        </el-button>
      </el-form>

      <el-form v-else label-position="top" @submit.prevent="submitTotp">
        <p class="login__step">第二步：动态验证码（TOTP）</p>
        <el-form-item label="6 位验证码">
          <el-input v-model="code" maxlength="6" size="large" placeholder="123456" autocomplete="one-time-code"
            @keyup.enter="submitTotp" />
        </el-form-item>
        <el-form-item>
          <el-checkbox v-model="trustDevice">在此设备上信任（跟随服务端策略）</el-checkbox>
        </el-form-item>
        <div class="login__actions">
          <el-button size="large" @click="backToCredentials">返回上一步</el-button>
          <el-button type="primary" size="large" :loading="submitting" @click="submitTotp">登录</el-button>
        </div>
      </el-form>

      <p class="login__foot">
        管理台会话保存在服务端内存中：服务重启即全部失效，需要重新登录。
        来源 IP 必须先在白名单内，否则连本页面都不会下发（403 ip_not_allowed）。
      </p>
    </el-card>
  </div>
</template>

<style scoped>
.login {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 24px;
  background: linear-gradient(160deg, #1f2d3d 0%, #2f6fed 100%);
}

.login__card {
  width: 100%;
  max-width: 420px;
  border-radius: 10px;
}

.login__title {
  margin: 0 0 6px;
  font-size: 20px;
}

.login__sub {
  margin: 0 0 18px;
  color: #909399;
  font-size: 13px;
}

.login__hint {
  margin-bottom: 14px;
}

.login__submit {
  width: 100%;
}

.login__step {
  margin: 0 0 12px;
  font-weight: 600;
}

.login__actions {
  display: flex;
  gap: 12px;
}

.login__actions .el-button {
  flex: 1;
}

.login__foot {
  margin: 18px 0 0;
  color: #909399;
  font-size: 12px;
  line-height: 1.7;
}
</style>
