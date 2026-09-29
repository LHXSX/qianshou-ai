import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['packages/client/pc-window-bridge/tests/*.client.spec.ts'], environment: 'node' } })
