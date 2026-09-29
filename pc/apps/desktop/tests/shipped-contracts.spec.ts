/**
 * A packaged application ships `contracts/v1` beside its runtime, so the Host
 * reads the fixed copy from the installation instead of a source checkout.
 */

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { withShippedContracts } from '../src/shipped-contracts.ts'

describe('shipped contract copy', () => {
  it('points the Host at the copy carried by a packaged application', () => {
    const environment = withShippedContracts({ PATH: '/usr/bin' }, join('/Applications', 'Resources'))
    expect(environment.QIANSHOU_CONTRACTS_DIR).toBe(join('/Applications', 'Resources', 'contracts', 'v1'))
    expect(environment.PATH).toBe('/usr/bin')
  })

  it('leaves a development run to resolve its own checkout copy', () => {
    const environment = { PATH: '/usr/bin' }
    expect(withShippedContracts(environment, undefined)).toBe(environment)
  })

  it('keeps an operator-selected directory, including an empty one', () => {
    expect(withShippedContracts({ QIANSHOU_CONTRACTS_DIR: '/opt/contracts/v1' }, '/Applications/Resources'))
      .toEqual({ QIANSHOU_CONTRACTS_DIR: '/opt/contracts/v1' })
    expect(withShippedContracts({ QIANSHOU_CONTRACTS_DIR: '' }, '/Applications/Resources'))
      .toEqual({ QIANSHOU_CONTRACTS_DIR: '' })
  })
})
