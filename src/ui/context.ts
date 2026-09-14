/** Shared services and the small helpers every view needs. */

import { ApiError, NetworkError } from '../api/client.ts';
import type { MonitoringApi } from '../api/monitoring.ts';
import type { SessionStore } from '../api/session.ts';

export interface AppContext {
  api: MonitoringApi;
  session: SessionStore;
  /** Show a message in the banner above the current view. */
  notify: (message: string, tone?: 'error' | 'warning' | 'info') => void;
  /** Clear the banner. */
  clearNotice: () => void;
  navigate: (hash: string) => void;
}

export interface View {
  element: HTMLElement;
  mount?: () => void;
  destroy?: () => void;
}

/** A sentence the reader can act on, for any failure this client can produce. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'The session has expired. Sign in again.';
    if (error.status === 403) return 'The server refused the request from this site.';
    if (error.status === 404) return 'That item is no longer available.';
    if (error.status === 429) {
      const wait = error.retryAfterSeconds;
      return wait
        ? `Too many requests. Try again in ${wait} seconds.`
        : 'Too many requests. Try again shortly.';
    }
    if (error.status >= 500) return 'The monitoring service is temporarily unavailable.';
    return error.detail;
  }
  if (error instanceof NetworkError) {
    return 'The monitoring service could not be reached. Check the connection.';
  }
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}

/** True for an abort raised by navigating away, which is not worth reporting. */
export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
