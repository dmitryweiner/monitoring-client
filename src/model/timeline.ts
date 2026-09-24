/**
 * The photo timeline: which photos and audio clips fall in a range, where on
 * the ruler they go, and which clip belongs to a photo.
 *
 * In attention mode the agent takes a photo a minute and records the minutes
 * that had sound. A clip's `observed_at` is its start and
 * `values.duration_seconds` its length, so a clip is an interval while a photo
 * is an instant.
 */

import { PHOTO_RETENTION_DAYS, SECONDS_PER_DAY } from '../config.ts';
import type { StoredEvent } from '../api/types.ts';
import { RANGE_PRESETS, type RangePreset, type TimeRange } from './range.ts';

/** The chart's ranges that fit inside photo retention. */
export const PHOTO_RANGE_PRESETS: readonly RangePreset[] = RANGE_PRESETS.filter(
  (preset) => preset.seconds <= PHOTO_RETENTION_DAYS * SECONDS_PER_DAY,
);

/** Clip length when the event does not carry one; the agent records minutes. */
export const DEFAULT_CLIP_SECONDS = 60;

/**
 * How far a photo may sit outside a clip and still be paired with it. The
 * photo and the recording are separate steps of the agent's cycle, so their
 * times differ by a few seconds even when they cover the same minute.
 */
export const CLIP_MATCH_SLACK_SECONDS = 10;

/** Test clips left on the server by the acceptance run, not worth showing. */
const HIDDEN_AUDIO_SOURCES = new Set(['acceptance']);

export interface Interval {
  start: number;
  end: number;
}

export function clipInterval(clip: StoredEvent): Interval {
  const duration = clip.values['duration_seconds'];
  const seconds = duration !== undefined && duration > 0 ? duration : DEFAULT_CLIP_SECONDS;
  return { start: clip.observed_at, end: clip.observed_at + seconds };
}

/** Clips from real recording sources, ascending by start. */
export function visibleClips(clips: StoredEvent[]): StoredEvent[] {
  return clips
    .filter((clip) => clip.kind === 'audio' && !HIDDEN_AUDIO_SOURCES.has(clip.source))
    .sort((left, right) => left.observed_at - right.observed_at);
}

/** Seconds from an instant to an interval; 0 when the instant is inside it. */
function distanceTo(timestamp: number, interval: Interval): number {
  if (timestamp < interval.start) return interval.start - timestamp;
  if (timestamp > interval.end) return timestamp - interval.end;
  return 0;
}

/**
 * The clip recorded around the moment of the photo: the one containing it, or
 * failing that the nearest within CLIP_MATCH_SLACK_SECONDS. Two back-to-back
 * minutes both contain their shared boundary, so a tie goes to the clip whose
 * start is nearer the photo, which is the minute the photo opens.
 */
export function audioForPhoto(
  photo: StoredEvent,
  clips: StoredEvent[],
  slackSeconds = CLIP_MATCH_SLACK_SECONDS,
): StoredEvent | null {
  let best: StoredEvent | null = null;
  let bestDistance = Infinity;
  let bestOffset = Infinity;
  for (const clip of visibleClips(clips)) {
    const distance = distanceTo(photo.observed_at, clipInterval(clip));
    if (distance > slackSeconds) continue;
    const offset = Math.abs(clip.observed_at - photo.observed_at);
    if (distance < bestDistance || (distance === bestDistance && offset < bestOffset)) {
      best = clip;
      bestDistance = distance;
      bestOffset = offset;
    }
  }
  return best;
}

/** The event nearest to `timestamp` in a list sorted by observed_at. */
export function nearestEvent(sorted: StoredEvent[], timestamp: number): StoredEvent | null {
  if (sorted.length === 0) return null;
  let low = 0;
  let high = sorted.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle]!.observed_at < timestamp) low = middle + 1;
    else high = middle;
  }
  const after = sorted[low]!;
  const before = sorted[low - 1];
  if (before && timestamp - before.observed_at <= after.observed_at - timestamp) return before;
  return after;
}

/** Position of an instant on the ruler, 0 at the start of the range and 1 at the end. */
export function fraction(range: TimeRange, timestamp: number): number {
  const span = range.end - range.start;
  return span > 0 ? (timestamp - range.start) / span : 0;
}

export interface PhotoBin {
  /** Bin index, 0 at the start of the range. */
  index: number;
  count: number;
  /** At least one photo in the bin was taken in attention mode. */
  attention: boolean;
}

/**
 * Photos grouped into equal slices of the range. A month can hold tens of
 * thousands of photos; one mark per slice keeps the ruler light while still
 * showing where photos are and where they are dense.
 */
export function binPhotos(photos: StoredEvent[], range: TimeRange, bins: number): PhotoBin[] {
  const result = new Map<number, PhotoBin>();
  for (const photo of photos) {
    const position = fraction(range, photo.observed_at);
    if (position < 0 || position > 1) continue;
    const index = Math.min(bins - 1, Math.floor(position * bins));
    const bin = result.get(index) ?? { index, count: 0, attention: false };
    bin.count += 1;
    if (photo.values['attention'] === 1) bin.attention = true;
    result.set(index, bin);
  }
  return [...result.values()].sort((left, right) => left.index - right.index);
}

/**
 * Clip intervals with neighbours closer than `gapSeconds` joined, so a run of
 * consecutive minutes draws as one band rather than dozens of slivers.
 */
export function mergeIntervals(clips: StoredEvent[], gapSeconds: number): Interval[] {
  const merged: Interval[] = [];
  for (const clip of visibleClips(clips)) {
    const interval = clipInterval(clip);
    const last = merged[merged.length - 1];
    if (last && interval.start - last.end <= gapSeconds) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

/** Steps offered for axis labels, from five minutes to a week. */
const TICK_STEPS = [
  300,
  600,
  900,
  1800,
  3600,
  7200,
  10_800,
  21_600,
  43_200,
  SECONDS_PER_DAY,
  2 * SECONDS_PER_DAY,
  7 * SECONDS_PER_DAY,
];

export interface AxisTick {
  at: number;
  /** A local midnight, labelled with the date rather than the time. */
  midnight: boolean;
}

/**
 * Labelled instants on the axis, at most `maxTicks`, on round local times:
 * whole hours and minutes within a day, local midnights for longer steps.
 */
export function axisTicks(range: TimeRange, maxTicks: number): AxisTick[] {
  const span = range.end - range.start;
  if (span <= 0 || maxTicks < 1) return [];
  const step =
    TICK_STEPS.find((candidate) => span / candidate <= maxTicks) ??
    (TICK_STEPS[TICK_STEPS.length - 1] as number);

  const ticks: AxisTick[] = [];
  const first = new Date(range.start * 1000);
  first.setHours(0, 0, 0, 0);
  if (step < SECONDS_PER_DAY) {
    // Walk each local day from its midnight, so a DST day keeps round hours.
    const day = first;
    while (day.getTime() / 1000 <= range.end) {
      const midnight = day.getTime() / 1000;
      for (let offset = 0; offset < SECONDS_PER_DAY; offset += step) {
        const at = midnight + offset;
        if (at >= range.start && at <= range.end) ticks.push({ at, midnight: offset === 0 });
      }
      day.setDate(day.getDate() + 1);
    }
    return ticks;
  }

  const days = Math.round(step / SECONDS_PER_DAY);
  const day = first;
  while (day.getTime() / 1000 <= range.end) {
    const at = day.getTime() / 1000;
    if (at >= range.start) ticks.push({ at, midnight: true });
    day.setDate(day.getDate() + days);
  }
  return ticks;
}
