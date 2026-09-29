/**
 * 设置小节的适配器：把这一页从"主面板"改成"设置里的一节"。
 *
 * 为什么需要这一层：页面组件声明的是 `PropsRuntime<'main'>`
 * （主面板座位），而设置小节给的是 `PropsRuntime<'settings.section'>`
 * （只多一个 `close`）。两者的**通用座位部分完全一致**，页面也只读 `t` 与注入面，
 * 所以这里把 settings 的 props 原样透传给页面即可——不需要复制页面、也不需要改它的签名。
 *
 * 不直接把页面注册进 `settings.section` 是为了让"这一页能在两个座位里渲染"
 * 这件事**显式**：将来若某一页真的需要 `close`（例如"保存并关闭"），
 * 改动就落在这一行，而不是散在页面内部。
 */
import { createElement } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { DevicesPage } from './DevicesPage.tsx'
import type { DevicesFace } from './DevicesPage.tsx'

/** 设置小节的座位 props：比主面板多一个 `close`。 */
export type DevicesSettingsProps = PropsRuntime<'settings.section'>

/** 在设置面板里渲染这一页。 */
export function SettingsSectionAdapter(props: DevicesSettingsProps & { readonly face: DevicesFace }) {
  return createElement(DevicesPage, { ...props, ...props.face } as never)
}
