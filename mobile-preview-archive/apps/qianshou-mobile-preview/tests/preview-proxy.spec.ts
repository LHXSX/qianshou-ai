/** Same-origin translation cannot turn an external browser request into a trusted one. */
import { expect, it } from 'vitest'
import { forwardPreviewHeaders } from '../preview-proxy.ts'

it.each(['127.0.0.1:4181', 'localhost:4175', '[::1]:4190'])('translates only the exact local authority %s', (host) => {
  const headers = new Map([['cookie', 'private-cookie'], ['origin', `http://${host}`], ['authorization', 'Bearer scoped-test-token']])
  forwardPreviewHeaders({ removeHeader: (name) => { headers.delete(name) }, setHeader: (name, value) => { headers.set(name, value) } },
    { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' }, 'https://app.qianshousuanli.com')
  expect(headers.has('cookie')).toBe(false)
  expect(headers.get('origin')).toBe('https://app.qianshousuanli.com')
  expect(headers.get('authorization')).toBe('Bearer scoped-test-token')
})

it.each([
  { host: '127.0.0.1:4181', origin: 'https://external.invalid' },
  { host: '127.0.0.1:4181', origin: 'http://127.0.0.1:4182' },
  { host: '127.0.0.1:4181', origin: 'http://localhost:4181' },
  { host: 'external.invalid', origin: 'https://external.invalid' },
  { host: '127.0.0.1:4181', origin: 'null' },
  { host: '127.0.0.1:4181', origin: 'broken' },
  { host: '127.0.0.1:4181', origin: 'http://user@127.0.0.1:4181' },
  { host: '127.0.0.1:4181', origin: 'http://127.0.0.1:4181/path' },
  { host: '127.0.0.1:4181', origin: 'http://127.0.0.1:4181', 'sec-fetch-site': 'cross-site' },
  { host: '127.0.0.1:4181', origin: 'http://127.0.0.1:4181', 'sec-fetch-site': 'same-site' },
  { host: '127.0.0.1:4181' },
  { origin: 'http://127.0.0.1:4181' },
  { host: '127.0.0.1:4181', origin: ['http://127.0.0.1:4181', 'https://external.invalid'] },
])('does not rewrite untrusted or absent origin %#', (incoming) => {
  const removed: string[] = []; const rewritten: unknown[] = []
  forwardPreviewHeaders({ removeHeader: (name) => { removed.push(name) }, setHeader: (...args) => { rewritten.push(args) } }, incoming, 'https://app.qianshousuanli.com')
  expect(removed).toEqual(['cookie'])
  expect(rewritten).toEqual([])
})
