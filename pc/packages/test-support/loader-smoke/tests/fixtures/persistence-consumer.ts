/** Run a real shipped profile with explicit durable or stateless startup needs. */
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import type {} from '@deepseek-ai/dsh-agent'
import { bootProductionProfile } from './production-profile.ts'

const [scenarioPatch, backendPatch, requirement, ...task] = process.argv.slice(2)
if (scenarioPatch === undefined || backendPatch === undefined
  || !['required', 'stateless', 'omitted'].includes(requirement ?? '')) {
  throw new Error('persistence consumer needs two patches and an explicit fixture mode')
}
const startup: { event: string; persistence: boolean }[] = []
const ctx = await bootProductionProfile({
  binName: 'persistence-startup-consumer',
  profile: 'headless',
  overlayPaths: [scenarioPatch, backendPatch],
  ...requirement === 'omitted' ? {} : { requirePersistence: requirement === 'required' },
  prepare(hostCtx) {
    hostCtx.on('agent/created', () => {
      startup.push({ event: 'agent-created', persistence: hostCtx.get('sessionPersistence') !== undefined })
    })
  },
})
try {
  const result = await runFixtureTurn(ctx, { task: task.join(' ') })
  process.stdout.write(`${JSON.stringify({ result, startup })}\n`)
} finally {
  await ctx.fiber.dispose()
}
