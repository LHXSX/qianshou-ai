/** Model-safe coordinator service: pairing, credentials, and revocation stay in authenticated owner UI. */
import type { DeviceInfo, RemoteJob } from './protocol.ts'

/** Authenticated task coordination without access to pairing secrets or device revocation. */
export interface RemoteDevicesService {
  /**
   * Read public device metadata without exposing credentials or pairing codes.
   * @returns Cloned devices including connectivity and advertised workspace IDs.
   */
  devices(): DeviceInfo[]
  /**
   * Persist a validated task before delivering it to the selected online peer.
   * @param value - Untrusted finite task request, validated by the coordinator.
   * @returns The actual task in awaiting-approval state; acceptance does not mean execution.
   * @throws If the device is offline, its workspace is absent, input is invalid or task capacity is exhausted.
   */
  submit(value: unknown): Promise<RemoteJob>
  /**
   * Read a retained task receipt without starting or retrying work.
   * @param id - Existing task identity.
   * @returns A cloned receipt, or undefined when the task is absent or no longer retained.
   */
  task(id: string): RemoteJob | undefined
  /**
   * Record a cancellation request and forward it to an available peer.
   * @param id - Existing task identity.
   * @returns Request acceptance; a terminal receipt still determines the execution outcome.
   * @throws If the task is unknown or persistence fails.
   */
  cancel(id: string): Promise<{ accepted: true }>
}

declare module '@deepseek-ai/cordis' {
  interface Context { remoteDevices: RemoteDevicesService }
}
