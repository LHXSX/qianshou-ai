// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { OrderSourcesPanel, type OrderSourcesPanelProps } from '../src/client/node-status/OrderSourcesPanel.tsx'
import { zh } from '../src/client/node-status/locales.ts'
import { publicationFocus } from '../src/client/node-status/publication-focus.ts'

afterEach(cleanup)
function props(): OrderSourcesPanelProps {
  return { t: key => zh[key], phase: 'ready', granted: false, ownerOn: false, busy: false, busyMessage: null,
    selectionSupported: true, error: null, onRefresh: vi.fn(), onToggle: vi.fn(), onSelect: vi.fn(),
    onActivateAuthor: vi.fn(), onManagePublication: vi.fn(() => true),
    data: { complete: true, sources: [{ id: 'skill:user-dsh:paper-helper', kind: 'skill', source: 'user-dsh',
      title: '文档助手', description: '整理文档', category: 'text', loadState: 'unknown', capabilityId: null,
      taskType: 'paper_check_v1', serviceId: null, selectable: false, eligible: false, enabled: false,
      reason: 'publication-approved', authorPublication: { publicationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        status: 'approved', archiveConfirmed: true, listingStatus: 'not-listed', salePriceYuan: null } }] } }
}

it('shows approved intake off and a separate missing listing step without submitting, pricing or enabling on render', () => {
  const p = props()
  render(<OrderSourcesPanel {...p} />)
  expect(screen.getByText(zh.orderAuthorIntakeOff)).toBeTruthy()
  expect(screen.getByText(zh.orderAuthorListingMissingPrice)).toBeTruthy()
  expect(screen.queryByText(zh.orderSourcePublicationPendingShort)).toBeNull()
  expect(screen.getByRole('button', { name: zh.orderAuthorEnable }).hasAttribute('disabled')).toBe(true)
  expect(p.onActivateAuthor).not.toHaveBeenCalled()
  expect(p.onManagePublication).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh.orderAuthorManagePublication }))
  expect(p.onManagePublication).toHaveBeenCalledExactlyOnceWith('skill:user-dsh:paper-helper')
  expect(p.onToggle).not.toHaveBeenCalled()
})

it('reports orders enabled only with fresh eligibility, coherent grant and the master switch', () => {
  const p = props()
  const item = p.data!.sources[0]!
  const data = { complete: true, sources: [{ ...item, serviceId: 'node' as const, loadState: 'active' as const,
    eligible: true, enabled: true, reason: 'ready' as const,
    authorProductId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    authorPublication: { ...item.authorPublication!, listingStatus: 'published' as const, salePriceYuan: '0.00' } }] }
  const view = render(<OrderSourcesPanel {...p} data={data} granted={true} ownerOn={true} />)
  expect(screen.getByText(zh.orderAuthorIntakeOn)).toBeTruthy()
  view.rerender(<OrderSourcesPanel {...p} data={data} granted={true} ownerOn={false} />)
  expect(screen.queryByText(zh.orderAuthorIntakeOn)).toBeNull()
  expect(screen.getByText(zh.orderAuthorIntakeOff)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: zh.orderAuthorEnable }))
  expect(p.onActivateAuthor).toHaveBeenCalledExactlyOnceWith('skill:user-dsh:paper-helper')
  expect(p.onToggle).not.toHaveBeenCalled()
  view.rerender(<OrderSourcesPanel {...p} data={data} granted={true} ownerOn={true} phase="unavailable" />)
  expect(screen.queryByText(zh.orderAuthorIntakeOn)).toBeNull()
  expect(screen.getByText(zh.orderAuthorIntakeUnknown)).toBeTruthy()
  expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: zh.orderAuthorManagePublication }).hasAttribute('disabled')).toBe(true)
})

it('keeps activation manual and exposes a failed management handoff without inferring success', () => {
  const p = props()
  const data = { ...p.data!, sources: [{ ...p.data!.sources[0]!, authorProductId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }] }
  render(<OrderSourcesPanel {...p} data={data} onManagePublication={vi.fn(() => false)} />)
  fireEvent.click(screen.getByRole('button', { name: zh.orderAuthorEnable }))
  expect(p.onActivateAuthor).toHaveBeenCalledExactlyOnceWith('skill:user-dsh:paper-helper')
  fireEvent.click(screen.getByRole('button', { name: zh.orderAuthorManagePublication }))
  expect(screen.getByText(zh.orderAuthorManageUnavailable)).toBeTruthy()
})

it('parses only canonical local skill focus identities', () => {
  expect(publicationFocus('skill:user-agents:paper-helper')).toEqual({ source: 'user-agents', name: 'paper-helper' })
  for (const value of ['bundle:paper-helper', 'skill:user-dsh:../other', 'skill:user-dsh:%70aper-helper',
    'skill:profile-entry:paper-helper', 'skill:user-dsh:UPPER']) expect(publicationFocus(value)).toBeNull()
})
