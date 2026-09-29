/** Ephemeral two-key, fixed-account integration fixture. Binds only 127.0.0.1; never use as an auth server. */
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPluginFreeLicenseService, PLUGIN_LICENSE_PATH } from '../src/plugin-license.ts'
import { createPluginLicenseBearerRoute, createPluginLicenseBearerVerifier,
  PLUGIN_LICENSE_BEARER_PATH } from '../src/plugin-license-bearer.ts'
import { createPluginReleasesRoute, PLUGIN_RELEASES_PATH,
  pluginApprovalPayload, pluginReleasePayload } from '../src/plugin-releases.ts'
import { verifySeedPluginPackage } from '../src/plugin-seed-package.ts'
import { createPluginSubmissionRoute } from '../src/plugin-submissions.ts'

const accountId = process.argv[2] ?? 'test-mac-owner'
if (!/^[a-zA-Z0-9._:-]{1,128}$/u.test(accountId)) throw new Error('TEST_ACCOUNT_ID_INVALID')
const root = await mkdtemp(join(tmpdir(), 'qianshou-seed-loopback-'))
const stagingDir = join(root, 'staging')
const artifactDir = join(root, 'artifacts')
const registryPath = join(root, 'releases.json')
const ledgerPath = join(root, 'licenses.json')
await mkdir(stagingDir, { mode: 0o700 })
await mkdir(artifactDir, { mode: 0o700 })
const archive = await readFile(new URL('./fixtures/qianshou.csv-profile-1.0.0.qspkg', import.meta.url))
const seed = verifySeedPluginPackage(archive)
const publisher = generateKeyPairSync('ed25519')
const operator = generateKeyPairSync('ed25519')
const publicKey = pair => pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
const publisherId = 'qianshou-official'
const operatorId = 'reviewer-seven'
const publisherKeys = { [publisherId]: publicKey(publisher) }
const operatorKeys = { [operatorId]: publicKey(operator) }
const releaseOptions = { registryPath, artifactDir, publisherKeys, operatorKeys }
let principal = { accountId, role: 'personal', isAdmin: false }
const authenticate = async () => principal
const submission = createPluginSubmissionRoute({ stagingDir, releaseOptions, authenticate,
  publisherAccounts: { [publisherId]: accountId }, operatorAccounts: { [operatorId]: 'test-reviewer' } })
const post = (handler, body) => handler(new Request('http://127.0.0.1/test', { method: 'POST', body: JSON.stringify(body) }))
const title = 'CSV 数据体检'
const summary = '离线统计 CSV 的列和样例，不读写工作区。'
const submitted = await (await post(submission, {
  action: 'submit', publisherId, title, summary, archiveBase64: archive.toString('base64'),
})).json()
if (!submitted.ok) throw new Error(`TEST_SUBMIT_FAILED:${JSON.stringify(submitted)}`)
const unsigned = { pluginId: seed.manifest.pluginId, version: seed.manifest.version,
  releaseId: seed.manifest.releaseId, title, summary, packageSha256: seed.packageSha256,
  packageBytes: seed.packageBytes, platforms: ['darwin', 'win32'], architectures: ['arm64', 'x64'],
  operations: [{ capabilityId: seed.manifest.capabilityId, operationId: seed.manifest.operationId,
    executorKind: 'node', inputSchemaSha256: seed.inputSchemaSha256,
    outputSchemaSha256: seed.outputSchemaSha256, permissions: [] }] }
const release = { ...unsigned, publisher: { id: publisherId,
  signature: sign(null, Buffer.from(pluginReleasePayload(unsigned)), publisher.privateKey).toString('base64') },
  approval: { reviewId: 'review-csv-1', reviewedAt: Date.now(), operatorId }, installable: false }
release.approval.signature = sign(null, Buffer.from(pluginApprovalPayload(release)), operator.privateKey).toString('base64')
principal = { accountId: 'test-reviewer', role: 'admin', isAdmin: true }
const reviewed = await (await post(submission, {
  action: 'approve', submissionId: submitted.submission.submissionId, release,
})).json()
if (!reviewed.ok) throw new Error(`TEST_REVIEW_FAILED:${JSON.stringify(reviewed)}`)
principal = { accountId, role: 'personal', isAdmin: false }
const testBearer = randomBytes(32).toString('base64url')
const numericAccountId = Number(accountId)
const bearerAccountId = Number.isSafeInteger(numericAccountId) && numericAccountId > 0 ? numericAccountId : 167
const verifyBearer = createPluginLicenseBearerVerifier({ accountApiOrigin: 'http://127.0.0.1',
  // Test-only Shanghai /auth/me substitute. Do not use this verifier in a deployed server.
  fetcher: async (_url, init) => init.headers.authorization === `Bearer ${testBearer}`
    ? Response.json({ ok: true, account: { id: bearerAccountId, role: 'personal' } })
    : Response.json({ ok: false }, { status: 401 }) })
const license = createPluginFreeLicenseService({ ledgerPath, releaseOptions,
  authenticate: request => new URL(request.url).pathname === PLUGIN_LICENSE_BEARER_PATH
    ? verifyBearer(request) : authenticate(),
  freeReleaseIds: [seed.manifest.releaseId] })
const releases = createPluginReleasesRoute({ ...releaseOptions, authorizeLicensedArtifact: license.authorizeArtifact })
const macLicenseRoute = createPluginLicenseBearerRoute({ handle: license.handler })
const server = createServer((request, response) => {
  if (request.url?.startsWith(PLUGIN_RELEASES_PATH)) {
    void releases.handler(request, response)
    return
  }
  if (request.url === PLUGIN_LICENSE_PATH && request.method === 'POST') {
    const chunks = []
    let length = 0
    request.on('data', chunk => {
      length += chunk.length
      if (length > 4096) request.destroy()
      else chunks.push(chunk)
    })
    request.on('end', () => {
      void (async () => {
        const body = Buffer.concat(chunks)
        const result = await license.handler(new Request('http://127.0.0.1' + PLUGIN_LICENSE_PATH,
          { method: 'POST', body }))
        response.writeHead(result.status, Object.fromEntries(result.headers))
        response.end(await result.text())
      })().catch(() => { response.writeHead(503); response.end() })
    })
    return
  }
  if (request.url === PLUGIN_LICENSE_BEARER_PATH) {
    void macLicenseRoute.handler(request, response)
    return
  }
  response.writeHead(404)
  response.end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (address === null || typeof address === 'string') throw new Error('TEST_LISTEN_FAILED')
process.stdout.write(`${JSON.stringify({ origin: `http://127.0.0.1:${address.port}`,
  accountId, testBearer, testBearerAccountId: String(bearerAccountId),
  bearerLicensePath: PLUGIN_LICENSE_BEARER_PATH,
  releaseId: seed.manifest.releaseId, packageSha256: seed.packageSha256,
  publisherKeys, operatorKeys, testOnly: true })}\n`)
const cleanup = () => { server.close(() => { void rm(root, { recursive: true, force: true }) }) }
process.on('SIGINT', cleanup)
process.on('SIGTERM', cleanup)
