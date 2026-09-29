import { expect, it } from 'vitest'
import { resolveDesktopPolicyEnvironment } from '../scripts/desktop-policy-environment.mjs'
import { validateDesktopPackageEnvironment } from '../scripts/desktop-package-environment.mjs'
import { resolveDesktopPolicyConfig } from '../src/mandatory-update-policy.ts'

const origins = { DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://harness-test.deepseek.com',
  DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: 'https://harness.deepseek.com' }

it('keeps Qianshou policy and fallback pages off DeepSeek services', () => {
  expect(() => resolveDesktopPolicyEnvironment({ ...origins, DSH_CLIENT_BUILD_PROFILE: 'qianshou' }))
    .toThrow(/Qianshou-controlled origin/u)
  const qianshou = { DSH_CLIENT_BUILD_PROFILE: 'qianshou',
    DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.qianshou.example' }
  expect(resolveDesktopPolicyEnvironment(qianshou)).toEqual({
    origin: 'https://policy.qianshou.example',
    allowedPageOrigins: ['https://policy.qianshou.example'], authentication: 'anonymous',
  })
  expect(() => resolveDesktopPolicyEnvironment({ ...qianshou,
    DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedPageOrigins: ['https://download.deepseek.com'] }),
  })).toThrow(/Qianshou update pages/u)
})

it.each(['test', 'production'] as const)('selects the %s policy and authentication together', (deployment) => {
  const policy = resolveDesktopPolicyEnvironment({ ...origins, DSH_DESKTOP_AUTO_UPDATE_ENV: deployment })
  const origin = deployment === 'test' ? origins.DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN : origins.DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN
  expect(policy).toEqual({ origin, allowedPageOrigins: [origin], authentication: deployment === 'test' ? 'feishu-test' : 'anonymous' })
  expect(resolveDesktopPolicyConfig(policy)).toMatchObject(policy)
})

it('requires only the selected origin, defaults to test, and accepts explicit page restrictions', () => {
  const policy = resolveDesktopPolicyEnvironment({
    DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: origins.DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN,
    DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedPageOrigins: ['https://download.deepseek.com'], intervalMs: 5000 }) })
  expect(policy).toMatchObject({ authentication: 'feishu-test', intervalMs: 5000, allowedPageOrigins: ['https://download.deepseek.com'] })
  expect(() => resolveDesktopPolicyEnvironment({ ...origins, DSH_DESKTOP_AUTO_UPDATE_ENV: 'prod' })).toThrow('production')
})

it.each([undefined, '', 'http://harness-test.deepseek.com', 'https://user:secret@harness-test.deepseek.com',
  'https://harness-test.deepseek.com/api', 'https://harness-test.deepseek.com/?secret=value'])('rejects invalid selected origin %s', (origin) => {
  expect(() => resolveDesktopPolicyEnvironment({ DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: origin })).toThrow('HTTPS origin')
  expect(() => resolveDesktopPolicyEnvironment({ DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: origin })).not.toThrow('secret=value')
})

it.each(['{', 'null', '[]', '{"origin":"https://old.example.com"}', '{"authentication":"anonymous"}',
  '{"allowedPageOrigins":[]}', '{"allowedPageOrigins":["http://example.com"]}'])('rejects invalid or conflicting shared options %s', (options) => {
  expect(() => resolveDesktopPolicyEnvironment({ ...origins, DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: options })).toThrow()
})

it.each([{ prepareOnly: true }, {}])('fails before signing/preparation when policy is absent in %j', (options) => {
  for (const platform of ['win32', 'darwin'] as const) {
    expect(() => { validateDesktopPackageEnvironment({ DSH_DESKTOP_APP_ID: 'com.example.test' }, { platform, arch: 'x64' }, options) })
      .toThrow('DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN')
  }
})

it('allows unsigned diagnostics only with the isolated Qianshou identity and profile', () => {
  for (const platform of ['win32', 'darwin'] as const) {
    const target = { platform, arch: 'x64' }
    expect(() => validateDesktopPackageEnvironment({
      DSH_CLIENT_BUILD_PROFILE: 'qianshou',
      DSH_DESKTOP_APP_ID: 'com.qianshou.desktop.internal',
      DSH_DESKTOP_UNSIGNED: '1',
    }, target, { unsigned: true })).not.toThrow()
    expect(() => validateDesktopPackageEnvironment({
      DSH_DESKTOP_APP_ID: 'com.example.test',
      DSH_DESKTOP_UNSIGNED: '1',
    }, target, { unsigned: true })).toThrow('internal Qianshou identity')
  }
})
