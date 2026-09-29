import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SkillImport from '../../qianshou-skill-import/src/index.ts'
import Catalog from '../src/index.ts'
import * as LocalSkillTools from '../src/local-skill-tools.ts'
import { expect, it, vi } from 'vitest'
import { localOrderSourceRejection, OrderSourceFailure } from '../src/order-source-diagnostics.ts'

it.each(['qs-pc-chain-count-20260927', 'svg-to-video', 'never-registered-capability'])(
  'authors %s with a new machine task type and runs real self-tests without name registration', async (name) => {
    const home = await mkdtemp(join(await realpath(tmpdir()), 'qianshou-authoring-tools-'))
    const installRoot = join(home, 'configured-skills')
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt, { personaPrefix: '' })
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(SkillImport, { installRoot })
      await ctx.plugin(Catalog, { registryUrl: 'https://registry.npmjs.org/', timeoutMs: 1000,
        connection: 'shipped', apiBaseUrl: '', installHome: join(home, 'catalog'), publisherKeys: {} })
      await ctx.plugin(LocalSkillTools)
      const call = (name: string, args: unknown) => ctx.tools.execute({ name, arguments: args,
        callId: ToolCallId(`authoring-${name}`), signal: new AbortController().signal })
      const result = await call('qianshou_skill_authoring_template', { name })
      expect(result.isError).toBe(false)
      const template = JSON.parse(typeof result.value === 'string' ? result.value : JSON.stringify(result.value)) as {
        files: Record<string, string>
        authoringContext: { destination: { source: 'user-dsh'; directory: string; conflict: boolean } }
      }
      expect(template.authoringContext.destination)
        .toEqual({ source: 'user-dsh', directory: join(installRoot, name),
          skillFile: join(installRoot, name, 'SKILL.md'), conflict: false })
      await expect(readdir(installRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      for (const [path, content] of Object.entries(template.files)) {
        const destination = join(template.authoringContext.destination.directory, path)
        await mkdir(dirname(destination), { recursive: true })
        await writeFile(destination, (path === 'SKILL.md'
          ? content.replace('name: quickjs-char-count-example', `name: ${name}`) : content)
          .replaceAll('qianshou_quickjs_char_count_v1', name.replaceAll('-', '_') + '_v1'))
      }
      const completed = await call('qianshou_skill_complete', { name, source: template.authoringContext.destination.source })
      expect(completed.isError).toBe(false)
      expect(JSON.parse(String(completed.value))).toMatchObject({ state: 'saved', platformContacted: false,
        actions: { protocol: 'qianshou.skill-actions.v1', state: 'saved', name, source: 'user-dsh', portableTrial: true } })
      expect(completed.meta).toMatchObject({ protocol: 'qianshou.skill-actions.v1', state: 'saved', name, portableTrial: true })
      const trial = await call('qianshou_try_local_skill', { name, source: template.authoringContext.destination.source,
        inputJson: '{"text":"千手🙂"}' })
      expect(trial.isError).toBe(false)
      expect(JSON.parse(String(trial.value))).toMatchObject({ output: { count: 3 } })
      expect(trial.meta).toMatchObject({ protocol: 'qianshou.skill-actions.v1', state: 'local-trial', name, portableTrial: true })
      const collision = await call('qianshou_skill_authoring_template', { name })
      expect(JSON.parse(String(collision.value)).authoringContext.destination.conflict).toBe(true)
    } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
  })

it.each([
  ['environment', 'source-inventory', 'installed-environment'],
  ['lock', 'dependency-lock', 'dependency-lock'],
  ['local', 'declaration', 'local-only'],
  ['runtime', 'declaration', 'runtime-abi'],
  ['entry', 'runtime-entry', 'runtime-entry'],
  ['schema', 'task-definition', 'output-schema'],
] as const)('returns local rejection facts for %s without a platform request', async (change, check, reason) => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'qianshou-source-rejection-'))
  const installRoot = join(home, 'skills')
  const ctx = new Context()
  const send = vi.fn()
  vi.stubGlobal('fetch', send)
  try {
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillImport, { installRoot })
    await ctx.plugin(Catalog, { registryUrl: 'https://registry.npmjs.org/', timeoutMs: 1000,
      connection: 'shipped', apiBaseUrl: '', installHome: join(home, 'catalog'), publisherKeys: {} })
    await ctx.plugin(LocalSkillTools)
    const call = (name: string, args: unknown) => ctx.tools.execute({ name, arguments: args,
      callId: ToolCallId(`rejection-${name}`), signal: new AbortController().signal })
    const result = await call('qianshou_skill_authoring_template', { name: 'svg-to-video' })
    const template = JSON.parse(typeof result.value === 'string' ? result.value : JSON.stringify(result.value)) as { files: Record<string, string>
      runtimeCapabilities: { externalProcesses: boolean; mediaEncoder: boolean } }
    expect(template.runtimeCapabilities).toMatchObject({ externalProcesses: false, mediaEncoder: false })
    const directory = join(installRoot, 'svg-to-video')
    for (const [path, content] of Object.entries(template.files)) {
      const target = join(directory, path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, path === 'SKILL.md'
        ? content.replace('name: quickjs-char-count-example', 'name: svg-to-video') : content)
    }
    const root = join(directory, 'scripts', 'order_adapter')
    if (change === 'environment') await mkdir(join(root, 'node_modules'))
    if (change === 'lock') await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    if (change === 'entry') await writeFile(join(root, 'src', 'adapter.mjs'), '// native renderer')
    if (change === 'local' || change === 'runtime') {
      const descriptor = JSON.parse(template.files['scripts/order_adapter/local-adapter.json']!)
      if (change === 'local') descriptor.platformDispatchable = false
      else descriptor.runtime.engine = 'node-child-process'
      await writeFile(join(root, 'local-adapter.json'), JSON.stringify(descriptor))
    }
    if (change === 'schema') {
      const definition = JSON.parse(template.files['scripts/order_adapter/task-definition.json']!)
      definition.outputSchema.properties.count.const = 4
      await writeFile(join(root, 'task-definition.json'), JSON.stringify(definition))
    }
    const trial = await call('qianshou_try_local_skill', {
      name: 'svg-to-video', source: 'user-dsh', inputJson: '{"text":"千手🙂"}',
    })
    expect(trial.isError).toBe(true)
    if (!trial.isError) throw new Error('expected local rejection')
    const rejection = JSON.parse(trial.error.message)
    expect(rejection).toMatchObject({ status: 'rejected', stage: 'local-package-validation',
      check, reason, platformContacted: false })
    expect(rejection.instructions).toContain('动画计划')
    expect(JSON.stringify(rejection)).not.toContain(home)
    expect(send).not.toHaveBeenCalled()
  } finally {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
    vi.unstubAllGlobals()
  }
})

it('keeps structured rejection across bundles and excludes arbitrary diagnostic payloads', () => {
  const foreign = Object.assign(new Error('QIANSHOU_CATALOG_order-adapter-invalid'), {
    diagnostic: { check: 'source-inventory', reason: 'installed-environment' },
  })
  expect(localOrderSourceRejection(foreign)).toMatchObject({ check: 'source-inventory',
    reason: 'installed-environment', platformContacted: false })
  const privateText = Object.assign(new Error('QIANSHOU_CATALOG_order-adapter-invalid'), {
    diagnostic: { check: '/private/secret', reason: 'token=secret' },
  })
  expect(JSON.stringify(localOrderSourceRejection(privateText))).not.toContain('secret')
  expect(localOrderSourceRejection(new Error('another failure'))).toBeNull()
  expect(localOrderSourceRejection(new OrderSourceFailure({ check: 'declaration', reason: 'runtime-abi' })))
    .toMatchObject({ check: 'declaration', reason: 'runtime-abi' })
})

it('refuses a completion card for a skill that was never saved, and distinguishes a saved instruction from execution', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'qianshou-saved-card-'))
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillImport, { installRoot: home })
    await ctx.plugin(Catalog, { registryUrl: 'https://registry.npmjs.org/', timeoutMs: 1000,
      connection: 'shipped', apiBaseUrl: '', installHome: join(home, 'catalog'), publisherKeys: {} })
    await ctx.plugin(LocalSkillTools)
    const call = () => ctx.tools.execute({ name: 'qianshou_skill_complete', arguments: { name: 'saved-guide', source: 'user-dsh' },
      callId: ToolCallId('complete-guide'), signal: new AbortController().signal })
    expect((await call()).isError).toBe(true)
    await mkdir(join(home, 'saved-guide'))
    await writeFile(join(home, 'saved-guide', 'SKILL.md'), '---\nname: saved-guide\ndescription: An instruction skill\n---\n# 保存方法\n')
    const complete = await call()
    expect(complete.isError).toBe(false)
    expect(complete.meta).toMatchObject({ protocol: 'qianshou.skill-actions.v1', state: 'saved', portableTrial: false })
    expect(complete.meta).not.toHaveProperty('artifactDigest')
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

it.each(['python-v2', 'canonical', 'canonical-unavailable'] as const)('uses the actual registered %s native author tool and skill-import root to save only five explicit V2 files', async (runtime) => {
  const { NATIVE_H3_RUNTIME_ABI_V2, NATIVE_H3_RUNTIME_V2, NATIVE_H3_RUNTIME_ABI_CANONICAL, NATIVE_H3_RUNTIME_CANONICAL } = await import('../../compute-core/src/native-h3-binding.ts')
  const { readNativeH3OrderSource } = await import('../src/native-h3-order-source.ts')
  const home = await mkdtemp(join(await realpath(tmpdir()), 'h3-v2-author-tools-'))
  const installRoot = join(home, 'skills')
  const ctx = new Context()
  const oldRead = vi.fn(async () => { throw new Error('must not upgrade V1') })
  const binding = { schema: 'qianshou.native-h3-execution-binding.v2' as const, runtimeAbi: runtime === 'python-v2' ? NATIVE_H3_RUNTIME_ABI_V2 : NATIVE_H3_RUNTIME_ABI_CANONICAL,
    runtime: runtime === 'python-v2' ? NATIVE_H3_RUNTIME_V2 : NATIVE_H3_RUNTIME_CANONICAL, executionRecipeSha256: 'a'.repeat(64), modelSha256: 'b'.repeat(64), firstFrameSha256: 'c'.repeat(64) }
  try {
    await ctx.plugin(SystemPrompt, { personaPrefix: '' }); await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillImport, { installRoot })
    await ctx.plugin(Catalog, { registryUrl: 'https://registry.npmjs.org/', timeoutMs: 1000,
      connection: 'shipped', apiBaseUrl: '', installHome: join(home, 'catalog'), publisherKeys: {} })
    ctx.provide('qianshouAccount', { state: async () => ({ phase: 'authenticated', account: { id: '167' } }) })
    ctx.provide('nodeContributor', { nativeH3AuthorBinding: oldRead,
      nativeH3AuthorBindingV2: oldRead,
      nativeH3AuthorBindingCurrent: async () => {
        if (runtime === 'canonical-unavailable') throw new Error('H3_CANONICAL_SELF_TEST_INVALID')
        return { binding, localOwnerConfigDigest: 'sha256:' + 'd'.repeat(64) }
      } })
    await ctx.plugin(LocalSkillTools)
    const result = await ctx.tools.execute({ name: 'qianshou_skill_authoring_template', arguments: { name: 'h3-v2-test',
      runtime: 'native-h3' },
    callId: ToolCallId('h3-v2-author'), signal: new AbortController().signal })
    if (runtime === 'canonical-unavailable') {
      expect(result.isError).toBe(true)
      expect(oldRead).not.toHaveBeenCalled()
      await expect(readdir(join(installRoot, 'h3-v2-test'))).rejects.toMatchObject({ code: 'ENOENT' })
      return
    }
    expect(result.isError).toBe(false)
    const template = JSON.parse(typeof result.value === 'string' ? result.value : JSON.stringify(result.value)) as { files: Record<string, string>
      authoringContext: { destination: { directory: string } } }
    expect(Object.keys(template.files)).toHaveLength(5)
    const root = template.authoringContext.destination.directory
    expect(root).toBe(join(installRoot, 'h3-v2-test'))
    await expect(readdir(root)).rejects.toMatchObject({ code: 'ENOENT' })
    for (const [path, bytes] of Object.entries(template.files)) { await mkdir(dirname(join(root, path)),
      { recursive: true }); await writeFile(join(root, path), bytes) }
    const source = await readNativeH3OrderSource(join(root, 'SKILL.md'))
    expect(source.declaration.contractVersion).toBe('v2')
    expect(source.declaration.taskType).toMatch(/^qianshou_h3_[a-f0-9]{32}_v2$/u)
    expect(source.taskDefinition.nativeBinding).toEqual(binding)
    expect(source.files.every(file => !file.bytes.includes(Buffer.from('localOwnerConfigDigest')))).toBe(true)
    expect(oldRead).not.toHaveBeenCalled()
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})
