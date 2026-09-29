/**
 * Node 半边：本插件只贡献浏览器界面（设置页里的模型路由控制台），
 * 宿主侧的路由与数据面已经由 `packages/host/model-gateway` 提供，
 * 所以这里是一个空插件体，不 import 任何浏览器代码。
 */

/** 宿主侧插件体：客户端界面之外没有要装配的东西。 */
export function apply(): void {}
