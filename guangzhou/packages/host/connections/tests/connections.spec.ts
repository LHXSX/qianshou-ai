/** Real process ownership, Loader composition and tool-policy proof without external accounts. */
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { ConnectionsRegistry } from '../src/registry.ts'
import type { RegistryConfig } from '../src/registry.ts'
import * as connections from '../src/index.ts'
import * as tools from '../src/tools.ts'
import { connectionDraft, connectionId } from '../src/validation.ts'

let root: string
let ctx: Context
let service: ConnectionsRegistry | undefined
let config: RegistryConfig
let actor: Agent
const presets = new WeakMap<Context, string>()
const signal = () => new AbortController().signal
const github = { kind: 'github', label: 'GitHub test', allowedPresets: ['forge-engineer'], github: { auth: 'gh' } }
const ssh = { kind: 'ssh', label: 'SSH test', allowedPresets: ['forge-engineer'], ssh: { host: 'test.invalid', port: 22, user: 'reader' } }
const handlers = new Map<string, (request: Request) => Promise<Response> | Response>()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'qianshou-connections-'))
  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  actor = await ctx.agentLoop.create(SessionId('connection-worker'), { provider: 'unused', model: 'unused' })
  presets.set(actor.ctx, 'forge-engineer')
  ctx.provide('agentPresets', { composedPreset: (scope: Context) => presets.get(scope) } as Context['agentPresets'])
  await ctx.plugin(LocalSubprocess)
  await ctx.plugin(MemoryCredentials, { TEST_GITHUB_TOKEN: 'test-only-secret' })
  const executable = join(root, 'fixture-ssh-gh.mjs')
  await writeFile(executable, `#!/usr/bin/env node\nimport { readFileSync, existsSync, writeFileSync } from 'node:fs';
const base = ${JSON.stringify(root)};
writeFileSync(base + '/argv.json', JSON.stringify(process.argv.slice(2)));
if (existsSync(base + '/hold')) { writeFileSync(base + '/started', 'yes'); setInterval(() => {}, 1000); }
else if (existsSync(base + '/fail')) { console.error('test-only-secret'); process.exitCode = 1; }
else if (existsSync(base + '/overflow')) console.log('x'.repeat(600000));
else if (process.argv.includes('api')) console.log(JSON.stringify(process.argv.at(-1) === 'user'
  ? { login: 'fixture-user' } : [{ name: 'repo', full_name: 'fixture-user/repo', private: true, html_url: 'https://github.com/fixture-user/repo', default_branch: 'main' }]));
else console.log('Linux\\n/home/reader\\nreader');\n`)
  await chmod(executable, 0o700)
  config = { statePath: join(root, 'connections.json'), cwd: root, sshCommand: executable, ghCommand: executable,
    timeoutMs: 8000, outputBytes: 16384, graceMs: 100, maxConcurrent: 2 }
  handlers.clear()
  ctx.provide('connection', { fetch: { register: (route: { path: string; fetch(request: Request): Promise<Response> | Response }) => {
    handlers.set(route.path, route.fetch); return () => { handlers.delete(route.path) }
  } } } as unknown as Context['connection'])
})
afterEach(async () => {
  await service?.close(); service = undefined
  await ctx.fiber.dispose()
  vi.unstubAllGlobals()
  await rm(root, { recursive: true, force: true })
})
async function open(): Promise<ConnectionsRegistry> { service = await ConnectionsRegistry.open(ctx, config); ctx.provide('connections', service); return service }
const call = (name: string, args: unknown, agent = actor) => ctx.tools.execute({ name, arguments: args, agent, signal: signal(), callId: ToolCallId('connection-test') })
async function started(): Promise<void> { await vi.waitFor(async () => expect(await readFile(join(root, 'started'), 'utf8')).toBe('yes')) }

describe.skipIf(process.platform === 'win32')('read-only connection service', () => {
  it('runs gh identity/repositories and fixed SSH argv without recording secrets', async () => {
    const registry = await open()
    const repo = await registry.save(github)
    expect(await registry.probe(repo.id, signal(), actor)).toMatchObject({ ok: true, identity: 'fixture-user', method: 'gh' })
    expect(await registry.repositories(repo.id, 1, signal(), actor)).toEqual({ repositories: [{ name: 'repo', fullName: 'fixture-user/repo', private: true, url: 'https://github.com/fixture-user/repo', defaultBranch: 'main' }], nextPage: null })
    const server = await registry.save(ssh)
    expect(await registry.inspect(server.id, signal(), actor)).toEqual({ platform: 'Linux', directory: '/home/reader', user: 'reader' })
    const argv = JSON.parse(await readFile(join(root, 'argv.json'), 'utf8')) as string[]
    expect(argv).toContain('StrictHostKeyChecking=yes')
    expect(argv).toContain('BatchMode=yes')
    expect(argv).toContain('ControlPath=none')
    expect(argv.slice(-3)).toEqual(['--', 'test.invalid', 'uname -s && pwd && id -un'])
    expect(await readFile(config.statePath, 'utf8')).not.toContain('test-only-secret')
    expect(registry.list(actor)).toHaveLength(2)
  })

  it('reports the actual missing provider without guessing from executable names', async () => {
    config = { ...config, sshCommand: join(root, 'missing-client-one'), ghCommand: join(root, 'missing-ssh-named-github') }
    const registry = await open()
    const account = await registry.save(github); const server = await registry.save(ssh)
    expect(await registry.probe(account.id, signal(), actor)).toMatchObject({ ok: false, error: 'GH_UNAVAILABLE' })
    expect(await registry.probe(server.id, signal(), actor)).toMatchObject({ ok: false, error: 'SSH_UNAVAILABLE' })
  })

  it('keeps default grants empty and rejects stale or different live presets', async () => {
    const registry = await open()
    const ungranted = await registry.save({ ...github, allowedPresets: [] })
    expect(registry.list(actor)).toEqual([])
    await expect(registry.probe(ungranted.id, signal(), actor)).rejects.toThrow('CONNECTION_FORBIDDEN')
    const row = await registry.save({ ...github, id: ungranted.id })
    presets.set(actor.ctx, 'forge-reviewer')
    await expect(registry.repositories(row.id, 1, signal(), actor)).rejects.toThrow('CONNECTION_FORBIDDEN')
    presets.set(actor.ctx, 'forge-engineer')
    await expect(registry.probe(row.id, signal(), { ...actor } as Agent)).rejects.toThrow('CONNECTION_FORBIDDEN')
    expect(registry.list()).toHaveLength(1)
  })

  it('drains pending SSH on edit/delete and clears prior successful probe', async () => {
    const registry = await open()
    const row = await registry.save(ssh)
    await registry.probe(row.id, signal(), actor)
    expect(registry.list()[0]?.lastProbe?.ok).toBe(true)
    await writeFile(join(root, 'hold'), '')
    const pending = registry.inspect(row.id, signal(), actor)
    const rejected = expect(pending).rejects.toThrow('CONNECTION_REVOKED')
    await started()
    const edited = await registry.save({ ...ssh, id: row.id, label: 'Updated' })
    await rejected
    expect(edited.lastProbe).toBeUndefined()
    expect(edited.revision).toBe(2)
    await rm(join(root, 'started'))
    const again = registry.inspect(row.id, signal(), actor)
    const gone = expect(again).rejects.toThrow('CONNECTION_REVOKED')
    await started(); await registry.delete(row.id); await gone
    expect(registry.list()).toEqual([])
  })

  it('bounds output and deadlines while suppressing credential-shaped stderr', async () => {
    const registry = await open(); const row = await registry.save(github)
    await writeFile(join(root, 'fail'), '')
    const failed = await registry.probe(row.id, signal(), actor)
    expect(failed).toMatchObject({ ok: false, error: 'CONNECTION_AUTH_OR_NETWORK_FAILED' })
    expect(JSON.stringify(failed)).not.toContain('test-only-secret')
    await rm(join(root, 'fail')); await writeFile(join(root, 'overflow'), '')
    expect(await registry.probe(row.id, signal(), actor)).toMatchObject({ ok: false, error: 'CONNECTION_OUTPUT_LIMIT' })
    await rm(join(root, 'overflow')); await writeFile(join(root, 'hold'), '')
    await registry.close()
    service = await ConnectionsRegistry.open(ctx, { ...config, timeoutMs: 1000 })
    await expect(service.probe(row.id, signal(), actor)).rejects.toThrow('CONNECTION_TIMEOUT')
  })

  it('aborts credential reads on explicit stop, credential revocation and preset changes', async () => {
    const registry = await open(); const row = await registry.save({ ...github, github: { auth: 'credential', credentialRef: 'TEST_GITHUB_TOKEN' } })
    let entered = 0
    vi.stubGlobal('fetch', vi.fn((_url: string, request: RequestInit) => {
      entered += 1
      expect(request.headers).toMatchObject({ Authorization: 'Bearer test-only-secret' })
      return new Promise<Response>((_resolve, reject) => request.signal?.addEventListener('abort', () => reject(request.signal?.reason), { once: true }))
    }))
    const cancellation = new AbortController()
    const pending = registry.probe(row.id, cancellation.signal, actor)
    const aborted = expect(pending).rejects.toThrow('REQUEST_ABORTED')
    await vi.waitFor(() => expect(entered).toBe(1)); cancellation.abort(); await aborted
    const second = registry.probe(row.id, signal(), actor)
    const revoked = expect(second).rejects.toThrow('CONNECTION_REVOKED')
    await vi.waitFor(() => expect(entered).toBe(2)); await registry.credentialChanged('TEST_GITHUB_TOKEN'); await revoked
    const response = Promise.withResolvers<Response>()
    vi.stubGlobal('fetch', vi.fn(() => response.promise))
    const third = registry.probe(row.id, signal(), actor)
    const denied = expect(third).rejects.toThrow('CONNECTION_FORBIDDEN')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    presets.set(actor.ctx, 'forge-reviewer'); response.resolve(Response.json({ login: 'fixture-user' })); await denied
  })

  it('revokes every connection sharing a credential before waiting for any reader to drain', async () => {
    const registry = await open()
    const draft = { ...github, github: { auth: 'credential', credentialRef: 'TEST_GITHUB_TOKEN' } }
    const first = await registry.save(draft); const second = await registry.save(draft)
    const cleanup = Promise.withResolvers<void>()
    let entered = 0; let aborted = 0
    vi.stubGlobal('fetch', vi.fn((_url: string, request: RequestInit) => {
      const index = entered++
      return new Promise<Response>((_resolve, reject) => request.signal?.addEventListener('abort', () => {
        aborted += 1
        if (index === 0) void cleanup.promise.then(() => reject(request.signal?.reason))
        else reject(request.signal?.reason)
      }, { once: true }))
    }))
    const firstRejected = expect(registry.probe(first.id, signal(), actor)).rejects.toThrow('CONNECTION_REVOKED')
    const secondRejected = expect(registry.probe(second.id, signal(), actor)).rejects.toThrow('CONNECTION_REVOKED')
    await vi.waitFor(() => expect(entered).toBe(2))
    const revoked = registry.credentialChanged('TEST_GITHUB_TOKEN')
    try { await vi.waitFor(() => expect(aborted).toBe(2)) }
    finally { cleanup.resolve() }
    await revoked; await firstRejected; await secondRejected
  })

  it('resolves credential references only in Host and returns bounded parsed public metadata', async () => {
    const registry = await open(); const row = await registry.save({ ...github, github: { auth: 'credential', credentialRef: 'TEST_GITHUB_TOKEN' } })
    const request = vi.fn(async (_url: string, _request: RequestInit) => Response.json({ login: 'fixture-user', token: 'must-not-project' }))
    vi.stubGlobal('fetch', request)
    expect(await registry.probe(row.id, signal(), actor)).toMatchObject({ ok: true, method: 'credential', identity: 'fixture-user' })
    expect(JSON.stringify(registry.list())).not.toContain('test-only-secret')
    expect(JSON.stringify(registry.list())).not.toContain('must-not-project')
    expect(request.mock.calls[0]?.[0]).toBe('https://api.github.com/user')
    await ctx.credentials.unset(credentialRef('TEST_GITHUB_TOKEN'))
    expect(await registry.probe(row.id, signal(), actor)).toMatchObject({ ok: false, error: 'CREDENTIAL_UNAVAILABLE' })
  })

  it('restores metadata without probe claims and refuses malformed saved documents', async () => {
    const registry = await open(); const row = await registry.save(github)
    await registry.probe(row.id, signal(), actor)
    await registry.close()
    service = await ConnectionsRegistry.open(ctx, config)
    expect(service.list()).toMatchObject([{ id: row.id, revision: 1, label: 'GitHub test' }])
    expect(service.list()[0]?.lastProbe).toBeUndefined()
    await writeFile(config.statePath, JSON.stringify({ version: 1, connections: [{ ...github, id: row.id, revision: 'invalid', updatedAt: 'today' }] }))
    await expect(ConnectionsRegistry.open(ctx, config)).rejects.toThrow('INVALID_CONNECTION_STORE')
    await writeFile(config.statePath, '{\"secret-shaped-data\":')
    await expect(ConnectionsRegistry.open(ctx, config)).rejects.toThrow('INVALID_CONNECTION_STORE')
  })

  it('enforces a finite request budget and drains shutdown with no late success', async () => {
    const registry = await open(); const row = await registry.save(ssh)
    await registry.probe(row.id, signal(), actor)
    await writeFile(join(root, 'hold'), '')
    const first = registry.probe(row.id, signal(), actor)
    const firstRejected = expect(first).rejects.toThrow('CONNECTION_REVOKED')
    const second = registry.inspect(row.id, signal(), actor)
    const secondRejected = expect(second).rejects.toThrow('CONNECTION_REVOKED')
    await started()
    expect(registry.list()[0]?.lastProbe).toBeUndefined()
    await expect(registry.probe(row.id, signal(), actor)).rejects.toThrow('CONNECTION_BUSY')
    await registry.close(); await firstRejected; await secondRejected
    expect(() => registry.list()).toThrow('CONNECTION_REVOKED')
  })

  it('loads actual Host and tools entries through Loader and preserves policy denial', async () => {
    const file = join(root, 'cordis.yml')
    await writeFile(file, `- name: '@deepseek-ai/dsh-host-connections'\n  config:\n    statePath: ${JSON.stringify(config.statePath)}\n    sshCommand: ${JSON.stringify(config.sshCommand)}\n    ghCommand: ${JSON.stringify(config.ghCommand)}\n- name: '@deepseek-ai/dsh-host-connections/tools'\n`)
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = root
    try {
      ctx.baseUrl = pathToFileURL(root).href + '/'
      await ctx.plugin(Loader); ctx.loader.builtins.include = Include
      const modules = new Map<string, unknown>([['@deepseek-ai/dsh-host-connections', connections], ['@deepseek-ai/dsh-host-connections/tools', tools]])
      ctx.loader.internal = { version: 'v2', async import(specifier: string) { const value = modules.get(specifier); if (!value) throw new Error('unexpected plugin'); return value } } as unknown as NonNullable<typeof ctx.loader.internal>
      await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
      await ctx.loader.await()
    } finally { if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome }
    const save = handlers.get('/api/qianshou/connections/save')!
    const saved = await save(new Request('http://localhost/api/qianshou/connections/save', { method: 'POST', body: JSON.stringify(github) }))
    expect(saved.status).toBe(200)
    const row = await saved.json() as { id: string }
    const listing = await call('connection_list', {})
    expect(listing.isError).not.toBe(true)
    expect(JSON.stringify(listing.content)).toContain('GitHub test')
    const proof = await call('connection_probe', { connection_id: row.id })
    expect(proof.isError).not.toBe(true)
    expect(proof.content).toMatchObject([{ type: 'text', text: expect.stringContaining('fixture-user') }])
    const block = ctx.on('tools/pre-execute', (exec, next) => exec.name === 'connection_probe' ? Promise.resolve({ kind: 'deny', reason: 'test policy refused' }) : next())
    expect((await call('connection_probe', { connection_id: row.id })).content).toMatchObject([{ type: 'text', text: expect.stringContaining('test policy refused') }])
    block()
    expect(ctx.tools.get('connection_ssh_execute')).toBeUndefined()
    const invalid = await save(new Request('http://localhost/api/qianshou/connections/save', { method: 'POST', body: JSON.stringify({ ...github, token: 'test-only-secret' }) }))
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: 'INVALID_CONNECTION' })
    const route = handlers.get('/api/qianshou/connections')!
    const views = await route(new Request('http://localhost/api/qianshou/connections'))
    expect(await views.json()).toMatchObject({ capabilities: { ssh: true, github: true, sshExecute: false } })
    const disposed = ctx.connections
    await disposed.close()
    expect((await route(new Request('http://localhost/api/qianshou/connections'))).status).toBe(400)
  })
})

describe('connection JSON boundaries', () => {
  it('rejects secrets, command fragments, wildcard grants and malformed persisted records', () => {
    expect(() => connectionDraft({ ...github, token: 'secret' })).toThrow('INVALID_CONNECTION')
    expect(() => connectionDraft({ ...ssh, ssh: { ...ssh.ssh, host: 'host; touch marker' } })).toThrow('INVALID_CONNECTION')
    expect(() => connectionDraft({ ...ssh, ssh: { ...ssh.ssh, keyPath: '../id_rsa' } })).toThrow('INVALID_CONNECTION')
    expect(() => connectionDraft({ ...github, allowedPresets: ['*'] })).toThrow('INVALID_CONNECTION')
    expect(() => connectionId('some-other-resource')).toThrow('INVALID_CONNECTION_ID')
  })
})
