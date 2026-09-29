import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 版本号来自 package.json，构建时注入 `__APP_VERSION__`。
 *
 * 「关于」那一栏原先写死 `版本 1.0.0`，而 package.json 是 `0.2.1`——硬编码的版本
 * 迟早和真实版本对不上，用户看到的每一个字都得是真的。
 */
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

/**
 * 资源前缀按**部署位置**决定，因为两种部署同时存在：
 *
 * - 独立预览（`http://203.0.113.20:18090/`，手机现在在看的那个）：资源在根下，`base: '/'`；
 * - 与工作台**同源**部署（`https://203.0.113.20:18443/mobile/`）：资源必须在 `/mobile/` 下，
 *   否则浏览器会去请求 `/assets/…`，而根下的 `/assets/` 属于工作台，结果是 404 白屏。
 *
 * 同源部署是为了让手机调工作台接口时**不再跨域**（浏览器不拦同源请求），
 * 这比给桥加 CORS 头更干净：没有放松任何边界，只是换了个位置。
 */
const base = process.env['QIANSHOU_MOBILE_BASE'] ?? '/'

export default defineConfig({
  plugins: [react()],
  base,
  resolve: {
    alias: {
      /**
       * 账号包直连源码。它的 package.json 指向 `lib/` 产物，而全仓 `tsc -b` 那棵树目前有
       * 既有报错、构建不出来；走源码不需要先构建，也不会用过期产物骗人。
       * 与 `tsconfig.json` 的 `paths` 必须保持一致，否则类型检查与打包会各看一份。
       */
      '@deepseek-ai/dsh-client-account': fileURLToPath(new URL('../../packages/client/account/src/index.ts', import.meta.url)),
      /** 手机快照没有桥的 lib；运行时代码直接打包同仓桥源码。 */
      '@deepseek-ai/dsh-client-pc-window-bridge': fileURLToPath(new URL('../../packages/client/pc-window-bridge/src/index.ts', import.meta.url)),
    },
  },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: {
    host: true,
    port: 4174,
    strictPort: true,
  },
  preview: {
    host: true,
    port: 4174,
    strictPort: true,
  },
})
