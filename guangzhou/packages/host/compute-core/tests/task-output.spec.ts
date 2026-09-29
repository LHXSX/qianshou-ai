import { createHash } from 'node:crypto'
import { link, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyTaskOutputs } from '../src/task-output.ts'

const paths: string[] = []
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }) })
async function root() { const path = await mkdtemp(join(tmpdir(), 'compute-output-test-')); paths.push(path); return path }
const output = (path: string) => ({ name: 'result', path, bytes: 5, sha256: createHash('sha256').update('hello').digest('hex') })
const signal = () => new AbortController().signal

describe('task result verification', () => {
  it('hashes a relative result inside the workspace and strips undeclared plugin fields', async () => {
    const path = await root()
    await writeFile(join(path, 'output'), 'hello')
    const result = await verifyTaskOutputs(path, { outputs: [{ ...output('output'), credential: 'untrusted field' } as ReturnType<typeof output>] }, 5, signal())
    expect(result.outputs).toEqual([output(await realpath(join(path, 'output')))])
    expect(Object.isFrozen(result.outputs[0])).toBe(true)
  })

  it('rejects an output outside the task workspace', async () => {
    const path = await root()
    const outside = await root()
    await writeFile(join(outside, 'secret'), 'hello')
    await expect(verifyTaskOutputs(path, { outputs: [output(join(outside, 'secret'))] }, 5, signal())).rejects.toThrow('COMPUTE_OUTPUT_PATH_INVALID')
  })

  it('rejects symlinks and hard links to files outside the workspace', async () => {
    const path = await root()
    const outside = await root()
    await writeFile(join(outside, 'secret'), 'hello')
    await symlink(join(outside, 'secret'), join(path, 'symbolic'))
    await link(join(outside, 'secret'), join(path, 'hard'))
    await expect(verifyTaskOutputs(path, { outputs: [output('symbolic')] }, 5, signal())).rejects.toThrow('COMPUTE_OUTPUT_PATH_INVALID')
    await expect(verifyTaskOutputs(path, { outputs: [output('hard')] }, 5, signal())).rejects.toThrow('COMPUTE_OUTPUT_FILE_INVALID')
  })

  it('rejects forged file sizes and digests', async () => {
    const path = await root()
    await writeFile(join(path, 'short'), 'hell')
    await writeFile(join(path, 'changed'), 'jello')
    await expect(verifyTaskOutputs(path, { outputs: [output('short')] }, 5, signal())).rejects.toThrow('COMPUTE_OUTPUT_FILE_INVALID')
    await expect(verifyTaskOutputs(path, { outputs: [output('changed')] }, 5, signal())).rejects.toThrow('COMPUTE_OUTPUT_DIGEST_MISMATCH')
  })

  it('enforces the aggregate limit and refuses duplicate physical results', async () => {
    const path = await root()
    await writeFile(join(path, 'one'), 'hello')
    await writeFile(join(path, 'two'), 'hello')
    await expect(verifyTaskOutputs(path, { outputs: [output('one'), { ...output('two'), name: 'second' }] }, 9, signal())).rejects.toThrow('COMPUTE_OUTPUT_LIMIT_EXCEEDED')
    await expect(verifyTaskOutputs(path, { outputs: [output('one'), { ...output('one'), name: 'second' }] }, 10, signal())).rejects.toThrow('COMPUTE_OUTPUT_PATH_INVALID')
  })
})
