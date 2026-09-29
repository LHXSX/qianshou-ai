/// <reference types="vite/client" />

/**
 * Vite 在构建时注入的环境变量类型（只声明本工程实际读取的键）。
 * `QIANSHOU_ADMIN_DEV_MOCK` 只在开发期由 `vite.config.ts` 读取，
 * 用于挂载 `mock/server.ts`；生产构建不包含 mock 代码。
 */
interface ImportMetaEnv {
  readonly QIANSHOU_ADMIN_DEV_MOCK?: string
  readonly QIANSHOU_ADMIN_API_TARGET?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}
