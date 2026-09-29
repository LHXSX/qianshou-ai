import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { MarketplaceNavigation } from '../src/client/marketplace-navigation.ts'
import type { MarketplacePublicationFocus } from '../src/client/marketplace-navigation-contract.ts'

it('retains the latest exact focus before mount and ignores obsolete acknowledgements', () => {
  const open = vi.fn()
  const navigation = new MarketplaceNavigation(open)
  const focus: { source: 'user-dsh'; name: string } = { source: 'user-dsh', name: 'paper-helper' }
  expect(navigation.openPublications(focus)).toBe(true)
  const first = navigation.store.getSnapshot().request!
  focus.name = 'changed'
  expect(first.focus?.name).toBe('paper-helper')
  expect(navigation.openPublications({ source: 'user-agents', name: 'other-helper' })).toBe(true)
  const latest = navigation.store.getSnapshot().request!
  expect(navigation.consume(first.id)).toBe(false)
  expect(navigation.store.getSnapshot().request).toBe(latest)
  expect(navigation.consume(latest.id)).toBe(true)
  expect(navigation.consume(latest.id)).toBe(false)
  expect(navigation.store.getSnapshot().request).toBeNull()
  expect(open).toHaveBeenCalledTimes(2)
})

it('rejects invalid focus and failed or disposed navigation without retaining a request', () => {
  const open = vi.fn(() => { throw new Error('panel unavailable') })
  const navigation = new MarketplaceNavigation(open)
  for (const focus of [{ source: 'profile-entry', name: 'paper-helper' }, { source: 'user-dsh', name: '../outside' },
    { source: 'user-dsh', name: 'paper-helper', taskType: 'untrusted' }, null]) {
    expect(navigation.openPublications(focus as unknown as MarketplacePublicationFocus)).toBe(false)
  }
  expect(open).not.toHaveBeenCalled()
  expect(navigation.openPublications()).toBe(false)
  expect(navigation.store.getSnapshot().request).toBeNull()
  navigation.dispose()
  expect(navigation.openPublications()).toBe(false)
  expect(open).toHaveBeenCalledOnce()
})

it('contains synchronous disposal and nested opening without overwriting the newer request', () => {
  let first = true
  const navigation = new MarketplaceNavigation(() => {
    if (first) { first = false; navigation.openPublications({ source: 'user-agents', name: 'new-helper' }) }
  })
  navigation.openPublications({ source: 'user-dsh', name: 'old-helper' })
  expect(navigation.store.getSnapshot().request?.focus?.name).toBe('new-helper')
  navigation.dispose()
  const disposedOnNotify = new MarketplaceNavigation(vi.fn())
  disposedOnNotify.store.subscribe(() => { disposedOnNotify.dispose() })
  expect(disposedOnNotify.openPublications()).toBe(false)
  expect(disposedOnNotify.store.getSnapshot().request).toBeNull()
})

it('withdraws the scoped service and invalidates retained callbacks when its owning fiber unloads', async () => {
  const ctx = new Context()
  const open = vi.fn()
  let navigation: MarketplaceNavigation | undefined
  await ctx.plugin((scope: Context) => {
    navigation = new MarketplaceNavigation(open)
    scope.provide('qianshouMarketplaceNavigation', navigation)
    scope.effect(() => () => { navigation!.dispose() })
  })
  const service = ctx.get('qianshouMarketplaceNavigation')!
  expect(service.openPublications({ source: 'user-dsh', name: 'paper-helper' })).toBe(true)
  await ctx.fiber.dispose()
  expect(ctx.get('qianshouMarketplaceNavigation', false)).toBeUndefined()
  expect(service.openPublications()).toBe(false)
  expect(navigation!.store.getSnapshot().request).toBeNull()
  expect(open).toHaveBeenCalledOnce()
})


it('does not apply a consumed request when its owner is disposed synchronously by the acknowledgement', () => {
  const navigation = new MarketplaceNavigation(vi.fn())
  navigation.openPublications()
  const request = navigation.store.getSnapshot().request!
  navigation.store.subscribe(() => { navigation.dispose() })
  expect(navigation.consume(request.id)).toBe(false)
  expect(navigation.openPublications()).toBe(false)
})

it('retains the exact saved local skill actions without creating publication state', () => {
  const open = vi.fn()
  const navigation = new MarketplaceNavigation(open)
  expect(navigation.openMySkill({ source: 'user-dsh', name: 'qs-test-demo' })).toBe(true)
  expect(navigation.store.getSnapshot().request).toMatchObject({ destination: 'mine', focus: { source: 'user-dsh', name: 'qs-test-demo' } })
  expect(open).toHaveBeenCalledOnce()
})
