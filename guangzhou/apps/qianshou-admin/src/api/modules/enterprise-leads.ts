/** Read-only enterprise inquiries through the existing authenticated admin origin. */
import { postJson } from '@/api/client'
import { ENDPOINTS } from '@/api/endpoints'

export interface EnterpriseLeadSummary {
  readonly id: number
  readonly company: string
  readonly contact: string
  readonly phone: string
  readonly size: string
  readonly use_case: string
  readonly budget: string
  readonly source: string
  readonly created_at: string
  readonly status: string
}

export interface EnterpriseLeadDetail extends EnterpriseLeadSummary {
  readonly note: string
  readonly submitted_at: string
  readonly source_ip: string
  readonly user_agent: string
}

export const listEnterpriseLeads = (offset: number, limit = 30) =>
  postJson<{ ok: true; items: EnterpriseLeadSummary[]; total: number; limit: number; offset: number }>(ENDPOINTS.enterpriseLeads, { offset, limit })

export const getEnterpriseLead = (id: number) =>
  postJson<{ ok: true; lead: EnterpriseLeadDetail }>(ENDPOINTS.enterpriseLead, { id })
