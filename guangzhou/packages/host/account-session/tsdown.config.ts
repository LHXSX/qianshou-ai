import { defineConfig } from 'tsdown'

// 宿主包的打包形状与 `mobile-sync` 一致：platform node、产物落 `lib/`。
// 插件入口是 `plugin`（由 profiles 按名字加载），库入口是 `index`。
export default defineConfig({
  entry: ['index', 'plugin'].map(entry => `lib/types/${entry}.js`),
  outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
  fixedExtension: false, dts: false, clean: false,
})
