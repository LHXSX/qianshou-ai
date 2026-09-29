import assert from 'node:assert/strict'
import test from 'node:test'
import { qianshouUploadInvocation } from './qianshou-upload.mjs'

test('selects each existing uploader with an explicit Qianshou identity', () => {
  for (const [target, script] of [
    ['mac-arm64', 'upload:mac:arm64'],
    ['mac-x64', 'upload:mac:x64'],
    ['win-x64', 'upload:win:x64'],
  ]) {
    const invocation = qianshouUploadInvocation(target, [], {
      DSH_CLIENT_BUILD_PROFILE: 'official', DSH_BUILD_CLIENT_PROFILE: 'official',
    })
    assert.equal(invocation.script, script)
    assert.equal(invocation.env.DSH_CLIENT_BUILD_PROFILE, 'qianshou')
    assert.equal(invocation.env.DSH_BUILD_CLIENT_PROFILE, undefined)
  }
})

test('rejects unknown targets and extra arguments before invoking an uploader', () => {
  assert.throws(() => qianshouUploadInvocation('linux-x64'), /Unsupported/u)
  assert.throws(() => qianshouUploadInvocation('win-x64', ['--credential-launcher']), /extra options/u)
})
