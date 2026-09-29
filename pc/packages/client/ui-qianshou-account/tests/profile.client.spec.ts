// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'

afterEach(() => { vi.unstubAllEnvs() })

it.each(['official', 'default'])('settles without a Qianshou Remote in the %s composition', async (profile) => {
  vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', profile)
  vi.resetModules()
  const feature = await import('../src/client/index.ts')
  const runtime = await SlotTestRuntime.create()
  runtime.ctx.provide('locale', new LocaleRuntime(runtime.ctx))
  try {
    // No account namespace is provided: the real injection scheduler must still activate this no-op plugin.
    const mounted = await runtime.mount({ inject: feature.inject, apply: feature.apply })
    expect(feature.inject).not.toContain('remote.qianshouAccount')
    await mounted.dispose()
  } finally { await runtime.dispose() }
})
