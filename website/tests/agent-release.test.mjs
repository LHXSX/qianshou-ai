import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function compile(path, context) {
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText
  vm.runInNewContext(code, context)
  return context.exports
}
const api = compile('../src/services/agentReleaseContract.ts', { exports: {} })
const artifact = { role: 'controller', platform: 'darwin', arch: 'arm64', label: '千手智能体主控端',
  fileName: 'Qianshou-Agent-0.2.0.dmg', url: '/downloads/qianshou-agent/0.2.0/Qianshou-Agent-0.2.0.dmg',
  size: 10485760, sha256: 'a'.repeat(64), signature: 'adhoc', verified: true, notes: ['发布验收合成数据。'] }
const feed = () => ({ schemaVersion: 1, product: 'qianshou-agent', version: '0.2.0', channel: 'preview',
  releasedAt: '2026-09-13T14:00:00Z', artifacts: [structuredClone(artifact)] })
assert.equal(api.parseAgentRelease(feed()).artifacts[0].url, artifact.url)
assert.equal(api.agentPlatformLabel(artifact), 'macOS · Apple Silicon')
assert.equal(api.agentFileSize(10485760), '10.0 MB')
assert.equal(api.parseAgentRelease({ ...feed(), artifacts: [] }).artifacts.length, 0)
let rejected = 0
for (const mutate of [
  f => { f.product = 'qianshou-eco-v3-preview' },
  f => { f.schemaVersion = 2 },
  f => { f.artifacts.push({ ...f.artifacts[0] }) },
  f => { f.artifacts[0].url = 'https://other.example/installer.dmg' },
  f => { f.artifacts[0].url = '/eco-v3/downloads/installer.dmg' },
  f => { f.artifacts[0].url = '/downloads/qianshou-agent/0.1.0/' + artifact.fileName },
  f => { f.artifacts[0].url = '/downloads/qianshou-agent/0.2.0/../' + artifact.fileName },
  f => { f.artifacts[0].url += '?redirect=1' },
  f => { f.artifacts[0].url = f.artifacts[0].url.replace('Qianshou', '%51ianshou') },
  f => { f.artifacts[0].sha256 = 'bad' },
  f => { f.artifacts[0].size = -1 },
  f => { f.artifacts[0].platform = 'android' },
  f => { delete f.artifacts[0].verified },
  f => { f.artifacts[0].fileName = 'different.dmg' },
]) {
  const f = feed(); mutate(f); assert.throws(() => api.parseAgentRelease(f)); rejected++
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const pending = [], timers = new Set(), mounts = [], unmounts = []
const exports = compile('../src/composables/useAgentRelease.ts', { exports: {}, AbortController,
  require(name) {
    if (name === 'vue') return { ref: value => ({ value }), onMounted: f => mounts.push(f), onUnmounted: f => unmounts.push(f) }
    return api
  },
  fetch(url, options) { const d = deferred(); pending.push({ ...d, url, signal: options.signal }); return d.promise },
  setTimeout(f) { timers.add(f); return f }, clearTimeout(f) { timers.delete(f) },
})
const state = exports.useAgentRelease()
const first = state.load(), second = state.load()
assert.equal(pending[0].signal.aborted, true)
assert.equal(timers.size, 1)
pending[1].resolve({ ok: true, json: async () => feed() }); await second
pending[0].resolve({ ok: false }); await first
assert.equal(state.release.value.version, '0.2.0'); assert.equal(state.error.value, ''); assert.equal(timers.size, 0)
const broken = state.load(); pending[2].resolve({ ok: false }); await broken
assert.equal(state.release.value, null); assert.match(state.error.value, /生态客户端下载不受影响/)
const late = state.load(); unmounts[0](); assert.equal(pending[3].signal.aborted, true); assert.equal(timers.size, 0)
pending[3].resolve({ ok: true, json: async () => feed() }); await late
assert.equal(state.release.value, null)
console.log(`PASS: agent feed accepts real targets and rejects ${rejected} invalid cases; retry aborts stale work, failure hides links, unmount cancels work and deadlines.`)
