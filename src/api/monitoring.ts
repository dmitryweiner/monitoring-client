/** Endpoint facade over ApiClient, one method per documented API v1 operation. */

import { MAX_PAGES, MAX_PAGE_LIMIT } from '../config.ts';
import type { ApiClient } from './client.ts';
import type {
  AggregateResponse,
  EventPage,
  LatestResponse,
  SessionResponse,
  StoredEvent,
} from './types.ts';

export interface HistoryQuery {
  start: number;
  end: number;
  source?: string | undefined;
  limit?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface AggregateQuery {
  start: number;
  end: number;
  source: string;
  metric: string;
  bucketSeconds: number;
  signal?: AbortSignal | undefined;
}

export class MonitoringApi {
  constructor(private readonly client: ApiClient) {}

  /** Exchange the admin key for a session. Rate limited to 10 attempts a minute. */
  login(key: string, signal?: AbortSignal): Promise<SessionResponse> {
    return this.client.requestJson<SessionResponse>('/v1/session', {
      method: 'POST',
      json: { key },
      auth: false,
      ...(signal ? { signal } : {}),
    });
  }

  /** Revoke the current session server-side. */
  logout(signal?: AbortSignal): Promise<void> {
    return this.client.requestNoContent('/v1/session', {
      method: 'DELETE',
      ...(signal ? { signal } : {}),
    });
  }

  latest(signal?: AbortSignal): Promise<LatestResponse> {
    return this.client.requestJson<LatestResponse>('/v1/latest', {
      ...(signal ? { signal } : {}),
    });
  }

  measurements(query: HistoryQuery, cursor?: string): Promise<EventPage> {
    return this.page('/v1/measurements', query, cursor);
  }

  photos(query: HistoryQuery, cursor?: string): Promise<EventPage> {
    return this.page('/v1/photos', query, cursor);
  }

  aggregate(query: AggregateQuery): Promise<AggregateResponse> {
    return this.client.requestJson<AggregateResponse>('/v1/measurements/aggregate', {
      query: {
        start: query.start,
        end: query.end,
        source: query.source,
        metric: query.metric,
        bucket_seconds: query.bucketSeconds,
      },
      ...(query.signal ? { signal: query.signal } : {}),
    });
  }

  /** Fetch the private JPEG. A plain <img src> cannot send the Bearer header. */
  photoBlob(eventId: string, signal?: AbortSignal): Promise<Blob> {
    return this.client.requestBlob(`/v1/photos/${encodeURIComponent(eventId)}`, {
      ...(signal ? { signal } : {}),
    });
  }

  /** Follow next_cursor until the range is exhausted or MAX_PAGES is reached. */
  async allMeasurements(query: HistoryQuery): Promise<StoredEvent[]> {
    return this.allPages((cursor) => this.measurements(query, cursor));
  }

  async allPhotos(query: HistoryQuery): Promise<StoredEvent[]> {
    return this.allPages((cursor) => this.photos(query, cursor));
  }

  private page(path: string, query: HistoryQuery, cursor?: string): Promise<EventPage> {
    return this.client.requestJson<EventPage>(path, {
      query: {
        start: query.start,
        end: query.end,
        source: query.source,
        limit: query.limit ?? MAX_PAGE_LIMIT,
        cursor,
      },
      ...(query.signal ? { signal: query.signal } : {}),
    });
  }

  private async allPages(
    fetchPage: (cursor?: string) => Promise<EventPage>,
  ): Promise<StoredEvent[]> {
    const items: StoredEvent[] = [];
    let cursor: string | undefined;
    // A hard cap keeps a server-side paging bug from looping forever.
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await fetchPage(cursor);
      items.push(...result.items);
      if (!result.next_cursor) return items;
      cursor = result.next_cursor;
    }
    return items;
  }
}
