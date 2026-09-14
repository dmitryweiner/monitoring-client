import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError, NetworkError } from '../src/api/client.ts';
import { MonitoringApi } from '../src/api/monitoring.ts';
import type { EventPage, StoredEvent } from '../src/api/types.ts';

interface Call {
  url: string;
  init: RequestInit;
}

/** A fetch double that records calls and replays queued responses. */
function fakeFetch(responses: Response[]) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('no response queued');
    return next;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function client(responses: Response[], token: string | null = 'session-token') {
  const unauthorized = vi.fn();
  const { impl, calls } = fakeFetch(responses);
  const api = new ApiClient({
    baseUrl: 'https://api.example',
    getToken: () => token,
    onUnauthorized: unauthorized,
    fetchImpl: impl,
  });
  return { api, calls, unauthorized };
}

function header(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

describe('ApiClient', () => {
  it('sends the session token as a Bearer header', async () => {
    const { api, calls } = client([jsonResponse({ ok: true })]);
    await api.requestJson('/v1/latest');
    expect(header(calls[0]!.init, 'Authorization')).toBe('Bearer session-token');
  });

  it('omits the header when the request is unauthenticated', async () => {
    const { api, calls } = client([jsonResponse({ ok: true })]);
    await api.requestJson('/v1/session', { method: 'POST', json: { key: 'x' }, auth: false });
    expect(header(calls[0]!.init, 'Authorization')).toBeNull();
    expect(calls[0]!.init.body).toBe('{"key":"x"}');
  });

  it('builds the query string and drops absent parameters', async () => {
    const { api, calls } = client([jsonResponse({ ok: true })]);
    await api.requestJson('/v1/measurements', {
      query: { start: 1, end: 2, source: undefined, limit: 100 },
    });
    expect(calls[0]!.url).toBe('https://api.example/v1/measurements?start=1&end=2&limit=100');
  });

  it('reports the detail returned by the API', async () => {
    const { api } = client([jsonResponse({ detail: 'invalid limit' }, 422)]);
    await expect(api.requestJson('/v1/measurements')).rejects.toMatchObject({
      name: 'ApiError',
      status: 422,
      detail: 'invalid limit',
    });
  });

  it('survives an error body that is not JSON', async () => {
    const { api } = client([new Response('error code: 1010', { status: 403 })]);
    const error = await api.requestJson('/v1/latest').catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
  });

  it('exposes Retry-After on a rate limited response', async () => {
    const { api } = client([
      jsonResponse({ detail: 'rate limited' }, 429, { 'Retry-After': '60' }),
    ]);
    const error = await api.requestJson('/v1/latest').catch((reason: unknown) => reason);
    expect((error as ApiError).retryAfterSeconds).toBe(60);
  });

  it('signals an expired session once', async () => {
    const { api, unauthorized } = client([
      jsonResponse({ detail: 'invalid or expired session' }, 401),
    ]);
    await api.requestJson('/v1/latest').catch(() => undefined);
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  it('does not signal an expired session for a rejected admin key', async () => {
    const { api, unauthorized } = client([jsonResponse({ detail: 'invalid key' }, 401)]);
    await api
      .requestJson('/v1/session', { method: 'POST', json: { key: 'wrong' }, auth: false })
      .catch(() => undefined);
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it('wraps a transport failure', async () => {
    const impl = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const api = new ApiClient({
      baseUrl: 'https://api.example',
      getToken: () => null,
      fetchImpl: impl,
    });
    await expect(api.requestJson('/v1/latest')).rejects.toBeInstanceOf(NetworkError);
  });
});

function photoEvent(observedAt: number): StoredEvent {
  return {
    schema_version: 1,
    device_id: 'home',
    event_id: `id-${observedAt}`,
    observed_at: observedAt,
    kind: 'photo',
    source: 'camera',
    status: 'ok',
    values: {},
    clock_synchronized: true,
    received_at: observedAt,
  };
}

describe('MonitoringApi', () => {
  it('follows the cursor until the last page', async () => {
    const first: EventPage = { items: [photoEvent(1)], next_cursor: 'abc' };
    const second: EventPage = { items: [photoEvent(2)], next_cursor: null };
    const { api, calls } = client([jsonResponse(first), jsonResponse(second)]);
    const monitoring = new MonitoringApi(api);

    const items = await monitoring.allPhotos({ start: 0, end: 10 });
    expect(items.map((item) => item.observed_at)).toEqual([1, 2]);
    expect(calls[1]!.url).toContain('cursor=abc');
  });

  it('stops after the page cap even if the server keeps returning cursors', async () => {
    const endless = () => jsonResponse({ items: [photoEvent(1)], next_cursor: 'more' });
    const { api, calls } = client(Array.from({ length: 20 }, endless));
    const monitoring = new MonitoringApi(api);

    await monitoring.allPhotos({ start: 0, end: 10 });
    expect(calls.length).toBe(8);
  });

  it('encodes the photo id in the path', async () => {
    const { api, calls } = client([new Response(new Blob(['jpeg']), { status: 200 })]);
    const monitoring = new MonitoringApi(api);

    await monitoring.photoBlob('a b/c');
    expect(calls[0]!.url).toBe('https://api.example/v1/photos/a%20b%2Fc');
  });

  it('passes aggregation parameters through', async () => {
    const { api, calls } = client([jsonResponse({ items: [] })]);
    const monitoring = new MonitoringApi(api);

    await monitoring.aggregate({
      start: 1,
      end: 2,
      source: 'cpu',
      metric: 'cpu_temperature_c',
      bucketSeconds: 3600,
    });
    expect(calls[0]!.url).toContain('bucket_seconds=3600');
    expect(calls[0]!.url).toContain('metric=cpu_temperature_c');
  });
});
