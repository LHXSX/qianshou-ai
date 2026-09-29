/**
 * 探针前置：为**本机 dsh web** 铸一张浏览器会话 cookie，写进 CDP Chrome 的 profile。
 *
 * 为什么需要它：`dsh web` 对每个 Host 请求校验一枚 HttpOnly 会话 cookie，
 * 其名字与签名都绑定在 **authority（host:port）** 上；而 launch token 只由
 * `dsh web` 启动时打印一次、只存在于服务进程内存里，外部拿不到。
 * 于是任何**独立的**自动化浏览器（CDP 调试实例）都会被 401 挡住。
 *
 * 本脚本不猜、不绕过：它用的就是服务端同一份实现与同一份密钥材料的公开协议——
 *   - 密钥：`~/.dsh/.credentials.yaml` 里 `client-connection/browser-session`
 *     这条 grant 记录的 `payload.secret`（base64url 编码的 32 字节）；
 *   - 载荷：`{version:1, authority:"host:port", issuedAt, expiresAt}`；
 *   - 值：`v1.<base64url(JSON)>.<base64url(HMAC-SHA256(secret, body))>`；
 *   - 名字：`dsh-auth-<base64url(SHA-256(authority))>`。
 * 这些常量与原实现一一对应：`packages/client/connection/src/browser-auth.ts`
 * 第 12–28 行（AUTH_RECORD_KEY / COOKIE_PREFIX / *_VERSION / SECRET_BYTES）。
 *
 * 用法（只在需要重新铸票时跑一次；默认有效期 30 天，与服务端 maxAgeDays 一致）：
 *   node packages/client/ui-conversation/tools/mint-local-session-cookie.mjs \
 *     --url http://127.0.0.1:3099/ [--creds ~/.dsh/.credentials.yaml] [--cdp http://127.0.0.1:9222]
 * 或把已有的有效票据搬到另一台调试实例（例如干净 profile 的探针浏览器）：
 *   … --cdp http://127.0.0.1:9233 --copy-from http://127.0.0.1:9222
 *
 * 注意：只写 cookie，不动服务进程、不改任何服务端状态。
 */
import { readFileSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'
import { homedir } from 'node:os'

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const target = new URL(arg('url', 'http://127.0.0.1:3099/'))
const CDP = arg('cdp', 'http://127.0.0.1:9222')
const CREDS = arg('creds', `${homedir()}/.dsh/.credentials.yaml`)
/* 也可以直接把一张**已知有效**的 cookie 复制到另一个调试实例上，
   省掉从密钥重铸（`--copy-from <其它 CDP 地址>`）。用于"干净 profile 的探针浏览器"。 */
const COPY_FROM = arg('copy-from', undefined)

const base64url = (value) => Buffer.from(value).toString('base64')
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const decodeBase64url = (value) => Buffer.from(
  value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4),
  'base64',
)

/* 只做这一条记录的抽取，不引入 YAML 依赖：密钥行是固定缩进的 `secret: <base64url>`。
   复制模式下不需要密钥，也不去读凭据文件。 */
let secret
if (COPY_FROM === undefined) {
  const yaml = readFileSync(CREDS, 'utf8')
  const section = yaml.split('\n').findIndex((line) => line.trim().startsWith('client-connection/browser-session:'))
  if (section === -1) throw new Error(`credentials: no client-connection/browser-session record in ${CREDS}`)
  for (const line of yaml.split('\n').slice(section, section + 8)) {
    const match = /^\s+secret:\s*(\S+)\s*$/u.exec(line)
    if (match) { secret = decodeBase64url(match[1]); break }
  }
  if (secret === undefined || secret.byteLength !== 32) throw new Error('credentials: browser-session secret is missing or not 32 bytes')
}

const authority = target.host
const payload = {
  version: 1,
  authority,
  issuedAt: Date.now(),
  expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
}
const body = base64url(Buffer.from(JSON.stringify(payload), 'utf8'))
/* 复制模式不需要自己签名：secret 根本没读，也不该在这里被用到。 */
const mintedValue = secret === undefined
  ? undefined
  : `v1.${body}.${base64url(createHmac('sha256', secret).update(body).digest())}`
const name = `dsh-auth-${base64url(createHash('sha256').update(authority).digest())}`

/* 统一用**页面会话**（Target.createTarget + Network.*）而不是浏览器级 Storage.*：
   实测浏览器级 `Storage.getCookies` / `Storage.setCookies` 在部分调试实例上直接报
   "Browser context management is not supported."，页面级 Network.* 一律可用。 */
const openPage = async (endpoint) => {
  const info = await (await fetch(`${endpoint}/json/version`)).json()
  const socket = new WebSocket(info.webSocketDebuggerUrl)
  let sequence = 0
  const waiting = new Map()
  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id)
      waiting.delete(msg.id)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    }
  })
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve)
    socket.addEventListener('error', reject)
  })
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const mid = ++sequence
    waiting.set(mid, { resolve, reject })
    socket.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true })
  return {
    call,
    sessionId,
    targetId,
    close: async () => { await call('Target.closeTarget', { targetId }).catch(() => {}); socket.close() },
  }
}

const page = await openPage(CDP)

/* 复制模式：从 `--copy-from` 指定的调试实例里取出该 authority 的 cookie 原值。
   只在两个实例之间搬运**同一台机器、同一个服务**的会话票据，不解析、不重签。 */
let value = mintedValue
let expiresAt = payload.expiresAt
if (COPY_FROM !== undefined) {
  const source = await openPage(COPY_FROM)
  await source.call('Network.enable', {}, source.sessionId)
  const stored = await source.call('Network.getCookies', { urls: [target.origin + '/'] }, source.sessionId)
  await source.close()
  const found = stored.cookies.find((cookie) => cookie.name === name)
  if (found === undefined) throw new Error(`copy-from: no ${name} cookie in ${COPY_FROM}`)
  value = found.value
  expiresAt = Math.round(found.expires * 1000)
}

const written = await page.call('Network.setCookie', {
  name,
  value,
  url: target.origin + '/',
  domain: target.hostname,
  path: '/',
  httpOnly: true,
  secure: false,
  sameSite: 'Strict',
  expires: Math.floor(expiresAt / 1000),
}, page.sessionId)
if (written.success !== true) throw new Error(`Network.setCookie failed: ${JSON.stringify(written)}`)
await page.close()
console.log(JSON.stringify({
  ok: true,
  authority,
  cookieName: name,
  source: COPY_FROM ?? `minted from ${CREDS}`,
  expiresAt: new Date(expiresAt).toISOString(),
  note: 'cookie written into the target CDP Chrome profile; the probe can now load the app',
}, null, 2))
