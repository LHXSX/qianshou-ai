import assert from 'node:assert/strict'
import { test } from 'node:test'
import { qianshouPackageInvocation } from './package.mjs'

test('selects the existing native packagers under one Qianshou product profile', () => {
  assert.deepEqual(qianshouPackageInvocation('mac-arm64'), { script: 'package:mac:arm64', options: [] })
  assert.deepEqual(qianshouPackageInvocation('win-x64', ['--unsigned', '--check']), {
    script: 'package:win:x64:unsigned', options: ['--check'],
  })
  assert.deepEqual(qianshouPackageInvocation('mac-arm64', ['--unsigned']), {
    script: 'package:mac:arm64:unsigned', options: [],
  })
  assert.throws(() => qianshouPackageInvocation('mac-x64', ['--unsigned']), /arm64 only/u)
  assert.throws(() => qianshouPackageInvocation('linux-x64'), /Unsupported/u)
})
