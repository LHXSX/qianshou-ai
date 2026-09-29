/** Public Beta Program form contract. The server deliberately gives the same 202 for first and duplicate submissions. */
export interface EnterpriseInquiry {
  company: string
  contact: string
  phone: string
  size: string
  use_case: string
  budget: string
  note: string
}

export type SubmitInquiryResult =
  | { kind: 'accepted' }
  | { kind: 'invalid' }
  | { kind: 'rate_limited'; retryAfter?: number }
  | { kind: 'unavailable' }
  | { kind: 'network' }

export async function submitEnterpriseInquiry(form: EnterpriseInquiry, send: typeof fetch = fetch): Promise<SubmitInquiryResult> {
  if (form.company.trim().length < 2 || form.company.length > 120 || !form.contact.trim() || form.contact.length > 60 || form.phone.trim().length < 3 || form.phone.length > 120 || !form.use_case || form.note.length > 2000) {
    return { kind: 'invalid' }
  }
  let response: Response
  try {
    response = await send('/api/v8/leads/enterprise', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, source: 'beta-program-page', submitted_at: new Date().toISOString() }),
    })
  } catch {
    return { kind: 'network' }
  }
  if (response.status === 202) {
    try {
      const body: unknown = await response.json()
      if (body !== null && typeof body === 'object' && !Array.isArray(body) && (body as { ok?: unknown }).ok === true) return { kind: 'accepted' }
    } catch { /* a malformed acceptance cannot be shown as success */ }
    return { kind: 'unavailable' }
  }
  if (response.status === 422 || response.status === 400) return { kind: 'invalid' }
  if (response.status === 429) {
    const seconds = Number(response.headers.get('Retry-After'))
    return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 3600 ? { kind: 'rate_limited', retryAfter: seconds } : { kind: 'rate_limited' }
  }
  return { kind: 'unavailable' }
}
