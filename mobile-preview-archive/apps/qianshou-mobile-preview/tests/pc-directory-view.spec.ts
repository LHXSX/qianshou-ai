// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { decoratePcDirectory } from '../src/pc-directory-view.ts'

it('puts live PCs first, disables offline PCs and retains the authorized click action', () => {
  const root = document.createElement('div')
  const click = vi.fn()
  for (const id of ['off', 'on']) {
    const button = document.createElement('button')
    button.dataset.testid = `mobile-pc-${id}`
    button.addEventListener('click', click)
    root.append(button)
  }
  const pcs = [
    { pcId: 'off', accountId: '1', label: 'A', online: false, platform: 'macos' as const },
    { pcId: 'on', accountId: '1', label: 'B', online: true, platform: 'windows' as const },
  ]
  decoratePcDirectory(root, pcs, true)
  expect((root.firstElementChild as HTMLElement).dataset.testid).toBe('mobile-pc-on')
  expect(root.querySelector('.is-online')?.textContent).toBe('在线')
  root.querySelector<HTMLButtonElement>('[data-testid="mobile-pc-on"]')!.click()
  root.querySelector<HTMLButtonElement>('[data-testid="mobile-pc-off"]')!.click()
  expect(click).toHaveBeenCalledTimes(1)
  decoratePcDirectory(root, pcs, false)
  expect(root.querySelector('.is-online')).toBeNull()
  expect(root.textContent).toContain('状态待确认')
  root.querySelector<HTMLButtonElement>('[data-testid="mobile-pc-on"]')!.click()
  expect(click).toHaveBeenCalledTimes(1)
})
