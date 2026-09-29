/** Pure URL and native capability checks for the isolated desktop renderer. */
export function trustedUrl(value, origin) {
  try { const url = new URL(value); return url.origin === origin && url.username === '' && url.password === '' }
  catch { return false }
}

/** Only the actual web-profile readiness line can supply the initial auth URL. */
export function authenticatedUrl(line, origin) {
  const match = /^dsh web: (http:\/\/[^\s]+)/u.exec(line.trim())
  if (!match || !trustedUrl(match[1], origin)) return null
  const url = new URL(match[1])
  return url.pathname === '/' && url.searchParams.get('token') ? url.href : null
}

/** Redact startup URL tokens before persistence; never echo raw backend output. */
export function redactLog(line) {
  return line.replace(/([?&](?:token|auth|key)=)[^\s&#]+/giu, '$1[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*)[^\s,;]+/giu, '$1[redacted]')
}

/** Remote-control IDs cross an IPC boundary and are passed as one argv item. */
export function validRustDeskId(value) { return typeof value === 'string' && /^[0-9]{6,12}$/u.test(value) }

/** Normal links may open outside the app, never custom protocols or token-bearing URLs. */
export function externalUrl(value, origin) {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin !== origin
      && url.username === '' && url.password === '' && !url.searchParams.has('token')
  } catch { return false }
}

/** Microphone requests must originate in the trusted main frame and request audio only. */
export function microphoneRequest(details, origin) {
  return details.isMainFrame === true && trustedUrl(details.requestingUrl, origin)
    && Array.isArray(details.mediaTypes) && details.mediaTypes.length === 1 && details.mediaTypes[0] === 'audio'
}
