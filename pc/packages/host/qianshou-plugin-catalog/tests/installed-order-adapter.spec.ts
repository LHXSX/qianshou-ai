import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { installedOrderAdapter } from '../src/installed-order-adapter.ts'

it('keeps an existing broken isolated runtime intact and fails closed before network installation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qianshou-runtime-corrupt-'))
  try {
    const root = join(home, 'scripts', 'order_adapter')
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(home, 'SKILL.md'), 'name: test\n')
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }))
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
    await writeFile(join(root, 'local-adapter.json'), JSON.stringify({
      schema: 'qianshou.local-adapter-candidate.v1', taskType: 'bar_chart_svg_v1',
      inputKind: 'inline_json', outputKind: 'local_artifact_manifest',
    }))
    for (const name of ['adapter.mjs', 'assemble_gif.py', 'encode_frames.swift']) {
      await writeFile(join(root, 'src', name), '// isolated fixture\n')
    }
    await mkdir(join(root, '.venv', 'bin'), { recursive: true })
    const python = join(root, '.venv', 'bin', 'python3')
    await writeFile(python, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    await expect(installedOrderAdapter(join(home, 'SKILL.md'), { prepareRuntime: true }))
      .rejects.toMatchObject({ code: 'order-runtime-unavailable' })
    expect(await readFile(python, 'utf8')).toBe('#!/bin/sh\nexit 1\n')
    expect((await readdir(root)).filter(name => name.startsWith('.venv.prepare-'))).toEqual([])
  } finally { await rm(home, { recursive: true, force: true }) }
})
