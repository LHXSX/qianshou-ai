import assert from 'node:assert/strict'
import { test } from 'node:test'
import { submitEnterpriseInquiry } from '../src/services/enterprise-lead.ts'

const form = { company: '测试公司', contact: '联系人', phone: '13800000000', size: '11-50', use_case: 'other', budget: '', note: '测试说明' }
const json = (value, status, headers) => new Response(JSON.stringify(value), { status, headers })

test('first and duplicate submissions share one neutral accepted result', async () => {
  const calls = []
  const send = async (path, init) => {
    calls.push({ path, init })
    return json({ ok: true, message: '申请已收悉' }, 202)
  }
  assert.deepEqual(await submitEnterpriseInquiry(form, send), { kind: 'accepted' })
  assert.deepEqual(await submitEnterpriseInquiry(form, send), { kind: 'accepted' })
  assert.equal(calls[0].path, '/api/v8/leads/enterprise')
  assert.equal(calls[0].init.method, 'POST')
  const payload = JSON.parse(calls[0].init.body)
  assert.equal(payload.source, 'beta-program-page')
  assert.equal(payload.company, form.company)
  assert.ok(Number.isFinite(Date.parse(payload.submitted_at)))
})

test('only exact 202 ok:true counts as accepted; validation does not send', async () => {
  assert.deepEqual(await submitEnterpriseInquiry(form, async () => json({ ok: true }, 200)), { kind: 'unavailable' })
  assert.deepEqual(await submitEnterpriseInquiry(form, async () => json({ ok: false }, 202)), { kind: 'unavailable' })
  assert.deepEqual(await submitEnterpriseInquiry(form, async () => new Response('bad', { status: 202 })), { kind: 'unavailable' })
  assert.deepEqual(await submitEnterpriseInquiry({ ...form, company: 'x' }, async () => { throw new Error('should not send') }), { kind: 'invalid' })
  assert.deepEqual(await submitEnterpriseInquiry(form, async () => json({ detail: 'bad' }, 422)), { kind: 'invalid' })
})

test('rate limit, service fault and network fault remain distinct', async () => {
  assert.deepEqual(await submitEnterpriseInquiry(form, async () => json({}, 429, { 'Retry-After': '60' })), { kind: 'rate_limited', retryAfter: 60 })
  assert.deepEqual(await submitEnterpriseInquiry(form, async () => json({}, 503)), { kind: 'unavailable' })
  assert.deepEqual(await submitEnterpriseInquiry(form, async () => { throw new Error('offline') }), { kind: 'network' })
})
