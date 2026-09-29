import { updateWorkOf } from '@deepseek-ai/dsh-agent'
/** Desktop installation admission and task inspection for the shared Web Host. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-client-connection'

/**
 * Register update admission on the owning Host context.
 * @param ctx - Booted Desktop profile context; disposal removes the request listener.
 * @returns Task inspector whose lock refuses new API requests, drains admitted requests, and rechecks work.
 */
export function installDesktopUpdateTaskControl(ctx: Context): (action: 'inspect' | 'lock' | 'unlock') => Promise<boolean> {
  const work = updateWorkOf(ctx.root)
  let locked = false
  let lockGeneration = 0
  let stopped = false
  ctx.effect(() => () => { stopped = true })
  const vetoes: Array<() => void> = []
  const releaseVetoes = (): void => { for (const release of vetoes.splice(0)) release() }
  ctx.effect(() => () => { releaseVetoes() })
  const pendingRequests = new Set<Promise<void>>()
  ctx.on('connection/request', async (request, response, next) => {
    if (locked && request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(503)
      response.end()
      return
    }
    const finished = Promise.withResolvers<void>()
    pendingRequests.add(finished.promise)
    try { await next() }
    finally { pendingRequests.delete(finished.promise); finished.resolve() }
  })
  return async (action) => {
    if (stopped) throw new Error('desktop update: Host is stopping')
    if (action === 'unlock') { locked = false; lockGeneration++; releaseVetoes(); await work.control('unlock') }
    const agents = ctx.get('agents')
    const jobs = ctx.get('jobs')
    if (agents === undefined || jobs === undefined) throw new Error('desktop update: task services are unavailable')
    if (action === 'lock') {
      locked = true
      if (vetoes.length === 0) {
        const refuse = (): never => { throw new Error('DESKTOP_UPDATE_IN_PROGRESS') }
        vetoes.push(agents.admission.register(refuse), jobs.admission.register(refuse))
      }
      const generation = ++lockGeneration
      // Every background producer closes its execution gate before the HTTP drain.
      const protectedWork = work.control('lock')
      // Observe rejection immediately while the request drain still owns its deadline.
      void protectedWork.catch(() => undefined)
      // Read requests are not tasks; admitted writes must finish before the final work check.
      await Promise.all(pendingRequests)
      await protectedWork
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Disposal can run while admitted requests drain.
      if (stopped) throw new Error('desktop update: Host is stopping')
      if (generation !== lockGeneration) throw new Error('desktop update: admission lock was superseded')
    }
    const externalBusy = await work.control('inspect')
    if (externalBusy && action !== 'unlock') throw new Error('DESKTOP_UPDATE_WORK_BUSY')
    const liveAgents = agents.list()
    return externalBusy || agents.admission.pending > 0 || jobs.admission.pending > 0 || liveAgents.some(agent => agent.status === 'running'
      || agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0)
      || [undefined, ...liveAgents].some(agent => jobs.list(agent)
        .some(job => job.status === 'running' || job.status === 'stopping'))
  }
}
