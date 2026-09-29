import { defineConfig } from 'tsdown'

// Public subpaths share the verifier's process-local credential registry.
export default defineConfig({
  entry: ['index', 'supply', 'tools', 'protocol', 'validation', 'executor', 'task-state', 'task-store', 'submission-ledger', 'envelope-security', 'contributor-policy', 'resource-observer', 'scheduler', 'node-protocol', 'node-session', 'node-transport', 'employee-task-coordinator', 'capability-manifest', 'plugin-contract', 'plugin-market', 'node-capability', 'resident-loop', 'task-workspace', 'task-output', 'result-assets', 'local-task-runner', 'resident/index', 'transport/memory-session', 'edge-worker/connection', 'transport/edge-worker-session'].map(entry => `lib/types/${entry}.js`),
  outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
  fixedExtension: false, dts: false, clean: false,
})
