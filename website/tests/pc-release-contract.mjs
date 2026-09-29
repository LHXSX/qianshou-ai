import assert from 'node:assert/strict'
import { parsePcRelease } from '../src/services/pcReleaseContract.ts'

const version = '0.1.6-alpha.3'
const artifact = (platform, fileName) => ({
  platform,
  fileName,
  url: `/downloads/qianshou-pc/${version}/${fileName}`,
  sizeBytes: 123456789,
  sha256: 'a'.repeat(64),
  buildId: 'build-verified-on-target',
  signature: 'trusted',
  verified: true,
  installTested: true,
})
const valid = {
  schemaVersion: 1,
  product: 'qianshou-pc',
  version,
  channel: 'preview',
  releasedAt: '2026-09-23T10:00:00Z',
  artifacts: [
    artifact('windows-x64', `Qianshou-PC-${version}-windows-x64.exe`),
    artifact('macos-arm64', `Qianshou-PC-${version}-macos-arm64.dmg`),
  ],
}
assert.equal(parsePcRelease(valid).artifacts.length, 2)

for (const [name, mutate] of [
  ['historic product', feed => { feed.product = 'qianshou-eco-v3-preview' }],
  ['old package URL', feed => { feed.artifacts[0].url = '/eco-v3/downloads/old.exe' }],
  ['Windows using Mac DMG', feed => { feed.artifacts[0].fileName = 'Qianshou-PC.dmg'; feed.artifacts[0].url = `/downloads/qianshou-pc/${version}/Qianshou-PC.dmg` }],
  ['Mac using Windows EXE', feed => { feed.artifacts[1].fileName = 'Qianshou-PC.exe'; feed.artifacts[1].url = `/downloads/qianshou-pc/${version}/Qianshou-PC.exe` }],
  ['untested installer', feed => { feed.artifacts[0].installTested = false }],
  ['unchecked installer', feed => { feed.artifacts[0].verified = false }],
  ['duplicate platform', feed => { feed.artifacts[1].platform = 'windows-x64' }],
  ['missing checksum', feed => { feed.artifacts[0].sha256 = '' }],
  ['missing build identity', feed => { feed.artifacts[0].buildId = '' }],
  ['unsigned Windows installer', feed => { feed.artifacts[0].signature = 'unsigned' }],
  ['ad hoc Mac installer', feed => { feed.artifacts[1].signature = 'adhoc' }],
]) {
  const feed = structuredClone(valid)
  mutate(feed)
  assert.throws(() => parsePcRelease(feed), undefined, name)
}
console.log('PC release contract: valid two-system feed and 11 unsafe feeds verified')
