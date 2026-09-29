/**
 * 插件入口：宿主加载的是这一份，而不是库入口。
 *
 * 分开的理由与 `index.ts` 的定位一致——`index.ts` 是**库**（谁都能 import 来建会话），
 * `plugin-entry.ts` 是**插件**（由 profiles 按名字加载，自带 cordis 身份与路由副作用）。
 * 把两者混在一个入口会让「只是想建个会话」的调用方也顺手挂上一组 HTTP 路由。
 */
export { apply, inject, name, type Config } from './plugin.ts'
