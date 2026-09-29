/** Employee discovery and credential-free dispatch attribution. */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { parentAgentOptionsForDelegation } from '@deepseek-ai/dsh-subagent'
import type { EmployeeAssignment, EmployeeSettingsService } from './employee-settings.ts'

/**
 * Describe the concrete route selected for this dispatch without credential access.
 * @param assignment - Current role and routing preference.
 * @param parent - Current CEO route, used only when both settings inherit.
 * @returns A human-readable assignment trace for the model/tool history.
 */
export function employeeAssignmentText(assignment: EmployeeAssignment, parent: AgentOptions): string {
  const provider = assignment.route?.provider ?? parent.provider
  const model = assignment.route?.model ?? parent.model
  return `${assignment.employee.name} (${assignment.employee.id}) · ${provider ?? 'default'}/${model ?? 'default'} · ${assignment.source}`
}

/**
 * Register dynamic employee discovery in the opted-in tool scope.
 * @param ctx - The owning agent/preset tool scope.
 * @param settings - User-owned roster; each read returns current preferences.
 */
export function registerListEmployees(ctx: Context, settings: EmployeeSettingsService): void {
  ctx.tools.register(defineTool({
    name: 'list_employees',
    description: 'List user-configured employee roles and their actual API/model routing preferences. '
      + 'These are role configurations, not evidence that a worker is running. Use an id as subagent.employee. '
      + 'Use list_agents to find existing workers and send_message to reuse a suitable idle worker. '
      + 'New dispatches use current routing preferences; existing worker conversations retain their original route.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, result) => [{ type: 'text', text: result }],
    },
    async execute(_args, exec) {
      if (!exec.agent) throw new Error('list_employees requires a calling agent')
      const parent = parentAgentOptionsForDelegation(exec.agent)
      return settings.current().employees.map((employee) => {
        const assignment = settings.resolve(employee.id)
        return `${employeeAssignmentText(assignment, parent)}\n职责: ${employee.role}`
      }).join('\n\n') || '(no configured employees)'
    },
  }))
}
