/**
 * The Host half of this plugin is inert on purpose: the authenticated supply
 * routes and the local probe live in the compute core, and this package
 * contributes a browser workspace only.
 */
import { describe, expect, it } from 'vitest'
import * as host from '../src/index.ts'

describe('supply host entry', () => {
  it('registers nothing on the Host and exposes only its inert apply', () => {
    expect(Object.keys(host)).toEqual(['apply'])
    expect(host.apply.length).toBe(0)
    expect(host.apply()).toBeUndefined()
  })
})
