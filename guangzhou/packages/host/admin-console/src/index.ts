/**
 * 宿主侧入口：让这个包能被仓库的宿主构建识别。
 *
 * 这个包是一个**独立服务**，不是服务其它包的插件：它有自己的 systemd 单元
 * （`qianshou-admin-console`）、自己的数据目录与 web 根，并且**不从 profile 加载**，
 * 目的正是「工作台挂了它仍然能登录、能查审计」（见 `server.ts` 的说明）。
 * 因此它没有天然的「给别人 import」的入口。
 *
 * 但仓库的宿主构建按约定要求**每个包**都有 `lib/types/index.js` 这一项入口
 * （根 `tsdown.config.ts` 的 `entry: lib/types/{index,invariant,startup}.js`）。
 * 缺少它会让**整个宿主构建**在见到这个包时失败——其它包也因此无法构建与上线。
 * 这个文件就是那一项：它只做**转出**，不新造任何行为。
 *
 * 为什么导出 `server.ts` 而不是空文件：
 * 1. `server.ts` 是这块功能真正的装配层（`createAdminService`、`API_PREFIX`、
 *    `SESSION_COOKIE` 等），转出它才让入口有意义；
 * 2. 空入口虽然也能让构建通过，但下一个想复用这里的读写的人会以为"这个包什么都不提供"。
 *
 * 独立服务的启动路径**不受影响**：`pnpm start` 跑的仍是 `node src/main.ts serve`，
 * 与这个入口无关。
 */
export {
  API_PREFIX,
  SERVICE_VERSION,
  SESSION_COOKIE,
  createAdminService,
  peekJson,
} from './server.ts'
