import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

/**
 * 工程内的测试配置：用根 node_modules 里的 vitest（本工程不重复安装测试框架），
 * 只跑本目录 `__tests__` 下的用例。
 *
 * 需要 `@vitejs/plugin-vue`：渲染冒烟用例会直接 import 真实的 `.vue` 视图。
 *
 * 目录名刻意用 `__tests__` 而不是 `tests`：仓库根的 vitest 配置会把 apps 下
 * `tests` 目录里的 spec 纳入整仓测试，而那套配置不认本工程的 `@/*` 别名。
 * 分开之后两组测试互不干扰，本工程用例用 `pnpm --filter @qianshou/admin-web test` 跑。
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // jsdom：渲染冒烟用例会 import 真实视图，其中 `AppLayout.vue` 间接引到
    // `vue-router` 的 `createWebHistory`（需要 window）；jsdom 由仓库根提供。
    environment: 'jsdom',
    include: ['__tests__/**/*.spec.ts'],
  },
})
