// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { ForgeBrandMark, ForgeBrandName } from '../src/client/ForgeBrand.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

describe('Qianshou shared identity', () => {
  it.each([24, 34])('renders a crisp decorative vector at %d pixels', (size) => {
    const view = render(<ForgeBrandMark size={size} />)
    const mark = view.container.querySelector('svg')!
    expect(mark.getAttribute('width')).toBe(String(size))
    expect(mark.getAttribute('height')).toBe(String(size))
    expect(mark.getAttribute('viewBox')).toBe('0 0 32 32')
    expect(mark.getAttribute('aria-hidden')).toBe('true')
    expect(mark.getAttribute('focusable')).toBe('false')
    expect(mark.querySelectorAll('path')).toHaveLength(6)
    expect(mark.querySelectorAll('circle')).toHaveLength(1)
    expect(mark.querySelector('image')).toBeNull()
    view.rerender(<ForgeBrandMark size={size} className="hero-geometry" />)
    expect(mark.classList.contains('hero-geometry')).toBe(true)
  })

  it.each([zh, en])('renders the complete localized two-line identity', (dictionary) => {
    const view = render(<ForgeBrandName t={key => key === 'name' ? dictionary.name : dictionary.subtitle} />)
    expect(view.getByText(dictionary.name).tagName).toBe('STRONG')
    expect(view.getByText(dictionary.subtitle)).toBeTruthy()
    expect(view.container.querySelector('[data-qianshou-brand="name"]')?.textContent)
      .toBe(dictionary.name + dictionary.subtitle)
  })
})
