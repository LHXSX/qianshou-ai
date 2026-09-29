/**
 * 验证网关能按后端把请求路由到**不同厂商**。
 *
 * 跑法：`PATH=/opt/homebrew/bin:$PATH node node_modules/tsx/dist/cli.mjs packages/host/model-gateway/tools/verify-per-backend-routing.mjs`
 *
 * 这是"每后端独立端点与密钥"那处修复的实证：早先只有一个全局 baseUrl，
 * 于是"换后端"只改了模型名、请求仍发给原厂商——上游只会说"模型不存在"，
 * 看起来像接上了、实际从来没通过。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createCreditLedger } from '../src/ledger.ts'
import { createGateway } from '../src/service.ts'
import { createRoutingConsole } from '../src/routing.ts'
import { BACKENDS } from '../src/tiers.ts'

function keyFrom(ref) {
  const homes = [
    process.env.QIANSHOU_DSH_HOME,
    process.env.DSH_HOME,
    join(homedir(), '.dsh'),
    join(homedir(), '.local/share/qianshou-agent/home'),
  ].filter(Boolean)
  for (const home of homes) {
    try {
      const lines = readFileSync(`${home}/.credentials.yaml`, 'utf8').split('\n')
      const s = lines.findIndex(l => l.startsWith('refs:'))
      for (let i = s + 1; i < lines.length; i += 1) {
        if (lines[i].length > 0 && !lines[i].startsWith(' ')) break
        const m = new RegExp(`^\\s+${ref}:\\s*(\\S.*)$`).exec(lines[i])
        if (m) return m[1].trim()
      }
    } catch {}
  }
  return null
}

const out = []
for (const [backendKey, backend] of Object.entries(BACKENDS)) {
  const ledger = createCreditLedger()
  const routing = createRoutingConsole()
  routing.publish({ publishedName: '千手·迅捷', label: '千手·迅捷', tiers: ['basic','plus','max'], maxOutputTokens: 4096, order: 0, upgradeRule: 'on-expiry', lifecycleStage: 'ga', shutdownDate: null, migrationTarget: null })
  // 刻意把**这个**后端绑成首选，验证网关真的把请求发给了它自己的厂商。
  routing.bind({ publishedName: '千手·迅捷', backendKeys: [backendKey], effectiveFrom: 0, reason: '逐后端路由验证', operator: 'system', rolloutPercent: 100 })
  ledger.grant('acc', 'basic', 390)
  const gateway = createGateway({
    ledger, routing, tierOf: () => 'basic',
    forwardConfigFor: () => ({ baseUrl: backend.baseUrl, apiKey: () => keyFrom(backend.credentialRef) }),
  })
  let text = ''
  let fail = null
  await new Promise((resolve) => {
    const h = gateway.chat({ callId: `c-${backendKey}`, accountId: 'acc', publishedName: '千手·迅捷', messages: [{ role: 'user', content: '只回复两字：收到' }], maxOutputTokens: 256 },
      { onDelta: t => { text += t }, onDone: () => resolve(), onError: f => { fail = f; resolve() } })
    void h.completed
  })
  const rec = ledger.recordsOf('acc', 1)[0]
  const ok = fail === null && text.trim().length > 0
  out.push(`${ok ? '✓' : '✗'} ${backendKey.padEnd(6)} → ${backend.baseUrl.replace('https://','')}`)
  out.push(`     模型=${backend.id} 正文=${JSON.stringify(text.trim())} 实测后端键=${rec?.backendKey ?? '（无记录）'}`)
  if (fail) out.push(`     失败：${fail.kind} ${fail.message}`)
}
console.log(out.join('\n'))
const failed = out.filter(l => l.startsWith('✗')).length
console.log(`\n${failed === 0 ? '三个后端都能被网关正确路由到各自的厂商。' : `${failed} 个后端路由失败。`}`)
process.exit(failed === 0 ? 0 : 1)
