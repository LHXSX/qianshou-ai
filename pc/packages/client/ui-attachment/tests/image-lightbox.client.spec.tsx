// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { ImageLightbox } from '../src/ImageLightbox.tsx'

afterEach(cleanup)

const labels = { dialog: '原图预览', close: '关闭原图预览' }

describe('ImageLightbox', () => {
  it('focuses its close control, closes by button and Escape, and restores focus', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const onClose = vi.fn()
    const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={onClose} />)
    const close = view.getByRole('button', { name: '关闭原图预览' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(window, { key: 'a' })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(close)
    expect(onClose).toHaveBeenCalledTimes(2)
    view.unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('tolerates a focus owner it cannot restore (no active element at mount)', () => {
    // jsdom always reports body as the fallback active element; stub the
    // element-less state a detached focus can leave.
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => null })
    try {
      const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={vi.fn()} />)
      view.unmount()
    } finally {
      delete (document as { activeElement?: unknown }).activeElement
    }
  })

  it('closes on a mask press but not on a press over the image', () => {
    const onClose = vi.fn()
    const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={onClose} />)
    fireEvent.mouseDown(view.getByRole('img'))
    expect(onClose).not.toHaveBeenCalled()
    const mask = document.querySelector('[aria-hidden="true"]') as HTMLElement
    fireEvent.mouseDown(mask)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('opens copy and download from a right-click on the enlarged image', () => {
    const onCopy = vi.fn()
    const onSave = vi.fn()
    const onClose = vi.fn()
    const view = render(<ImageLightbox
      src="blob:original"
      alt="原图"
      labels={labels}
      actions={{ copy: '复制图片', save: '保存图片', download: '下载图片', note: null, onCopy, onSave }}
      onClose={onClose}
    />)
    fireEvent.contextMenu(view.getByRole('img'), { clientX: 40, clientY: 50 })
    const menu = view.getByRole('menu')
    expect(menu.getAttribute('style')).toContain('left: 40px')
    fireEvent.click(view.getByRole('menuitem', { name: '复制图片' }))
    expect(onCopy).toHaveBeenCalledTimes(1)
    expect(view.queryByRole('menu')).toBeNull()
    fireEvent.contextMenu(view.getByRole('img'), { clientX: 40, clientY: 50 })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(view.queryByRole('menu')).toBeNull()
    fireEvent.contextMenu(view.getByRole('img'), { clientX: 40, clientY: 50 })
    fireEvent.click(view.getByRole('menuitem', { name: '下载图片' }))
    expect(onSave).toHaveBeenCalledTimes(1)
  })
})
