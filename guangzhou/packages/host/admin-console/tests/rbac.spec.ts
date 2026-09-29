/**
 * 权限模型的测试：**每条规则都要有一条对应的用例**。
 *
 * 用户要求"权限模型必须第一天就有，逐条可测"。这里的五条规则各自对应一组用例：
 * 1. 角色 → 菜单权限；
 * 2. 角色 → 接口权限（服务端强制）；
 * 3. 数据范围（all / self）；
 * 4. 高危操作标记（决定必须两步确认）；
 * 5. 与算力台权限彻底分离（两套角色表）。
 */
import { describe, expect, it } from 'vitest'
import {
  BUILTIN_ROLES,
  COMPUTE_SURFACE,
  MENU,
  PERMISSIONS,
  SURFACE,
  can,
  findRole,
  isHighRisk,
  isKnownPermission,
  menuFor,
  permissionGroups,
  roleGrantable,
  scopeOf,
  validatePermissions,
  validateRoleInput,
  type AdminRecord,
  type RoleRecord,
} from '../src/rbac.ts'

/** 造一个自定义角色。 */
function customRole(permissions: readonly string[], scopeDefault: 'all' | 'self' = 'all'): RoleRecord {
  return {
    id: 'custom-1',
    name: '自定义角色',
    kind: 'custom',
    surface: SURFACE,
    description: '',
    permissions,
    scopeDefault,
  }
}

/** 造一条管理员记录。 */
function adminRecord(roleId: string, scope: 'all' | 'self'): AdminRecord {
  return { accountId: '167', displayName: '张三', roleId, scope, enabled: true, createdAt: 0, createdBy: 'test' }
}

describe('规则 1：角色 → 菜单权限', () => {
  it('超级管理员能看到全部菜单', () => {
    const role = findRole([], 'super-admin') as RoleRecord
    expect(menuFor(role)).toHaveLength(MENU.length)
  })

  it('审计员看不到账号与额度、订阅、市场等运营菜单', () => {
    const role = findRole([], 'auditor') as RoleRecord
    const keys = menuFor(role).map(item => item.key)
    expect(keys).toContain('audit')
    expect(keys).toContain('rbac')
    expect(keys).toContain('whitelist')
    expect(keys).not.toContain('account')
    expect(keys).not.toContain('subscription')
    expect(keys).not.toContain('market')
  })

  it('总览这类无需权限的菜单对任何角色都在（否则登录后是空白页）', () => {
    const role = customRole(['audit.read'])
    expect(menuFor(role).map(item => item.key)).toEqual(['overview', 'audit'])
  })

  it('菜单里的 perm 必须是目录里真实存在的权限键（防止菜单与权限表漂移）', () => {
    for (const item of MENU) {
      if (item.perm === null) continue
      expect(isKnownPermission(item.perm), `${item.key} 引用了不存在的权限 ${item.perm}`).toBe(true)
    }
  })

  /**
   * 反方向的漂移：**加了权限点却忘了加菜单**。
   *
   * 这个坑是实打实踩到的：上游密钥的接口、权限键、前端页面全都建好了，
   * 唯独漏了 `MENU` —— 于是 super-admin 明明有 `credential.read`，
   * 侧栏却不显示入口，**整个功能在界面上不存在**，而接口测试全绿。
   * 类型检查也抓不到（`MENU` 只是个数组字面量）。
   */
  it('每个模块都有菜单入口（否则功能在界面上不可达）', () => {
    const menuPerms = new Set(MENU.map(item => item.perm).filter((perm): perm is string => perm !== null))
    const modulesWithMenu = new Set(
      PERMISSIONS.filter(permission => menuPerms.has(permission.key)).map(permission => permission.module),
    )
    const orphans = [...new Set(PERMISSIONS.map(permission => permission.module))]
      .filter(module_ => !modulesWithMenu.has(module_))
    expect(orphans, `这些模块有权限点但没有菜单入口：${orphans.join(', ')}`).toEqual([])
  })

  it('上游密钥有菜单入口，且挂在「安全」组下', () => {
    const item = MENU.find(entry => entry.key === 'credential')
    expect(item).toBeDefined()
    expect(item?.perm).toBe('credential.read')
    expect(item?.group).toBe('安全')
  })

  it('模型路由有菜单入口，且挂在「运营」组下', () => {
    const item = MENU.find(entry => entry.key === 'models')
    expect(item).toBeDefined()
    expect(item?.perm).toBe('models.read')
    expect(item?.group).toBe('运营')
  })
})

describe('规则 2：角色 → 接口权限（服务端判定）', () => {
  it('拥有权限才通过，否则拒绝', () => {
    const role = customRole(['account.read'])
    expect(can(role, 'account.read')).toBe(true)
    expect(can(role, 'account.charge.adjust')).toBe(false)
    expect(can(role, 'rbac.manage')).toBe(false)
  })

  it('客服不能用权限管理、退款、白名单这些权限', () => {
    const role = findRole([], 'support') as RoleRecord
    for (const permission of ['rbac.manage', 'order.refund', 'whitelist.manage', 'subscription.manage', 'flags.manage']) {
      expect(can(role, permission), `客服不应有 ${permission}`).toBe(false)
    }
  })

  it('财务有退款与额度调整，但没有权限管理与白名单', () => {
    const role = findRole([], 'finance') as RoleRecord
    expect(can(role, 'order.refund')).toBe(true)
    expect(can(role, 'account.charge.adjust')).toBe(true)
    expect(can(role, 'rbac.manage')).toBe(false)
    expect(can(role, 'whitelist.manage')).toBe(false)
  })

  it('未知权限键一律不生效（fail-closed）', () => {
    const role = customRole(['account.read', '不存在的权限'])
    expect(can(role, '不存在的权限')).toBe(false)
    expect(validatePermissions(['不存在的权限'])).not.toBeNull()
    expect(validatePermissions(['account.read'])).toBeNull()
  })
})

describe('规则 3：数据范围', () => {
  it('管理员记录上的 scope 覆盖角色默认值', () => {
    const role = findRole([], 'support') as RoleRecord
    expect(role.scopeDefault).toBe('self')
    expect(scopeOf(adminRecord('support', 'all'), role)).toBe('all')
    expect(scopeOf(adminRecord('support', 'self'), role)).toBe('self')
  })

  it('角色的默认范围参与计算（记录里没覆盖时）', () => {
    const role = customRole(['audit.read'], 'self')
    const record = { ...adminRecord('custom-1', 'all') }
    // 记录里显式写了 all，就以记录为准。
    expect(scopeOf(record, role)).toBe('all')
  })
})

describe('规则 4：高危操作标记', () => {
  it('钱与权限相关的操作都标成高危（必须两步确认）', () => {
    for (const key of ['account.charge.adjust', 'subscription.manage', 'order.refund', 'rbac.manage', 'whitelist.manage', 'flags.manage', 'market.pricing.manage', 'discovery.publish']) {
      expect(isHighRisk(key), `${key} 应当是高危`).toBe(true)
    }
  })

  it('只读权限不是高危', () => {
    for (const key of ['account.read', 'audit.read', 'rbac.read', 'whitelist.read']) {
      expect(isHighRisk(key), `${key} 不该是高危`).toBe(false)
    }
  })

  it('**未知权限键按高危处理**（不认识的动作用户必须当面确认）', () => {
    expect(isHighRisk('不存在的权限')).toBe(true)
  })

  it('目录里每个高危权限都有说明（前端要展示"为什么危险"）', () => {
    for (const permission of PERMISSIONS) {
      expect(permission.description.length, `${permission.key} 缺少说明`).toBeGreaterThan(0)
      expect(permission.title.length).toBeGreaterThan(0)
    }
  })
})

describe('规则 5：与算力台权限彻底分离（两套角色表）', () => {
  it('算力台面（compute）的角色不能授予到本管理台', () => {
    const computeRole = { ...customRole(['account.read']), id: 'eco-ops', surface: COMPUTE_SURFACE as unknown as typeof SURFACE }
    const problem = roleGrantable(computeRole)
    expect(problem).not.toBeNull()
    expect(problem).toContain('compute')
  })

  it('本面的内置角色可以授予', () => {
    for (const role of BUILTIN_ROLES) {
      expect(roleGrantable(role), `${role.id} 应当可授予`).toBeNull()
      expect(role.surface).toBe(SURFACE)
    }
  })

  it('不存在的角色不能授予', () => {
    expect(roleGrantable(undefined)).not.toBeNull()
  })

  it('内置角色的面都标成 ai-admin（不是靠约定，而是数据）', () => {
    expect(BUILTIN_ROLES.every(role => role.surface === SURFACE)).toBe(true)
  })
})

describe('角色输入校验', () => {
  it('内置角色的权限不可改', () => {
    expect(validateRoleInput({ id: 'super-admin', name: '超级管理员', permissions: ['account.read'] })).not.toBeNull()
  })

  it('id 形状与权限非空都校验', () => {
    expect(validateRoleInput({ id: 'Bad_Id', name: 'x', permissions: ['account.read'] })).not.toBeNull()
    expect(validateRoleInput({ id: 'ok-role', name: '', permissions: ['account.read'] })).not.toBeNull()
    expect(validateRoleInput({ id: 'ok-role', name: '角色', permissions: [] })).not.toBeNull()
    expect(validateRoleInput({ id: 'ok-role', name: '角色', permissions: ['account.read'] })).toBeNull()
  })
})

describe('权限目录自身的完整性', () => {
  it('权限键唯一', () => {
    const keys = PERMISSIONS.map(permission => permission.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('分组覆盖全部权限，且每个模块都有标题', () => {
    const groups = permissionGroups()
    const total = groups.reduce((sum, group) => sum + group.items.length, 0)
    expect(total).toBe(PERMISSIONS.length)
    expect(groups.every(group => group.title.length > 0)).toBe(true)
  })

  it('六个业务模块都被目录覆盖（"首版要全的"在权限层面的落点）', () => {
    const modules = new Set(PERMISSIONS.map(permission => permission.module))
    for (const module of ['account', 'subscription', 'market', 'discovery', 'order', 'rbac', 'audit', 'whitelist', 'flags', 'models']) {
      expect(modules.has(module), `缺少模块 ${module} 的权限点`).toBe(true)
    }
  })
})
