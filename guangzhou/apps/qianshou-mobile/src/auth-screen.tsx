/**
 * 登录 / 注册屏。
 *
 * 这是**唯一**的账号入口，PC 与手机用的是同一份账号（余额、节点归属、会话一体），
 * 所以文案里不出现「手机账号」这种说法。
 *
 * 三条不可省的实现细节：
 * 1. **2FA 是独立一步**：口令对了但账号开了二步验证时，上游返回的不是令牌而是挑战，
 *    必须先补 6 位码才能拿到令牌。少这一步，开了 2FA 的用户会卡在「登录成功但进不去」。
 * 2. **注册不自动登录**：上游注册响应是否带令牌未核实（账号包刻意不猜），
 *    所以注册成功后切到登录页并提示「用刚设的账号登录」，而不是假装已经进去了。
 * 3. **口令不落任何地方**：只在本组件的 state 里存在到提交为止；提交后立刻清空。
 */
import { useEffect, useState } from 'react'
import type { AccountService } from './account.ts'
import type { AccountClient } from '@deepseek-ai/dsh-client-account'
import * as I from './icons.tsx'

/** 屏幕当前的步骤。`two-factor` 只在账号开了 2FA 时出现。 */
type Step = 'password' | 'two-factor'

/** 从任意错误里取出能给用户看的一句话；口令绝不参与。 */
function messageOf(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  return '操作没成功，稍后再试。'
}

/**
 * 账号屏。
 * @param props.service - 账号服务（含客户端与会话）。
 * @param props.onDone - 登录成功后回到「我的」。
 * @param props.onBack - 返回上一屏。
 */
export function AuthScreen({ service, onDone, onBack }: {
  service: AccountService
  onDone: () => void
  onBack: () => void
}) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [method, setMethod] = useState<'password' | 'phone'>('password')
  const [step, setStep] = useState<Step>('password')
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [phone, setPhone] = useState('')
  const [smsCode, setSmsCode] = useState('')
  const [sending, setSending] = useState(false)
  const [resendSeconds, setResendSeconds] = useState(0)
  const [trust, setTrust] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 2FA 挑战令牌：只活在内存里，刷新页面即失效，这是刻意的。 */
  const [challenge, setChallenge] = useState<string | null>(null)

  const client: AccountClient = service.client

  useEffect(() => {
    if (resendSeconds <= 0) return
    const timer = window.setTimeout(() => setResendSeconds(seconds => Math.max(0, seconds - 1)), 1000)
    return () => window.clearTimeout(timer)
  }, [resendSeconds])

  async function sendSms(): Promise<void> {
    if (sending || resendSeconds > 0) return
    if (!/^1[3-9]\d{9}$/.test(phone.trim())) { setError('请填写 11 位中国大陆手机号。'); return }
    setSending(true)
    setError(null)
    setNotice(null)
    try {
      const receipt = await client.sendSms({ phone: phone.trim(), purpose: mode })
      setResendSeconds(receipt.resendAfter)
      setNotice(`验证码已发送至 ${receipt.phone}，${Math.ceil(receipt.expiresIn / 60)} 分钟内有效。`)
    } catch (thrown) {
      setError(messageOf(thrown))
      const retry = thrown !== null && typeof thrown === 'object' && 'retryAfterSeconds' in thrown
        ? (thrown as { retryAfterSeconds?: unknown }).retryAfterSeconds : null
      if (typeof retry === 'number' && retry > 0) setResendSeconds(retry)
    } finally { setSending(false) }
  }

  /** 口令与验证码在任何分支结束后都必须清掉。 */
  const clearSecrets = (): void => {
    setPassword('')
    setCode('')
    setSmsCode('')
  }

  async function submit(): Promise<void> {
    if (busy) return
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      if (step === 'two-factor') {
        if (challenge === null) throw new Error('验证码已过期，请重新登录。')
        await client.loginTotp({ challenge_token: challenge, code, trust_device: trust })
        await service.loadAccount()
        clearSecrets()
        onDone()
        return
      }
      if (method === 'phone') {
        const input = { phone: phone.trim(), code: smsCode.trim() }
        if (mode === 'register') {
          await client.registerPhone({ ...input, ...(identifier.trim() ? { username: identifier.trim() } : {}) })
        } else {
          const result = await client.loginPhone(input)
          if (result.kind === 'two-factor') {
            setChallenge(result.challenge.challenge_token)
            setStep('two-factor')
            setSmsCode('')
            setNotice('请输入验证器里的 6 位动态码。')
            return
          }
        }
        const loaded = await service.loadAccount()
        if (loaded === null) throw new Error('已验证手机号，但暂时读不到账号资料，请稍后刷新。')
        setSmsCode('')
        onDone()
        return
      }
      if (mode === 'register') {
        await client.register({
          password,
          ...(identifier.trim().length === 0 ? {} : { username: identifier.trim() }),
          ...(email.trim().length === 0 ? {} : { email: email.trim() }),
        })
        clearSecrets()
        // 不假装已登录：切到登录页，让用户用刚设的凭据进来。
        setMode('login')
        setNotice('账号已创建，请用刚设的账号登录。')
        return
      }
      const result = await client.login({ username: identifier.trim(), password })
      if (result.kind === 'two-factor') {
        setChallenge(result.challenge.challenge_token)
        setStep('two-factor')
        setPassword('')
        setNotice(result.challenge.default_method === 'totp' ? '请输入验证器里的 6 位验证码。' : '需要进一步验证才能继续。')
        return
      }
      await service.loadAccount()
      clearSecrets()
      onDone()
    } catch (thrown) {
      clearSecrets()
      setError(messageOf(thrown))
    } finally {
      setBusy(false)
    }
  }

  const canSubmit = step === 'two-factor'
    ? /^\d{6}$/.test(code.trim())
    : method === 'phone'
      ? /^1[3-9]\d{9}$/.test(phone.trim()) && /^\d{6}$/.test(smsCode.trim())
      : identifier.trim().length > 0 && password.length > 0

  return (
    <div className="app">
      <div className="head">
        <button className="icon-btn" aria-label="返回" onClick={onBack}><I.IcoBack /></button>
        <span className="brand-title">千手账号</span>
      </div>
      <div className="scroll tight">
        <h2 className="auth-title">{step === 'two-factor' ? '两步验证' : mode === 'login' ? '登录千手账号' : '注册千手账号'}</h2>
        <p className="auth-lead">
          用你的算力账号登录。手机与电脑登录的是<strong>同一个账号</strong>：余额、任务与节点归属都是同一份。
        </p>

        {step === 'password' && <div className="auth-methods" role="tablist" aria-label="登录方式">
          <button role="tab" aria-selected={method === 'password'} className={method === 'password' ? 'selected' : ''}
            onClick={() => { setMethod('password'); setError(null); setNotice(null) }}>账号密码</button>
          <button role="tab" aria-selected={method === 'phone'} className={method === 'phone' ? 'selected' : ''}
            onClick={() => { setMethod('phone'); setError(null); setNotice(null) }}>手机验证码</button>
        </div>}

        {notice !== null && <p className="auth-notice" role="status">{notice}</p>}
        {error !== null && <p className="auth-error" role="alert">{error}</p>}

        {step === 'password' && method === 'password' && (
          <div className="auth-fields">
            <label className="field">
              <span className="field-label">{mode === 'login' ? '账号或邮箱' : '账号'}</span>
              <input
                value={identifier}
                autoComplete="username"
                spellCheck={false}
                onChange={e => setIdentifier(e.target.value)}
              />
            </label>
            {mode === 'register' && (
              <label className="field">
                <span className="field-label">邮箱（可选）</span>
                <input value={email} autoComplete="email" spellCheck={false} onChange={e => setEmail(e.target.value)} />
              </label>
            )}
            <label className="field">
              <span className="field-label">密码</span>
              <input
                type="password"
                value={password}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
              />
            </label>
          </div>
        )}

        {step === 'password' && method === 'phone' && <div className="auth-fields">
          <label className="field">
            <span className="field-label">中国大陆手机号</span>
            <input value={phone} type="tel" inputMode="tel" autoComplete="tel-national" placeholder="11 位手机号"
              onChange={e => { setPhone(e.target.value); setSmsCode(''); setNotice(null) }} />
          </label>
          {mode === 'register' && <label className="field">
            <span className="field-label">昵称（可选）</span>
            <input value={identifier} autoComplete="nickname" onChange={e => setIdentifier(e.target.value)} />
          </label>}
          <label className="field">
            <span className="field-label">短信验证码</span>
            <span className="auth-code-row">
              <input value={smsCode} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="6 位数字"
                onChange={e => setSmsCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                onKeyDown={e => { if (e.key === 'Enter') void submit() }} />
              <button type="button" disabled={sending || resendSeconds > 0 || !/^1[3-9]\d{9}$/.test(phone.trim())}
                onClick={() => void sendSms()}>{sending ? '发送中…' : resendSeconds > 0 ? `${resendSeconds} 秒` : '获取验证码'}</button>
            </span>
          </label>
        </div>}

        {step === 'two-factor' && (
          <div className="auth-fields">
            <label className="field">
              <span className="field-label">6 位验证码</span>
              <input
                value={code}
                inputMode="numeric"
                autoComplete="one-time-code"
                onChange={e => setCode(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
              />
            </label>
            <label className="auth-check">
              <input type="checkbox" checked={trust} onChange={e => setTrust(e.target.checked)} />
              <span>信任这台设备（下次在这台手机上不用再输验证码）</span>
            </label>
          </div>
        )}

        <button className="primary auth-submit" disabled={!canSubmit || busy} onClick={() => void submit()}>
          {busy ? '处理中…' : step === 'two-factor' ? '验证' : mode === 'login' ? '登录' : method === 'phone' ? '注册并登录' : '注册'}
        </button>

        {step === 'password' && (
          <button className="auth-switch" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setSmsCode(''); setError(null); setNotice(null) }}>
            {mode === 'login' ? '还没有账号？去注册' : '已经有账号？去登录'}
          </button>
        )}

        {!service.snapshot().cookies && (
          <p className="auth-hint">
            这台设备走的是 http，浏览器不会保存 httpOnly cookie，所以登录状态只能用本地存储保存。
            要在手机上真正用上更安全的方式，需要把手机端放到 https 下。
          </p>
        )}
      </div>
    </div>
  )
}
