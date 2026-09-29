/** Select a loopback Web port for an isolated Desktop development instance. */
export function resolveDesktopWebPort(value: string | undefined): number {
  if (value === undefined || value === '') return 19_387
  if (!/^[1-9]\d{0,4}$/u.test(value)) throw new Error('DSH_DESKTOP_WEB_PORT must be a port from 1 through 65535')
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new Error('DSH_DESKTOP_WEB_PORT must be a port from 1 through 65535')
  }
  return port
}
