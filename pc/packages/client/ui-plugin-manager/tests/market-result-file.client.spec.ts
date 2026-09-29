import { afterEach, describe, expect, it, vi } from 'vitest'
import { marketResultFile } from '../src/client/market-result-file.ts'

const taskId = '12345678-1234-4234-8234-123456789abc'
const otherId = '87654321-4321-4321-8321-cba987654321'
const sha = 'a'.repeat(64)
const reference = `qianshou-file://task/${taskId}/${sha}`
const web = { protocol: 'https:', origin: 'https://app.example', hostname: 'app.example' }

afterEach(() => { vi.unstubAllGlobals() })

describe('market file attachment request', () => {
  it.each([
    { protocol: 'dsh-app:', origin: 'null', hostname: 'app', base: 'dsh-app://app' },
    { ...web, base: web.origin },
    { protocol: 'http:', origin: 'http://localhost:5277', hostname: 'localhost', base: 'http://localhost:5277' },
  ])('uses only the current $protocol renderer origin', (location) => {
    const result = marketResultFile(reference, taskId, location)
    expect(result).toEqual({ href: `${location.base}/api/qianshou/result-file?task_id=${taskId}&asset_id=${sha}` })
    const url = new URL(result!.href)
    expect([...url.searchParams.keys()]).toEqual(['task_id', 'asset_id'])
    expect(url.pathname).toBe('/api/qianshou/result-file')
    expect(url.username).toBe('')
    expect(url.password).toBe('')
    expect(url.hash).toBe('')
  })

  it('rejects a different card identity rather than exposing another task', () => {
    for (const expected of [otherId, taskId.toUpperCase(), '../' + taskId, '', 'workload-1']) {
      expect(marketResultFile(reference, expected, web)).toBeNull()
    }
  })

  it.each([
    reference + '?token=private', reference + '#hash', reference + '/extra', reference + '.pdf',
    reference.replace(taskId, taskId.toUpperCase()), reference.replace(sha, sha.toUpperCase()),
    reference.replace(taskId, '%31' + taskId.slice(1)), reference.replace('/task/', '/user@task/'),
    reference.replace('/task/', '/task/../'), reference.replace(sha, 'a'.repeat(63)),
    reference.replace(sha, 'a'.repeat(65)), reference.replace('qianshou-file:', 'QIANSHOU-FILE:'),
    reference.replace('qianshou-file:', 'qianshou-media:') + '.png',
    'https://private-bucket.example/result.pdf?version=private',
    'javascript:alert(1)', 'data:text/html,<script>private</script>',
    JSON.stringify({ schema: 'artifact.v1', workload_id: taskId, sha256: sha, object_key: 'private-key' }),
    ' ' + reference, reference + '\n', '',
  ])('refuses malformed, raw or foreign reference %s', (value) => {
    expect(marketResultFile(value, taskId, web)).toBeNull()
  })

  it.each([
    { protocol: 'file:', origin: 'null', hostname: '' },
    { protocol: 'data:', origin: 'null', hostname: '' },
    { protocol: 'dsh-app:', origin: 'null', hostname: 'foreign' },
    { ...web, origin: 'not an origin' },
    { ...web, origin: 'https://app.example/' },
    { ...web, origin: 'https://app.example/path' },
    { ...web, origin: 'https://app.example?token=private' },
    { ...web, origin: 'https://app.example#hash' },
    { ...web, origin: 'https://user:secret@app.example' },
    { ...web, origin: 'https://foreign.example' },
    { ...web, protocol: 'http:' },
    { ...web, origin: 'null' },
  ])('rejects inconsistent or unsupported renderer location $origin', (location) => {
    expect(marketResultFile(reference, taskId, location)).toBeNull()
  })

  it('does not fetch, render, execute or treat a request as independently verified', () => {
    const fetch = vi.fn(() => { throw new Error('unexpected fetch') })
    vi.stubGlobal('fetch', fetch)
    const result = marketResultFile(reference, taskId, web)
    expect(result).toEqual({ href: `${web.origin}/api/qianshou/result-file?task_id=${taskId}&asset_id=${sha}` })
    expect(Object.keys(result!)).toEqual(['href'])
    expect(fetch).not.toHaveBeenCalled()
  })
})
