/** Operator-only market configuration must not silently enable uploads on an unconfigured PC. */
import { fileURLToPath } from 'node:url'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { interpolate } from '@deepseek-ai/cordis-plugin-loader'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllEnvs() })

function profileConfig(id: string): Record<string, unknown> {
  const rows = loadOverlayPatches('web-plugin-market-test',
    fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
    .flatMap(patch => patch.insert ?? [])
  const row = rows.find(item => item.id === id)
  if (row === undefined || row.config === undefined) throw new Error('profile row missing')
  return interpolate({}, row.config) as Record<string, unknown>
}
function marketConfig(): Record<string, unknown> { return profileConfig('qianshou-plugin-catalog') }

it('keeps the built-in catalog when no operator origin or verification keys are supplied', () => {
  vi.stubEnv('QIANSHOU_PLUGIN_MARKET_API_ORIGIN', '')
  vi.stubEnv('QIANSHOU_PLUGIN_PUBLISHER_ID', '')
  vi.stubEnv('QIANSHOU_PLUGIN_PUBLISHER_PUBLIC_KEY', '')
  vi.stubEnv('QIANSHOU_PLUGIN_REVIEWER_ID', '')
  vi.stubEnv('QIANSHOU_PLUGIN_REVIEWER_PUBLIC_KEY', '')
  expect(marketConfig()).toMatchObject({ connection: 'shipped', apiBaseUrl: '',
    publisherKeys: {}, operatorKeys: {} })
})

it('uses only the operator environment for the API origin and public verification keys', () => {
  vi.stubEnv('QIANSHOU_PLUGIN_MARKET_API_ORIGIN', 'https://qianshousuanli.com')
  vi.stubEnv('QIANSHOU_PLUGIN_PUBLISHER_ID', 'qianshou.lab')
  vi.stubEnv('QIANSHOU_PLUGIN_PUBLISHER_PUBLIC_KEY', 'publisher-public-spki')
  vi.stubEnv('QIANSHOU_PLUGIN_REVIEWER_ID', 'qianshou.review')
  vi.stubEnv('QIANSHOU_PLUGIN_REVIEWER_PUBLIC_KEY', 'reviewer-public-spki')
  expect(marketConfig()).toMatchObject({ connection: 'api',
    apiBaseUrl: 'https://qianshousuanli.com',
    publisherKeys: { 'qianshou.lab': 'publisher-public-spki' },
    operatorKeys: { 'qianshou.review': 'reviewer-public-spki' } })
})

it('keeps the verified compute API default until an operator configures the replacement origin', () => {
  vi.stubEnv('QIANSHOU_COMPUTE_API_ORIGIN', '')
  expect(profileConfig('qianshou-compute-core')['baseUrl']).toBe('https://qianshousuanli.com')
  vi.stubEnv('QIANSHOU_COMPUTE_API_ORIGIN', 'https://qsnode.com')
  expect(profileConfig('qianshou-compute-core')['baseUrl']).toBe('https://qsnode.com')
})

it('opts only the Qianshou PC profile into the free node consumer without granting execution permission', () => {
  vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'qianshou')
  expect(profileConfig('qianshou-compute-core')['researchImage']).toEqual({ gatewayOrigin: 'https://app.qianshousuanli.com' })
  expect(profileConfig('qianshou-node-contributor')['mediaResearchEnabled']).toBe(true)
  expect(profileConfig('qianshou-node-contributor')).not.toHaveProperty('mediaSharingConsents')
  vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'dsh')
  expect(profileConfig('qianshou-node-contributor')['mediaResearchEnabled']).toBe(false)
})

it.each(['image-trial', 'video-trial'])('keeps the default free image scheduler in the %s development overlay', (name) => {
  vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'qianshou')
  const original = profileConfig('qianshou-compute-core')
  const patches = loadOverlayPatches(name,
    fileURLToPath(new URL(`../../../../qianshou/${name}.patch.yml`, import.meta.url)))
  const [entry] = applyEntryPatches([{
    id: 'qianshou-compute-core', name: '@deepseek-ai/dsh-compute-core', config: original,
  }], patches, (message) => { throw new Error(message) })
  expect(entry?.config).toMatchObject({ researchImage: original.researchImage,
    imageTrial: { gatewayOrigin: 'http://127.0.0.1:18991' } })
})


it('ships verified production archive and attestor hosts and the independent package public key', () => {
  vi.stubEnv('QIANSHOU_COMPUTE_API_ORIGIN', '')
  vi.stubEnv('QIANSHOU_ORDER_ARCHIVE_HOSTNAME', '')
  vi.stubEnv('QIANSHOU_ORDER_ATTESTOR_HOSTNAME', '')
  expect(marketConfig()).toMatchObject({ coreOrigin: 'https://qianshousuanli.com',
    orderArchiveHostname: 'qs-task-evidence-prod-1463872884.cos.ap-shanghai.myqcloud.com',
    orderAttestorHostname: 'attestor.qianshousuanli.com',
    orderPackageIssuerKeys: { 'gz-package-v5-f893b2814989': 'l0i3wnK2OPVzgtr9wldUvvAbDlevXZ6swJ8e4S_fe1E' } })
})
