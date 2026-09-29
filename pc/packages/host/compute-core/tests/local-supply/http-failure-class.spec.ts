/**
 * 读侧非 2xx 的**机器可读分类**（工单 6 · 第 2 条）。
 *
 * 为什么这组必须存在：`supply/http.ts:34-37` 曾把**任何**非 2xx 折成一个 code，
 * 于是「这单不存在（404 ⇒ 终局）」与「服务端 500（⇒ 可重试）」在下游长得一模一样，
 * 都只能落"未知"。本文件把两者钉成**不同的类**，并要求这个类能从错误对象上机器读出。
 *
 * 断言里刻意没有 receipt / ack / confirmed：HTTP 的失败分类不构成任何受理。
 */
import { createServer, type RequestListener } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { classifyHttpStatus, requestJson, SupplyHttpError } from '../../src/supply/http.ts'

const options = { timeoutMs: 1000, maxResponseBytes: 65536 }

const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

/** 一个真 HTTP 读侧；每个用例都走真 socket，不 mock fetch。 */
async function serve(handler: RequestListener) {
  const server = createServer(handler)
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
}

/** 用给定状态码回答一次；响应体刻意带一个「不该外泄」的标记。 */
async function answerWith(status: number): Promise<URL> {
  return serve((_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end('{"credential":"do-not-return"}')
  })
}

/** 拿一次真实的非 2xx 失败对象。 */
async function failureOf(status: number): Promise<SupplyHttpError> {
  const url = await answerWith(status)
  const thrown = await requestJson(url, {}, options).then(() => null, (error: unknown) => error)
  expect(thrown).toBeInstanceOf(SupplyHttpError)
  return thrown as SupplyHttpError
}

describe('HTTP failure classification', () => {
  it('classifies 404 and 5xx differently: 终局不存在 ≠ 服务端故障', async () => {
    const absent = await failureOf(404)
    const fault = await failureOf(500)
    // ① 本包的验收判据：两者必须落在**不同**的分类上。
    expect(absent.failureClass).toBe('workload-absent')
    expect(fault.failureClass).toBe('server-fault')
    expect(absent.failureClass).not.toBe(fault.failureClass)
    // 分类不止在字段上不同，在既有的稳定码上也不同：谁读哪一条都不会再把两者混为一谈。
    expect(absent.code).toBe('SUPPLY_HTTP_NOT_FOUND')
    expect(fault.code).toBe('SUPPLY_HTTP_FAILED')
    expect(absent.status).toBe(404)
    expect(fault.status).toBe(500)
  })

  it.each([
    [400, 'client-rejected', 'SUPPLY_HTTP_FAILED'],
    [401, 'auth-required', 'SUPPLY_AUTH_REQUIRED'],
    [403, 'auth-required', 'SUPPLY_AUTH_REQUIRED'],
    [404, 'workload-absent', 'SUPPLY_HTTP_NOT_FOUND'],
    [410, 'workload-absent', 'SUPPLY_HTTP_NOT_FOUND'],
    [429, 'throttled', 'SUPPLY_HTTP_THROTTLED'],
    [500, 'server-fault', 'SUPPLY_HTTP_FAILED'],
    [503, 'server-fault', 'SUPPLY_HTTP_FAILED'],
  ])('maps a real %i answer to class %s and code %s', async (status, failureClass, code) => {
    await expect(failureOf(status)).resolves.toMatchObject({ failureClass, code, status })
  })

  it('never lets the upstream failure body travel with the class', async () => {
    const error = await failureOf(500)
    expect(error.message).not.toContain('do-not-return')
    expect(String(error.stack)).not.toContain('do-not-return')
    expect(JSON.stringify(error)).not.toContain('do-not-return')
  })

  it('keeps the classifier total: a 2xx answer is not a failure, every other status has exactly one class', () => {
    expect(classifyHttpStatus(200)).toBeNull()
    expect(classifyHttpStatus(204)).toBeNull()
    expect(classifyHttpStatus(302)).toBe('client-rejected')
    expect(classifyHttpStatus(404)).toBe('workload-absent')
    expect(classifyHttpStatus(429)).toBe('throttled')
    expect(classifyHttpStatus(500)).toBe('server-fault')
  })
})
