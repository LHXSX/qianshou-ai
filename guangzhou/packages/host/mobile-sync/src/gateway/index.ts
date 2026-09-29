/** Host-side PC session gateway surface: durable admission, receipts and routes. */
export { PcWindowGateway, cursorText, REASON, type PcWindowGatewayOptions } from './service.ts'
export { PcWindowStore, commandKey, originKey, type PcWindowState, type PcWindowStoreConfig } from './store.ts'
export { createSessionCommandPort, type PreparedSessionController, type SessionCommandPortOptions } from './session-port.ts'
export { registerGatewayRoutes } from './routes.ts'
export { parseAction, parseBinding, parseCommand, parseCursor, parseRequestIds } from './validate.ts'
export * from './types.ts'
export { createPairingTickets, DEFAULT_TICKET_TTL_MS, type PairingTickets, type RedeemResult } from './pairing.ts'
