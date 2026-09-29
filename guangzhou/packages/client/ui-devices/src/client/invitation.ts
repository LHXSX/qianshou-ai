/**
 * Normalize an address suitable to share; format acceptance never proves remote connectivity.
 * @param value - User-entered coordinator origin, excluding credentials and browser authentication paths.
 * @returns A non-loopback HTTPS origin, or null when the address cannot safely be shared.
 */
export function remoteCoordinatorAddress(value: string): string | null {
  try {
    const url = new URL(value.trim())
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || (url.pathname !== '' && url.pathname !== '/') || host === 'localhost' || host.endsWith('.localhost')
      || host === '[::1]' || host === '[::]' || host === '0.0.0.0' || /^127\./.test(host)
      || /^\[::ffff:7f/i.test(host)) return null
    return url.origin
  } catch { return null }
}
