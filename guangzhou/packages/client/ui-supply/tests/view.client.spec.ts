/**
 * Pure projections: every absence has its own copy key, so a `null` fact can
 * never be rendered as 0, false or idle.
 */
import { describe, expect, it } from 'vitest'
import {
  advertisingKey, durationBucket, errorKey, problemKey, serviceKindKey, stateHintKey, stateKey, verificationKey,
} from '../src/client/view.ts'

describe('supply view projections', () => {
  it('buckets an idle duration in the unit its magnitude deserves', () => {
    expect(durationBucket(0)).toEqual({ key: 'idleSeconds', count: 0 })
    expect(durationBucket(59)).toEqual({ key: 'idleSeconds', count: 59 })
    expect(durationBucket(60)).toEqual({ key: 'idleMinutes', count: 1 })
    expect(durationBucket(3599)).toEqual({ key: 'idleMinutes', count: 59 })
    expect(durationBucket(3600)).toEqual({ key: 'idleHours', count: 1 })
  })

  it('labels each admission state, including the unobserved one', () => {
    expect([stateKey('disabled'), stateKey('blocked'), stateKey('ready'), stateKey(null)])
      .toEqual(['stateDisabled', 'stateBlocked', 'stateReady', 'stateUnknown'])
    expect([stateHintKey('disabled'), stateHintKey('blocked'), stateHintKey('ready'), stateHintKey(null)])
      .toEqual(['hintDisabled', 'hintBlocked', 'hintReady', 'hintUnknown'])
  })

  it('labels each advertisement state, including the unobserved one', () => {
    expect([advertisingKey('not-connected'), advertisingKey('withdrawn'), advertisingKey('advertising'), advertisingKey(null)])
      .toEqual(['advertisingNotConnected', 'advertisingWithdrawn', 'advertisingAdvertising', 'advertisingUnknown'])
  })

  it('labels self-check verdicts and capability kinds verbatim', () => {
    expect([verificationKey('verified'), verificationKey('pending'), verificationKey('unavailable')])
      .toEqual(['verified', 'pending', 'unavailable'])
    expect([serviceKindKey('tool'), serviceKindKey('local-model')]).toEqual(['serviceKindTool', 'serviceKindModel'])
  })

  it('names each operation failure by its stable code', () => {
    expect(errorKey('INVALID_SUPPLY_RESPONSE')).toBe('errorInvalidResponse')
    expect(errorKey('SUPPLY_POLICY_INVALID')).toBe('errorPolicyInvalid')
    expect(errorKey('SUPPLY_STORAGE_UNAVAILABLE')).toBe('errorStorageUnavailable')
    expect(errorKey('AUTH_REQUIRED')).toBe('errorAuthRequired')
    expect(errorKey('UNAUTHORIZED')).toBe('errorAuthRequired')
    expect(errorKey('FORBIDDEN')).toBe('errorAuthRequired')
    expect(errorKey('HTTP_500')).toBe('errorRequestFailed')
  })

  it('names each rejected draft field', () => {
    expect(problemKey({ kind: 'mode' })).toEqual({ key: 'invalidMode' })
    expect(problemKey({ kind: 'maxConcurrency' })).toEqual({ key: 'invalidMaxConcurrency' })
    expect(problemKey({ kind: 'minFreeMemory' })).toEqual({ key: 'invalidMinFreeMemory' })
    expect(problemKey({ kind: 'minIdleSeconds' })).toEqual({ key: 'invalidMinIdleSeconds' })
    expect(problemKey({ kind: 'serviceIdLimit' })).toEqual({ key: 'invalidTooManyServices' })
    expect(problemKey({ kind: 'serviceId', id: 'tool x' })).toEqual({ key: 'invalidServiceId', id: 'tool x' })
  })
})
