/** The fixed `contracts/v1` copy a packaged application carries beside its runtime. */

import { join } from 'node:path'

/**
 * Point the Host at the shipped contract copy.
 * A development run leaves the variable absent, because the Host then resolves
 * the checkout copy itself, and an operator-set value always wins.
 * @param environment - Environment the Host child inherits.
 * @param resourcesPath - Packaged resources directory, or undefined in a development run.
 * @returns The same environment, extended only when packaging shipped a copy and nothing set the variable.
 */
export function withShippedContracts(
  environment: NodeJS.ProcessEnv,
  resourcesPath: string | undefined,
): NodeJS.ProcessEnv {
  if (resourcesPath === undefined || environment.QIANSHOU_CONTRACTS_DIR !== undefined) return environment
  return { ...environment, QIANSHOU_CONTRACTS_DIR: join(resourcesPath, 'contracts', 'v1') }
}
