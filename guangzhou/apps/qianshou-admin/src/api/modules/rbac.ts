/** §4 权限模型：权限目录、角色矩阵、管理员授权（写操作全部走两步确认）。 */

import { apply, preflight } from '../confirm'
import { postJson } from '../client'
import { ENDPOINTS } from '../endpoints'
import type {
  AdminDraft,
  AdminRecord,
  ApplyResult,
  ConfirmPreview,
  PermissionGroup,
  RoleDraft,
  RoleRecord,
} from '../types'

/** `POST rbac/permissions`：带 highRisk/description 的完整权限目录，前端据此渲染权限矩阵。 */
export async function fetchPermissionGroups(): Promise<readonly PermissionGroup[]> {
  const response = await postJson<{ ok: true; groups: readonly PermissionGroup[] }>(ENDPOINTS.rbacPermissions, {})
  return response.groups ?? []
}

/** `POST rbac/roles/list`：角色列表（含 surface，用于展示是否属于本面）。 */
export async function fetchRoles(): Promise<readonly RoleRecord[]> {
  const response = await postJson<{ ok: true; roles: readonly RoleRecord[] }>(ENDPOINTS.rbacRolesList, {})
  return response.roles ?? []
}

/**
 * 角色写操作第一步：预览差异。
 * 契约要求 `surface !== 'ai-admin'` 的角色不能授予给本管理台，前端不做拦截（服务端会拒），
 * 但提交时只传本面字段，避免把算力台的角色 id 混进来。
 */
export function preflightRole(draft: RoleDraft): Promise<ConfirmPreview> {
  const payload: Record<string, unknown> = { op: draft.op }
  if (draft.id !== undefined) payload.id = draft.id
  if (draft.name !== undefined) payload.name = draft.name
  if (draft.permissions !== undefined) payload.permissions = [...draft.permissions]
  if (draft.scopeDefault !== undefined) payload.scopeDefault = draft.scopeDefault
  if (draft.description !== undefined) payload.description = draft.description
  return preflight(ENDPOINTS.rbacRolesPreflight, payload)
}

/** 角色写操作第二步：带令牌与原因执行。 */
export function applyRole(token: string, reason: string): Promise<ApplyResult> {
  return apply(ENDPOINTS.rbacRolesApply, token, reason)
}

/** `POST rbac/admins/list`：管理员授权列表。 */
export async function fetchAdmins(): Promise<readonly AdminRecord[]> {
  const response = await postJson<{ ok: true; admins: readonly AdminRecord[] }>(ENDPOINTS.rbacAdminsList, {})
  return response.admins ?? []
}

/** 管理员授权第一步：预览差异。只发送本次操作实际需要的字段。 */
export function preflightAdmin(draft: AdminDraft): Promise<ConfirmPreview> {
  const payload: Record<string, unknown> = { op: draft.op, accountId: draft.accountId }
  if (draft.roleId !== undefined) payload.roleId = draft.roleId
  if (draft.scope !== undefined) payload.scope = draft.scope
  if (draft.displayName !== undefined) payload.displayName = draft.displayName
  return preflight(ENDPOINTS.rbacAdminsPreflight, payload)
}

/** 管理员授权第二步：带令牌与原因执行。 */
export function applyAdmin(token: string, reason: string): Promise<ApplyResult> {
  return apply(ENDPOINTS.rbacAdminsApply, token, reason)
}
