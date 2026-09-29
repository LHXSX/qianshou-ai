/**
 * 归一化与失败分类的单元测试。
 *
 * 这两块是「上游说什么 → 我们给出什么」的唯一翻译层，所以测试的重点不是覆盖分支，
 * 而是钉住几条**不能出错**的判断：
 * - 认不出的东西要说认不出，不能编造缺省值（尤其是「2FA 已开启」这种安全结论）；
 * - 429 必须按操作分桶，否则用户不知道该等哪个动作；
 * - 失败文案里不能出现上游回显的提交内容。
 */
import { describe, expect, it } from 'vitest'
import {
  asBoolean,
  asList,
  asNumber,
  asString,
  asTwoFactorChallenge,
  classifyFailure,
  FIELD_COPY,
  FAILURE_COPY,
  isAccountFailure,
  KNOWN_ERROR_CODES,
  networkFailure,
  normalizeAccount,
  normalizeSecurityLogs,
  normalizeSessions,
  normalizeTotpStatus,
  parseRetryAfter,
  rateLimitScopeOf,
  RATE_LIMIT_COPY,
  unparseableFailure,
  AccountFailure,
  ENDPOINTS,
  accountUrl,
  sessionPath,
  sessionTrustPath,
  ACCOUNT_API_PREFIX,
  ACCOUNT_API_ORIGIN,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
} from '../src/index.ts'

describe('基础取值：认不出就说认不出', () => {
  it('字符串只认非空', () => {
    expect(asString('x')).toBe('x')
    expect(asString('')).toBeNull()
    expect(asString(3)).toBeNull()
    expect(asString(null)).toBeNull()
  })

  it('数字接受数字与纯数字字符串', () => {
    expect(asNumber(5)).toBe(5)
    expect(asNumber('5')).toBe(5)
    expect(asNumber('')).toBeNull()
    expect(asNumber('abc')).toBeNull()
    expect(asNumber(Number.NaN)).toBeNull()
  })

  it('布尔只认真正的布尔，不把字符串 "false" 当真', () => {
    expect(asBoolean(true)).toBe(false || true)
    expect(asBoolean('true')).toBeNull()
    expect(asBoolean(0)).toBeNull()
  })

  it('列表接受多种包装，也接受裸数组', () => {
    expect(asList({ sessions: [1, 2] }, ['sessions'])).toEqual([1, 2])
    expect(asList({ items: [3] }, ['sessions', 'items'])).toEqual([3])
    expect(asList([9], ['sessions'])).toEqual([9])
    expect(asList({ nope: 1 }, ['sessions'])).toEqual([])
    expect(asList(null, ['sessions'])).toEqual([])
  })
})

describe('会话列表归一化', () => {
  it('认得出 id / device / ip 的别名', () => {
    const sessions = normalizeSessions({ sessions: [{ session_id: 's1', device_name: '手机', ip_address: '10.0.0.1' }] })
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.id).toBe('s1')
    expect(sessions[0]?.device).toBe('手机')
    expect(sessions[0]?.ip).toBe('10.0.0.1')
  })

  it('没有 id 的会话被丢掉：撤不掉的条目只会变成点不动的按钮', () => {
    expect(normalizeSessions({ sessions: [{ device: '无 id' }] })).toHaveLength(0)
    expect(normalizeSessions({ sessions: ['不是对象'] })).toHaveLength(0)
  })

  it('认不出 current / trusted 时按 false 处理，不编造「当前设备」标签', () => {
    const sessions = normalizeSessions({ items: [{ id: 's2' }] })
    expect(sessions[0]?.current).toBe(false)
    expect(sessions[0]?.trusted).toBe(false)
  })

  it('认得出 is_current / is_trusted / last_used_at 这些别名', () => {
    const sessions = normalizeSessions([{ id: 's3', is_current: true, is_trusted: true, last_used_at: '2026-09-16' }])
    expect(sessions[0]?.current).toBe(true)
    expect(sessions[0]?.trusted).toBe(true)
    expect(sessions[0]?.last_seen_at).toBe('2026-09-16')
  })
})

describe('安全日志归一化', () => {
  it('认得出 event / action / type 三种事件名', () => {
    expect(normalizeSecurityLogs({ logs: [{ id: '1', event: 'login' }] })[0]?.event).toBe('login')
    expect(normalizeSecurityLogs({ items: [{ id: '2', action: 'logout' }] })[0]?.event).toBe('logout')
    expect(normalizeSecurityLogs({ security_logs: [{ id: '3', type: 'totp_enabled' }] })[0]?.event).toBe('totp_enabled')
  })

  it('没有事件名的条目被丢掉：界面上它只是一行空白', () => {
    expect(normalizeSecurityLogs({ logs: [{ id: '1' }] })).toHaveLength(0)
  })

  it('没有 id 时用空串占位，不编造一个假 id', () => {
    expect(normalizeSecurityLogs({ logs: [{ event: 'login' }] })[0]?.id).toBe('')
  })

  it('认得出 ts / ip_address / message 这些别名', () => {
    const log = normalizeSecurityLogs({ logs: [{ id: '1', event: 'login', ts: '2026-09-16', ip_address: '1.2.3.4', message: '登录成功' }] })[0]
    expect(log?.created_at).toBe('2026-09-16')
    expect(log?.ip).toBe('1.2.3.4')
    expect(log?.detail).toBe('登录成功')
  })
})

describe('TOTP 状态归一化', () => {
  it('认得出 enabled 就给出状态', () => {
    const status = normalizeTotpStatus({ enabled: true, confirmed: true, recovery_codes_remaining: 8 })
    expect(status?.enabled).toBe(true)
    expect(status?.confirmed).toBe(true)
    expect(status?.recovery_codes_remaining).toBe(8)
  })

  it('**认不出 enabled 时返回 null，而不是 false**', () => {
    // 把「不知道」显示成「未开启 2FA」，会让用户在没受保护的情况下以为已经开了。
    expect(normalizeTotpStatus({})).toBeNull()
    expect(normalizeTotpStatus('nope')).toBeNull()
  })

  it('没有 confirmed 字段时以 enabled 为准，不谎称未确认', () => {
    expect(normalizeTotpStatus({ enabled: true })?.confirmed).toBe(true)
  })

  it('认得出 verified / trusted / recovery_codes_left 这些别名', () => {
    const status = normalizeTotpStatus({ enabled: true, verified: true, trusted: true, recovery_codes_left: '3' })
    expect(status?.confirmed).toBe(true)
    expect(status?.trusted_device).toBe(true)
    expect(status?.recovery_codes_remaining).toBe(3)
  })
})

describe('账号归一化', () => {
  it('数字 id 与字符串 id 都接受', () => {
    expect(normalizeAccount({ id: 42 })?.id).toBe(42)
    expect(normalizeAccount({ id: '42' })?.id).toBe('42')
  })

  it('没有 id 就没有账号：id 是双端唯一的共同身份，不能拿用户名顶替', () => {
    expect(normalizeAccount({ username: 'someone' })).toBeNull()
    expect(normalizeAccount({ id: '' })).toBeNull()
    expect(normalizeAccount({ id: true })).toBeNull()
  })

  it('余额保持原样（数字或字符串），缺失则是 null', () => {
    expect(normalizeAccount({ id: 1, balance: 0 })?.balance).toBe(0)
    expect(normalizeAccount({ id: 1, balance: '12.50' })?.balance).toBe('12.50')
    expect(normalizeAccount({ id: 1 })?.balance).toBeNull()
  })

  it('缺失的文本字段用空串占位，不塞 null 到界面里', () => {
    const account = normalizeAccount({ id: 1 })
    expect(account?.username).toBe('')
    expect(account?.email).toBe('')
    expect(account?.role).toBe('')
    expect(account?.status).toBe('')
    expect(account?.created_at).toBeNull()
  })
})

describe('2FA 挑战识别', () => {
  it('必须同时满足 two_factor_required 与 challenge_token', () => {
    expect(asTwoFactorChallenge({ two_factor_required: true, challenge_token: 't' })?.challenge_token).toBe('t')
    // 只有标志、没有挑战令牌：不能当 2FA 处理，否则界面会卡在一个没有输入的验证页。
    expect(asTwoFactorChallenge({ two_factor_required: true })).toBeNull()
    expect(asTwoFactorChallenge({ challenge_token: 't' })).toBeNull()
    expect(asTwoFactorChallenge({ two_factor_required: 'true', challenge_token: 't' })).toBeNull()
    expect(asTwoFactorChallenge(null)).toBeNull()
  })

  it('可用方式只保留字符串项；缺失时是空数组而不是编造 totp', () => {
    expect(asTwoFactorChallenge({ two_factor_required: true, challenge_token: 't', available_methods: ['totp', 7] })?.available_methods).toEqual(['totp'])
    expect(asTwoFactorChallenge({ two_factor_required: true, challenge_token: 't' })?.available_methods).toEqual([])
    expect(asTwoFactorChallenge({ two_factor_required: true, challenge_token: 't', available_methods: 'totp' })?.available_methods).toEqual([])
  })

  it('默认方式缺失时退回 totp（上游文档里的唯一取值）', () => {
    expect(asTwoFactorChallenge({ two_factor_required: true, challenge_token: 't' })?.default_method).toBe('totp')
    expect(asTwoFactorChallenge({ two_factor_required: true, challenge_token: 't', default_method: 'sms' })?.default_method).toBe('sms')
  })

  it('account_id 只接受数字与字符串，其它一律空串', () => {
    expect(asTwoFactorChallenge({ two_factor_required: true, challenge_token: 't', account_id: 42 })?.account_id).toBe(42)
    expect(asTwoFactorChallenge({ two_factor_required: true, challenge_token: 't', account_id: {} })?.account_id).toBe('')
    expect(asTwoFactorChallenge({ two_factor_required: true, challenge_token: 't' })?.challenge_expires_in).toBe(0)
  })
})

describe('失败分类', () => {
  it('状态码与文案给不出信息时落到「请求不成立」', () => {
    const failure = classifyFailure({ status: 400, operation: 'me', payload: {} })
    expect(failure.kind).toBe('invalid-request')
  })

  it('每个原因都有中文文案，且都提到怎么处理', () => {
    for (const [kind, copy] of Object.entries(FAILURE_COPY)) {
      expect(copy.trim().length, kind).toBeGreaterThan(0)
      expect(copy, kind).toMatch(/[\u4e00-\u9fff]/)
    }
  })

  it('字段提示也是中文', () => {
    for (const [field, copy] of Object.entries(FIELD_COPY)) {
      expect(copy, field).toMatch(/[\u4e00-\u9fff]/)
    }
  })

  it('限流分桶覆盖三个动作，且每个都有自己的频次说明', () => {
    expect(rateLimitScopeOf('register')).toBe('register')
    expect(rateLimitScopeOf('login-totp')).toBe('two-factor')
    expect(rateLimitScopeOf('login')).toBe('login')
    // 受保护读被限流时，用户眼里的动作仍然是「登录态下的操作」，归到 login 桶。
    expect(rateLimitScopeOf('me')).toBe('login')
    for (const scope of ['register', 'login', 'two-factor'] as const) {
      expect(RATE_LIMIT_COPY[scope]).toMatch(/[\u4e00-\u9fff]/)
    }
  })

  it('上游把口令回显在校验错误里时，分类结果只带字段名', () => {
    const failure = classifyFailure({
      status: 422,
      operation: 'register',
      payload: {
        code: 'VALIDATION_ERROR',
        errors: [{ loc: ['body', 'password'], input: 'super-secret-value', msg: 'String should have at least 6 characters' }],
      },
      secrets: ['super-secret-value'],
    })
    expect(failure.message).toContain('至少 6 位')
    expect(JSON.stringify(failure)).not.toContain('super-secret-value')
    expect(JSON.stringify(failure)).not.toContain('String should have')
  })

  it('校验失败认不出字段时用本包文案，而不是上游那句笼统的「请求参数校验失败」', () => {
    // 上游的 message 在这一类里没有增量信息，用户需要的是「去检查必填项和格式」。
    const failure = classifyFailure({
      status: 422,
      operation: 'me',
      payload: { code: 'VALIDATION_ERROR', message: '请求参数校验失败', errors: [{ loc: ['body', 'unknown_field'] }] },
    })
    expect(failure.message).toBe(FAILURE_COPY['invalid-request'])
    expect(failure.message).toMatch(/[\u4e00-\u9fff]/)
  })

  it('上游错误码白名单是显式列表，不靠猜', () => {
    expect(KNOWN_ERROR_CODES).toContain('VALIDATION_ERROR')
    expect(KNOWN_ERROR_CODES).toContain('AUTH_TOKEN_INVALID')
  })

  it('isAccountFailure 只认本包的失败对象', () => {
    expect(isAccountFailure(new AccountFailure('network', 'x'))).toBe(true)
    expect(isAccountFailure(new Error('x'))).toBe(false)
    expect(isAccountFailure('x')).toBe(false)
  })

  it('网络失败与取消是两类，取消不带状态码', () => {
    expect(networkFailure({ operation: 'login', aborted: false }).kind).toBe('network')
    expect(networkFailure({ operation: 'login', aborted: true }).kind).toBe('aborted')
    expect(networkFailure({ operation: 'login', aborted: true }).status).toBeUndefined()
  })

  it('不可解析的失败会带上真实的 content-type 线索', () => {
    expect(unparseableFailure({ status: 200, operation: 'login', contentType: 'text/html' }).message).toContain('text/html')
    // 没有 content-type 时不硬塞一句空括号。
    expect(unparseableFailure({ status: 200, operation: 'login' }).message).not.toContain('（服务器返回的是')
  })

  it('失败对象暴露 status / operation / traceId，便于报障时定位', () => {
    const failure = classifyFailure({ status: 401, operation: 'me', payload: { code: 'AUTH_TOKEN_INVALID', trace_id: 'abc123' } })
    expect(failure.status).toBe(401)
    expect(failure.operation).toBe('me')
    expect(failure.traceId).toBe('abc123')
  })

  it('trace_id 缺失或不是字符串时不产生假值', () => {
    expect(classifyFailure({ status: 401, operation: 'me', payload: { trace_id: '' } }).traceId).toBeUndefined()
    expect(classifyFailure({ status: 401, operation: 'me', payload: { trace_id: 7 } }).traceId).toBeUndefined()
  })
})

describe('Retry-After 解析', () => {
  it('秒数形式', () => {
    expect(parseRetryAfter('42')).toBe(42)
  })

  it('HTTP 日期形式按剩余秒数换算', () => {
    const now = Date.parse('2026-09-16T00:00:00Z')
    expect(parseRetryAfter('Wed, 16 Sep 2026 00:00:30 GMT', now)).toBe(30)
  })

  it('已经过去的日期给 0 而不是负数', () => {
    const now = Date.parse('2026-09-16T00:01:00Z')
    expect(parseRetryAfter('Wed, 16 Sep 2026 00:00:00 GMT', now)).toBe(0)
  })

  it('缺失与非法值都给 undefined，不编造一个等待时间', () => {
    expect(parseRetryAfter(null)).toBeUndefined()
    expect(parseRetryAfter(undefined)).toBeUndefined()
    expect(parseRetryAfter('   ')).toBeUndefined()
    expect(parseRetryAfter('soon')).toBeUndefined()
  })
})

describe('端点常量', () => {
  it('基址与前缀分开，调用方不必自己拼字符串', () => {
    expect(ACCOUNT_API_ORIGIN).toBe('https://qianshousuanli.com')
    expect(ACCOUNT_API_PREFIX).toBe('/api/v8')
    expect(accountUrl(ACCOUNT_API_ORIGIN, ENDPOINTS.login)).toBe('https://qianshousuanli.com/api/v8/auth/login')
  })

  it('拼接不受基址末尾斜杠影响', () => {
    expect(accountUrl('https://accounts.test/', ENDPOINTS.me)).toBe('https://accounts.test/api/v8/auth/me')
    expect(accountUrl('https://accounts.test///', ENDPOINTS.me)).toBe('https://accounts.test/api/v8/auth/me')
  })

  it('前缀可覆盖，便于打桩服务器与私有部署', () => {
    expect(accountUrl('https://accounts.test', ENDPOINTS.login, '/edge/v8')).toBe('https://accounts.test/edge/v8/auth/login')
    expect(accountUrl('https://accounts.test', ENDPOINTS.login, '/edge/v8/')).toBe('https://accounts.test/edge/v8/auth/login')
  })

  it('会话 id 会被转义，避免路径穿越拼出别的端点', () => {
    expect(sessionPath('a/b')).toBe('/auth/sessions/a%2Fb')
    expect(sessionTrustPath('a b')).toBe('/auth/sessions/a%20b/trust')
  })

  it('cookie 常量与上游一致：名字与路径都不能改', () => {
    expect(REFRESH_COOKIE_NAME).toBe('we_refresh_token')
    expect(REFRESH_COOKIE_PATH).toBe('/api/v8/auth')
  })

  it('所有端点都在 /api/v8 之下，profile 在 /my 之下', () => {
    expect(Object.values(ENDPOINTS).every(path => path.startsWith('/'))).toBe(true)
    expect(ENDPOINTS.profile).toBe('/my/profile')
    expect(ENDPOINTS.sessions).toBe('/auth/sessions')
  })
})
