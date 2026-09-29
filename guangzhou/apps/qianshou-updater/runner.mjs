/** Private updater helper entry. Electron runs this file only with ELECTRON_RUN_AS_NODE=1. */
import { activationFromHelperInput, runActivationHelper } from './bootstrap.mjs'

try {
  const encoded = process.env.QIANSHOU_UPDATE_HELPER
  delete process.env.QIANSHOU_UPDATE_HELPER
  if (typeof encoded !== 'string' || encoded.length > 2 * 1024 * 1024) throw new Error('Invalid helper input')
  await runActivationHelper(await activationFromHelperInput(JSON.parse(encoded)))
} catch {
  // Avoid logging private paths, readiness tokens or inherited process state.
  process.exitCode = 1
}
