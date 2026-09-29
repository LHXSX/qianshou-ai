<template>
  <AuthFrame :title="challenge ? '验证你的身份' : '欢迎回到千手'"
    :description="challenge ? '输入身份验证器上的动态验证码，完成安全登录。' : '登录个人工作空间，管理设备、任务与账户。'"
    eyebrow="YOUR WORKSPACE AWAITS">
    <div v-if="!challenge" class="auth-methods" role="tablist" aria-label="登录方式">
      <button type="button" role="tab" :disabled="busy" :aria-selected="method === 'password'" :class="{ selected: method === 'password' }" @click="method = 'password'; error = ''">账号密码</button>
      <button type="button" role="tab" :disabled="busy" :aria-selected="method === 'phone'" :class="{ selected: method === 'phone' }" @click="method = 'phone'; error = ''">手机验证码</button>
    </div>
    <div v-if="error" class="qs-error auth-error" role="alert">{{ error }}</div>
    <PhoneCodeForm v-if="method === 'phone' && !challenge" purpose="login" :busy="busy" @submit="submitPhone" />
    <form v-else class="qs-form" @submit.prevent="submitPassword">
      <template v-if="!challenge">
        <div class="qs-field"><label for="login-username">账号</label><input id="login-username" ref="usernameInput" v-model="username" autocomplete="username" required maxlength="100" placeholder="输入账号或邮箱" :disabled="busy"></div>
        <div class="qs-field"><label for="login-password">密码</label><div class="qs-password"><input id="login-password" v-model="password" :type="showPassword ? 'text' : 'password'" autocomplete="current-password" required placeholder="输入密码" :disabled="busy"><button type="button" :aria-label="showPassword ? '隐藏密码' : '显示密码'" :aria-pressed="showPassword" @click="showPassword = !showPassword">{{ showPassword ? '隐藏' : '显示' }}</button></div></div>
        <label class="qs-check"><input v-model="remember" type="checkbox" :disabled="busy"><span>在这台设备上保持登录<br>公共或共用设备建议关闭。</span></label>
      </template>
      <template v-else>
        <div class="qs-field"><label for="totp-code">动态验证码</label><input id="totp-code" ref="codeInput" v-model="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="6 位验证码" required :disabled="busy"><small>验证码只用于本次身份验证。</small></div>
      </template>
      <button class="qs-button primary" type="submit" :disabled="busy">{{ busy ? '正在验证…' : challenge ? '验证并登录' : '登录工作空间' }} <span v-if="!busy">↗</span></button>
      <button v-if="challenge" class="qs-text-button" type="button" :disabled="busy" @click="resetChallenge">返回{{ method === 'phone' ? '手机' : '账号' }}登录</button>
    </form>
    <div class="qs-auth-links">还没有账号？ <router-link to="/register">创建账号</router-link><div class="workspaces"><a href="/ea/#/login">企业工作台 ↗</a><router-link to="/access">运营管理入口 ↗</router-link></div></div>
  </AuthFrame>
</template>

<script setup lang="ts">
import { ref, nextTick, onMounted, onUnmounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import AuthFrame from '../shared/AuthFrame.vue'
import PhoneCodeForm from '../components/auth/PhoneCodeForm.vue'
import '../shared/auth-form.css'
import { auth, type AuthLoginResponse } from '../services/api'
import type { WebLoginAttempt } from '../services/browserSession'
import { errorMessage } from '../services/identityContract'

const router = useRouter(), route = useRoute()
const method = ref<'password' | 'phone'>('password')
const username = ref(''), password = ref(''), remember = ref(false), showPassword = ref(false)
const busy = ref(false), error = ref(''), challenge = ref(''), code = ref('')
const challengeRemember = ref(false)
const usernameInput = ref<HTMLInputElement>(), codeInput = ref<HTMLInputElement>()
let attempt: WebLoginAttempt | null = null
let disposed = false

onMounted(() => { error.value = auth.sessionError() || ''; usernameInput.value?.focus() })
onUnmounted(() => { disposed = true; if (attempt) void auth.cancelLogin(attempt) })

async function resetChallenge() {
  const previous = attempt
  attempt = null
  challenge.value = ''; challengeRemember.value = false; code.value = ''; password.value = ''; error.value = ''
  if (previous) await auth.cancelLogin(previous)
  await nextTick(); if (method.value === 'password') usernameInput.value?.focus()
}

async function finish(response: AuthLoginResponse, ticket: WebLoginAttempt, rememberMe: boolean) {
  if (!response.access_token) throw new Error('未取得有效登录会话。')
  await auth.setSession({ accessToken: response.access_token, refreshToken: response.refresh_token,
    user: response.user, rememberMe }, ticket)
  if (disposed || attempt !== ticket) return
  attempt = null
  password.value = ''; code.value = ''
  const requested = typeof route.query.redirect === 'string' ? route.query.redirect : ''
  const safe = /^\/(dashboard|tasks|wallet|my-nodes|equipment|app-market|level|account(?:\/(info|security|notifications))?)$/.test(requested)
  await router.replace(safe ? requested : '/dashboard')
}

async function submitPhone(payload: { phone: string; code: string; rememberMe: boolean }) {
  if (busy.value) return
  error.value = ''; busy.value = true
  try {
    const ticket = await auth.beginLogin(payload.rememberMe)
    attempt = ticket
    if (disposed) { await auth.cancelLogin(ticket); return }
    const result = await auth.loginWithPhone(payload.phone, payload.code, payload.rememberMe, ticket)
    if (disposed || attempt !== ticket) return
    if ('two_factor_required' in result && result.two_factor_required) {
      challenge.value = result.challenge_token
      challengeRemember.value = payload.rememberMe
      await nextTick(); codeInput.value?.focus()
    } else await finish(result as AuthLoginResponse, ticket, payload.rememberMe)
  } catch (e) { if (!disposed) error.value = errorMessage(e, '手机号登录失败，请检查验证码。') }
  finally { busy.value = false }
}

async function submitPassword() {
  if (busy.value) return
  error.value = ''; busy.value = true
  try {
    if (challenge.value && attempt) {
      const ticket = attempt
      const result = await auth.loginTotp(challenge.value, code.value, { rememberMe: challengeRemember.value }, ticket)
      if (!disposed && attempt === ticket) await finish(result, ticket, challengeRemember.value)
    } else {
      const ticket = await auth.beginLogin(remember.value)
      attempt = ticket
      if (disposed) { await auth.cancelLogin(ticket); return }
      const result = await auth.login(username.value.trim(), password.value, remember.value, ticket)
      if (disposed || attempt !== ticket) return
      if ('two_factor_required' in result && result.two_factor_required) {
        challenge.value = result.challenge_token; password.value = ''
        challengeRemember.value = remember.value
        await nextTick(); codeInput.value?.focus()
      } else await finish(result as AuthLoginResponse, ticket, remember.value)
    }
  } catch (e) { if (!disposed) error.value = errorMessage(e, '登录失败，请检查账号与密码。') }
  finally { busy.value = false }
}
</script>

<style scoped>
.auth-methods{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:4px;margin-bottom:22px;border:1px solid var(--qs-line);border-radius:10px;background:rgba(127,145,163,.08)}.auth-methods button{min-height:38px;border:0;border-radius:7px;background:transparent;color:var(--qs-muted);font-size:12px;cursor:pointer}.auth-methods button.selected{background:var(--qs-surface,#fff);color:var(--qs-text);box-shadow:0 2px 8px rgba(15,23,42,.08)}.auth-error{margin-bottom:16px}
</style>
