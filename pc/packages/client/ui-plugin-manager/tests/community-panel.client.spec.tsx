// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommunityDiscoveryPanel } from '../src/client/CommunityDiscoveryPanel.tsx'
import type { CommunityView } from '../src/client/community-controller.ts'
import { zh, type CommunityKey } from '../src/client/community-locales.ts'

afterEach(cleanup)

const t = (key: CommunityKey): string => zh[key]
const entry = {
  name: '@example/writer', version: '1.2.3', description: '文档写作',
  publisher: 'example', license: 'MIT', packageUrl: 'https://www.npmjs.com/package/%40example%2Fwriter/v/1.2.3',
  installSpec: '@example/writer@1.2.3',
}

function view(overrides: Partial<CommunityView> = {}): CommunityView {
  return {
    status: 'idle', query: '', source: '', entries: [], nextOffset: null,
    excluded: 0, unavailable: 0, checkedAt: null, loadingMore: false, pageError: false,
    ...overrides,
  }
}

function actions() {
  return { search: vi.fn(), loadMore: vi.fn(), reviewPackage: vi.fn() }
}

describe('community discovery panel', () => {
  it('does not search on render or when query text changes; the button submits the current text', () => {
    const props = actions()
    const { rerender } = render(<CommunityDiscoveryPanel view={view()} query="" t={t} {...props} />)
    expect(props.search).not.toHaveBeenCalled()
    rerender(<CommunityDiscoveryPanel view={view()} query="  writer  " t={t} {...props} />)
    expect(props.search).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh.search }))
    expect(props.search).toHaveBeenCalledExactlyOnceWith('  writer  ')
    expect(props.loadMore).not.toHaveBeenCalled()
    expect(props.reviewPackage).not.toHaveBeenCalled()
  })

  it('shows the public source and unreviewed notice, then reviews only the exact package spec', () => {
    const props = actions()
    render(<CommunityDiscoveryPanel view={view({
      status: 'ready', query: 'writer', source: 'https://registry.npmjs.org/',
      entries: [entry], checkedAt: 1_700_000_000_000,
    })} query="writer" t={t} {...props} />)

    expect(screen.getByText('来源：https://registry.npmjs.org/')).toBeTruthy()
    expect(screen.getByText(zh.description)).toBeTruthy()
    expect(screen.getByText(zh.inspectHint)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.inspect }))
    expect(props.reviewPackage).toHaveBeenCalledExactlyOnceWith('@example/writer@1.2.3')
    expect(props.search).not.toHaveBeenCalled()
    expect(props.loadMore).not.toHaveBeenCalled()
  })

  it('keeps the last queried results marked stale until a new search and blocks old-query pagination', () => {
    const props = actions()
    const { rerender } = render(<CommunityDiscoveryPanel view={view({
      status: 'ready', query: 'writer', source: 'https://registry.npmjs.org/',
      entries: [entry], nextOffset: 12, checkedAt: 1_700_000_000_000,
    })} query="reader" t={t} {...props} />)
    expect(screen.getByText(zh.changedQuery)).toBeTruthy()
    expect(screen.getByText('“writer”的搜索结果')).toBeTruthy()
    expect(props.loadMore).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: zh.loadMore })).toHaveProperty('disabled', true)

    rerender(<CommunityDiscoveryPanel view={view({
      status: 'ready', query: 'writer', source: 'https://registry.npmjs.org/',
      entries: [entry], nextOffset: 12, checkedAt: 1_700_000_000_000, loadingMore: true,
    })} query="writer" t={t} {...props} />)
    expect(screen.getByRole('button', { name: zh.searching })).toHaveProperty('disabled', true)
  })

  it('shows a next-page error without hiding the already verified results', () => {
    render(<CommunityDiscoveryPanel view={view({ status: 'ready', query: 'writer', source: 'https://registry.npmjs.org/',
      entries: [entry], nextOffset: 12, pageError: true })} query="writer" t={t} {...actions()} />)
    expect(screen.getByRole('alert').textContent).toBe(zh.moreError)
    expect(screen.getByText(entry.name)).toBeTruthy()
  })
})
