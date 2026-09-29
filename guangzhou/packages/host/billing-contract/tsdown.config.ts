import { defineConfig } from 'tsdown'

// Subpaths mirror the package exports: `.` from src/index.ts and `./pricing` from src/pricing.ts.
// Entries name the Host TypeScript output (lib/types) that `tsc -b tsconfig.host.json` emits first,
// matching packages/host/node-contributor/tsdown.config.ts.
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/pricing.js'], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
  fixedExtension: false, dts: false, clean: false,
})
