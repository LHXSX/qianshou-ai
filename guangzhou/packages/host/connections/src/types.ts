/** Client-safe records for user-authorized, read-only external connections. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque Host-issued connection address. */
export type ConnectionId = Branded<'ConnectionId'>
/** Non-secret common connection configuration. */
export interface ConnectionBase {
  id: ConnectionId
  label: string
  allowedPresets: string[]
}
/** OpenSSH destination using the user's existing known_hosts and local authentication. */
export interface SshConnection extends ConnectionBase {
  kind: 'ssh'
  ssh: { host: string; port: number; user: string; keyPath?: string }
}
/** Public GitHub account authenticated by gh or a Host-resolved credential reference. */
export interface GithubConnection extends ConnectionBase {
  kind: 'github'
  github: { auth: 'gh' | 'credential'; credentialRef?: string }
}
/** The supported external connection kinds; records never contain secret literals. */
export type ConnectionRecord = SshConnection | GithubConnection
/** A new connection omits its Host-issued id. */
export type ConnectionDraft = Omit<SshConnection, 'id'> & { id?: ConnectionId }
  | Omit<GithubConnection, 'id'> & { id?: ConnectionId }
/** Result of an actual bounded authentication and read request. */
export interface ConnectionProbe {
  ok: boolean
  at: string
  method: 'ssh' | 'gh' | 'credential'
  identity?: string
  detail?: string
  error?: string
}
/** Browser view: durable non-secret configuration plus the latest in-process probe. */
export type ConnectionView = ConnectionRecord & { revision: number; updatedAt: string; lastProbe?: ConnectionProbe }
/** Bounded public metadata returned by GitHub's repository listing. */
export interface GithubRepository {
  name: string
  fullName: string
  private: boolean
  url: string
  defaultBranch: string | null
}
/** One upstream page; callers explicitly request the next page. */
export interface GithubRepositoryPage { repositories: GithubRepository[]; nextPage: number | null }
/** Identity returned by a read-only SSH inspection. */
export interface SshInspection { platform: string; directory: string; user: string }
