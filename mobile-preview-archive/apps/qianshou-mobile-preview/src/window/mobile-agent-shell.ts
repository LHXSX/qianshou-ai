/**
 * Sole executable import of the mobile agent shell for the window host.
 * Every mobile mount (browser, iOS, Android, HarmonyOS) shares this file.
 */
export {
  IndexedDbMobileSyncState,
  MOBILE_SYNC_INITIAL_STATE,
  MOBILE_SYNC_PATH,
  MobileAgentShell,
  createMobileHttpSyncPort,
  parseMobileSyncState,
} from '@deepseek-ai/dsh-client-mobile-agent-shell'

export type {
  MobileAcceptancePolicy,
  MobileAgentShellSnapshot,
  MobileAgentSyncPort,
  MobileAuthPort,
  MobileSyncAck,
  MobileSyncState,
  MobileSyncStatePort,
  MobileTaskDecision,
  SurfaceState,
} from '@deepseek-ai/dsh-client-mobile-agent-shell'
