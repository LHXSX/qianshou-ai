/** Preset-scoped read tools; management and arbitrary commands remain user capabilities. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from './registry.ts'
import { connectionId } from './validation.ts'

/** Cordis tool consumer name. */
export const name = 'qianshou-connection-tools'
/** Required authoritative services. */
export const inject = ['tools', 'connections']

/** Register reads through normal tool policy and live preset authorization.
 * @param ctx - Explicitly selected employee or CEO preset scope.
 */
export function apply(ctx: Context): void {
  const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] }
  ctx.tools.register(defineTool({ name: 'connection_list', description: 'List only saved SSH/GitHub connections granted to your current live preset. Empty means no authorization; ask the user to configure Connections. A saved record is not proof of connectivity. Never request secret tokens in conversation.',
    parameters: {}, output, isConcurrencySafe: () => true,
    async execute(_args, exec) { if (!exec.agent) throw new Error('CONNECTION_FORBIDDEN'); exec.signal.throwIfAborted(); return JSON.stringify(ctx.connections.list(exec.agent)) },
    presentCall: () => ({ card: 'generic', title: '列出已授权连接', kind: 'read' }),
  }))
  ctx.tools.register(defineTool({ name: 'connection_probe', description: 'Test an authorized saved connection with an actual bounded read. SSH requires an existing trusted host key and local agent/key authentication; GitHub reads the authenticated identity. Never infer success from saved settings.',
    parameters: { connection_id: { type: 'string', required: true } }, output, isConcurrencySafe: () => true,
    async execute(args, exec) { if (!exec.agent) throw new Error('CONNECTION_FORBIDDEN'); return JSON.stringify(await ctx.connections.probe(connectionId(args.connection_id), exec.signal, exec.agent)) },
    presentCall: args => ({ card: 'generic', title: '验证连接', kind: 'read', rawInput: args.connection_id }),
  }))
  ctx.tools.register(defineTool({ name: 'connection_github_repositories', description: 'Read one page of repositories available to an authorized saved GitHub account. This does not clone, edit, create issues or publish anything. Use nextPage explicitly for another page.',
    parameters: { connection_id: { type: 'string', required: true }, page: { type: 'integer', description: 'One-based page, default 1.' } }, output, isConcurrencySafe: () => true,
    async execute(args, exec) { if (!exec.agent) throw new Error('CONNECTION_FORBIDDEN'); return JSON.stringify(await ctx.connections.repositories(connectionId(args.connection_id), args.page ?? 1, exec.signal, exec.agent)) },
    presentCall: args => ({ card: 'generic', title: '读取 GitHub 仓库', kind: 'read', rawInput: args.connection_id }),
  }))
  ctx.tools.register(defineTool({ name: 'connection_ssh_inspect', description: 'Inspect an authorized saved SSH server using only the fixed uname/pwd/id command. Returns actual OS, login directory and user. Arbitrary commands, file changes and deployment are not exposed by this connector; do not bypass approval through a different tool.',
    parameters: { connection_id: { type: 'string', required: true } }, output, isConcurrencySafe: () => true,
    async execute(args, exec) { if (!exec.agent) throw new Error('CONNECTION_FORBIDDEN'); return JSON.stringify(await ctx.connections.inspect(connectionId(args.connection_id), exec.signal, exec.agent)) },
    presentCall: args => ({ card: 'generic', title: '只读检查 SSH 服务器', kind: 'read', rawInput: args.connection_id }),
  }))
}
