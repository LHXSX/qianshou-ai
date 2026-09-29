import { defineConfig } from 'tsdown'

// `fixedExtension: false` makes the ESM output land on `lib/index.js`, which is
// what `package.json` exports and what the Cordis loader resolves at boot.
// Without it tsdown writes `lib/index.mjs` and the plugin entry cannot be found.
export default defineConfig({
  entry: ['index'].map(entry => `lib/types/${entry}.js`),
  outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
  fixedExtension: false, dts: false, clean: false,
})
