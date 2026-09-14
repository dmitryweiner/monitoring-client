/**
 * Navigation across the photo archive.
 *
 * The API lists photos in ascending order with a cursor, and there is no
 * "newest first" mode, so the viewer works from per-day listings: at most 144
 * photos a day, one request each, cached. Moving past the edge of a day loads
 * the neighbouring day and skips days with no photos.
 */

import type { StoredEvent } from '../api/types.ts';
import { localDayKey, shiftDayKey } from './range.ts';

export type DayLoader = (dayKey: string) => Promise<StoredEvent[]>;

/**
 * The most recently taken photo in a `/v1/latest` response.
 *
 * That endpoint returns the newest event of every (kind, source) pair, so more
 * than one photo comes back whenever the archive holds more than one photo
 * source. The order of the array is not the order of time, so the newest one
 * has to be chosen by `observed_at` rather than taken as the first match.
 */
export function newestPhoto(items: StoredEvent[]): StoredEvent | null {
  let newest: StoredEvent | null = null;
  for (const item of items) {
    if (item.kind !== 'photo') continue;
    if (!newest || item.observed_at > newest.observed_at) newest = item;
  }
  return newest;
}

export interface NavigatorOptions {
  /** Loads one local calendar day, ascending by observed_at. */
  load: DayLoader;
  /** How far back photos are kept; days older than this are never requested. */
  retentionDays: number;
  /** Current time in Unix seconds; injectable for tests. */
  now: () => number;
}

export interface PhotoPosition {
  /** 1-based position of the current photo within its local day. */
  indexInDay: number;
  /** Number of photos in that day. */
  countInDay: number;
  dayKey: string;
}

export class PhotoNavigator {
  private readonly days = new Map<string, StoredEvent[]>();
  private current: StoredEvent | null = null;

  constructor(private readonly options: NavigatorOptions) {}

  get photo(): StoredEvent | null {
    return this.current;
  }

  /** Drop cached listings so a later navigation sees photos that arrived since. */
  invalidate(): void {
    this.days.clear();
  }

  private async items(dayKey: string): Promise<StoredEvent[]> {
    const cached = this.days.get(dayKey);
    if (cached) return cached;
    const loaded = await this.options.load(dayKey);
    const sorted = [...loaded].sort((left, right) => left.observed_at - right.observed_at);
    this.days.set(dayKey, sorted);
    return sorted;
  }

  private oldestDayKey(): string {
    const earliest = this.options.now() - this.options.retentionDays * 86_400;
    return localDayKey(earliest);
  }

  private newestDayKey(): string {
    return localDayKey(this.options.now());
  }

  /** Position the viewer on a known photo, usually the newest one. */
  async select(photo: StoredEvent | null): Promise<StoredEvent | null> {
    this.current = photo;
    if (photo) await this.items(localDayKey(photo.observed_at));
    return photo;
  }

  /** Where the current photo sits inside its day, for the "n of m" readout. */
  position(): PhotoPosition | null {
    if (!this.current) return null;
    const dayKey = localDayKey(this.current.observed_at);
    const items = this.days.get(dayKey);
    if (!items) return null;
    const index = items.findIndex((item) => item.event_id === this.current?.event_id);
    if (index === -1) return null;
    return { indexInDay: index + 1, countInDay: items.length, dayKey };
  }

  /** The previous (older) photo, crossing into earlier days when needed. */
  async previous(): Promise<StoredEvent | null> {
    return this.step(-1);
  }

  /** The next (newer) photo, crossing into later days when needed. */
  async next(): Promise<StoredEvent | null> {
    return this.step(1);
  }

  /** The neighbour in a direction without moving there, used for prefetching. */
  async peek(direction: 1 | -1): Promise<StoredEvent | null> {
    const saved = this.current;
    const neighbour = await this.step(direction);
    this.current = saved;
    return neighbour;
  }

  private async step(direction: 1 | -1): Promise<StoredEvent | null> {
    if (!this.current) return null;
    const startKey = localDayKey(this.current.observed_at);
    const items = await this.items(startKey);
    const index = items.findIndex((item) => item.event_id === this.current?.event_id);
    if (index !== -1) {
      const neighbour = items[index + direction];
      if (neighbour) {
        this.current = neighbour;
        return neighbour;
      }
    }

    const limitKey = direction === -1 ? this.oldestDayKey() : this.newestDayKey();
    let dayKey = startKey;
    // At most one extra request per empty day, bounded by the retention window.
    for (let hops = 0; hops <= this.options.retentionDays + 1; hops += 1) {
      if (dayKey === limitKey) return null;
      const shifted = shiftDayKey(dayKey, direction);
      if (!shifted) return null;
      dayKey = shifted;
      const dayItems = await this.items(dayKey);
      const candidate = direction === -1 ? dayItems[dayItems.length - 1] : dayItems[0];
      if (candidate) {
        this.current = candidate;
        return candidate;
      }
      if (dayKey === limitKey) return null;
    }
    return null;
  }

  /** The newest photo available, scanning back from today. */
  async newest(): Promise<StoredEvent | null> {
    return this.scan(this.newestDayKey(), -1, (items) => items[items.length - 1]);
  }

  /** The oldest photo still within retention. */
  async oldest(): Promise<StoredEvent | null> {
    return this.scan(this.oldestDayKey(), 1, (items) => items[0]);
  }

  /**
   * The first photo at or after `timestamp`. When the chosen moment is after
   * the last photo, the nearest earlier photo is returned instead, so a date
   * with no later photos still shows something.
   */
  async jumpTo(requested: number): Promise<StoredEvent | null> {
    // Keep the scan inside the retention window; a date outside it would
    // otherwise cost one request per day before returning nothing.
    const now = this.options.now();
    const earliest = now - this.options.retentionDays * 86_400;
    const timestamp = Math.min(Math.max(requested, earliest), now);
    const dayKey = localDayKey(timestamp);
    const items = await this.items(dayKey);
    const atOrAfter = items.find((item) => item.observed_at >= timestamp);
    if (atOrAfter) {
      this.current = atOrAfter;
      return atOrAfter;
    }
    const forward = await this.scan(dayKey, 1, (dayItems) => dayItems[0], true);
    if (forward) return forward;
    return this.scan(dayKey, -1, (dayItems) => dayItems[dayItems.length - 1], true);
  }

  private async scan(
    fromDayKey: string,
    direction: 1 | -1,
    pick: (items: StoredEvent[]) => StoredEvent | undefined,
    skipFirst = false,
  ): Promise<StoredEvent | null> {
    const limitKey = direction === -1 ? this.oldestDayKey() : this.newestDayKey();
    let dayKey = fromDayKey;
    for (let hops = 0; hops <= this.options.retentionDays + 1; hops += 1) {
      if (!(skipFirst && hops === 0)) {
        const candidate = pick(await this.items(dayKey));
        if (candidate) {
          this.current = candidate;
          return candidate;
        }
      }
      if (dayKey === limitKey) return null;
      const shifted = shiftDayKey(dayKey, direction);
      if (!shifted) return null;
      dayKey = shifted;
    }
    return null;
  }
}
