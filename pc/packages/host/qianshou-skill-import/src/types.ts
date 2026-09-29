/** Browser-visible facts for a single local SKILL.md import. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** One short-lived Host preflight, consumed exactly once by install. */
export type SkillImportInspectionId = Branded<'SkillImportInspectionId'>

/** Metadata reviewed before the Host writes a skill file. */
export interface SkillImportInspection {
  readonly inspectionId: SkillImportInspectionId
  readonly name: string
  readonly description: string
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
  readonly sha256: string
  readonly bytes: number
  readonly targetPath: string
  readonly expiresAt: number
}

/** Disk-only receipt; Session discovery is an independent later observation. */
export interface SkillImportReceipt {
  readonly state: 'written'
  readonly name: string
  readonly sha256: string
  readonly path: string
  readonly bytes: number
}

/** Read-only answer for one exact digest at the controlled user-skill path. */
export interface SkillImportVerification {
  readonly state: 'matched' | 'different' | 'missing'
}

/** A validated local user skill, independent of any Session's winning skill. */
export interface LocalSkillEntry {
  readonly name: string
  readonly displayName: string
  readonly description: string
  readonly whenToUse?: string
  readonly category?: string
  readonly source: 'user-dsh' | 'user-agents'
  readonly path: string
  readonly updatedAt: number
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
  /** Exact instruction digest used to refuse a stale removal request. */
  readonly sha256?: string
  /** Only user-owned files, outside managed package/runtime directories, can be archived. */
  readonly canArchive?: boolean
}

/** One explicit selection from the current local inventory; clients cannot select another root. */
export interface LocalSkillArchiveRequest {
  readonly source: LocalSkillEntry['source']
  readonly name: string
  readonly path: string
  readonly sha256: string
}

/** Whole-file or whole-directory move receipt; cloud records and installed runtimes remain unchanged. */
export interface LocalSkillArchiveReceipt {
  readonly state: 'archived'
  readonly source: LocalSkillEntry['source']
  readonly name: string
  readonly originalPath: string
  readonly archivePath: string
  readonly receiptPath: string
  readonly sha256: string
}

/** A verified recoverable entry from the Host's archive directory. */
export interface LocalSkillArchiveEntry extends LocalSkillArchiveReceipt {
  readonly archiveId: string
  readonly archivedAt: string
  readonly displayName?: string
  readonly description?: string
}

/** Restore selects an opaque archive id; clients never choose a destination path. */
export interface LocalSkillRestoreRequest {
  readonly source: LocalSkillEntry['source']
  readonly archiveId: string
  readonly sha256: string
}

/** Actual completed restoration, without enabling or publishing the skill. */
export interface LocalSkillRestoreReceipt {
  readonly state: 'restored'
  readonly source: LocalSkillEntry['source']
  readonly archiveId: string
  readonly name: string
  readonly sha256: string
  readonly path: string
}

/** The skill files owned by this computer; call `skills.list` for Session availability. */
export interface LocalSkillList {
  readonly skills: readonly LocalSkillEntry[]
}

/** Host-only authoring locations; filesystem readiness grants no write authority. */
export interface SkillAuthoringContext {
  readonly roots: readonly {
    readonly source: LocalSkillEntry['source']
    readonly path: string
    readonly exists: boolean
    readonly hostWritable: boolean
    readonly problem?: 'unsafe-path' | 'not-writable' | 'unreadable'
  }[]
  readonly destination: {
    readonly source: LocalSkillEntry['source']
    readonly directory: string
    readonly skillFile: string
    readonly conflict: boolean
  } | null
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'skill-import/invalid': {}
    'skill-import/conflict': {}
    'skill-import/expired': {}
    'skill-import/unsafe-path': {}
    'skill-import/not-owned': {}
    'skill-import/managed': {}
    'skill-import/changed': {}
    'skill-import/in-use': {}
  }
}
