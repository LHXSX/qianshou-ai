/**
 * Owner controlled boundary for a local model implementation.
 *
 * This module deliberately contains no model SDK, weight loader or native
 * process launcher.  A platform specific package injects those pieces after
 * the owner has installed and granted a plugin.  The adapter may advertise
 * `ready` only after a real preflight has returned at least one passing check;
 * a descriptor, an installed package name or a GPU is never enough evidence.
 */
import { ComputeError } from './errors.ts'
import type { ComputeCapabilityId } from './protocol.ts'

export type LocalModelRuntime = 'injected' | 'native' | 'http-loopback'
export type LocalModelState = 'unknown' | 'ready' | 'degraded' | 'unavailable' | 'quarantined'

export interface LocalModelDescriptor {
  readonly modelId: string
  readonly modelVersion: string
  readonly capabilityId: ComputeCapabilityId
  readonly displayName: string
  readonly runtime: LocalModelRuntime
  readonly localOnly: true
  readonly supportsStreaming: boolean
  readonly supportsCancellation: boolean
}

export interface LocalModelCheck {
  readonly id: string
  readonly status: 'pass' | 'fail' | 'skipped'
  readonly detail?: string
}

export interface LocalModelObservation {
  readonly state: LocalModelState
  readonly available: boolean
  readonly checks: readonly LocalModelCheck[]
  readonly reasonCodes: readonly string[]
  readonly observedAt: string
}

export interface LocalModelExecutionContext {
  readonly executionId: string
  readonly signal: AbortSignal
}

export interface LocalModelRecoveryResult {
  readonly outcome: 'recovered' | 'still-unavailable' | 'not-supported'
  readonly health: LocalModelObservation
}

export interface LocalModelAdapter<TRequest, TResult, TChunk> {
  describe(): LocalModelDescriptor
  preflight(signal?: AbortSignal): Promise<LocalModelObservation>
  invoke(request: TRequest, context: LocalModelExecutionContext): Promise<TResult>
  stream(request: TRequest, context: LocalModelExecutionContext): AsyncIterable<TChunk>
  cancel(executionId: string): Promise<{ readonly cancelled: boolean }>
  health(signal?: AbortSignal): Promise<LocalModelObservation>
  recover(signal?: AbortSignal): Promise<LocalModelRecoveryResult>
}

export interface InjectedLocalModelAdapterOptions<TRequest, TResult, TChunk> {
  readonly descriptor: LocalModelDescriptor
  /** Real local checks: weights, runtime, model probe and output contract. */
  readonly preflight?: (context: { readonly signal: AbortSignal }) => Promise<LocalModelObservation>
  readonly invoke: (request: TRequest, context: LocalModelExecutionContext) => Promise<TResult>
  readonly stream?: (request: TRequest, context: LocalModelExecutionContext) => AsyncIterable<TChunk>
  readonly cancel?: (executionId: string) => Promise<void> | void
  readonly health?: (context: { readonly signal: AbortSignal }) => Promise<LocalModelObservation>
  /** Restart/reload a local runner. The factory performs a fresh preflight afterwards. */
  readonly recover?: (context: { readonly signal: AbortSignal }) => Promise<void>
}

/**
 * Build a guarded adapter around a node-owned implementation.
 *
 * The returned object is intentionally small and transport agnostic.  It
 * centralises lifecycle rules so H3, z-ming and future local models cannot
 * accidentally bypass preflight, cancellation or the owner authorization
 * boundary.  No callback is invoked before a successful preflight.
 */
export function createInjectedLocalModelAdapter<TRequest, TResult, TChunk>(
  options: InjectedLocalModelAdapterOptions<TRequest, TResult, TChunk>,
): LocalModelAdapter<TRequest, TResult, TChunk> {
  const descriptor = validateDescriptor(options.descriptor)
  if (typeof options.invoke !== 'function') throw new ComputeError('COMPUTE_MODEL_ADAPTER_INVALID')
  if (descriptor.supportsStreaming && options.stream === undefined) {
    throw new ComputeError('COMPUTE_MODEL_STREAM_UNIMPLEMENTED')
  }
  if (descriptor.supportsCancellation && options.cancel === undefined) {
    throw new ComputeError('COMPUTE_MODEL_CANCEL_UNIMPLEMENTED')
  }

  const active = new Map<string, AbortController>()
  let latest: LocalModelObservation | undefined
  let preflightInFlight: Promise<LocalModelObservation> | undefined

  const preflight = (signal: AbortSignal = new AbortController().signal): Promise<LocalModelObservation> => {
    // One self-test may be shared by concurrent callers, but a caller's
    // cancellation must only cancel that caller's wait.  The shared probe has
    // its own signal; otherwise a mobile disconnect could abort a PC probe
    // that another route is waiting on.
    const shared = preflightInFlight ?? (() => {
      const probeController = new AbortController()
      const probe = (async () => {
        probeController.signal.throwIfAborted()
      let observation: LocalModelObservation
      try {
        observation = options.preflight === undefined
            ? unavailable('COMPUTE_MODEL_PREFLIGHT_UNIMPLEMENTED')
            : normalizeObservation(await options.preflight({ signal: probeController.signal }), 'preflight')
      } catch (error) {
        if (probeController.signal.aborted) throw error
        observation = unavailable('COMPUTE_MODEL_PREFLIGHT_FAILED')
      }
      latest = observation
      return observation
      })().finally(() => { if (preflightInFlight === probe) preflightInFlight = undefined })
      preflightInFlight = probe
      return probe
    })()
    return awaitWithAbort(shared, signal)
  }

  const begin = async (executionId: string, signal: AbortSignal): Promise<{ controller: AbortController; unlink: () => void }> => {
    if (!isToken(executionId)) throw new ComputeError('COMPUTE_MODEL_EXECUTION_ID_INVALID', 422)
    if (active.has(executionId)) throw new ComputeError('COMPUTE_MODEL_EXECUTION_DUPLICATE', 409)
    const controller = new AbortController()
    const unlink = linkAbort(signal, controller)
    active.set(executionId, controller)
    let observation: LocalModelObservation
    try {
      observation = await preflight(controller.signal)
    } catch (error) {
      active.delete(executionId)
      unlink()
      throw error
    }
    if (!observation.available || observation.state !== 'ready') {
      active.delete(executionId)
      unlink()
      throw new ComputeError('COMPUTE_MODEL_UNAVAILABLE', 409)
    }
    return { controller, unlink }
  }

  const finish = (executionId: string, unlink: () => void): void => {
    active.delete(executionId)
    unlink()
  }

  return Object.freeze({
    describe: () => descriptor,
    preflight,
    async invoke(request: TRequest, context: LocalModelExecutionContext): Promise<TResult> {
      const begun = await begin(context.executionId, context.signal)
      try {
        begun.controller.signal.throwIfAborted()
        return await options.invoke(request, { executionId: context.executionId, signal: begun.controller.signal })
      } finally {
        finish(context.executionId, begun.unlink)
      }
    },
    stream(request: TRequest, context: LocalModelExecutionContext): AsyncIterable<TChunk> {
      if (!descriptor.supportsStreaming || options.stream === undefined) {
        throw new ComputeError('COMPUTE_MODEL_STREAM_UNSUPPORTED', 409)
      }
      const iterator = (async function* () {
        const begun = await begin(context.executionId, context.signal)
        try {
          begun.controller.signal.throwIfAborted()
          for await (const chunk of options.stream!(request, { executionId: context.executionId, signal: begun.controller.signal })) {
            begun.controller.signal.throwIfAborted()
            yield chunk
          }
        } finally {
          finish(context.executionId, begun.unlink)
        }
      })()
      return iterator
    },
    async cancel(executionId: string): Promise<{ readonly cancelled: boolean }> {
      const controller = active.get(executionId)
      if (controller === undefined) return { cancelled: false }
      controller.abort()
      try {
        await options.cancel?.(executionId)
      } catch {
        throw new ComputeError('COMPUTE_MODEL_CANCEL_FAILED', 502)
      }
      return { cancelled: true }
    },
    async health(signal: AbortSignal = new AbortController().signal): Promise<LocalModelObservation> {
      signal.throwIfAborted()
      if (options.health === undefined) return latest ?? unavailable('COMPUTE_MODEL_HEALTH_UNOBSERVED')
      try {
        const observation = normalizeObservation(await options.health({ signal }), 'health')
        latest = observation
        return observation
      } catch (error) {
        if (signal.aborted) throw error
        const observation = unavailable('COMPUTE_MODEL_HEALTH_FAILED')
        latest = observation
        return observation
      }
    },
    async recover(signal: AbortSignal = new AbortController().signal): Promise<LocalModelRecoveryResult> {
      signal.throwIfAborted()
      if (active.size > 0) throw new ComputeError('COMPUTE_MODEL_RECOVERY_BUSY', 409)
      if (options.recover === undefined) {
        const health = unavailable('COMPUTE_MODEL_RECOVERY_UNIMPLEMENTED')
        latest = health
        return { outcome: 'not-supported', health }
      }
      try {
        await options.recover({ signal })
      } catch (error) {
        if (signal.aborted) throw error
        const health = unavailable('COMPUTE_MODEL_RECOVERY_FAILED')
        latest = health
        return { outcome: 'still-unavailable', health }
      }
      const health = await preflight(signal)
      return { outcome: health.available && health.state === 'ready' ? 'recovered' : 'still-unavailable', health }
    },
  })
}

function validateDescriptor(value: LocalModelDescriptor): LocalModelDescriptor {
  if (!value || value.localOnly !== true || value.runtime !== 'injected'
    || !isToken(value.modelId) || !isToken(value.modelVersion) || !isToken(value.capabilityId) || !isToken(value.displayName)
    || typeof value.supportsStreaming !== 'boolean' || typeof value.supportsCancellation !== 'boolean') {
    throw new ComputeError('COMPUTE_MODEL_DESCRIPTOR_INVALID', 422)
  }
  return Object.freeze({ ...value })
}

function normalizeObservation(value: LocalModelObservation, source: string): LocalModelObservation {
  if (!value || !Array.isArray(value.checks) || value.checks.length === 0 || value.checks.length > 64
    || !Array.isArray(value.reasonCodes) || value.reasonCodes.length > 32
    || !['unknown', 'ready', 'degraded', 'unavailable', 'quarantined'].includes(value.state)
    || typeof value.available !== 'boolean') {
    throw new ComputeError('COMPUTE_MODEL_OBSERVATION_INVALID', 422, source)
  }
  const checks = value.checks.map((check) => {
    if (!check || !isToken(check.id) || !['pass', 'fail', 'skipped'].includes(check.status)
      || (check.detail !== undefined && (typeof check.detail !== 'string' || check.detail.length > 512))) {
      throw new ComputeError('COMPUTE_MODEL_CHECK_INVALID', 422)
    }
    return Object.freeze({ ...check })
  })
  const reasonCodes = value.reasonCodes.map(code => {
    if (!isToken(code)) throw new ComputeError('COMPUTE_MODEL_REASON_INVALID', 422)
    return code
  })
  const passed = checks.length > 0 && checks.every(check => check.status === 'pass')
  // A callback cannot claim readiness without executable evidence.  We also
  // reject contradictory available/state pairs so callers cannot advertise a
  // model merely because a package or GPU happens to be present.
  const available = value.available && value.state === 'ready' && passed
  const state: LocalModelState = available ? 'ready' : (value.state === 'quarantined' ? 'quarantined' : 'unavailable')
  return Object.freeze({ state, available, checks: Object.freeze(checks), reasonCodes: Object.freeze(available ? reasonCodes : [...reasonCodes, ...(passed ? [] : ['COMPUTE_MODEL_CHECK_FAILED'])]), observedAt: validTimestamp(value.observedAt) })
}

function unavailable(reason: string): LocalModelObservation {
  const checks: readonly LocalModelCheck[] = Object.freeze([{ id: 'adapter', status: 'fail', detail: reason }])
  return Object.freeze({ state: 'unavailable' as const, available: false, checks, reasonCodes: Object.freeze([reason]), observedAt: new Date().toISOString() })
}

function validTimestamp(value: unknown): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return new Date().toISOString()
  return value
}

function isToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value)
}

function linkAbort(source: AbortSignal, target: AbortController): () => void {
  const abort = (): void => { target.abort(source.reason) }
  if (source.aborted) abort()
  else source.addEventListener('abort', abort, { once: true })
  return () => source.removeEventListener('abort', abort)
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new ComputeError('COMPUTE_MODEL_ABORTED', 499))
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { cleanup(); reject(signal.reason ?? new ComputeError('COMPUTE_MODEL_ABORTED', 499)) }
    const cleanup = (): void => { signal.removeEventListener('abort', abort) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}
