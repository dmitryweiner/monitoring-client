/**
 * Thin fetch wrapper for the monitoring API.
 *
 * The page is served from GitHub Pages while the API lives on a Cloudflare
 * Worker, so every authenticated request carries `Authorization: Bearer`.
 * With a Bearer header the Worker skips its cookie CSRF check, which is why
 * no CSRF token is sent here.
 */

export type QueryValue = string | number | boolean | undefined | null;

export interface RequestOptions {
  method?: string;
  query?: Record<string, QueryValue>;
  json?: unknown;
  /** Send the session token. Defaults to true. */
  auth?: boolean;
  signal?: AbortSignal;
}

/** The API answered, but with an error status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(detail);
    this.name = 'ApiError';
  }
}

/** The request never produced an HTTP response. */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('the monitoring service could not be reached', { cause });
    this.name = 'NetworkError';
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  getToken: () => string | null;
  /** Called when the server rejects the session, so the UI can ask for the key again. */
  onUnauthorized?: (() => void) | undefined;
  fetchImpl?: typeof fetch | undefined;
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, QueryValue>): string {
  let url = `${baseUrl}${path}`;
  if (query) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) search.set(key, String(value));
    }
    const encoded = search.toString();
    if (encoded) url += `?${encoded}`;
  }
  return url;
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly getToken: () => string | null;
  private readonly onUnauthorized: (() => void) | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl;
    this.getToken = options.getToken;
    this.onUnauthorized = options.onUnauthorized;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private async send(path: string, options: RequestOptions): Promise<Response> {
    const headers = new Headers();
    const init: RequestInit = { method: options.method ?? 'GET', headers };
    if (options.signal) init.signal = options.signal;

    if (options.auth !== false) {
      const token = this.getToken();
      if (token) headers.set('Authorization', `Bearer ${token}`);
    }
    if (options.json !== undefined) {
      headers.set('Content-Type', 'application/json');
      init.body = JSON.stringify(options.json);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(buildUrl(this.baseUrl, path, options.query), init);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new NetworkError(error);
    }

    if (!response.ok) throw await this.toError(response, options.auth !== false);
    return response;
  }

  private async toError(response: Response, authenticated: boolean): Promise<ApiError> {
    let detail = `request failed with status ${response.status}`;
    try {
      const body: unknown = await response.json();
      if (
        body &&
        typeof body === 'object' &&
        typeof (body as { detail?: unknown }).detail === 'string'
      ) {
        detail = (body as { detail: string }).detail;
      }
    } catch {
      // A non-JSON error body (for example Cloudflare's own edge page) keeps the default text.
    }
    if (response.status === 401 && authenticated) this.onUnauthorized?.();
    return new ApiError(
      response.status,
      detail,
      parseRetryAfter(response.headers.get('Retry-After')),
    );
  }

  /** Perform a request and decode the JSON body. */
  async requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.send(path, options);
    return (await response.json()) as T;
  }

  /** Perform a request and discard the body (204 responses). */
  async requestNoContent(path: string, options: RequestOptions = {}): Promise<void> {
    await this.send(path, options);
  }

  /** Perform a request and return the raw body, used for JPEG downloads. */
  async requestBlob(path: string, options: RequestOptions = {}): Promise<Blob> {
    const response = await this.send(path, options);
    return await response.blob();
  }
}
