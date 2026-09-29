/** Browser-only coordinator for Shanghai's single-use rotating refresh tokens.
 * Call commitLogin only after the server has authenticated the account (including MFA).
 * JWT decoding below checks pair consistency; it does NOT verify authorization/signatures.
 */
export type Persistence = 'local' | 'session';
export type SessionCode =
  | 'WEB_LOCKS_UNAVAILABLE' | 'SESSION_STORAGE_UNAVAILABLE' | 'SESSION_CHANGED'
  | 'SESSION_REAUTH_REQUIRED' | 'SESSION_SCOPE_CONFLICT' | 'INVALID_TOKEN_PAIR'
  | 'REFRESH_REJECTED' | 'REFRESH_UNCERTAIN' | 'REFRESH_INVALID_RESPONSE';

export class SessionError extends Error {
  constructor(public readonly code: SessionCode) { super(code); this.name = 'SessionError'; }
}

export interface LoginPair { accountId: string; accessToken: string; refreshToken: string }
export interface LoginTicket { readonly scope: string; readonly generation: string }
export interface RequestLease extends LoginTicket {
  readonly accountId: string;
  readonly revision: number;
  readonly accessToken: string;
  readonly familyKey: string;
}
interface Session extends LoginTicket {
  phase: 'login' | 'empty' | 'active' | 'refreshing' | 'reauth';
  revision: number;
  accountId?: string;
  accessToken?: string;
  refreshToken?: string;
  familyKey?: string;
  digest?: string;
  attempt?: string;
}
// Cross-tab fences contain digests and random session generations, never tokens/account data.
interface Fence extends LoginTicket {
  digest: string;
  phase: 'active' | 'refreshing' | 'revoked';
  attempt?: string;
}
interface Claims { sub: string; sid: string; kind: string; jti: string; exp: number; role: string }
const PREFIX = 'eco.session.v1:';
const STATE_LOCK = `${PREFIX}state`;

function fail(code: SessionCode): never { throw new SessionError(code); }
function claims(token: string): Claims {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return fail('INVALID_TOKEN_PAIR');
    const middle = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(middle.padEnd(Math.ceil(middle.length / 4) * 4, '=')), c => c.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Claims;
    if (!parsed || typeof parsed.sub !== 'string' || !parsed.sub ||
        typeof parsed.sid !== 'string' || !parsed.sid ||
        typeof parsed.jti !== 'string' || !parsed.jti ||
        typeof parsed.role !== 'string' || !parsed.role ||
        !Number.isFinite(parsed.exp) || parsed.exp * 1000 <= Date.now()) return fail('INVALID_TOKEN_PAIR');
    return parsed;
  } catch { return fail('INVALID_TOKEN_PAIR'); }
}
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function bindPair(pair: LoginPair) {
  if (!pair || typeof pair.accountId !== 'string' || !pair.accountId ||
      typeof pair.accessToken !== 'string' || typeof pair.refreshToken !== 'string') return fail('INVALID_TOKEN_PAIR');
  const access = claims(pair.accessToken);
  const refresh = claims(pair.refreshToken);
  if (access.kind !== 'access' || refresh.kind !== 'refresh' || access.sub !== pair.accountId ||
      refresh.sub !== pair.accountId || access.sid !== refresh.sid || access.role !== refresh.role) return fail('INVALID_TOKEN_PAIR');
  const [family, digest] = await Promise.all([sha256(refresh.sid), sha256(pair.refreshToken)]);
  return { familyKey: `${PREFIX}family:${family}`, digest };
}

export function createSessionCoordinator(options: {
  namespace: string;
  persistence: Persistence;
  refreshTimeoutMs?: number;
}) {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(options.namespace) ||
      !['local', 'session'].includes(options.persistence)) throw new TypeError('Invalid session scope');
  const timeoutMs = options.refreshTimeoutMs ?? 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new TypeError('Invalid refresh timeout');
  const scope = `${options.namespace}:${options.persistence}`;
  const storageKey = `${PREFIX}session:${options.namespace}`;
  const refreshUrl = new URL('/api/v8/auth/refresh', window.location.origin);
  if (!['http:', 'https:'].includes(refreshUrl.protocol)) throw new TypeError('HTTP origin required');
  let pendingMutation = 0;
  let localEpoch = 0;

  const supported = () => typeof navigator.locks?.request === 'function' &&
    typeof crypto.subtle?.digest === 'function' && typeof crypto.randomUUID === 'function';
  const assertSupported = () => { if (!supported()) fail('WEB_LOCKS_UNAVAILABLE'); };
  function storage(mode: Persistence): Storage {
    try { return mode === 'local' ? window.localStorage : window.sessionStorage; }
    catch { return fail('SESSION_STORAGE_UNAVAILABLE'); }
  }
  function read<T>(mode: Persistence, key: string): T | null {
    try { const raw = storage(mode).getItem(key); return raw ? JSON.parse(raw) as T : null; }
    catch { return fail('SESSION_STORAGE_UNAVAILABLE'); }
  }
  function write(mode: Persistence, key: string, value: unknown) {
    try { storage(mode).setItem(key, JSON.stringify(value)); }
    catch { fail('SESSION_STORAGE_UNAVAILABLE'); }
  }
  const current = () => read<Session>(options.persistence, storageKey);
  const save = (value: Session) => write(options.persistence, storageKey, value);
  const fenceOf = (value: Session) => value.familyKey ? read<Fence>('local', value.familyKey) : null;
  function owns(fence: Fence | null, value: LoginTicket) {
    return Boolean(fence && fence.scope === value.scope && fence.generation === value.generation);
  }
  function matches(value: Session | null, ticket: LoginTicket): value is Session {
    return Boolean(value && ticket.scope === scope && value.scope === scope && value.generation === ticket.generation);
  }
  function coherent(value: Session): boolean {
    const fence = fenceOf(value);
    return Boolean(owns(fence, value) && fence!.digest === value.digest &&
      fence!.phase === value.phase && fence!.attempt === value.attempt &&
      value.accountId && value.accessToken && value.refreshToken && value.familyKey);
  }
  function leaseOf(value: Session): RequestLease {
    return Object.freeze({ scope, generation: value.generation, accountId: value.accountId!,
      revision: value.revision, accessToken: value.accessToken!, familyKey: value.familyKey! });
  }
  function state<T>(action: () => T): Promise<T> {
    assertSupported();
    return navigator.locks.request(STATE_LOCK, { mode: 'exclusive' }, action);
  }
  function revokeOwned(value: Session | null) {
    if (!value?.familyKey) return;
    const fence = fenceOf(value);
    if (owns(fence, value)) write('local', value.familyKey, { ...fence, phase: 'revoked', attempt: undefined });
  }
  function empty(phase: 'empty' | 'login'): Session {
    return { scope, generation: crypto.randomUUID(), revision: 0, phase };
  }
  function requireReauth(value: Session, revoke = true) {
    if (revoke) revokeOwned(value);
    save({ scope, generation: value.generation, revision: value.revision, phase: 'reauth' });
  }

  /** No fallback to the other persistence store, legacy keys, or role namespaces. */
  function capture(): RequestLease | null {
    assertSupported();
    if (pendingMutation) return null;
    const value = current();
    return value?.scope === scope && ['active', 'refreshing'].includes(value.phase) && coherent(value) ? leaseOf(value) : null;
  }
  /** Generation binds application responses to an account; a normal rotation keeps it valid. */
  function isCurrent(lease: RequestLease): boolean {
    const now = capture();
    return Boolean(now && now.scope === lease.scope && now.generation === lease.generation && now.accountId === lease.accountId);
  }
  function isLoginCurrent(ticket: LoginTicket): boolean {
    assertSupported();
    const value = current();
    return !pendingMutation && matches(value, ticket) && value.phase === 'login';
  }
  async function beginLogin(): Promise<LoginTicket> {
    assertSupported();
    ++localEpoch;
    ++pendingMutation;
    try {
      return await state(() => {
        revokeOwned(current());
        const next = empty('login');
        save(next);
        return Object.freeze({ scope, generation: next.generation });
      });
    } finally { --pendingMutation; }
  }
  async function cancelLogin(ticket: LoginTicket): Promise<boolean> {
    return state(() => {
      const value = current();
      if (!matches(value, ticket) || value.phase !== 'login') return false;
      save(empty('empty'));
      return true;
    });
  }
  async function commitLogin(ticket: LoginTicket, pair: LoginPair): Promise<RequestLease> {
    assertSupported();
    const epoch = localEpoch;
    const bound = await bindPair(pair);
    return state(() => {
      const value = current();
      if (epoch !== localEpoch || !matches(value, ticket) || value.phase !== 'login') return fail('SESSION_CHANGED');
      // A real new login creates a fresh server sid. Importing an existing family is forbidden.
      if (read<Fence>('local', bound.familyKey)) return fail('SESSION_SCOPE_CONFLICT');
      const next: Session = { ...value, ...pair, ...bound, phase: 'active', revision: 1 };
      write('local', bound.familyKey, { scope, generation: value.generation, digest: bound.digest, phase: 'active' } satisfies Fence);
      save(next);
      return leaseOf(next);
    });
  }
  /** Without a lease, this is explicit user logout; with a lease, stale errors cannot clear a new account. */
  async function clear(lease?: RequestLease): Promise<boolean> {
    assertSupported();
    const observed = current();
    if (lease && (!matches(observed, lease) || observed.accountId !== lease.accountId)) return false;
    ++localEpoch;
    ++pendingMutation;
    try {
      return await state(() => {
        const value = current();
        if (lease && (!matches(value, lease) || value.accountId !== lease.accountId)) return false;
        revokeOwned(value);
        save(empty('empty'));
        return true;
      });
    } finally { --pendingMutation; }
  }

  async function refresh(lease: RequestLease): Promise<RequestLease> {
    assertSupported();
    if (pendingMutation || !lease || lease.scope !== scope) return fail('SESSION_CHANGED');
    const epoch = localEpoch;
    return navigator.locks.request(`${PREFIX}refresh:${lease.familyKey}`, { mode: 'exclusive' }, async () => {
      const claimed = await state(() => {
        const value = current();
        if (pendingMutation || epoch !== localEpoch || !matches(value, lease) || value.accountId !== lease.accountId) return fail('SESSION_CHANGED');
        if (value.phase !== 'active' || !coherent(value)) {
          // A persisted refreshing marker means the previous lock holder died/was interrupted.
          // A cloned sessionStorage tab with an old digest is isolated; never revoke its healthy sibling.
          const fence = fenceOf(value);
          const abandoned = owns(fence, value) && fence!.phase === 'refreshing' && fence!.digest === value.digest;
          requireReauth(value, abandoned);
          return fail('SESSION_REAUTH_REQUIRED');
        }
        if (value.revision !== lease.revision || value.accessToken !== lease.accessToken) return { reused: leaseOf(value) };
        const attempt = crypto.randomUUID();
        write('local', value.familyKey!, { scope, generation: value.generation, digest: value.digest!, phase: 'refreshing', attempt } satisfies Fence);
        const next: Session = { ...value, phase: 'refreshing', attempt };
        save(next);
        return { value: next };
      });
      if ('reused' in claimed) return claimed.reused!;
      const before = claimed.value!;
      let pair: LoginPair;
      let bound: Awaited<ReturnType<typeof bindPair>>;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(refreshUrl.href, {
          method: 'POST', mode: 'same-origin', credentials: 'omit', redirect: 'error', cache: 'no-store',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ refresh_token: before.refreshToken }), signal: controller.signal,
        });
        if (!response.ok) fail(response.status === 401 || response.status === 403 ? 'REFRESH_REJECTED' : 'REFRESH_UNCERTAIN');
        const data = await response.json();
        if (data?.ok !== true || !data?.tokens) fail('REFRESH_INVALID_RESPONSE');
        pair = { accountId: before.accountId!, accessToken: data.tokens.access_token, refreshToken: data.tokens.refresh_token };
        bound = await bindPair(pair);
        if (bound.familyKey !== before.familyKey || bound.digest === before.digest) fail('REFRESH_INVALID_RESPONSE');
      } catch (error) {
        const code = error instanceof SessionError
          ? (error.code === 'INVALID_TOKEN_PAIR' ? 'REFRESH_INVALID_RESPONSE' : error.code)
          : 'REFRESH_UNCERTAIN';
        await state(() => {
          const now = current();
          if (!matches(now, before) || now.refreshToken !== before.refreshToken || now.attempt !== before.attempt) return fail('SESSION_CHANGED');
          requireReauth(now);
        });
        return fail(code);
      } finally { clearTimeout(timeout); }
      return state(() => {
        const now = current();
        if (epoch !== localEpoch || !matches(now, before) || now.phase !== 'refreshing' ||
            now.refreshToken !== before.refreshToken || now.attempt !== before.attempt || !coherent(now)) return fail('SESSION_CHANGED');
        const next: Session = { ...now, ...pair, ...bound, phase: 'active', attempt: undefined, revision: now.revision + 1 };
        write('local', next.familyKey!, { scope, generation: next.generation, digest: next.digest!, phase: 'active' } satisfies Fence);
        save(next);
        return leaseOf(next);
      });
    });
  }

  return Object.freeze({ supported, capture, isCurrent, isLoginCurrent, beginLogin, cancelLogin, commitLogin, refresh, clear });
}
