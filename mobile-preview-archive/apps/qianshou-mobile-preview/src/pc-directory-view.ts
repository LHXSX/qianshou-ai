/** Present account-owned PCs without confusing heartbeat presence with remote authorization. */
import type { AccountPc } from './window/mobile-workspace-types.ts'

/** Keep online PCs first; use a stable display order within each group. */
export function orderedPcs(pcs: readonly AccountPc[]): AccountPc[] {
  return [...pcs].sort((a, b) => Number(b.online) - Number(a.online)
    || a.label.localeCompare(b.label, 'zh-CN') || a.pcId.localeCompare(b.pcId))
}

/** Decorate existing actionable rows, retaining the controller's authorization and click handler. */
export function decoratePcDirectory(root: HTMLElement, pcs: readonly AccountPc[], ready: boolean): void {
  const rows = new Map([...root.querySelectorAll<HTMLButtonElement>('button[data-testid]')]
    .map(row => [row.dataset.testid, row]))
  for (const pc of orderedPcs(pcs)) {
    const row = rows.get(`mobile-pc-${pc.pcId}`)
    if (!row) continue
    const online = ready && pc.online
    const status = ready ? online ? '在线' : '离线' : '状态待确认'
    row.classList.add('pc-device-row')
    row.disabled = !online
    row.setAttribute('aria-label', `${pc.label}，${pc.platform === 'windows' ? 'Windows' : 'Mac'}，${status}`)
    const icon = document.createElement('span')
    icon.className = 'pc-device-icon'
    icon.setAttribute('aria-hidden', 'true')
    const info = document.createElement('span')
    info.className = 'pc-device-info'
    const name = document.createElement('strong')
    name.textContent = pc.label
    const detail = document.createElement('small')
    detail.textContent = pc.platform === 'windows' ? 'Windows' : 'Mac'
    info.append(name, detail)
    const presence = document.createElement('span')
    presence.className = `pc-device-presence${online ? ' is-online' : ''}`
    const dot = document.createElement('i')
    dot.setAttribute('aria-hidden', 'true')
    presence.append(dot, status)
    row.replaceChildren(icon, info, presence)
    root.append(row)
  }
}
