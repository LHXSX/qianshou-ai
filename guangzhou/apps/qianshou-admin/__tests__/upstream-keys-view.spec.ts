/**
 * 上游密钥页的**真实挂载**测试（jsdom，不是 SSR）。
 *
 * 为什么不能只靠 SSR 冒烟：`el-drawer` 默认关闭时内容不渲染，所以"那个输入框
 * 是不是 `type=password`"在 SSR 下根本看不到 —— 而它正是需求里的硬要求之一
 * （**输入框 type=password、不回显、可清空**）。这条要求漏掉的话，密钥会以明文
 * 出现在管理员屏幕上（同事路过就能看见），所以必须真的挂载出来看。
 *
 * 本文件走**真实交互**：挂载 → 等首屏取数 → 点某一行的「更换」→ 看抽屉里的输入框。
 * 网络全部打桩（返回一份契约形状的密钥状态），因此不依赖任何后端。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import ElementPlus from 'element-plus'
import UpstreamKeysView from '../src/views/UpstreamKeysView.vue'

/** 契约形状的 `credential/list` 响应（**不含任何明文密钥**，本来也没有这个字段）。 */
const LIST_FIXTURE = {
  ok: true,
  credentialsPath: '/srv/qianshou-home/.credentials.yaml',
  fileExists: true,
  fileMode: '0600',
  keys: [{
    ref: 'DEEPSEEK_API_KEY',
    configured: true,
    fingerprint: 'a1b2c3d4',
    updatedAt: 1_700_000_000_000,
    updatedBy: '167',
    previousFingerprint: 'deadbeef',
    shadowedByEnvironment: false,
    restartRequired: true,
    restartService: 'qianshou-workbench',
    restartCommand: 'systemctl restart qianshou-workbench',
  }],
  activation: {
    fileWatcher: '工作台的凭据插件监听该文件，改动会被自动加载。',
    gatewayCache: '模型网关对已解析成功的密钥永久缓存，进程内不会重读。',
    restartRequired: true,
    restartService: 'qianshou-workbench',
    restartCommand: 'systemctl restart qianshou-workbench',
    note: '改完必须重启工作台才生效。',
  },
  backups: { dir: '/srv/qianshou-admin/data/credential-backups' },
}

const apps: App[] = []

afterEach(() => {
  for (const app of apps.splice(0)) app.unmount()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

/** 挂载视图并把首屏取数喂成契约形状。 */
async function mountView(): Promise<HTMLElement> {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(LIST_FIXTURE), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })))

  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(UpstreamKeysView)
  app.use(ElementPlus)
  app.use(createRouter({
    history: createMemoryHistory(),
    // 根路由是必要的：视图本身不依赖路由，但 Element Plus 的一些组件会读当前位置，
    // 没有匹配项时 Vue Router 会打警告（噪音会掩盖真正的错误）。
    routes: [
      { path: '/', name: 'home', component: { template: '<div/>' } },
      { path: '/credential', name: 'credential', component: { template: '<div/>' } },
    ],
  }))
  apps.push(app)
  app.mount(host)
  // 等首屏取数与表格渲染落定。
  for (let i = 0; i < 6; i += 1) await nextTick()
  return host
}

/** 找到「更换」按钮并点它（真实交互，不直接调组件内部函数）。 */
async function clickReplace(): Promise<boolean> {
  const button = [...document.querySelectorAll('button')]
    .find(candidate => (candidate.textContent ?? '').trim() === '更换')
  if (button === undefined) return false
  button.click()
  for (let i = 0; i < 8; i += 1) await nextTick()
  return true
}

describe('上游密钥页：更新表单必须是密码框，且不回显', () => {
  it('首屏渲染出密钥行与指纹，但**没有任何明文**', async () => {
    const host = await mountView()
    expect(host.textContent).toContain('DEEPSEEK_API_KEY')
    expect(host.textContent).toContain('a1b2c3d4')
    expect(host.textContent).toContain('需重启才生效')
  })

  it('点「更换」后，密钥输入框是 type=password（明文看不见）且初始为空', async () => {
    await mountView()
    expect(await clickReplace()).toBe(true)
    const passwordInputs = [...document.querySelectorAll('input[type="password"]')]
    expect(passwordInputs.length).toBeGreaterThan(0)
    // 打开表单不该带上任何已有密钥（服务端也根本不回）。
    for (const input of passwordInputs) expect((input as HTMLInputElement).value).toBe('')
  })

  it('输入框可清空：没有被 disabled / readonly 锁住', async () => {
    await mountView()
    expect(await clickReplace()).toBe(true)
    const input = document.querySelector('input[type="password"]') as HTMLInputElement | null
    expect(input).not.toBeNull()
    // 锁住的话，管理员改不掉已粘贴的值（也就无法真正清空）。
    expect((input as HTMLInputElement).disabled).toBe(false)
    expect((input as HTMLInputElement).readOnly).toBe(false)
  })

  it('页面上不出现任何形如密钥的字符串（不回显的底线）', async () => {
    const host = await mountView()
    await clickReplace()
    const text = `${host.textContent ?? ''}${document.body.textContent ?? ''}`
    expect(text).not.toMatch(/sk-[A-Za-z0-9_-]{6,}/)
  })
})
