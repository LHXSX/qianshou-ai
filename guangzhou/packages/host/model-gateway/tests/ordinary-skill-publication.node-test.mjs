import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { createOrdinarySkillPublication, ordinarySkillReviewBytes, ORDINARY_SKILL_PATH } from '../src/ordinary-skill-publication.ts'
import { verifyOrdinarySkillPackage } from '../src/ordinary-skill-package.ts'
import { createOrdinarySkillBearerRoute } from '../src/ordinary-skill-bearer.ts'

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1 }
  return (crc ^ 0xffffffff) >>> 0
}
function zip(entries) {
  const locals = []; const central = []; let offset = 0
  for (const [name, content] of entries) {
    const path = Buffer.from(name); const bytes = Buffer.from(content); const checksum = crc32(bytes); const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(path.length, 26); locals.push(local, path, bytes)
    const dir = Buffer.alloc(46); dir.writeUInt32LE(0x02014b50); dir.writeUInt16LE((3 << 8) | 20, 4); dir.writeUInt16LE(20, 6)
    dir.writeUInt32LE(checksum, 16); dir.writeUInt32LE(bytes.length, 20); dir.writeUInt32LE(bytes.length, 24); dir.writeUInt16LE(path.length, 28)
    dir.writeUInt32LE((0o100600 << 16) >>> 0, 38); dir.writeUInt32LE(offset, 42); central.push(dir, path); offset += 30 + path.length + bytes.length
  }
  const c = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(c.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, c, end])
}
const archive = () => zip([['SKILL.md', '---\nname: write-summary\ndescription: Summarize local notes\n---\nRead the notes and write a concise summary.\n'], ['references/style.md', 'Use plain language.\n']])
const submit = () => ({ action: 'submit', requestId: randomUUID(), skillId: 'write-summary', version: '1.0.0', title: 'Summary skill', summary: 'An ordinary instruction skill', price_yuan: '5.00', archiveBase64: archive().toString('base64') })
const actor = { accountId: '7', isAdmin: false }
const staff = { accountId: '8', isAdmin: true }
function signedReview(meta, pair, changed = {}) {
  const fields = ['submissionId', 'accountId', 'skillId', 'version', 'title', 'summary', 'price_yuan', 'currency', 'packageSha256', 'packageBytes', 'unpackedTreeSha256', 'skillMdSha256', 'skillMdPath']
  const payload = { schema: 'qianshou.ordinary-skill-review.v1', purpose: 'qianshou:ordinary-skill-review', ...Object.fromEntries(fields.map(k => [k, meta[k]])),
    manual_test: { tested: true, test_receipt_sha256: 'e'.repeat(64) }, decision: 'publish', note: 'Staff pulled and manually tested this exact fixture.',
    reviewId: randomUUID(), operatorId: 'reviewer', operatorAccountId: '8', reviewedAt: Date.now(), ...changed }
  return { key_id: 'reviewer', payload, signature: sign(null, ordinarySkillReviewBytes(payload), pair.privateKey).toString('base64') }
}
const request = (body, who = 'owner') => new Request('https://local/api/skills', { method: 'POST', headers: { authorization: 'Bearer ' + who, 'content-type': 'application/json' }, body: JSON.stringify(body) })
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'qs-ordinary-skill-')); const pair = generateKeyPairSync('ed25519')
  const options = { storePath: join(dir, 'publication.sqlite'), operatorKeys: { reviewer: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') },
    operatorAccounts: { reviewer: '8' }, authenticate: async req => req.headers.get('authorization')?.endsWith('staff') ? staff : actor }
  return { dir, pair, options, service: createOrdinarySkillPublication(options) }
}

test('ordinary SKILL.md packages need no adapter manifest and reject traversal, malformed text and mixed roots', () => {
  const verified = verifyOrdinarySkillPackage(archive()); assert.equal(verified.skillMdPath, 'SKILL.md'); assert.equal(verified.files.length, 2)
  assert.equal(verifyOrdinarySkillPackage(zip([['summary/SKILL.md', '# Summary\n']])).skillMdPath, 'summary/SKILL.md')
  assert.throws(() => verifyOrdinarySkillPackage(zip([['SKILL.md', '# okay'], ['../secret', 'bad']])));
  assert.throws(() => verifyOrdinarySkillPackage(zip([['a/SKILL.md', '# okay'], ['b/file', 'bad']])));
  assert.throws(() => verifyOrdinarySkillPackage(zip([['SKILL.md', Buffer.from([0xff])]])));
})

test('staff pulls original bytes, independently signs tested package and price, and publication survives restart', async () => {
  const f = setup(); let service = f.service
  try {
    const body = submit(); const first = await (await service.handler(request(body))).json(); const meta = first.submission
    assert.equal(meta.kind, 'ordinary_skill'); assert.equal(meta.review.status, 'pending'); assert.equal(meta.price_yuan, '5.00')
    assert.equal(meta.publisher_kind, 'user')
    assert.equal(meta.requestId, body.requestId)
    const recovered = await (await service.handler(request({ action: 'mine', requestId: body.requestId }))).json()
    assert.equal(recovered.submissions.length, 1); assert.equal(recovered.submissions[0].submissionId, meta.submissionId)
    assert.deepEqual((await (await service.handler(request({ action: 'mine', requestId: randomUUID() }))).json()).submissions, [])
    assert.equal((await (await service.handler(request(body))).json()).duplicate, true)
    assert.equal((await service.handler(request({ ...body, price_yuan: '6.00' }))).status, 409)
    assert.equal((await service.handler(request({ action: 'pull', submissionId: meta.submissionId }))).status, 403)
    const pulled = await (await service.handler(request({ action: 'pull', submissionId: meta.submissionId }, 'staff'))).json()
    assert.deepEqual(Buffer.from(pulled.archiveBase64, 'base64'), archive())
    const receipt = signedReview(meta, f.pair); const review = { action: 'review', submissionId: meta.submissionId, review: receipt }
    assert.equal((await service.handler(request(review, 'staff'))).status, 200)
    assert.equal((await (await service.handler(request(review, 'staff'))).json()).duplicate, true)
    const listing = (await (await service.catalog()).json()).listings[0]
    assert.equal(listing.review.status, 'published'); assert.equal(listing.purchase_available, false); assert.equal(listing.installable, false)
    assert.equal(listing.price_yuan, '5.00'); assert.equal(listing.review.receipt.signature, receipt.signature)
    service.close(); service = createOrdinarySkillPublication({ ...f.options, officialAccounts: ['7'] })
    assert.equal((await (await service.catalog()).json()).listings[0].packageSha256, meta.packageSha256)
    assert.equal((await (await service.catalog()).json()).listings[0].publisher_kind, 'official')
    assert.equal(statSync(f.options.storePath).mode & 0o777, 0o600)
  } finally { service.close(); rmSync(f.dir, { recursive: true, force: true }) }
})

test('unreviewed, forged, changed-price and duplicate-version packages cannot become a published skill', async () => {
  const f = setup()
  try {
    const meta = (await (await f.service.handler(request(submit()))).json()).submission
    assert.equal((await (await f.service.catalog()).json()).listings.length, 0)
    const apply = async receipt => await f.service.handler(request({ action: 'review', submissionId: meta.submissionId, review: receipt }, 'staff'))
    assert.equal((await apply(signedReview(meta, f.pair, { price_yuan: '8.00' }))).status, 400)
    assert.equal((await apply(signedReview(meta, f.pair, { manual_test: { tested: false, test_receipt_sha256: null } }))).status, 400)
    const bad = signedReview(meta, f.pair); bad.payload.packageSha256 = 'a'.repeat(64); assert.equal((await apply(bad)).status, 400)
    assert.equal((await apply(signedReview(meta, f.pair, { reviewedAt: Date.now() - 600_000 }))).status, 400)
    assert.equal((await apply(signedReview(meta, f.pair))).status, 200)
    const another = (await (await f.service.handler(request(submit()))).json()).submission
    const duplicate = await f.service.handler(request({ action: 'review', submissionId: another.submissionId, review: signedReview(another, f.pair) }, 'staff'))
    assert.equal(duplicate.status, 409); assert.equal((await (await f.service.catalog()).json()).listings.length, 1)
  } finally { f.service.close(); rmSync(f.dir, { recursive: true, force: true }) }
})

test('real public HTTP permits account submission and own reads while staff pull/review stay off the public carrier', async () => {
  const f = setup(); const token = 'buyer-'.padEnd(32, 'b')
  const service = createOrdinarySkillPublication({ ...f.options, storePath: undefined, authenticate: async () => actor })
  service.close() // Unconfigured source remains closed.
  const route = createOrdinarySkillBearerRoute({ path: ORDINARY_SKILL_PATH, actions: ['submit', 'mine', 'catalog'], handle: f.service.handler, publicRead: f.service.catalog })
  const server = createServer((req, res) => { void route.handler(req, res) }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}${ORDINARY_SKILL_PATH}`
  const post = async (body, headers = {}) => await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  try {
    assert.equal((await post(submit())).status, 200)
    assert.equal((await post({ action: 'pending' })).status, 403); assert.equal((await post({ action: 'pull', submissionId: randomUUID() })).status, 403)
    assert.equal((await post(submit(), { origin: 'https://evil.example' })).status, 403)
    assert.equal((await fetch(url)).status, 200); assert.deepEqual((await (await post({ action: 'catalog' })).json()).listings, [])
    const own = await (await post({ action: 'mine' })).json(); assert.equal(own.submissions.length, 1)
  } finally { await new Promise(resolve => server.close(resolve)); f.service.close(); rmSync(f.dir, { recursive: true, force: true }) }
})
