import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../src/api/session.ts';

/** Minimal in-memory Storage, optionally failing like a blocked localStorage. */
function memoryStorage(failing = false): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => {
      if (failing) throw new Error('blocked');
      return map.get(key) ?? null;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      if (failing) throw new Error('blocked');
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      if (failing) throw new Error('blocked');
      map.set(key, value);
    },
  } as Storage;
}

const FUTURE = () => Date.now() / 1000 + 3600;
const PAST = () => Date.now() / 1000 - 3600;

describe('SessionStore', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('has no token before a session is stored', () => {
    expect(new SessionStore(memoryStorage()).token).toBeNull();
  });

  it('keeps the session across instances', () => {
    const storage = memoryStorage();
    new SessionStore(storage).set({ session_key: 'abc', expires_at: FUTURE() });
    expect(new SessionStore(storage).token).toBe('abc');
  });

  it('treats an expired session as absent', () => {
    const store = new SessionStore(memoryStorage());
    store.set({ session_key: 'abc', expires_at: PAST() });
    expect(store.token).toBeNull();
    expect(store.active).toBe(false);
  });

  it('forgets the session on clear', () => {
    const storage = memoryStorage();
    const store = new SessionStore(storage);
    store.set({ session_key: 'abc', expires_at: FUTURE() });
    store.clear();
    expect(store.token).toBeNull();
    expect(new SessionStore(storage).token).toBeNull();
  });

  it('notifies subscribers on change', () => {
    const store = new SessionStore(memoryStorage());
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.set({ session_key: 'abc', expires_at: FUTURE() });
    store.clear();
    unsubscribe();
    store.set({ session_key: 'def', expires_at: FUTURE() });

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('ignores a malformed stored value', () => {
    const storage = memoryStorage();
    storage.setItem('monitor.session', 'not json');
    expect(new SessionStore(storage).token).toBeNull();
  });

  it('still works in memory when storage is blocked', () => {
    const store = new SessionStore(memoryStorage(true));
    store.set({ session_key: 'abc', expires_at: FUTURE() });
    expect(store.token).toBe('abc');
  });

  it('works with no storage at all', () => {
    const store = new SessionStore(null);
    store.set({ session_key: 'abc', expires_at: FUTURE() });
    expect(store.token).toBe('abc');
  });
});
