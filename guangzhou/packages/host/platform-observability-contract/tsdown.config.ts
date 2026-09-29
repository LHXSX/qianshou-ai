import { defineConfig } from 'tsdown'

// `exports` points at lib/index.js, so the emitted extension must not drift to .mjs:
// `fixedExtension: false` keeps it .js. Same reason as packages/host/billing-contract.
export default defineConfig({
  entry: ['src/index.ts'], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
  fixedExtension: false, dts: true, clean: true,
})
