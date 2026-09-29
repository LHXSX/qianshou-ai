<template>
  <AuthFrame title="开始你的千手之旅" description="创建账号，连接应用、设备与分布式算力。" eyebrow="CREATE YOUR ACCOUNT">
    <div class="auth-methods" role="tablist" aria-label="注册方式">
      <button type="button" role="tab" :aria-selected="method === 'phone'" :class="{ selected: method === 'phone' }" @click="method = 'phone'">手机号注册</button>
      <button type="button" role="tab" :aria-selected="method === 'password'" :class="{ selected: method === 'password' }" @click="method = 'password'">账号密码</button>
    </div>
    <div v-if="error" class="qs-error auth-error" role="alert">{{ error }}</div>
    <PhoneCodeForm v-if="method === 'phone'" purpose="register" :busy="busy" @submit="submitPhone" />
    <p v-if="method === 'phone'" class="phone-enterprise-note">
      手机号先创建个人账号；企业服务请创建账号后<router-link to="/beta">提交合作需求</router-link>，需审核开通。
    </p>
    <form v-else class="qs-form" @submit.prevent="submitPassword">
      <div v-if="success" class="qs-form-status" role="status">
        账号已创建。<span v-if="role === 'enterprise'">企业用途已登记，当前仍按个人权限使用。企业服务请<router-link to="/beta">提交合作需求</router-link>。</span>
        <router-link to="/login">前往登录 →</router-link>
      </div>
      <template v-else>
        <div class="qs-field"><label for="register-username">账号</label><input id="register-username" v-model="username" autocomplete="username" required minlength="3" maxlength="20" placeholder="3–20 个字符" :disabled="busy"></div>
        <div class="qs-field"><label for="register-password">密码</label><div class="qs-password"><input id="register-password" v-model="password" :type="showPassword ? 'text' : 'password'" autocomplete="new-password" required minlength="6" maxlength="128" placeholder="至少 6 位，建议使用较长且独立的密码" :disabled="busy"><button type="button" :aria-label="showPassword ? '隐藏密码' : '显示密码'" @click="showPassword = !showPassword">{{ showPassword ? '隐藏' : '显示' }}</button></div></div>
        <div class="qs-field"><label for="register-confirm">确认密码</label><input id="register-confirm" v-model="confirmPassword" type="password" autocomplete="new-password" required placeholder="再次输入密码" :disabled="busy"></div>
        <fieldset class="register-role"><legend>账号用途</legend><div class="qs-role-options"><label><input v-model="role" type="radio" value="individual" :disabled="busy">个人使用</label><label><input v-model="role" type="radio" value="enterprise" :disabled="busy">企业用途登记</label></div><p>企业用途只记录需求。新账号先按个人权限使用；企业服务与权限需另行审核开通。</p></fieldset>
        <label class="qs-check"><input v-model="agree" type="checkbox" required :disabled="busy"><span>我已阅读并同意 <router-link to="/terms" target="_blank">用户服务协议</router-link> 和 <router-link to="/privacy" target="_blank">隐私政策</router-link>。</span></label>
        <button class="qs-button primary" type="submit" :disabled="busy">{{ busy ? '正在创建…' : '创建账号' }} <span>↗</span></button>
      </template>
    </form>
    <div class="qs-auth-links">已有账号？ <router-link to="/login">登录工作空间</router-link><div class="workspaces"><a href="/ea/#/login">企业工作台 ↗</a></div></div>
  </AuthFrame>
</template>

<script setup lang="ts">
import { onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import AuthFrame from '../shared/AuthFrame.vue'
import PhoneCodeForm from '../components/auth/PhoneCodeForm.vue'
import '../shared/auth-form.css'
import { auth } from '../services/api'
import type { WebLoginAttempt } from '../services/browserSession'
import { errorMessage } from '../services/identityContract'

const router = useRouter()
const method = ref<'phone' | 'password'>('phone')
const username = ref(''), password = ref(''), confirmPassword = ref('')
const role = ref('individual'), agree = ref(false), showPassword = ref(false)
const busy = ref(false), error = ref(''), success = ref(false)
let attempt: WebLoginAttempt | null = null
let disposed = false
onUnmounted(() => { disposed = true; if (attempt) void auth.cancelLogin(attempt) })

async function submitPhone(payload: { phone: string; code: string; rememberMe: boolean }) {
  if (busy.value) return
  error.value = ''; busy.value = true
  let accountCreated = false
  try {
    const ticket = await auth.beginLogin(payload.rememberMe)
    attempt = ticket
    if (disposed) { await auth.cancelLogin(ticket); return }
    const response = await auth.registerWithPhone(payload.phone, payload.code, payload.rememberMe, ticket)
    accountCreated = true
    await auth.setSession({ accessToken: response.access_token, refreshToken: response.refresh_token,
      user: response.user, rememberMe: payload.rememberMe }, ticket)
    if (!disposed && attempt === ticket) {
      attempt = null
      await router.replace('/dashboard')
    }
  } catch (e) { if (!disposed) error.value = accountCreated
    ? '账号已经创建，但登录会话未确认。请转到登录页，用此手机号重新获取验证码登录。'
    : errorMessage(e, '手机号注册失败，请检查验证码。') }
  finally { busy.value = false }
}

async function submitPassword() {
  if (busy.value) return
  error.value = ''
  if (!agree.value) { error.value = '请先阅读并同意用户协议与隐私政策。'; return }
  if (password.value !== confirmPassword.value) { error.value = '两次输入的密码不一致。'; return }
  busy.value = true
  try {
    await auth.register(username.value.trim(), password.value, role.value)
    password.value = ''; confirmPassword.value = ''; success.value = true
  } catch (e) { error.value = errorMessage(e, '注册失败，请检查填写内容。') }
  finally { busy.value = false }
}
</script>

<style scoped>
.auth-methods{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:4px;margin-bottom:22px;border:1px solid var(--qs-line);border-radius:10px;background:rgba(127,145,163,.08)}.auth-methods button{min-height:38px;border:0;border-radius:7px;background:transparent;color:var(--qs-muted);font-size:12px;cursor:pointer}.auth-methods button.selected{background:var(--qs-surface,#fff);color:var(--qs-text);box-shadow:0 2px 8px rgba(15,23,42,.08)}.auth-error{margin-bottom:16px}.register-role{border:0;padding:0;margin:0;min-width:0}.register-role legend{font-size:12px;color:#d0dcdf;margin-bottom:9px}.register-role p{font-size:10px;color:var(--qs-muted);line-height:1.8;margin-top:9px}
.phone-enterprise-note{margin:14px 0 0;padding:12px 14px;border:1px solid #d9e7f8;border-radius:11px;background:#f3f8ff;color:#425670;font-size:12px;line-height:1.7}.phone-enterprise-note a{color:#1559b7;font-weight:650;text-decoration:underline;text-underline-offset:3px}
</style>
