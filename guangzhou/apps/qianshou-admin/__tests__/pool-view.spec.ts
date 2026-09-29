/**
 * 号池页的**真实挂载**测试（jsdom，不是 SSR）。
 *
 * 覆盖的是这个页面最容易骗人的几处，每一处都有"看起来对了、其实是假的"的写法：
 *
 * 1. **三种形态都能提交**：`crsr_…`、`userId::eyJ…`、`userId%3A%3AJWT` —— 断言的是
 *    **请求 body 里那一串与粘贴的完全一致**（前端不许"顺手规范化"，剥包装是服务端的事）。
 * 2. **`duplicate` 不调 apply**：接口一旦被调用就是"运营以为加了两个号"的源头，
 *    所以断言的是"`pool/apply` **一次都没被请求**"，而不是只看界面文案。
 * 3. **`fingerprint: null` 不显示空白或 0**：服务端用 `valueKnown: false` /
 *    `fingerprintSubject: null` 明确标注"落盘值还没产生"，界面必须如实说。
 * 4. **原因不足 4 字不让提交**：确认按钮在点之前就是 disabled 的。
 * 5. **只读角色看不到写入口**：不出现「加号（粘贴 CK）」与「移除」按钮。
 *
 * 网络全部打桩（返回契约形状的响应），因此不依赖任何后端。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import ElementPlus from 'element-plus'
import PoolView from '../src/views/PoolView.vue'
import { fingerprintCell, probeText, statusMeta } from '../src/api/modules/pool'
import { clearSession, loadSession } from '../src/session/store'

/** 契约形状的 `pool/list` 响应（**任何字段都不含明文凭据**，本来也没有这个字段）。 */
const LIST_FIXTURE = {
  ok: true,
  keys: [{
    ref: 'CURSOR_CK_1a2b3c4d',
    label: '客服号-1',
    status: 'active',
    fingerprint: 'a1b2c3d4',
    lastVerifiedAt: 1_700_000_000_000,
    authId: 'user_abc123',
    email: 'ops@example.com',
    addedAt: 1_700_000_000_000,
    addedBy: '167',
    previousFingerprint: 'deadbeef',
    shape: 'api-key',
  }],
  fileError: null,
  activation: {
    fileWatcher: '工作台的凭据插件监听该文件，改动会被自动加载。',
    consumer: '模型网关的号池路由（尚未接入）',
    restartRequired: false,
    restartService: null,
    restartCommand: null,
    note: '号池的号就是凭据文件 refs: 段里的一个 ref；管理台负责让它进池并留下记录。',
  },
  metadataPath: '/srv/qianshou-admin/data/pool.json',
}

/** `session/me` 夹具：`writeOnly=false` 时是只读角色（有读权限、没有写权限）。 */
function sessionFixture(options: { readonly superAdmin: boolean }): unknown {
  return {
    ok: true,
    admin: {
      accountId: '167',
      displayName: options.superAdmin ? '超级管理员' : '审计员',
      roleId: options.superAdmin ? 'super-admin' : 'auditor',
      roleName: options.superAdmin ? '超级管理员' : '审计员',
      roleKind: 'builtin',
      scope: 'all',
      surface: 'ai-admin',
    },
    permissions: options.superAdmin ? ['credential.read', 'credential.manage'] : ['credential.read', 'audit.read'],
    menu: [{ key: 'pool', title: '上游号池', group: '安全', perm: 'credential.read' }],
    readiness: [],
    clientIp: '127.0.0.1',
  }
}

/** 请求体里出现的**明文凭据**（用于断言"没有出现在页面上"的反面）。 */
const SECRET_API_KEY = `crsr_${'a'.repeat(64)}`
const SECRET_JWT = `eyJhbGciOiJIUzI1NiJ9.${'b'.repeat(40)}.${'c'.repeat(20)}`

const apps: App[] = []
let requests: { readonly path: string; readonly body: Record<string, unknown> }[] = []

beforeEach(() => {
  requests = []
  clearSession()
})

afterEach(() => {
  for (const app of apps.splice(0)) app.unmount()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  clearSession()
})

interface StubOptions {
  readonly superAdmin: boolean
  /** 每个端点路径的自定义响应（键为路径后缀）。 */
  readonly overrides?: Readonly<Record<string, unknown>>
  /** 抛错的端点（模拟 4xx）。 */
  readonly failures?: Readonly<Record<string, { readonly status: number; readonly body: unknown }>>
}

/** 打桩 `fetch`：记录每次请求的路径与 body，按路径返回夹具。 */
function stubFetch(options: StubOptions): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : String(input)
    const raw = typeof init?.body === 'string' ? init.body : '{}'
    requests.push({ path, body: JSON.parse(raw) as Record<string, unknown> })

    for (const [suffix, failure] of Object.entries(options.failures ?? {})) {
      if (path.endsWith(suffix)) {
        return new Response(JSON.stringify(failure.body), {
          status: failure.status,
          headers: { 'content-type': 'application/json' },
        })
      }
    }
    for (const [suffix, payload] of Object.entries(options.overrides ?? {})) {
      if (path.endsWith(suffix)) {
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
    }
    if (path.endsWith('/session/me')) {
      return new Response(JSON.stringify(sessionFixture({ superAdmin: options.superAdmin })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (path.endsWith('/pool/list')) {
      return new Response(JSON.stringify(LIST_FIXTURE), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }))
}

/** 契约形状的 `pool/preflight`（op=add）响应。 */
function addPreview(overrides: Record<string, unknown> = {}): unknown {
  return {
    ok: true,
    confirm: {
      token: 'token-add-1',
      expiresAt: Date.now() + 60_000,
      diff: {
        ref: 'CURSOR_CK_1a2b3c4d',
        action: 'add',
        identity: { authId: 'user_abc123', email: 'ops@example.com' },
        fingerprint: 'new12345',
        fingerprintSubject: 'stored-value',
        valueKnown: true,
        shape: 'api-key',
        existingRef: null,
        duplicateBasis: null,
        previousFingerprint: null,
        probe: { ok: true, latencyMs: 620, endpoint: 'exchange_user_api_key → GetMe', status: 200 },
        note: '贴进来的已经是归一化后的长期 key，落盘的就是它本身；指纹就是它的指纹。',
        ...overrides,
      },
    },
  }
}

/** 契约形状的 `pool/apply` 响应。 */
function applyResult(overrides: Record<string, unknown> = {}): unknown {
  return {
    ok: true,
    auditId: 'audit-1',
    result: {
      ref: 'CURSOR_CK_1a2b3c4d',
      fingerprint: 'new12345',
      previousFingerprint: null,
      action: 'add',
      backupPath: '/srv/qianshou-admin/data/credential-backups/b.yaml',
      updatedAt: 1_700_000_000_000,
      updatedBy: '167',
      written: true,
      ...overrides,
    },
  }
}

/** 挂载视图：先真的走一遍 `session/me`（权限与身份来自服务端），再等首屏取数落定。 */
async function mountView(options: StubOptions = { superAdmin: true }): Promise<HTMLElement> {
  stubFetch(options)
  await loadSession()

  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(PoolView)
  app.use(ElementPlus)
  app.use(createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: { template: '<div/>' } },
      { path: '/pool', name: 'pool', component: { template: '<div/>' } },
    ],
  }))
  apps.push(app)
  app.mount(host)
  await settle()
  return host
}

/** 等若干轮微任务 + 渲染落定。 */
async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await nextTick()
}

/** 找到文案完全匹配的按钮。 */
function buttonWithText(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')]
    .find(candidate => (candidate.textContent ?? '').trim() === text) as HTMLButtonElement | undefined
}

/** 点一个按钮并等渲染落定。 */
async function click(button: HTMLButtonElement | undefined): Promise<void> {
  expect(button).toBeDefined()
  button?.click()
  await settle()
}

/** 往输入框写值（走真实 input 事件，与人工输入等价）。 */
async function type(input: HTMLInputElement | HTMLTextAreaElement | null | undefined, value: string): Promise<void> {
  expect(input).toBeTruthy()
  if (input === null || input === undefined) return
  input.value = value
  input.dispatchEvent(new Event('input'))
  await settle()
}

/** 粘贴一枚凭据并走到"两步确认弹窗"打开为止。 */
async function submitCredential(credential: string, label = ''): Promise<void> {
  await click(buttonWithText('加号（粘贴 CK）'))
  const password = document.querySelector('input[type="password"]') as HTMLInputElement | null
  expect(password).not.toBeNull()
  await type(password, credential)
  if (label !== '') {
    const labelInput = [...document.querySelectorAll('input')]
      .find(candidate => candidate.placeholder === '例如：客服号-1')
    await type(labelInput as HTMLInputElement | undefined, label)
  }
  await click(buttonWithText('下一步：预览（真实探测）'))
}

/** 确认弹窗里那个执行按钮（`ConfirmApplyDialog` 的 footer 按钮；文案随动作变）。 */
function applyButton(): HTMLButtonElement | undefined {
  return buttonWithText('确认写入号池') ?? buttonWithText('已在池中，无需写入')
}

/** 所有发往某个端点的请求。 */
function requestsTo(suffix: string): { readonly path: string; readonly body: Record<string, unknown> }[] {
  return requests.filter(request => request.path.endsWith(suffix))
}

describe('上游号池：列表', () => {
  it('渲染号的标签 / ref / 指纹 / 身份 / 状态 / 时间，且不含任何明文密钥', async () => {
    const host = await mountView()
    const text = `${host.textContent ?? ''}${document.body.textContent ?? ''}`
    expect(text).toContain('客服号-1')
    expect(text).toContain('CURSOR_CK_1a2b3c4d')
    expect(text).toContain('a1b2c3d4')
    expect(text).toContain('user_abc123')
    expect(text).toContain('ops@example.com')
    expect(text).toContain('在池中')
    expect(text).toContain('2023-11-15') // 1_700_000_000_000 的本地日期
    // 页面上不出现任何形如凭据的字符串（不回显的底线）。
    expect(text).not.toMatch(/crsr_[A-Za-z0-9_-]{6,}/)
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/)
  })

  it('凭据文件读不懂时降级展示，但绝不假装"池子是空的"', async () => {
    const host = await mountView({
      superAdmin: true,
      overrides: {
        '/pool/list': {
          ...LIST_FIXTURE,
          fileError: { code: 'credentials_unreadable', message: '解析失败：第 3 行不是合法的 YAML。' },
        },
      },
    })
    const text = host.textContent ?? ''
    expect(text).toContain('凭据文件当前读不懂')
    expect(text).toContain('credentials_unreadable')
  })
})

describe('上游号池：加号（两步确认）', () => {
  it('形态一 `crsr_…`：请求体里就是粘贴的那一串（不做任何前端加工）', async () => {
    await mountView({ superAdmin: true, overrides: { '/pool/preflight': addPreview() } })
    await submitCredential(SECRET_API_KEY, '客服号-1')

    const preflight = requestsTo('/pool/preflight')
    expect(preflight.length).toBe(1)
    expect(preflight[0]?.body['op']).toBe('add')
    expect(preflight[0]?.body['credential']).toBe(SECRET_API_KEY)
    expect(preflight[0]?.body['label']).toBe('客服号-1')
    // 明文进了请求 body 之后不该留在屏幕上。
    expect(document.body.textContent).not.toContain(SECRET_API_KEY)
    expect(document.body.textContent).toContain('新增（号池里还没有这个号）')
  })

  it('形态二 `userId::eyJ…`：原样提交（剥包装是服务端的事）', async () => {
    const wrapped = `user_abc123::${SECRET_JWT}`
    await mountView({ superAdmin: true, overrides: { '/pool/preflight': addPreview() } })
    await submitCredential(wrapped)
    expect(requestsTo('/pool/preflight')[0]?.body['credential']).toBe(wrapped)
  })

  it('形态三 `userId%3A%3AeyJ…`：百分号编码原样提交', async () => {
    const encoded = `user_abc123%3A%3A${SECRET_JWT}`
    await mountView({ superAdmin: true, overrides: { '/pool/preflight': addPreview() } })
    await submitCredential(encoded)
    expect(requestsTo('/pool/preflight')[0]?.body['credential']).toBe(encoded)
  })

  it('填了原因才能执行：apply 收到同一份凭据、令牌与 trim 过的原因', async () => {
    await mountView({
      superAdmin: true,
      overrides: { '/pool/preflight': addPreview(), '/pool/apply': applyResult() },
    })
    await submitCredential(SECRET_API_KEY, '客服号-1')

    expect(applyButton()?.disabled).toBe(true) // 还没填原因 → 点不动
    const textarea = document.querySelector('.el-dialog textarea') as HTMLTextAreaElement | null
    await type(textarea, '  工单 #123 已核对  ')
    expect(applyButton()?.disabled).toBe(false)
    await click(applyButton())

    const applied = requestsTo('/pool/apply')
    expect(applied.length).toBe(1)
    expect(applied[0]?.body['credential']).toBe(SECRET_API_KEY)
    expect(applied[0]?.body['label']).toBe('客服号-1')
    expect(applied[0]?.body['token']).toBe('token-add-1')
    expect(applied[0]?.body['reason']).toBe('工单 #123 已核对')
  })

  it('原因不足 4 字时不让提交（按钮保持 disabled）', async () => {
    await mountView({
      superAdmin: true,
      overrides: { '/pool/preflight': addPreview(), '/pool/apply': applyResult() },
    })
    await submitCredential(SECRET_API_KEY)
    const textarea = document.querySelector('.el-dialog textarea') as HTMLTextAreaElement | null
    await type(textarea, '短')
    expect(applyButton()?.disabled).toBe(true)
    expect(document.body.textContent).toContain('已填 1 / 最少 4 字')
    applyButton()?.click()
    await settle()
    expect(requestsTo('/pool/apply').length).toBe(0)
  })

  it('`duplicate`：显眼提示"已经在池子里"，且**一次都不调** apply', async () => {
    await mountView({
      superAdmin: true,
      overrides: {
        '/pool/preflight': addPreview({
          action: 'duplicate',
          duplicateBasis: 'value',
          existingRef: 'CURSOR_CK_1a2b3c4d',
        }),
      },
    })
    await submitCredential(SECRET_API_KEY)
    const text = document.body.textContent ?? ''
    expect(text).toContain('这个号已经在池子里了，不会重复添加')
    expect(text).toContain('已在池中（不会重复添加）')
    expect(text).toContain('值相同（同一把 key 必然是同一个号）')

    // 运营的意图已经达成 —— 界面不该让人再贴一次，也不该真的再写一遍。
    const textarea = document.querySelector('.el-dialog textarea') as HTMLTextAreaElement | null
    await type(textarea, '重复贴一次想确认')
    const button = applyButton()
    // 不是"点了才报错"：按钮本身就是按不动的，而且旁边写清了为什么。
    expect(button).toBeDefined()
    expect(button?.disabled).toBe(true)
    expect(document.body.textContent).toContain('这个号已经在池子里了：不会重复添加')
    button?.click()
    await settle()
    expect(requestsTo('/pool/apply').length).toBe(0)
    expect(requestsTo('/pool/preflight').length).toBe(1)
  })

  it('`fingerprint: null` + `valueKnown: false`：说明"落盘后才产生"，不显示空白或 0', async () => {
    await mountView({
      superAdmin: true,
      overrides: {
        '/pool/preflight': addPreview({
          action: 'add',
          fingerprint: null,
          fingerprintSubject: null,
          valueKnown: false,
          shape: 'session',
        }),
      },
    })
    await submitCredential(`user_abc123::${SECRET_JWT}`)
    const text = document.body.textContent ?? ''
    expect(text).toContain('（要落盘后才产生）')
    expect(text).toContain('这枚凭据还没有落盘指纹')
    expect(text).toContain('写入时会先归一化成一把新的长期 key')
    // 不出现"指纹 0"、也不出现空白的指纹格（`null` 被渲染成文本）。
    expect(text).not.toContain('null')
    expect(text).not.toMatch(/落盘指纹\s*0/)
  })

  it('探测结论按四类分开说：限流不能说成"凭据无效"', async () => {
    await mountView({
      superAdmin: true,
      overrides: {
        '/pool/preflight': addPreview({
          probe: { ok: false, kind: 'upstream_unavailable', message: '上游 429', status: 429 },
        }),
      },
    })
    await submitCredential(SECRET_API_KEY)
    const text = document.body.textContent ?? ''
    expect(text).toContain('不能证明凭据无效')
    expect(text).not.toContain('凭据被上游拒绝')
  })
})

describe('上游号池：权限', () => {
  it('只读角色看不到写入口（按钮不出现），并说明缺什么', async () => {
    const host = await mountView({ superAdmin: false })
    const text = host.textContent ?? ''
    expect(text).toContain('当前身份只能查看号池，不能修改')
    expect(text).toContain('credential.manage')
    expect(text).toContain('super-admin')
    expect(buttonWithText('加号（粘贴 CK）')).toBeUndefined()
    expect(buttonWithText('移除')).toBeUndefined()
    // 只看不写：列表仍然要看得见。
    expect(text).toContain('CURSOR_CK_1a2b3c4d')
    expect(requestsTo('/pool/list').length).toBe(1)
  })

  it('super-admin 能看到「加号」与每行的「移除」', async () => {
    const host = await mountView({ superAdmin: true })
    expect(buttonWithText('加号（粘贴 CK）')).toBeDefined()
    expect(buttonWithText('移除')).toBeDefined()
    expect(host.textContent).not.toContain('当前身份只能查看号池')
  })
})

describe('上游号池：移除（高危，二次确认）', () => {
  it('移除走同一个两步协议：先预览，填原因后才真的调 pool/remove', async () => {
    await mountView({
      superAdmin: true,
      overrides: {
        '/pool/preflight': {
          ok: true,
          confirm: {
            token: 'token-remove-1',
            expiresAt: Date.now() + 60_000,
            diff: {
              ref: 'CURSOR_CK_1a2b3c4d',
              action: 'remove',
              before: {
                ref: 'CURSOR_CK_1a2b3c4d',
                label: '客服号-1',
                fingerprint: 'a1b2c3d4',
                authId: 'user_abc123',
                email: 'ops@example.com',
              },
              after: null,
              probe: null,
            },
          },
        },
        '/pool/remove': applyResult({ action: 'remove', fingerprint: null, written: true }),
      },
    })

    await click(buttonWithText('移除'))
    const preflight = requestsTo('/pool/preflight')
    expect(preflight.length).toBe(1)
    expect(preflight[0]?.body['op']).toBe('remove')
    expect(preflight[0]?.body['ref']).toBe('CURSOR_CK_1a2b3c4d')
    expect(preflight[0]?.body['credential']).toBeUndefined()

    const dangerButton = buttonWithText('确认移除')
    expect(dangerButton?.disabled).toBe(true)
    const textarea = document.querySelector('.el-dialog textarea') as HTMLTextAreaElement | null
    await type(textarea, '该号已停用')
    await click(buttonWithText('确认移除'))

    const removed = requestsTo('/pool/remove')
    expect(removed.length).toBe(1)
    expect(removed[0]?.body['ref']).toBe('CURSOR_CK_1a2b3c4d')
    expect(removed[0]?.body['token']).toBe('token-remove-1')
    expect(removed[0]?.body['reason']).toBe('该号已停用')
  })
})

describe('号池的纯函数：服务端没给的字段不编', () => {
  it('fingerprintCell 把三种"没有指纹"分开说', () => {
    expect(fingerprintCell({ fingerprint: 'a1b2c3d4' })).toEqual({ text: 'a1b2c3d4', hint: '', unknown: false })
    const session = fingerprintCell({ fingerprint: null, fingerprintSubject: null, valueKnown: false })
    expect(session.unknown).toBe(true)
    expect(session.text).toBe('（要落盘后才产生）')
    expect(session.hint).toContain('归一化')
    expect(fingerprintCell({ fingerprint: null, fingerprintSubject: 'stored-value' }).text).toBe('（服务端未返回指纹）')
    expect(fingerprintCell({}).text).toBe('（服务端未返回指纹）')
  })

  it('statusMeta 不把 missing 渲染成"在池中"', () => {
    expect(statusMeta('active').text).toBe('在池中')
    expect(statusMeta('missing').tagType).toBe('danger')
    expect(statusMeta('missing').description).toContain('已经被删掉')
    expect(statusMeta('weird').text).toContain('未识别状态')
  })

  it('probeText 认不出形状时说"未识别"，不谎称失败/通过', () => {
    expect(probeText(null)).toBeUndefined()
    expect(probeText({ ok: false, kind: 'something_new', message: 'x', status: null })?.title).toContain('未识别')
    expect(probeText({ ok: true, latencyMs: 5, endpoint: 'x', status: 200 })?.ok).toBe(true)
  })
})
