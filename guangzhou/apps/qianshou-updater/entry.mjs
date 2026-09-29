/** Packaged Electron entry; standalone helpers import bootstrap.mjs without loading Electron. */
export { UpdateCenter } from './electron.mjs'
export { bootstrapUpdate, prepareActivation, launchActivation, cancelActivation, acknowledgeDataAccess, acknowledgeReady } from './bootstrap.mjs'
