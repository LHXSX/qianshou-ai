// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MarketTaskProgress } from '../src/client/MarketTaskProgress.tsx'
import { zh, en } from '../src/client/market-task-progress-locales.ts'
import type { MarketTaskWorkload } from '../src/client/market-task-transport.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })

function workload(overrides: Partial<MarketTaskWorkload> = {}): MarketTaskWorkload {
  return { id: 'workload_123', status: 'RUNNING', resultAvailable: false, executionStage: 'executing', ...overrides }
}

it.each([null, undefined, 0])('keeps a generating provider visible without inventing a percentage for %s', (progress) => {
  render(<MarketTaskProgress workload={workload(progress === undefined ? {} : { progress })}
    disconnected={false} labels={zh} />)
  expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false)
  expect(screen.getByText('正在执行')).toBeTruthy()
  expect(screen.queryByText(/\d+%/)).toBeNull()
})

it('displays the server percentage, including 100 while independent checking is still pending', () => {
  const { rerender } = render(<MarketTaskProgress workload={workload({ progress: 0.375 })}
    disconnected={false} labels={en} />)
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('37.5')
  expect(screen.getByText('38%')).toBeTruthy()
  rerender(<MarketTaskProgress workload={workload({ progress: 1, executionStage: 'checking' })}
    disconnected={false} labels={en} />)
  expect(screen.getByText('100%')).toBeTruthy()
  expect(screen.getByText('Checking the result')).toBeTruthy()
})

it.each(['DONE', 'FAILED', 'CANCELLED', 'CANCELED', 'QUARANTINED'])('stops active execution feedback for %s', (status) => {
  render(<MarketTaskProgress workload={workload({ status, progress: 0.5 })} disconnected={false} labels={zh} />)
  expect(screen.queryByRole('progressbar')).toBeNull()
})

it('counts from the server creation time and disposes its clock on terminal state and unmount', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-26T14:10:00Z'))
  const { rerender, unmount } = render(<MarketTaskProgress workload={workload({ createdAt: '2026-09-26T14:09:50Z' })}
    disconnected={false} labels={zh} />)
  expect(screen.getByText('已等待 0:10')).toBeTruthy()
  act(() => { vi.advanceTimersByTime(2000) })
  expect(screen.getByText('已等待 0:12')).toBeTruthy()
  rerender(<MarketTaskProgress workload={workload({ status: 'DONE', createdAt: '2026-09-26T14:09:50Z' })}
    disconnected={false} labels={zh} />)
  expect(vi.getTimerCount()).toBe(0)
  unmount(); expect(vi.getTimerCount()).toBe(0)
})

it('does not invent a start time for an old receipt or a percentage for an unknown state', () => {
  render(<MarketTaskProgress workload={workload({ status: 'UNKNOWN', progress: null })} disconnected={true} labels={en} />)
  expect(screen.queryByText(/^Elapsed/)).toBeNull()
  expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toBe(en.taskProgressDisconnected)
  expect(screen.getByText(en.taskProgressUnconfirmed)).toBeTruthy()
})

it.each([NaN, Infinity, -0.1, 1.1])('never draws an invalid observed percentage %s', (progress) => {
  render(<MarketTaskProgress workload={workload({ progress })} disconnected={false} labels={zh} />)
  expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false)
  expect(screen.queryByText(/%/)).toBeNull()
})

it.each(['UNKNOWN', 'UNRECOGNIZED', 'CREATED'])('keeps %s indeterminate even when a stale receipt says 100 percent', (status) => {
  render(<MarketTaskProgress workload={workload({ status, progress: 1 })} disconnected={false} labels={zh} />)
  expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false)
  expect(screen.queryByText('100%')).toBeNull()
})

it('explains video waiting without inventing a queue position, ETA or stale execution percent', () => {
  render(<MarketTaskProgress videoTask workload={workload({ status: 'WAITING_FOR_WORKERS', progress: 0.4 })}
    disconnected={false} labels={zh} />)
  expect(screen.getByText(zh.taskVideoWaiting)).toBeTruthy()
  expect(screen.getByText(zh.taskVideoQueueUnknown)).toBeTruthy()
  expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false)
  expect(screen.queryByText(/第\s*\d+\s*位|\d+\s*分钟后/)).toBeNull()
})

it('shows only a witnessed video execution percentage and keeps result checking separate', () => {
  const { rerender } = render(<MarketTaskProgress videoTask
    workload={workload({ status: 'RUNNING', executionStage: 'executing', progress: 0 })}
    disconnected={false} labels={zh} />)
  expect(screen.getByText(zh.taskVideoExecuting)).toBeTruthy()
  expect(screen.getByText(zh.taskVideoNoPercent)).toBeTruthy()
  expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false)
  rerender(<MarketTaskProgress videoTask
    workload={workload({ status: 'RUNNING', executionStage: 'executing', progress: 0.4 })}
    disconnected={false} labels={zh} />)
  expect(screen.getByText('40%')).toBeTruthy()
  expect(screen.getByText(zh.taskVideoPercentHint)).toBeTruthy()
  rerender(<MarketTaskProgress videoTask
    workload={workload({ status: 'RUNNING', executionStage: 'checking', progress: 1 })}
    disconnected={false} labels={zh} />)
  expect(screen.getByText(zh.taskVideoChecking)).toBeTruthy()
  expect(screen.getByText(zh.taskVideoCheckingHint)).toBeTruthy()
  expect(screen.queryByText(zh.taskVideoExecuting)).toBeNull()
})

it('stops showing a stale percentage when video status updates disconnect', () => {
  render(<MarketTaskProgress videoTask workload={workload({ progress: 0.8 })} disconnected labels={zh} />)
  expect(screen.getByText(zh.taskProgressDisconnected)).toBeTruthy()
  expect(screen.queryByText('80%')).toBeNull()
  expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false)
})
