<template>
  <form class="qs-form" @submit.prevent="submit">
    <div v-if="error" class="qs-error" role="alert">{{ error }}</div>
    <div v-if="sent" class="qs-form-status" role="status">验证码已发送至 {{ maskedPhone }}，请在有效期内输入。</div>
    <div class="qs-field">
      <label :for="`${purpose}-phone`">手机号</label>
      <input :id="`${purpose}-phone`" v-model="phone" type="tel" inputmode="tel" autocomplete="tel-national"
        placeholder="中国大陆手机号" :disabled="busy || sending" required maxlength="18" />
    </div>
    <div class="qs-field">
      <label :for="`${purpose}-code`">短信验证码</label>
      <div class="phone-code-line">
        <input :id="`${purpose}-code`" v-model="code" inputmode="numeric" autocomplete="one-time-code"
          pattern="[0-9]{6}" maxlength="6" placeholder="6 位验证码" :disabled="busy" required />
        <button type="button" class="qs-code-button" :disabled="busy || sending || cooldown > 0" @click="sendCode">
          {{ sending ? '发送中…' : cooldown > 0 ? `${cooldown} 秒后重发` : '发送验证码' }}
        </button>
      </div>
      <small>验证码仅用于本次{{ purpose === 'register' ? '注册' : '登录' }}，不会向他人展示。</small>
    </div>
    <label class="qs-check"><input v-model="remember" type="checkbox" :disabled="busy"><span>在这台设备上保持登录<br>公共或共用设备建议关闭。</span></label>
    <label v-if="purpose === 'register'" class="qs-check"><input v-model="agree" type="checkbox" required :disabled="busy"><span>我已阅读并同意 <router-link to="/terms" target="_blank">用户服务协议</router-link> 和 <router-link to="/privacy" target="_blank">隐私政策</router-link>。</span></label>
    <button class="qs-button primary" type="submit" :disabled="busy || sending">
      {{ busy ? '正在验证…' : purpose === 'register' ? '验证并创建账号' : '验证并登录' }}
    </button>
  </form>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { auth } from '../../services/api'
import { errorMessage } from '../../services/identityContract'

const props = defineProps<{ purpose: 'login' | 'register'; busy: boolean }>()
const emit = defineEmits<{ submit: [payload: { phone: string; code: string; rememberMe: boolean }] }>()
const phone = ref('')
const code = ref('')
const remember = ref(false)
const agree = ref(false)
const error = ref('')
const sent = ref(false)
const sending = ref(false)
const cooldown = ref(0)
let timer: ReturnType<typeof setInterval> | undefined

function normalizedPhone() {
  let value = phone.value.replace(/[\s\-()]/g, '')
  if (value.startsWith('+86')) value = value.slice(3)
  else if (value.startsWith('86') && value.length === 13) value = value.slice(2)
  if (!/^1[3-9]\d{9}$/.test(value)) throw new Error('请输入有效的中国大陆手机号。')
  return value
}
const maskedPhone = computed(() => {
  try { return normalizedPhone().replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2') }
  catch { return '该手机号' }
})

async function sendCode() {
  if (sending.value || cooldown.value > 0 || props.busy) return
  error.value = ''
  let value: string
  try { value = normalizedPhone() }
  catch (e) { error.value = errorMessage(e, '请检查手机号。'); return }
  sending.value = true
  try {
    const response = await auth.sendPhoneCode(value, props.purpose)
    sent.value = true
    cooldown.value = Number.isFinite(response.resend_after) ? Math.max(1, response.resend_after) : 60
    if (timer) clearInterval(timer)
    timer = setInterval(() => { cooldown.value = Math.max(0, cooldown.value - 1); if (cooldown.value === 0 && timer) clearInterval(timer) }, 1000)
  } catch (e) { error.value = errorMessage(e, '验证码发送失败，请稍后重试。') }
  finally { sending.value = false }
}

function submit() {
  error.value = ''
  try {
    const value = normalizedPhone()
    if (!/^\d{6}$/.test(code.value)) throw new Error('请输入 6 位短信验证码。')
    if (props.purpose === 'register' && !agree.value) throw new Error('请先阅读并同意用户协议与隐私政策。')
    emit('submit', { phone: value, code: code.value, rememberMe: remember.value })
  } catch (e) { error.value = errorMessage(e, '请检查填写内容。') }
}

onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<style scoped>
.phone-code-line{display:flex;gap:8px}.phone-code-line input{min-width:0;flex:1}.qs-code-button{min-width:112px;padding:0 10px;border:1px solid var(--qs-line);border-radius:7px;background:transparent;color:var(--qs-accent);font-size:12px;cursor:pointer}.qs-code-button:disabled{opacity:.55;cursor:default}
</style>
