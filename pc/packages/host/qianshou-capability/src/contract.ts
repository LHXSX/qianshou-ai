/** Read the fixed `contracts/v1` copy; the registry names capabilities and the intent schema validates card input. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import type { EstimateIntent } from './types.ts'

/** Registry discriminator from `contracts/v1/capabilities.registry.json`. */
const REGISTRY_CONTRACT = 'qianshou/capabilities/registry/v1'
/** Intent discriminator from `contracts/v1/intent.schema.json`. */
const INTENT_TITLE = 'qianshou/intent/v1'
/**
 * `name_grammar` of the registry: lowercase dot-separated `domain.object.action`, at least two
 * segments. Only the domain must start with a letter; a later segment may start with a digit,
 * which `render.3d` in the shipped registry does.
 */
const CAPABILITY_ID = /^[a-z][a-z0-9]*(?:\.[a-z0-9]+)+$/

/** Thrown at load when the contract copy is missing or does not have the expected structure. */
export class ContractLoadError extends Error {
  constructor(readonly file: string, detail: string) {
    super(`qianshou-capability: ${file}: ${detail}`)
    this.name = 'ContractLoadError'
  }
}

/** One registry row reduced to what the card and the estimate request need. */
export interface RegistryCapability {
  id: string
  title: string | null
  /** Platform `task_type` spellings; the first one is the estimate landing. */
  legacyTaskTypes: string[]
}

/** Loaded contract facts used by the service. */
export interface ContractSet {
  registryVersion: string
  capabilities: Map<string, RegistryCapability>
  /** `properties.goal` of the intent schema. */
  goalSchema: JsonSchemaNode
  /** `properties.budget` of the intent schema. */
  budgetSchema: JsonSchemaNode
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

async function readJson(dir: string, file: string): Promise<unknown> {
  let text: string
  try { text = await readFile(join(dir, file), 'utf8') } catch (error) {
    throw new ContractLoadError(file, error instanceof Error ? error.message : 'unreadable')
  }
  try { return JSON.parse(text) as unknown } catch { throw new ContractLoadError(file, 'not JSON') }
}

/**
 * Load the registry and the intent schema from one directory holding the `contracts/v1` copy.
 * @param dir - Directory containing `capabilities.registry.json` and `intent.schema.json`.
 * @returns Validated registry rows and the two intent sub-schemas this package enforces.
 */
export async function loadContracts(dir: string): Promise<ContractSet> {
  const registry = record(await readJson(dir, 'capabilities.registry.json'))
  if (registry === null || registry.contract !== REGISTRY_CONTRACT) throw new ContractLoadError('capabilities.registry.json', `contract must be ${REGISTRY_CONTRACT}`)
  if (typeof registry.registry_version !== 'string' || registry.registry_version.length === 0) throw new ContractLoadError('capabilities.registry.json', 'registry_version must be a string')
  if (!Array.isArray(registry.capabilities) || registry.capabilities.length === 0) throw new ContractLoadError('capabilities.registry.json', 'capabilities must be a non-empty array')
  const capabilities = new Map<string, RegistryCapability>()
  for (const row of registry.capabilities as unknown[]) {
    const entry = record(row)
    const id = entry?.capability
    if (entry === null || typeof id !== 'string' || !CAPABILITY_ID.test(id)) throw new ContractLoadError('capabilities.registry.json', 'capabilities[].capability must follow name_grammar')
    if (capabilities.has(id)) throw new ContractLoadError('capabilities.registry.json', `duplicate capability ${id}`)
    const legacy = Array.isArray(entry.legacy_task_types) ? entry.legacy_task_types : []
    if (legacy.some(name => typeof name !== 'string' || name.length === 0)) throw new ContractLoadError('capabilities.registry.json', `${id}: legacy_task_types must be strings`)
    capabilities.set(id, { id, title: typeof entry.title === 'string' ? entry.title : null, legacyTaskTypes: legacy as string[] })
  }
  const intent = record(await readJson(dir, 'intent.schema.json'))
  const properties = record(intent?.properties)
  if (intent === null || intent.title !== INTENT_TITLE || properties === null) throw new ContractLoadError('intent.schema.json', `title must be ${INTENT_TITLE}`)
  const goalSchema: unknown = properties.goal
  const budgetSchema: unknown = properties.budget
  try {
    assertSupportedJsonSchema(goalSchema)
    assertSupportedJsonSchema(budgetSchema)
  } catch (error) { throw new ContractLoadError('intent.schema.json', error instanceof Error ? error.message : 'unsupported schema') }
  return { registryVersion: registry.registry_version, capabilities, goalSchema, budgetSchema }
}

/**
 * Check one capability id against the registry name grammar without consulting the server.
 * @param value - Untrusted Remote argument.
 * @returns Whether the id could name a registry capability.
 */
export function isCapabilityId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && CAPABILITY_ID.test(value)
}

/**
 * Validate the card's intent subset against the contract's own `goal` and `budget` nodes.
 * @param contracts - Loaded contract set.
 * @param value - Untrusted Remote argument.
 * @returns Path-qualified violations; empty means the intent is acceptable.
 */
export function intentViolations(contracts: ContractSet, value: unknown): string[] {
  const intent = record(value)
  if (intent === null) return ['intent must be an object']
  const keys = Object.keys(intent).filter(key => key !== 'goal' && key !== 'budget')
  const violations = keys.map(key => `intent.${key} is not part of the card subset`)
  violations.push(...validateJsonSchemaValue(contracts.goalSchema, intent.goal, 'intent.goal'))
  if (typeof intent.goal === 'string' && intent.goal.length > 2000) violations.push('intent.goal exceeds 2000 characters')
  if (intent.budget !== null) violations.push(...validateJsonSchemaValue(contracts.budgetSchema, intent.budget, 'intent.budget'))
  return violations
}

/**
 * Narrow an already validated intent value.
 * @param value - Value for which {@link intentViolations} returned an empty list.
 * @returns The typed intent.
 */
export function asIntent(value: unknown): EstimateIntent {
  return value as EstimateIntent
}
