/** Read-only model administration using the existing dedicated service credential. */
import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { CREDENTIALS_FILENAME } from '@deepseek-ai/dsh-credentials-local'
import { createAiAdminRoutes } from './admin-routes.ts'
import type { RoutingConsole } from './routing.ts'
import { createModelReadHttpRoute } from './model-read-http.ts'
import { createModelReadAuthorizer, type ModelReadConfig } from './service-admin-read-auth.ts'
import { readServiceCredential } from './service-admin-auth.ts'

export const name = 'qianshou-admin-model-read'
export const inject = ['routingConsole']
export interface Config extends ModelReadConfig { readonly dshHome: string }

/** Register only model reads; finance and binding routes remain owned by their existing plugins.
 * @param ctx - Host context with the active authoritative routing console.
 * @param config - Explicit service reference and audience, without any credential value.
 */
export function apply(ctx: Context, config: Config): void {
  const authorise = createModelReadAuthorizer(config,
    ref => readServiceCredential(join(resolveDshHome(config.dshHome), CREDENTIALS_FILENAME), ref))
  ctx.inject(['webServer'], webCtx => {
    const route = createModelReadHttpRoute('/internal/models/names', async request => {
      const auth = await authorise(request)
      if (!auth.ok) return auth.response
      const routing = ctx.get('routingConsole') as unknown as RoutingConsole
      return createAiAdminRoutes({ routing, authenticate: () => auth.principal }).names(request)
    })
    webCtx.effect(() => (webCtx as unknown as { webServer: { register: (route: unknown) => () => void } }).webServer.register(route),
      'admin-model-read: authenticated loopback model directory')
  })
}
