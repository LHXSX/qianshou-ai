// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { OrderPublicationsPanel } from '../src/client/OrderPublicationsPanel.tsx'
import type { LocalSkillsPanelProps } from '../src/client/LocalSkillsPanel.tsx'
import { zh } from '../src/client/local-skill-locales.ts'
import { zh as marketZh } from '../src/client/marketplace-locales.ts'

const id = '416dfb88-ea17-4a36-98b5-e1c08edd3c55'
const key = 'skill:user-agents:generic-scan'
afterEach(cleanup)
function props(): LocalSkillsPanelProps {
  return { view: { status: 'ready', skills: [] }, t: key => zh[key], ensure: vi.fn(async () => {}),
    reload: vi.fn(async () => {}), submitSkillProduct: vi.fn(async () => false), publication: {
      busyKey: null, refreshing: false, sellerProducts: {}, sellerProductsUnavailable: false, sellerProductErrors: {},
      items: { [key]: { phase: 'approved', publicationId: id, archiveStatus: 'confirmed', priceYuan: '0.50', salePriceYuan: null } },
    } }
}
function panel(p: LocalSkillsPanelProps) {
  return <OrderPublicationsPanel localSkills={p} t={key => marketZh[key]} manage={vi.fn()} />
}

it.each(['0', '0.0', '0.00'])('submits only manually entered %s as free, without borrowing execution price', async (input) => {
  const p = props(); render(panel(p))
  const field = screen.getByRole('textbox', { name: zh.sellerProductPriceLabel })
  expect(field.getAttribute('value')).toBe('')
  const button = screen.getByRole('button', { name: zh.sellerProductSubmit })
  expect(button.hasAttribute('disabled')).toBe(true)
  expect(p.submitSkillProduct).not.toHaveBeenCalled()
  fireEvent.change(field, { target: { value: input } }); fireEvent.click(button)
  await waitFor(() => { expect(p.submitSkillProduct).toHaveBeenCalledExactlyOnceWith('user-agents', 'generic-scan', '0.00') })
  await waitFor(() => { expect(screen.getByText(zh.sellerProductSubmitFailed)).toBeTruthy() })
  expect(field.getAttribute('value')).toBe(input)
})

it('keeps price and progress on failure; rejects blank, over-precision and out-of-range prices', async () => {
  const p = props(); let resolve!: (result: boolean) => void
  p.submitSkillProduct = vi.fn(() => new Promise<boolean>((done) => { resolve = done }))
  render(panel(p)); const field = screen.getByRole('textbox', { name: zh.sellerProductPriceLabel })
  for (const value of ['', ' ', '1.001', '-1', '100000.01']) {
    fireEvent.change(field, { target: { value } })
    expect(screen.getByRole('button', { name: zh.sellerProductSubmit }).hasAttribute('disabled')).toBe(true)
  }
  fireEvent.change(field, { target: { value: '12.3' } })
  fireEvent.click(screen.getByRole('button', { name: zh.sellerProductSubmit }))
  expect(screen.getByRole('button', { name: zh.sellerProductSubmitting }).hasAttribute('disabled')).toBe(true)
  expect(field.hasAttribute('disabled')).toBe(true)
  resolve(false); await waitFor(() => { expect(screen.getByText(zh.sellerProductSubmitFailed)).toBeTruthy() })
  expect(field.getAttribute('value')).toBe('12.3')
  expect(p.submitSkillProduct).toHaveBeenCalledExactlyOnceWith('user-agents', 'generic-scan', '12.30')
})

it('uses an already explicit sale price without offering edits or a changed publication', async () => {
  const p = props(); p.publication = { ...p.publication!, items: { [key]: { ...p.publication!.items[key]!, salePriceYuan: '2.00' } } }
  render(panel(p)); expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.getByText(zh.sellerProductPriceLocked)).toBeTruthy()
  expect(p.submitSkillProduct).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh.sellerProductSubmit }))
  await waitFor(() => { expect(p.submitSkillProduct).toHaveBeenCalledExactlyOnceWith('user-agents', 'generic-scan', '2.00') })
})

it('fails closed for stale records, unavailable ledgers, loading sources and already recorded products', () => {
  const p = props(); const view = render(panel(p))
  const field = screen.getByRole('textbox', { name: zh.sellerProductPriceLabel })
  fireEvent.change(field, { target: { value: '0' } })
  for (const update of [
    { ...p, publication: { ...p.publication!, refreshing: true } },
    { ...p, publication: { ...p.publication!, sellerProductsUnavailable: true } },
    { ...p, publication: { ...p.publication!, items: { [key]: { ...p.publication!.items[key]!, reviewSyncStale: true } } } },
    { ...p, view: { ...p.view, status: 'loading' as const } },
  ]) {
    view.rerender(panel(update)); expect(screen.getByRole('button', { name: zh.sellerProductSubmit }).hasAttribute('disabled')).toBe(true)
  }
  for (const marker of [{ marketProductId: 'known-product' }, { marketProductStatus: 'rejected' as const }]) {
    view.rerender(panel({ ...p, publication: { ...p.publication!,
      items: { [key]: { ...p.publication!.items[key]!, ...marker } } } }))
    expect(screen.queryByRole('button', { name: zh.sellerProductSubmit })).toBeNull()
  }
  const { archiveStatus: _archive, ...unconfirmed } = p.publication!.items[key]!
  view.rerender(panel({ ...p, publication: { ...p.publication!, items: { [key]: unconfirmed } } }))
  expect(screen.queryByRole('button', { name: zh.sellerProductSubmit })).toBeNull()
  expect(screen.getByText(zh.sellerProductArchiveRequired)).toBeTruthy()
  expect(p.submitSkillProduct).not.toHaveBeenCalled()
})

it('retains the exact explicit input during refresh and only submits after a new owner click', async () => {
  const p = props(); const view = render(panel(p))
  const field = screen.getByRole('textbox', { name: zh.sellerProductPriceLabel })
  fireEvent.change(field, { target: { value: '2.40' } })
  view.rerender(panel({ ...p, publication: { ...p.publication!, refreshing: true } }))
  expect(field.getAttribute('value')).toBe('2.40')
  expect(field.hasAttribute('disabled')).toBe(true)
  expect(p.submitSkillProduct).not.toHaveBeenCalled()
  view.rerender(panel(p))
  expect(field.getAttribute('value')).toBe('2.40')
  expect(screen.getByRole('button', { name: zh.sellerProductSubmit }).hasAttribute('disabled')).toBe(false)
  expect(p.submitSkillProduct).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh.sellerProductSubmit }))
  await waitFor(() => { expect(p.submitSkillProduct).toHaveBeenCalledExactlyOnceWith('user-agents', 'generic-scan', '2.40') })
})
