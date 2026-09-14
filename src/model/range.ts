/**
 * Time ranges and the choice between raw history and server-side aggregation.
 *
 * The Worker clamps `start` to the retention window, rejects spans over 91 days
 * and rejects aggregations producing more than 1000 buckets, so the same limits
 * are applied here before a request is built.
 */

import { MEASUREMENT_RETENTION_DAYS, PHOTO_RETENTION_DAYS, SECONDS_PER_DAY } from '../config.ts';

export interface TimeRange {
  /** Unix seconds UTC, inclusive. */
  start: number;
  /** Unix seconds UTC, inclusive. */
  end: number;
}

export type RangeId = '1h' | '6h' | '24h' | '7d' | '30d' | '90d';

export interface RangePreset {
  id: RangeId;
  label: string;
  seconds: number;
}

export const RANGE_PRESETS: readonly RangePreset[] = [
  { id: '1h', label: 'Last hour', seconds: 3600 },
  { id: '6h', label: 'Last 6 hours', seconds: 6 * 3600 },
  { id: '24h', label: 'Last 24 hours', seconds: SECONDS_PER_DAY },
  { id: '7d', label: 'Last 7 days', seconds: 7 * SECONDS_PER_DAY },
  { id: '30d', label: 'Last 30 days', seconds: 30 * SECONDS_PER_DAY },
  { id: '90d', label: 'Last 90 days', seconds: 90 * SECONDS_PER_DAY },
];

export const DEFAULT_RANGE_ID: RangeId = '24h';

/** Largest span the API accepts in one request. */
export const MAX_SPAN_SECONDS = 91 * SECONDS_PER_DAY;

/** Server-side limit on buckets returned by one aggregation. */
export const MAX_BUCKETS = 1000;

/** Aggregation bucket sizes offered, all within the documented 600..86400. */
export const BUCKET_LADDER = [600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];

/** Up to this span the raw history is small enough to plot point by point. */
export const RAW_SPAN_LIMIT_SECONDS = 7 * SECONDS_PER_DAY;

export type LoadMode = 'raw' | 'aggregate';

export function findPreset(id: string): RangePreset | undefined {
  return RANGE_PRESETS.find((preset) => preset.id === id);
}

/** The range covered by a preset, ending now. */
export function presetRange(preset: RangePreset, nowSeconds: number): TimeRange {
  return { start: nowSeconds - preset.seconds, end: nowSeconds };
}

/** Clamp a range to what the API will accept for the given kind of event. */
export function clampRange(
  range: TimeRange,
  kind: 'measurement' | 'photo',
  nowSeconds: number,
): TimeRange {
  const retentionDays = kind === 'photo' ? PHOTO_RETENTION_DAYS : MEASUREMENT_RETENTION_DAYS;
  const earliest = nowSeconds - retentionDays * SECONDS_PER_DAY;
  const end = Math.min(range.end, nowSeconds + 300);
  let start = Math.max(range.start, earliest);
  if (end - start > MAX_SPAN_SECONDS) start = end - MAX_SPAN_SECONDS;
  return { start: Math.min(start, end), end };
}

export function spanSeconds(range: TimeRange): number {
  return Math.max(0, range.end - range.start);
}

/**
 * Raw events keep full resolution but cost one request per 1000 events, so they
 * are used only up to a week. Longer spans go through the aggregate endpoint.
 */
export function chooseMode(range: TimeRange): LoadMode {
  return spanSeconds(range) <= RAW_SPAN_LIMIT_SECONDS ? 'raw' : 'aggregate';
}

/** Smallest offered bucket that keeps the response within MAX_BUCKETS. */
export function chooseBucketSeconds(range: TimeRange): number {
  const span = spanSeconds(range);
  const last = BUCKET_LADDER[BUCKET_LADDER.length - 1] as number;
  for (const bucket of BUCKET_LADDER) {
    if (span / bucket <= MAX_BUCKETS) return bucket;
  }
  return last;
}

/** Local calendar day containing `timestamp`, as a range of Unix seconds. */
export function localDayRange(timestamp: number): TimeRange {
  const date = new Date(timestamp * 1000);
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0);
  return { start: start.getTime() / 1000, end: end.getTime() / 1000 - 0.001 };
}

/** Stable key for a local calendar day, used to cache photo listings. */
export function localDayKey(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Unix seconds of local midnight for a `YYYY-MM-DD` key. */
export function dayKeyToTimestamp(key: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date.getTime() / 1000;
}

/** Move a `YYYY-MM-DD` key by whole local days, crossing month and DST boundaries. */
export function shiftDayKey(key: string, deltaDays: number): string | null {
  const timestamp = dayKeyToTimestamp(key);
  if (timestamp === null) return null;
  const date = new Date(timestamp * 1000);
  date.setDate(date.getDate() + deltaDays);
  return localDayKey(date.getTime() / 1000);
}
