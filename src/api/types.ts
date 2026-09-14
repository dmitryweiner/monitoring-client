/** Types for API v1 of the monitoring Worker, mirroring cloud/openapi.json. */

export type EventKind = 'measurement' | 'photo';
export type EventStatus = 'ok' | 'error';

/** An event as returned by the read endpoints. Times are Unix seconds UTC. */
export interface StoredEvent {
  schema_version: 1;
  device_id: string;
  event_id: string;
  observed_at: number;
  kind: EventKind;
  source: string;
  status: EventStatus;
  values: Record<string, number>;
  clock_synchronized: boolean;
  received_at: number;
}

/** One page of history, ordered by (observed_at, event_id) ascending. */
export interface EventPage {
  items: StoredEvent[];
  next_cursor: string | null;
}

/** Newest event per (kind, source) plus the last time the device was seen. */
export interface LatestResponse {
  device_id: string;
  last_seen: number | null;
  items: StoredEvent[];
}

export interface SessionResponse {
  session_key: string;
  expires_at: number;
}

export interface AggregateBucket {
  bucket: number;
  count: number;
  mean: number;
  minimum: number;
  maximum: number;
}

export interface AggregateResponse {
  source: string;
  metric: string;
  bucket_seconds: number;
  items: AggregateBucket[];
}
