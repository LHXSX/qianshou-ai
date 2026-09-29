import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const repo = fileURLToPath(new URL('../../../../', import.meta.url))
const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
const headless = join(repo, 'apps/cli/tests/profiles/headless')
const settlement = join(headless, 'tests/expected/subagent-settlement')
const driver = fixture('persistence-consumer.ts')
const tsconfigPath = join(repo, 'tsconfig.json')

describe('shipped profile persistence startup requirements', () => {
  it('waits for a delayed real backend and stores both root and child completion', async () => {
    const result = await runLoaderSmoke({
      label: 'delayed durable root and child',
      tempDirPrefix: 'loader-smoke-durable-profile-',
      binScript: driver,
      configPath: fixture('delayed-persistence.patch.yml'),
      binArgs: [join(headless, 'subagent-settlement-snapshot.patch.yml'), fixture('delayed-persistence.patch.yml'),
        'required', 'Start one continuable background subagent and answer from its completion notice. Do not call list_agents, send_message, job_output, or job_list.'],
      tsconfigPath,
      mode: 'src',
      env: {
        DEEPSEEK_API_KEY: '',
        DSH_SNAPSHOT: 'replay',
        DSH_SNAPSHOT_FILE: join(settlement, 'parent.replay.jsonl'),
        DSH_SNAPSHOT_OVERRIDE: join(settlement, 'parent.override.json'),
        DSH_SNAPSHOT_CHILD_FILES: join(settlement, 'child.replay.jsonl'),
        NODE_OPTIONS: '--disable-warning=ExperimentalWarning',
      },
      inspect: async (cwd) => {
        const root = join(cwd, '.sessions')
        const files = (await readdir(root, { recursive: true })).filter(file => file.endsWith('.jsonl'))
        expect(files).toHaveLength(2)
        const logs = await Promise.all(files.map(async (file) => {
          const content = await readFile(join(root, file), 'utf8')
          return content.split('\n').filter(Boolean).map(line => JSON.parse(line) as {
            type: string
            id?: string
            parentSession?: string
            data?: { reason?: { kind?: string } }
          })
        }))
        const parent = logs.find(rows => rows[0]?.parentSession === undefined)
        const child = logs.find(rows => rows[0]?.parentSession !== undefined)
        expect(parent?.[0]?.type).toBe('session')
        expect(child?.[0]?.parentSession).toBe(parent?.[0]?.id)
        for (const rows of [parent, child]) {
          expect(rows?.findLast(row => row.type === 'turn/end')?.data?.reason?.kind).toBe('completed')
        }
        expect(JSON.stringify(parent)).toContain('PARENT_RECEIVED_CHILD_RESULT')
        expect(JSON.stringify(child)).toContain('CHILD_RESULT')
      },
    })
    const output = JSON.parse(result.stdout) as { result: { output: string }; startup: { persistence: boolean }[] }
    expect(output.result.output).toBe('PARENT_RECEIVED_CHILD_RESULT')
    expect(output.startup.length).toBeGreaterThanOrEqual(2)
    expect(output.startup.every(event => event.persistence)).toBe(true)
    expect(result.stderr).toBe('')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it.each(['stateless', 'omitted'])('supports %s startup with the backend disabled', async (requirement) => {
    const result = await runLoaderSmoke({
      label: `stateless profile ${requirement}`,
      tempDirPrefix: 'loader-smoke-stateless-profile-',
      binScript: driver,
      configPath: fixture('stateless-profile.patch.yml'),
      binArgs: [join(headless, 'retry-snapshot.patch.yml'), fixture('stateless-profile.patch.yml'), requirement, 'Say RETRY_OK after one retry.'],
      tsconfigPath,
      mode: 'src',
      env: { DEEPSEEK_API_KEY: '', DSH_SNAPSHOT: 'replay', NODE_OPTIONS: '--disable-warning=ExperimentalWarning' },
      inspect: (cwd) => { expect(existsSync(join(cwd, '.sessions'))).toBe(false) },
    })
    const output = JSON.parse(result.stdout) as { result: { output: string }; startup: { persistence: boolean }[] }
    expect(output.result.output).toBe('RETRY_OK')
    expect(output.startup).toEqual([{ event: 'agent-created', persistence: false }])
    expect(result.stderr).toBe('')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
