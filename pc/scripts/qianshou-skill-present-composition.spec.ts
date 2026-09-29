/** Actual selected preset rows mount through Loader; no model call is needed for file delivery. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { load, dump } from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { PluginPackages } from '@deepseek-ai/dsh-app-boot'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { assembleContextFor } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets, { COMPOSITION_FILE } from '@deepseek-ai/dsh-agent-presets'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { WorkspaceFiles } from '@deepseek-ai/dsh-api-workspace-files'
import * as Persona from '@deepseek-ai/dsh-persona'
import * as Present from '@deepseek-ai/dsh-tool-present'
import type {} from '@deepseek-ai/dsh-tool-present/types'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as ToolPwsh from '@deepseek-ai/dsh-tool-pwsh'
import * as ToolFsSearch from '@deepseek-ai/dsh-tool-fs-search'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import { PwshLocalExecutor } from '@deepseek-ai/dsh-pwsh-local'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import { handlePresentPreview } from '../packages/client/ui-deliverables/src/present-preview.ts'
import { afterEach, describe, expect, it } from 'vitest'

interface Row { id: string; name: string; config?: unknown; disabled?: unknown }
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

async function fixture(withPresent = true, preset = 'qianshou-skill-creator', localExecution = false) {
  const actual = load(await readFile(fileURLToPath(new URL(`../qianshou/presets/${preset}/agent.cordis.yml`, import.meta.url)), 'utf8'), { schema: entryListSchema }) as Row[]
  const present = actual.filter(row => row.name === '@deepseek-ai/dsh-tool-present')
  expect(present).toHaveLength(1)
  expect(present[0]?.disabled).toBeUndefined()
  const plugins = new Map<string, string>([['persona', 'persona'], ['present', 'present']])
  if (localExecution) for (const id of ['tool-fs', 'tool-fs-search', 'skill-filesystem', 'tool-skill', process.platform === 'win32' ? 'tool-pwsh' : 'tool-bash']) plugins.set(id, id)
  const rows = actual.filter(row => plugins.has(row.id)).map(row => {
    const { disabled: _disabled, ...active } = row
    return { ...active, name: `cordis:${plugins.get(row.id)}` }
  })
  const root = await mkdtemp(join(tmpdir(), 'dsh-qianshou-present-composition-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const presetId = 'skill-present-test'
  const directory = join(root, presetId)
  await mkdir(directory)
  const path = join(directory, COMPOSITION_FILE)
  await writeFile(path, dump(withPresent ? rows : rows.filter(row => row.id === 'persona')))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  await ctx.plugin(PluginPackages)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.persona = Persona
  ctx.loader.builtins.present = Present
  ctx.loader.builtins['tool-fs'] = ToolFs
  ctx.loader.builtins['tool-bash'] = ToolBash
  ctx.loader.builtins['tool-pwsh'] = ToolPwsh
  ctx.loader.builtins['tool-fs-search'] = ToolFsSearch
  ctx.loader.builtins['skill-filesystem'] = SkillFilesystem
  ctx.loader.builtins['tool-skill'] = ToolSkill
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  if (localExecution) {
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(ShellEnv)
    await ctx.plugin(process.platform === 'win32' ? PwshLocalExecutor : LocalBashExecutor, { timeoutMs: 10_000 })
    await ctx.plugin(SkillRegistry)
  }
  ctx.provide('sandboxPolicy', { workspaceRoot: root } as never)
  await ctx.plugin({ inject: ['fs', 'sandboxPolicy'], apply: (scope) => {
    new WorkspaceFiles(scope, { maxBytes: 65536, maxFileBytes: 32 * 1024 * 1024, maxLines: 100, maxEntries: 100 })
  } })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, { default: presetId, roots: [{ path: root, trust: 'user' }], includeShippedRoot: false, includeUserRoot: false })
  const agent = async (id: string) => (await ctx.agents.create({ sessionId: SessionId(id), meta: { cwd: root },
    setup: async scope => void await ctx.agentPresets.mount(scope, presetId),
  })).agent
  return { ctx, root, actual, rows, path, agent }
}

describe('Qianshou skill creator explicit file deliveries', () => {
  it('resolves present schema and mandatory final-file guidance in the actual selected rows', async () => {
    const { ctx, agent } = await fixture()
    const owner = await agent('schema-owner')
    const schema = ctx.tools.schemas(owner).find(tool => tool.name === 'present')
    expect(schema).toBeDefined()
    expect(schema?.description).toContain('must call present after writing it and before your final response')
    expect(schema?.description).toContain('Bash')
    expect(schema?.parameters).toMatchObject({ type: 'object', properties: { files: { type: 'array' } } })
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(owner))
    const prompt = assembly.sections.map(section => section.text).join('\n')
    expect(prompt).toContain('必须在最终答复前调用 present')
    expect(prompt).toContain('文字说明、文件路径或 JSON 中的路径不能替代文件交付')
    expect(ctx.tools.schemas()).toEqual([])
  })

  it('executes present, commits a durable event, and reads safe bytes by its coordinates', async () => {
    const { ctx, root, agent } = await fixture()
    const owner = await agent('delivery-owner')
    owner.session.append('turn/start', { turn: 1 })
    const bytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
    await writeFile(join(root, 'dog.gif'), bytes)
    await writeFile(join(root, 'deck.pptx'), Buffer.from([80, 75, 0, 255]))
    const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('file-delivery'),
      name: 'present', arguments: { files: [{ path: 'deck.pptx' }, { path: 'dog.gif' }] }, agent: owner,
    })
    expect(result.isError).toBe(false)
    const event = owner.session.snapshotEvents().find(value => value.type === 'deliverables/presented')!
    expect(event.data).toMatchObject({ turn: 1, callId: 'file-delivery', files: [{ path: 'deck.pptx' }, { path: 'dog.gif' }] })
    ctx.provide('sessionQuery', { readEvent: async (request: { sessionId: string; seq: number }) => {
      expect(request.sessionId).toBe(owner.id)
      expect(request.seq).toBe(event.seq)
      return { session: owner.session.header, target: event }
    } } as never)
    const response = await handlePresentPreview(ctx, new Request(`http://localhost/api/present.preview?sessionId=${owner.id}&seq=${event.seq}&index=1`))
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
    const office = await handlePresentPreview(ctx, new Request(`http://localhost/api/present.preview?sessionId=${owner.id}&seq=${event.seq}&index=0`))
    expect(office.status).toBe(415)
    expect(await readFile(join(root, 'deck.pptx'))).toEqual(Buffer.from([80, 75, 0, 255]))
  })

  it('does not manufacture a delivery when the selected tool cannot access the file', async () => {
    const { ctx, agent } = await fixture()
    const owner = await agent('missing-owner')
    owner.session.append('turn/start', { turn: 1 })
    const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('missing-file'),
      name: 'present', arguments: { files: [{ path: 'missing.pptx' }] }, agent: owner,
    })
    expect(result.isError).toBe(true)
    expect(owner.session.snapshotEvents().filter(value => value.type === 'deliverables/presented')).toEqual([])
  })

  it('keeps joined Sessions on their old generation while new Sessions gain present', async () => {
    const { ctx, rows, path, agent } = await fixture(false)
    const original = await agent('old-generation')
    expect(ctx.tools.schemas(original).map(tool => tool.name)).toEqual([])
    await writeFile(path, dump(rows))
    const current = await agent('new-generation')
    expect(ctx.tools.schemas(current).map(tool => tool.name)).toEqual(['present'])
    expect(ctx.tools.schemas(original).map(tool => tool.name)).toEqual([])
    expect(original.session.snapshotEvents().filter(event => event.type === 'deliverables/presented')).toEqual([])
  })
})

describe('Qianshou calling mode ordinary local execution', () => {
  it('mounts the normal scoped tools and executes write, shell, and present without a compute executor', async () => {
    const { ctx, root, actual, agent } = await fixture(true, 'qianshou-call', true)
    const owner = await agent('calling-local-owner')
    const names = ctx.tools.schemas(owner).map(tool => tool.name)
    expect(names).toEqual(expect.arrayContaining(['read', 'write', 'edit', 'glob', 'grep', 'skill', 'present', process.platform === 'win32' ? 'pwsh' : 'bash']))
    expect(ctx.tools.schemas()).toEqual([])
    expect(actual.filter(row => row.id === 'tool-bash' || row.id === 'tool-pwsh')).toHaveLength(2)
    owner.session.append('turn/start', { turn: 1 })
    const invoke = (name: string, args: unknown) => ctx.tools.execute({ signal: new AbortController().signal,
      callId: ToolCallId(`calling-${name}`), name, arguments: args, agent: owner })
    expect((await invoke('write', { file_path: 'office-task.txt', content: 'three pages, 16:9' })).isError).toBe(false)
    const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
    const command = process.platform === 'win32'
      ? "Copy-Item -LiteralPath office-task.txt -Destination office-result.txt"
      : 'cp office-task.txt office-result.txt'
    expect((await invoke(shell, { command, description: 'Create the local file output', workdir: root })).isError).toBe(false)
    expect(await readFile(join(root, 'office-result.txt'), 'utf8')).toBe('three pages, 16:9')
    expect((await invoke('present', { files: [{ path: 'office-result.txt' }] })).isError).toBe(false)
    expect(owner.session.snapshotEvents().find(event => event.type === 'deliverables/presented')?.data).toMatchObject({ files: [{ path: 'office-result.txt' }] })
    const prompt = (await ctx.systemPrompt.assemble(assembleContextFor(owner))).sections.map(section => section.text).join('\n')
    expect(prompt).toContain('Word、PPT、Excel 和 Python 脚本都共用这条本机执行通道')
    expect(prompt).toContain('等待中央服务器的真实报价，再由用户确认')
  })
})
