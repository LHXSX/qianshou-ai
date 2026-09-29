/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

interface ImportMetaEnv {
  /** 后端 API 基础地址，例：http://localhost:8000/api/v8 */
  readonly VITE_API_BASE_URL?: string
  /** WebSocket 基础地址（如启用 WS 推送） */
  readonly VITE_WS_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
