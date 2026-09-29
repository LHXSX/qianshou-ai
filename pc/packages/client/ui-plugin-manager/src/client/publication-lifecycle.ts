import type { LocalSkillKey } from './local-skill-locales.ts'

export type PublicationLifecycleAction = 'withdraw' | 'delist' | 'archive' | 'restore'

export const publicationActionLabel: Readonly<Record<PublicationLifecycleAction, LocalSkillKey>> = {
  withdraw: 'publicationLifecycleWithdraw', delist: 'publicationLifecycleDelist',
  archive: 'publicationLifecycleArchive', restore: 'publicationLifecycleRestore',
}

export const publicationActionEffect: Readonly<Record<PublicationLifecycleAction, LocalSkillKey>> = {
  withdraw: 'publicationLifecycleWithdrawEffect', delist: 'publicationLifecycleDelistEffect',
  archive: 'publicationLifecycleArchiveEffect', restore: 'publicationLifecycleRestoreEffect',
}
