import assert from 'node:assert/strict'
import { parsePcBetaRelease } from '../src/services/pcBetaReleaseContract.ts'
import { parsePcRelease } from '../src/services/pcReleaseContract.ts'

const version = '0.1.6-alpha.2'
const artifact = (platform, buildId, fileName) => ({
  platform,
  fileName,
  url: `/downloads/qianshou-pc/beta/${buildId}/${fileName}`,
  sizeBytes: 123456789,
  sha256: 'a'.repeat(64),
  buildId,
})
const valid = {
  schemaVersion: 1,
  product: 'qianshou-pc',
  channel: 'internal-beta',
  version,
  releasedAt: '2026-09-24T14:00:00Z',
  appId: 'com.qianshou.desktop.internal',
  signed: false,
  notarized: false,
  installTested: false,
  updateFeed: false,
  artifacts: [
    artifact('macos-arm64', '36000341046', `qianshou-${version}-mac-arm64.dmg`),
    artifact('windows-x64', '36004022829', `qianshou-${version}-win-x64.exe`),
  ],
}
assert.equal(parsePcBetaRelease(valid).artifacts.length, 2)
assert.throws(() => parsePcRelease(valid), undefined, 'beta cannot enter the formal feed')

for (const [name, mutate] of [
  ['historic product', feed => { feed.product = 'qianshou-eco-v3-preview' }],
  ['formal channel', feed => { feed.channel = 'stable' }],
  ['wrong app identity', feed => { feed.appId = 'com.qianshou.desktop' }],
  ['claimed signature', feed => { feed.signed = true }],
  ['claimed notarization', feed => { feed.notarized = true }],
  ['claimed installation test', feed => { feed.installTested = true }],
  ['claimed update feed', feed => { feed.updateFeed = true }],
  ['wrong extension', feed => { feed.artifacts[0].fileName = 'qianshou-0.1.6-alpha.2-mac-arm64.exe' }],
  ['wrong product filename', feed => { feed.artifacts[0].fileName = 'old-0.1.6-alpha.2-mac-arm64.dmg' }],
  ['external URL', feed => { feed.artifacts[0].url = 'https://github.com/private-artifact' }],
  ['path traversal', feed => { feed.artifacts[0].buildId = '..' }],
  ['mismatched URL build', feed => { feed.artifacts[0].buildId = 'other-run' }],
  ['duplicate platform', feed => { feed.artifacts[1].platform = 'macos-arm64' }],
  ['missing installer checksum', feed => { feed.artifacts[0].sha256 = '' }],
  ['zip checksum in uppercase', feed => { feed.artifacts[0].sha256 = 'A'.repeat(64) }],
  ['zero installer size', feed => { feed.artifacts[0].sizeBytes = 0 }],
]) {
  const feed = structuredClone(valid)
  mutate(feed)
  assert.throws(() => parsePcBetaRelease(feed), undefined, name)
}
console.log('PC beta release contract: two-platform feed and 16 invalid feeds verified')
