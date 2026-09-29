/** Real Loader composition with file tools and Session lifetimes for child-evidence tests; no model or network dependency. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as WorkspaceChanges from '../src/index.ts'
import { endTurn, toolCall } from './support.ts'

const signal = new AbortController().signal
let calls = 0

/** Test-only composition options beyond the plugin config. */
export interface BootOptions {
  /** Session ids a fake `sessionPersistence` service reports as stored; absent mounts no persistence service. */
  stored?: ReadonlySet<string>
  /** Absolute `DSH_HOME` for this boot; omitted unsets it so a leaked desktop home cannot write durable evidence. */
  home?: string
}

/**
 * A `boot` bound to one test file's cleanup list.
 * @param cleanups - run in reverse order after each test.
 * @returns the booted composition with Session and tool helpers.
 */
export function makeBoot(cleanups: Array<() => unknown>) {
  return async (config: Partial<WorkspaceChanges.Config> = {}, options: BootOptions = {}) => {
    const previousHome = process.env.DSH_HOME
    delete process.env.DSH_HOME
    if (options.home !== undefined) process.env.DSH_HOME = options.home
    cleanups.push(() => {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    })
    const root = await mkdtemp(join(tmpdir(), 'dsh-child-changes-loader-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    ctx.baseUrl = `${pathToFileURL(root).href}/`
    if (options.stored !== undefined) {
      const stored = options.stored
      ctx.provide('sessionPersistence', { stat: (id: string) => Promise.resolve(stored.has(id) ? { id } : undefined) })
    }
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['session', SessionStore], ['subprocess', LocalSubprocessRuntime], ['fs', LocalFileSystem],
      ['tools', Tools], ['prompt', SystemPrompt], ['tool-fs', ToolFs], ['changes', WorkspaceChanges],
    ])
    // Loader's documented builtin resolver supplies the actual plugin modules; no fake Node internals.
    for (const [name, plugin] of modules) ctx.loader.builtins[name] = plugin
    const rows = [...modules.keys()].map(name => ({ name: `cordis:${name}`, ...(name === 'changes' ? { config: { includeChildren: true, ...config } } : {}) }))
    await writeFile(join(root, 'cordis.yml'), JSON.stringify(rows))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(root, 'cordis.yml')).href } })
    await ctx.loader.await()
    expect([...ctx.loader.entries()].filter(entry => !entry.disabled && entry.fiber === undefined)).toEqual([])
    const make = (id: string, cwd = root, parent?: Session) => {
      const session = ctx.sessions.prepare(SessionId(id), { meta: { cwd, ...parent === undefined ? {} : {
        parentSession: parent.id, origin: 'subagent', delegationDepth: (parent.header.delegationDepth ?? 0) + 1,
      } } })
      const detach = ctx.sessions.enter(session)
      ctx.sessions.announce(session)
      cleanups.push(detach)
      return { session, detach }
    }
    const write = async (session: Session, turn: number, name: 'write' | 'edit', args: unknown, customSignal = signal) => {
      const result = await ctx.tools.execute({ name, arguments: args, callId: ToolCallId(`file-${++calls}`),
        agent: { session, ctx } as never, signal: customSignal })
      toolCall(session, turn, name, args, { isError: result.isError })
      return result
    }
    const finish = async (session: Session, turn: number) => {
      await ctx.serial('agent/turn-stopping', { agent: { session }, turn } as never)
      endTurn(session, turn)
      await vi.waitFor(() => { expect(ctx.workspaceChanges.children(session.header.parentSession!).entries.find(row => row.sessionId === session.id && row.turn === turn)?.state).not.toBe('pending') })
    }
    return { ctx, root, make, write, finish }
  }
}
