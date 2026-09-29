/** Probe the Qianshou gateway without printing credentials or refreshing another owner's session. */
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const desktop = process.argv.includes('--desktop')
const home = resolve(process.env.QIANSHOU_DSH_HOME ?? resolve(root, '..',
  desktop ? 'qianshou-pc-desktop-home' : 'qianshou-pc-home'))
const base = 'https://app.qianshousuanli.com/api/qianshou/ai'
const accountRef = 'QIANSHOU_ACCOUNT_ACCESS_TOKEN'
const manualRef = 'QIANSHOU_ACCESS_TOKEN'
const result = { gateway: base, profile: desktop ? 'desktop' : 'web', credentialConfigured: false,
  credentialSource: 'none', inference: 'not-run' }
let refs = {}
try {
  const path = resolve(home, '.credentials.yaml')
  const info = await stat(path)
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('UNSAFE_CREDENTIAL_FILE')
  const document = yaml.load(await readFile(path, 'utf8'))
  if (typeof document === 'object' && document !== null && typeof document.refs === 'object' && document.refs !== null) refs = document.refs
} catch (error) {
  if (error.code !== 'ENOENT') {
    console.log(JSON.stringify({ ...result, status: 'credential-read-failed' }))
    process.exit(1)
  }
}
const credential = ref => {
  const value = process.env[ref] ?? refs[ref]
  return typeof value === 'string' && value.trim() ? value : undefined
}
// The account Host owns refresh and durable writes. This read-only probe never
// races it by rotating a refresh token or updating its credential file.
const accountToken = credential(accountRef)
const token = accountToken ?? credential(manualRef)
result.credentialConfigured = Boolean(token)
result.credentialSource = accountToken ? 'account-session' : token ? 'manual-reference' : 'none'
const headers = token ? { Authorization: `Bearer ${token}` } : {}
try {
  // Use the same catalog method as AccountSession.reconnect: the deployed
  // gateway rejects GET before its authenticated catalog handler.
  const response = await fetch(`${base}/models`, { method: 'POST', headers,
    signal: AbortSignal.timeout(15000), redirect: 'error' })
  result.httpStatus = response.status
  if (response.ok) {
    const body = await response.json()
    result.models = Array.isArray(body.data) ? body.data.map(x => x.id).filter(x => typeof x === 'string' && x.length > 0) : []
    result.status = result.models.length > 0 ? 'catalog-reachable' : 'invalid-model-catalog'
    if (token && result.models.length > 0 && process.argv.includes('--inference')) {
      const reply = await fetch(`${base}/chat/completions`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: result.models[0], messages: [{ role: 'user', content: '只回复OK。' }],
          max_tokens: 32, stream: false, thinking: { type: 'disabled' } }),
        signal: AbortSignal.timeout(45000), redirect: 'error',
      })
      result.inferenceHttpStatus = reply.status
      if (reply.ok) {
        const body = await reply.json()
        result.inference = typeof body.choices?.[0]?.message?.content === 'string'
          && body.choices[0].message.content.trim().length > 0 ? 'nonempty-response' : 'empty-response'
      } else result.inference = 'rejected'
    }
  } else result.status = response.status === 401
    ? accountToken ? 'account-reconnect-required' : 'account-sign-in-required' : 'gateway-rejected'
} catch { result.status = 'network-or-response-error' }
console.log(JSON.stringify(result, null, 2))
if (result.status !== 'catalog-reachable' || (process.argv.includes('--inference') && result.inference !== 'nonempty-response')) process.exitCode = 1
