import { describe, expect, it, vi } from 'vitest'
import { NodeStatusController } from '../src/client/node-status/controller.ts'
import { parseNodeStatus, type NodeCommandOutcome, type NodePowerState, type NodeStatusReadout } from '../src/client/node-status/types.ts'
import { createStubTransport, onlineSnapshot } from './fixtures/node-status.fixture.ts'

function readout(ownerId: number): NodeStatusReadout {
  const parsed = parseNodeStatus(onlineSnapshot())
  if (parsed === null) throw new Error('Invalid node fixture')
  return { kind: 'snapshot', snapshot: { ...parsed, connection: { ...parsed.connection, ownerId } } }
}

const off: NodePowerState = { running: false, managed: false, mode: null }
const on: NodePowerState = { running: true, managed: true, mode: 'running' }

describe('node identity invalidation', () => {
  it('clears the old snapshot immediately and ignores its late read without ending the new poll', async () => {
    const oldRead = Promise.withResolvers<NodeStatusReadout>()
    const newRead = Promise.withResolvers<NodeStatusReadout>()
    const transport = { ...createStubTransport([]),
      read: vi.fn().mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise),
      power: vi.fn().mockResolvedValue(off) }
    const controller = new NodeStatusController({ transport, storage: null })
    controller.accept(readout(167))
    const oldPoll = controller.poll()
    controller.invalidateIdentity()
    expect(controller.state()).toMatchObject({ readout: null, phase: 'connecting', power: null, polling: true })
    oldRead.resolve(readout(167)); await oldPoll
    expect(controller.state()).toMatchObject({ readout: null, polling: true })
    expect(transport.power).not.toHaveBeenCalled()
    newRead.resolve(readout(168))
    await vi.waitFor(() =>{  expect(controller.state().polling).toBe(false) })
    expect(controller.state().readout).toEqual(readout(168))
    expect(controller.state().alert).toBeNull()
    controller.dispose()
  })

  it('does not restore old power or command receipts after the new account is read', async () => {
    const oldPower = Promise.withResolvers<NodePowerState>()
    const oldCommand = Promise.withResolvers<NodeCommandOutcome>()
    const transport = { ...createStubTransport([]),
      read: vi.fn().mockResolvedValueOnce(readout(167)).mockResolvedValueOnce(readout(168)),
      power: vi.fn().mockReturnValueOnce(oldPower.promise).mockResolvedValueOnce(off),
      command: vi.fn().mockReturnValueOnce(oldCommand.promise) }
    const controller = new NodeStatusController({ transport, storage: null })
    const oldPoll = controller.poll()
    await vi.waitFor(() =>{  expect(transport.power).toHaveBeenCalledTimes(1) })
    const command = controller.abort('all')
    controller.invalidateIdentity()
    await vi.waitFor(() =>{  expect(controller.state().power).toEqual(off) })
    oldPower.resolve(on); oldCommand.resolve({ ok: true, code: 'OK' })
    await Promise.all([oldPoll, command])
    expect(controller.state()).toMatchObject({ readout: readout(168), power: off, lastCommand: null, polling: false })
    controller.dispose()
  })

  it('keeps a new switch busy when the old identity switch finishes late', async () => {
    const oldSwitch = Promise.withResolvers<NodePowerState>()
    const newSwitch = Promise.withResolvers<NodePowerState>()
    const transport = { ...createStubTransport([readout(168)], off),
      setPower: vi.fn().mockReturnValueOnce(oldSwitch.promise).mockReturnValueOnce(newSwitch.promise) }
    const controller = new NodeStatusController({ transport, storage: null })
    const first = controller.setPower(true)
    controller.invalidateIdentity()
    const second = controller.setPower(false)
    oldSwitch.resolve(on); await first
    expect(controller.state()).toMatchObject({ power: null, powerBusy: true })
    newSwitch.resolve(off); await second
    expect(controller.state()).toMatchObject({ power: off, powerBusy: false })
    controller.dispose()
  })

  it('makes late reads and commands inert after disposal and never starts another read', async () => {
    const pending = Promise.withResolvers<NodeStatusReadout>()
    const transport = { ...createStubTransport([]), read: vi.fn().mockReturnValue(pending.promise) }
    const controller = new NodeStatusController({ transport, storage: null })
    const poll = controller.poll()
    const state = controller.state()
    controller.dispose()
    pending.resolve(readout(167)); await poll
    controller.start(); controller.invalidateIdentity(); await controller.poll()
    expect(controller.state()).toBe(state)
    expect(transport.read).toHaveBeenCalledTimes(1)
    expect(await controller.abort('all')).toMatchObject({ ok: false, code: 'CONTROLLER_DISPOSED' })
    expect(transport.commands).toEqual([])
  })
})
