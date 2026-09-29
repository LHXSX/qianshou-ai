/**
 * Node 半边：本插件只贡献浏览器界面。
 *
 * 额度与账号的**数据面**已经由 `packages/host/model-gateway`
 * （`/api/qianshou/ai/status`）与 `packages/host/account-session`
 * （`/api/qianshou/account/state`）提供，所以这里是一个空插件体，
 * 不 import 任何浏览器代码——否则宿主侧会为了一个界面引入 DOM 依赖。
 */

/** 宿主侧插件体：客户端界面之外没有要装配的东西。 */
export function apply(): void {}
