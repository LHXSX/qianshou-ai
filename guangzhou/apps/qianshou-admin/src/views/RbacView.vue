<script setup lang="ts">
/**
 * 权限管理（契约 §4 + §9）。
 *
 * 三个区块：角色矩阵（按 `rbac/permissions` 目录勾选）、管理员授权、权限目录。
 * 所有写操作（角色 create/update/delete、管理员 grant/update/revoke）都走两步确认弹窗：
 * `…/preflight` 展示 before → after，填原因后 `…/apply`。
 *
 * 前端不做权限判断：
 * - 内置角色（kind=builtin）的权限不允许改，这一点用服务端数据（kind）标注并禁用勾选，
 *   最终仍由服务端拒绝；
 * - 管理员列表里的 `surface` 直接展示，非 `ai-admin` 的角色不会出现勾选来源里。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { CheckboxValueType } from 'element-plus'
import {
  applyAdmin,
  applyRole,
  fetchAdmins,
  fetchPermissionGroups,
  fetchRoles,
  preflightAdmin,
  preflightRole,
} from '@/api/modules/rbac'
import { useAsyncData } from '@/utils/async-state'
import { formatTime } from '@/utils/format'
import type { AdminRecord, ConfirmPreview, PermissionGroup, RoleRecord } from '@/api/types'
import ErrorAlert from '@/components/ErrorAlert.vue'
import ConfirmApplyDialog from '@/components/ConfirmApplyDialog.vue'

const tab = ref<'roles' | 'admins' | 'catalog'>('roles')

const permissionsState = useAsyncData<readonly PermissionGroup[]>(fetchPermissionGroups)
const rolesState = useAsyncData<readonly RoleRecord[]>(fetchRoles)
const adminsState = useAsyncData<readonly AdminRecord[]>(fetchAdmins)

onMounted(() => {
  void permissionsState.run()
  void rolesState.run()
  void adminsState.run()
})

const groups = computed<readonly PermissionGroup[]>(() => permissionsState.data.value ?? [])
const roles = computed<readonly RoleRecord[]>(() => rolesState.data.value ?? [])
const admins = computed<readonly AdminRecord[]>(() => adminsState.data.value ?? [])
const highRiskKeys = computed(() => {
  const keys = new Set<string>()
  for (const group of groups.value) {
    for (const item of group.items) {
      if (item.highRisk) keys.add(item.key)
    }
  }
  return keys
})

// —— 角色编辑 ——————————————————————————————————————————————

const roleDrawerOpen = ref(false)
const roleOp = ref<'create' | 'update'>('create')
const roleId = ref('')
const roleName = ref('')
const roleDescription = ref('')
const roleScope = ref<'all' | 'self'>('all')
const rolePermissions = ref<string[]>([])
const roleIsBuiltin = ref(false)

function openCreateRole(): void {
  roleOp.value = 'create'
  roleId.value = ''
  roleName.value = ''
  roleDescription.value = ''
  roleScope.value = 'all'
  rolePermissions.value = []
  roleIsBuiltin.value = false
  roleDrawerOpen.value = true
}

function openEditRole(role: RoleRecord): void {
  roleOp.value = 'update'
  roleId.value = role.id
  roleName.value = role.name
  roleDescription.value = role.description
  roleScope.value = role.scopeDefault
  rolePermissions.value = [...role.permissions]
  roleIsBuiltin.value = role.kind === 'builtin'
  roleDrawerOpen.value = true
}

function togglePermission(key: string, checked: boolean): void {
  const next = new Set(rolePermissions.value)
  if (checked) next.add(key)
  else next.delete(key)
  rolePermissions.value = [...next]
}

const roleDraftValid = computed(() => {
  if (roleOp.value === 'create' && roleName.value.trim() === '') return false
  if (rolePermissions.value.length === 0 && roleOp.value === 'create') return false
  return true
})

// —— 两步确认弹窗状态 ——————————————————————————————————————

const roleDialogOpen = ref(false)
const roleDialogTitle = ref('')
const roleDialogDescription = ref('')
const pendingRoleDraft = ref<Parameters<typeof preflightRole>[0] | undefined>(undefined)

// 授权抽屉（填参数）与两步确认弹窗（预览 → 原因 → 执行）是两个界面状态，必须分开。
const adminDrawerOpen = ref(false)
const adminConfirmOpen = ref(false)
/** 确认弹窗是「执行成功关闭」还是「取消关闭」，决定是否把抽屉还给管理员继续编辑。 */
const adminApplied = ref(false)
const adminDialogTitle = ref('')
const adminDialogDescription = ref('')
const pendingAdminDraft = ref<Parameters<typeof preflightAdmin>[0] | undefined>(undefined)

function submitRole(): void {
  if (!roleDraftValid.value) {
    ElMessage.warning('请填写角色名称并至少勾选一个权限')
    return
  }
  pendingRoleDraft.value = {
    op: roleOp.value,
    // create 时 id 允许留空（由服务端生成）；填了就让服务端校验唯一性。
    id: roleId.value.trim(),
    name: roleName.value.trim(),
    permissions: [...rolePermissions.value],
    scopeDefault: roleScope.value,
    description: roleDescription.value.trim(),
  }
  roleDialogTitle.value = roleOp.value === 'create' ? '创建自定义角色（两步确认）' : `修改角色 ${roleId.value}（两步确认）`
  roleDialogDescription.value =
    '服务端会把该角色的权限与数据范围改动整理成 before → after 供你核对；确认后写入审计日志。'
  roleDialogOpen.value = true
}

function requestRoleDelete(role: RoleRecord): void {
  pendingRoleDraft.value = { op: 'delete', id: role.id }
  roleDialogTitle.value = `删除角色 ${role.name}（两步确认）`
  roleDialogDescription.value = '删除前服务端会返回该角色当前的权限矩阵与成员数，确认后不可撤销。'
  roleDialogOpen.value = true
}

const rolePreview = (): Promise<ConfirmPreview> =>
  pendingRoleDraft.value === undefined
    ? Promise.reject(new Error('缺少角色草稿，请重新打开编辑界面'))
    : preflightRole(pendingRoleDraft.value)

async function refreshAfterRoleApply(): Promise<void> {
  await Promise.all([rolesState.run(), adminsState.run()])
}

// —— 管理员授权 ——————————————————————————————————————————————

const adminDialogMode = ref<'grant' | 'update' | 'revoke'>('grant')
const draftAccountId = ref('')
const draftRoleId = ref('')
const draftScope = ref<'all' | 'self'>('all')
const draftDisplayName = ref('')

const roleOptions = computed(() =>
  roles.value.map((role) => ({ value: role.id, label: `${role.name}（${role.id}）`, surface: role.surface })),
)

/** 只允许选择本面（ai-admin）的角色作为授予来源，其余在界面上明确标注为不可选。 */
const aiAdminRoles = computed(() => roleOptions.value.filter((option) => option.surface === 'ai-admin'))
const foreignRoles = computed(() => roleOptions.value.filter((option) => option.surface !== 'ai-admin'))

function openGrantAdmin(): void {
  adminDialogMode.value = 'grant'
  draftAccountId.value = ''
  draftRoleId.value = aiAdminRoles.value[0]?.value ?? ''
  draftScope.value = 'all'
  draftDisplayName.value = ''
  adminDialogTitle.value = '授予管理台管理员（两步确认）'
  adminDialogDescription.value =
    'accountId 与手机端/电脑端是同一套账号体系。服务端会拒绝任何 surface 不是 ai-admin 的角色。'
  pendingAdminDraft.value = undefined
  adminDrawerOpen.value = true
}

function openUpdateAdmin(admin: AdminRecord): void {
  adminDialogMode.value = 'update'
  draftAccountId.value = admin.accountId
  draftRoleId.value = admin.roleId
  draftScope.value = admin.scope
  draftDisplayName.value = admin.displayName
  adminDialogTitle.value = `调整管理员 ${admin.accountId}（两步确认）`
  adminDialogDescription.value = '可修改角色、数据范围与显示名；停用账号请在账号服务侧处理。'
  pendingAdminDraft.value = undefined
  adminDrawerOpen.value = true
}

function openRevokeAdmin(admin: AdminRecord): void {
  adminDialogMode.value = 'revoke'
  draftAccountId.value = admin.accountId
  draftRoleId.value = admin.roleId
  draftScope.value = admin.scope
  draftDisplayName.value = admin.displayName
  adminDialogTitle.value = `吊销管理员 ${admin.accountId}（两步确认）`
  adminDialogDescription.value = '吊销后该账号立即失去管理台权限；已签发的会话由服务端处理。'
  pendingAdminDraft.value = undefined
  adminDrawerOpen.value = true
}

function submitAdminDraft(): void {
  if (draftAccountId.value.trim() === '') {
    ElMessage.warning('请填写 accountId')
    return
  }
  const draft: Parameters<typeof preflightAdmin>[0] = {
    op: adminDialogMode.value,
    accountId: draftAccountId.value.trim(),
    ...(adminDialogMode.value === 'revoke'
      ? {}
      : { roleId: draftRoleId.value, scope: draftScope.value, displayName: draftDisplayName.value.trim() }),
  }
  pendingAdminDraft.value = draft
  // 草稿定稿后才进入第一步预览，避免一打开界面就打写接口。
  adminApplied.value = false
  adminDrawerOpen.value = false
  adminConfirmOpen.value = true
}

const adminPreview = (): Promise<ConfirmPreview> =>
  pendingAdminDraft.value === undefined
    ? Promise.reject(new Error('缺少授权草稿，请重新打开授权界面'))
    : preflightAdmin(pendingAdminDraft.value)

async function refreshAfterAdminApply(): Promise<void> {
  await adminsState.run()
}

function handleAdminApplied(): void {
  adminApplied.value = true
  void refreshAfterAdminApply()
}

/** 取消关闭时把抽屉还给管理员，避免辛苦填的参数被吞掉。 */
function handleAdminConfirmClosed(): void {
  if (adminApplied.value) {
    adminApplied.value = false
    return
  }
  adminDrawerOpen.value = true
}

// —— 权限目录 ——————————————————————————————————————————————

async function confirmAndRevoke(admin: AdminRecord): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认吊销 ${admin.displayName || admin.accountId} 的管理台权限？`, '吊销管理员', {
      confirmButtonText: '继续',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return
  }
  openRevokeAdmin(admin)
}
</script>

<template>
  <div class="qs-page">
    <div class="qs-page__head">
      <div>
        <h2 class="qs-page__title">权限管理</h2>
        <p class="qs-page__desc">
          角色与权限、管理员授权都来自服务端。所有写操作走两步确认（预览差异 → 填原因执行），
          前端只负责呈现，权限判定始终在服务端。
        </p>
      </div>
      <div class="actions">
        <el-button :loading="rolesState.loading.value || adminsState.loading.value"
          @click="() => { void rolesState.run(); void adminsState.run() }">刷新</el-button>
        <el-button type="primary" @click="openCreateRole">新建自定义角色</el-button>
      </div>
    </div>

    <ErrorAlert v-if="permissionsState.error.value" :error="permissionsState.error.value" />
    <ErrorAlert v-if="rolesState.error.value" :error="rolesState.error.value" />
    <ErrorAlert v-if="adminsState.error.value" :error="adminsState.error.value" />

    <el-tabs v-model="tab">
      <el-tab-pane label="角色" name="roles">
        <el-table :data="[...roles]" border size="small">
          <el-table-column label="角色" min-width="200">
            <template #default="{ row }">
              <div class="role-name">{{ row.name }}</div>
              <div class="qs-mono role-id">{{ row.id }}</div>
            </template>
          </el-table-column>
          <el-table-column label="类型" width="110">
            <template #default="{ row }">
              <el-tag :type="row.kind === 'builtin' ? 'info' : 'primary'" size="small">
                {{ row.kind === 'builtin' ? '内置（权限不可改）' : '自定义' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="surface" width="120">
            <template #default="{ row }">
              <el-tag :type="row.surface === 'ai-admin' ? 'success' : 'danger'" size="small" effect="plain">
                {{ row.surface }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="默认数据范围" width="130">
            <template #default="{ row }">{{ row.scopeDefault === 'all' ? 'all（全部）' : 'self（仅自己）' }}</template>
          </el-table-column>
          <el-table-column label="权限数" width="90" align="right">
            <template #default="{ row }">{{ row.permissions.length }}</template>
          </el-table-column>
          <el-table-column label="成员数" width="90" align="right">
            <template #default="{ row }">{{ row.memberCount }}</template>
          </el-table-column>
          <el-table-column label="说明" min-width="200">
            <template #default="{ row }">{{ row.description || '—' }}</template>
          </el-table-column>
          <el-table-column label="操作" width="150" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="openEditRole(row)">查看 / 编辑</el-button>
              <el-button v-if="row.kind === 'custom'" link type="danger" @click="requestRoleDelete(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="roles.length === 0 && !rolesState.loading.value" description="服务端未返回角色" />
      </el-tab-pane>

      <el-tab-pane label="管理员授权" name="admins">
        <div class="qs-toolbar">
          <el-button type="primary" @click="openGrantAdmin">授予管理员</el-button>
          <span class="qs-empty-hint">scope 由服务端在查询时裁剪数据，前端拿到的就是裁剪后的结果。</span>
        </div>
        <el-table :data="[...admins]" border size="small">
          <el-table-column label="accountId" min-width="120">
            <template #default="{ row }">
              <span class="qs-mono">{{ row.accountId }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="displayName" label="显示名" min-width="140" />
          <el-table-column label="角色" min-width="160">
            <template #default="{ row }">
              <span>{{ row.roleId }}</span>
            </template>
          </el-table-column>
          <el-table-column label="数据范围" width="130">
            <template #default="{ row }">{{ row.scope === 'all' ? 'all（全部）' : 'self（仅自己）' }}</template>
          </el-table-column>
          <el-table-column label="启用" width="90">
            <template #default="{ row }">
              <el-tag :type="row.enabled ? 'success' : 'danger'" size="small">{{ row.enabled ? '启用' : '停用' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="创建时间" min-width="170">
            <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column label="创建人" min-width="110">
            <template #default="{ row }">
              <span class="qs-mono">{{ row.createdBy }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="150" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="openUpdateAdmin(row)">调整</el-button>
              <el-button link type="danger" @click="confirmAndRevoke(row)">吊销</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="admins.length === 0 && !adminsState.loading.value" description="服务端未返回管理员记录" />
      </el-tab-pane>

      <el-tab-pane label="权限目录" name="catalog">
        <el-alert v-if="groups.length === 0" type="info" :closable="false" show-icon
          title="权限目录不可用（可能缺少 rbac.read 权限）" />
        <el-collapse v-else>
          <el-collapse-item v-for="group in groups" :key="group.module"
            :title="`${group.title}（${group.module} · ${group.items.length} 项）`">
            <el-table :data="[...group.items]" size="small" border>
              <el-table-column label="权限键" min-width="220">
                <template #default="{ row }">
                  <span class="qs-mono">{{ row.key }}</span>
                </template>
              </el-table-column>
              <el-table-column prop="title" label="名称" min-width="140" />
              <el-table-column label="高危" width="100">
                <template #default="{ row }">
                  <el-tag v-if="row.highRisk" type="danger" size="small">需两步确认</el-tag>
                  <span v-else class="qs-empty-hint">否</span>
                </template>
              </el-table-column>
              <el-table-column prop="description" label="说明" min-width="240" />
            </el-table>
          </el-collapse-item>
        </el-collapse>
      </el-tab-pane>
    </el-tabs>

    <!-- 角色编辑抽屉：勾选权限矩阵 -->
    <el-drawer v-model="roleDrawerOpen" :title="roleOp === 'create' ? '新建自定义角色' : `角色 ${roleId}`" size="720px">
      <el-alert v-if="roleIsBuiltin" class="qs-card" type="warning" :closable="false" show-icon
        title="内置角色的权限不可修改"
        description="契约 §4.3：内置角色的权限由服务端固定。这里可以查看，但提交修改会被服务端拒绝。" />

      <el-form label-position="top">
        <el-form-item v-if="roleOp === 'create'" label="角色 id（服务端校验唯一性）">
          <el-input v-model="roleId" placeholder="留空由服务端生成" />
        </el-form-item>
        <el-form-item label="角色名称">
          <el-input v-model="roleName" :disabled="roleIsBuiltin" placeholder="例如：市场审核员" />
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="roleDescription" type="textarea" :rows="2" :disabled="roleIsBuiltin" />
        </el-form-item>
        <el-form-item label="默认数据范围">
          <el-radio-group v-model="roleScope" :disabled="roleIsBuiltin">
            <el-radio value="all">all（看全部）</el-radio>
            <el-radio value="self">self（只看自己经办）</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="权限矩阵（按契约目录勾选）">
          <div class="matrix">
            <div v-for="group in groups" :key="group.module" class="matrix__group">
              <div class="matrix__title">{{ group.title }} <span class="qs-mono">{{ group.module }}</span></div>
              <el-checkbox v-for="item in group.items" :key="item.key"
                :model-value="rolePermissions.includes(item.key)" :disabled="roleIsBuiltin"
                @change="(value: CheckboxValueType) => togglePermission(item.key, value === true)">
                <span class="qs-mono">{{ item.key }}</span>
                <span class="matrix__label">{{ item.title }}</span>
                <el-tag v-if="item.highRisk" type="danger" size="small" effect="plain">高危</el-tag>
              </el-checkbox>
            </div>
            <el-empty v-if="groups.length === 0" description="权限目录不可用，无法勾选" :image-size="72" />
          </div>
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="roleDrawerOpen = false">取消</el-button>
        <el-button type="primary" :disabled="roleIsBuiltin" @click="submitRole">
          {{ roleOp === 'create' ? '预览创建' : '预览修改' }}
        </el-button>
      </template>
    </el-drawer>

    <!-- 管理员授予 / 调整抽屉 -->
    <el-drawer v-model="adminDrawerOpen" :title="adminDialogTitle" size="520px">
      <el-form label-position="top">
        <el-form-item label="accountId（与客户端同一套账号）">
          <el-input v-model="draftAccountId" :disabled="adminDialogMode !== 'grant'" placeholder="例如 167" />
        </el-form-item>
        <el-form-item label="显示名（可选）">
          <el-input v-model="draftDisplayName" :disabled="adminDialogMode === 'revoke'" />
        </el-form-item>
        <el-form-item label="角色（只列 surface=ai-admin）">
          <el-select v-model="draftRoleId" :disabled="adminDialogMode === 'revoke'" class="full">
            <el-option v-for="option in aiAdminRoles" :key="option.value" :value="option.value" :label="option.label" />
          </el-select>
          <div v-if="foreignRoles.length > 0" class="foreign">
            另有 {{ foreignRoles.length }} 个非本面角色（算力运营台）不可选，服务端也会拒绝：
            <el-tag v-for="option in foreignRoles" :key="option.value" size="small" type="info" effect="plain">
              {{ option.value }} · {{ option.surface }}
            </el-tag>
          </div>
        </el-form-item>
        <el-form-item label="数据范围">
          <el-radio-group v-model="draftScope" :disabled="adminDialogMode === 'revoke'">
            <el-radio value="all">all（看全部）</el-radio>
            <el-radio value="self">self（只看自己经办）</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="adminDrawerOpen = false">取消</el-button>
        <el-button type="primary" @click="submitAdminDraft">下一步：预览差异</el-button>
      </template>
    </el-drawer>

    <!-- 管理员授权：两步确认（预览 → 原因 → 执行） -->
    <ConfirmApplyDialog v-model="adminConfirmOpen" :title="adminDialogTitle" :description="adminDialogDescription"
      :preflight-request="adminPreview" :apply-request="applyAdmin" confirm-button-text="确认执行"
      @applied="handleAdminApplied" @closed="handleAdminConfirmClosed" />

    <!-- 角色写操作：两步确认 -->
    <ConfirmApplyDialog v-model="roleDialogOpen" :title="roleDialogTitle" :description="roleDialogDescription"
      :preflight-request="rolePreview" :apply-request="applyRole" confirm-button-text="确认执行"
      @applied="refreshAfterRoleApply" />
  </div>
</template>

<style scoped>
.role-name {
  font-weight: 600;
}

.role-id {
  color: #909399;
}

.matrix {
  width: 100%;
}

.matrix__group {
  padding: 10px 0;
  border-bottom: 1px dashed #ebeef5;
}

.matrix__group:last-child {
  border-bottom: none;
}

.matrix__title {
  margin-bottom: 8px;
  font-weight: 600;
}

.matrix__label {
  margin: 0 8px 0 6px;
  color: #606266;
}

.full {
  width: 100%;
}

.foreign {
  margin-top: 8px;
  color: #909399;
  font-size: 12px;
  line-height: 1.8;
}

.actions {
  display: flex;
  gap: 8px;
}
</style>
