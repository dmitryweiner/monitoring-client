/**
 * Session persistence.
 *
 * The admin key is never stored: it is exchanged once for a session key that
 * the Worker accepts for seven days. The session key lives in localStorage so
 * a page reload does not ask for the admin key again.
 */

import { SESSION_STORAGE_KEY } from '../config.ts';

export interface StoredSession {
  session_key: string;
  expires_at: number;
}

type Listener = (session: StoredSession | null) => void;

function isStoredSession(value: unknown): value is StoredSession {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StoredSession>;
  return typeof candidate.session_key === 'string' && typeof candidate.expires_at === 'number';
}

/** localStorage throws in some privacy modes; treat it as absent. */
function safeStorage(): Storage | null {
  try {
    const probe = globalThis.localStorage;
    const key = '__monitor_probe__';
    probe.setItem(key, '1');
    probe.removeItem(key);
    return probe;
  } catch {
    return null;
  }
}

export class SessionStore {
  private current: StoredSession | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly storage: Storage | null;

  constructor(storage: Storage | null = safeStorage()) {
    this.storage = storage;
    this.current = this.read();
  }

  private read(): StoredSession | null {
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem(SESSION_STORAGE_KEY);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      return isStoredSession(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private write(session: StoredSession | null): void {
    if (!this.storage) return;
    try {
      if (session) this.storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
      else this.storage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // A full or blocked storage only costs the convenience of staying signed in.
    }
  }

  /** The session key, or null when absent or expired. */
  get token(): string | null {
    const session = this.current;
    if (!session) return null;
    if (session.expires_at * 1000 <= Date.now()) return null;
    return session.session_key;
  }

  get expiresAt(): number | null {
    return this.current?.expires_at ?? null;
  }

  get active(): boolean {
    return this.token !== null;
  }

  set(session: StoredSession): void {
    this.current = session;
    this.write(session);
    this.emit();
  }

  clear(): void {
    if (!this.current) return;
    this.current = null;
    this.write(null);
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.current);
  }
}
