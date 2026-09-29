import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createAdminDevMock } from './mock/server'

/**
 * 生产挂在 `https://admin.qianshousuanli.com` 的**域名根路径**，
 * 所以资源 base 固定为 `/`；同时 SPA 路由使用 HTML5 history（非 hash）。
 */
const PRODUCTION_BASE = '/'

/** 管理台接口前缀，与 packages/host/admin-console/API.md §1 一致。 */
const ADMIN_API_PREFIX = '/api/qianshou/ai/admin'

/** 默认后端地址：admin-console 的 systemd 服务端口（API.md §7 逃生路径示例里的 7090）。 */
const DEFAULT_BACKEND_TARGET = 'http://127.0.0.1:7090'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const useDevMock = env.QIANSHOU_ADMIN_DEV_MOCK === '1'
  const backendTarget = env.QIANSHOU_ADMIN_API_TARGET || DEFAULT_BACKEND_TARGET

  return {
    base: PRODUCTION_BASE,
    plugins: [
      vue(),
      // 仅开发期生效：显式设 QIANSHOU_ADMIN_DEV_MOCK=1 才挂载。
      // 该插件位于 mock/ 且被本开关包裹，`vite build` 的产物里不含任何 mock 代码。
      ...(useDevMock ? [createAdminDevMock()] : []),
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      port: 4175,
      strictPort: true,
      proxy: useDevMock
        ? undefined
        : {
            // 开发期同源：浏览器请求 /api/... 由这里转发到本机 admin-console。
            [ADMIN_API_PREFIX]: {
              target: backendTarget,
              changeOrigin: false,
              secure: false,
            },
          },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: true,
      // Element Plus 全量引入约 1MB gzip 前体积，内网管理台可接受；
      // 提高告警阈值以免每次构建都被噪音掩盖真实告警。
      chunkSizeWarningLimit: 1500,
    },
  }
})
