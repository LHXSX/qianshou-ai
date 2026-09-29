/** Execute the packaged fixture through a real Loader and the real tool policy pipeline. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { boot } from '@deepseek-ai/dsh-app-boot'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'

it.each(['1', '2'])('loads text-tools v%s, executes real statistics, and removes its tool with the entry', async (version) => {
  const dir = await mkdtemp(join(tmpdir(), 'qianshou-text-tools-loader-'))
  const config = join(dir, 'cordis.yml')
  await writeFile(config, '[]\n')
  const ctx = await boot('fixture', config, [{ insert: [
    { id: 'system-prompt', name: 'cordis:system-prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'fixture', name: fileURLToPath(new URL(`./fixtures/text-tools-v${version}/index.js`, import.meta.url)) },
  ] }], (ctx) => {
    ctx.loader.builtins['system-prompt'] = SystemPrompt
    ctx.loader.builtins.tools = Tools
  })
  try {
    const call = (text: string) => ctx.tools.execute({ name: 'qianshou_text_statistics', arguments: { text },
      callId: ToolCallId('local-text-statistics'), signal: new AbortController().signal })
    const result = await call('hello')
    expect(result.isError).toBe(false)
    if (typeof result.value !== 'string') throw new Error('expected structured text output')
    expect(JSON.parse(result.value)).toEqual({ version: `${version}.0.0`, characters: 5, utf8Bytes: 5,
      nonemptyLines: 1, sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      ...(version === '2' ? { whitespaceSeparatedWords: 1 } : {}) })
    const bounded = await call('汉'.repeat(22000))
    expect(bounded.isError).toBe(true)
    expect(JSON.stringify(bounded.content)).toContain('TEXT_TOO_LARGE')
    const entry = [...ctx.loader.entries()].find(row => row.options.id === 'fixture')
    if (entry === undefined) throw new Error('fixture entry absent')
    await entry.update({ disabled: true })
    await ctx.loader.await()
    const removed = await call('hello')
    expect(removed.isError).toBe(true)
    expect(ctx.tools.get('qianshou_text_statistics')).toBeUndefined()
    expect(JSON.stringify(removed.content)).toContain('unknown tool')
  } finally {
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
