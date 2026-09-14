import { describe, expect, it } from 'vitest';
import type { StoredEvent } from '../src/api/types.ts';
import { PhotoNavigator, newestPhoto } from '../src/model/photoNav.ts';
import { localDayKey } from '../src/model/range.ts';

/** Local noon of a day offset from a fixed base date, so tests ignore the time zone. */
function localTime(dayOffset: number, hour = 12, minute = 0): number {
  const date = new Date(2026, 5, 20, hour, minute, 0, 0);
  date.setDate(date.getDate() + dayOffset);
  return date.getTime() / 1000;
}

function photo(observedAt: number): StoredEvent {
  return {
    schema_version: 1,
    device_id: 'home',
    event_id: `photo-${observedAt}`,
    observed_at: observedAt,
    kind: 'photo',
    source: 'camera',
    status: 'ok',
    values: {},
    clock_synchronized: true,
    received_at: observedAt + 3,
  };
}

/** Builds a loader over a fixed set of photos and counts the requests it serves. */
function makeLoader(photos: StoredEvent[]) {
  const requests: string[] = [];
  const load = async (dayKey: string): Promise<StoredEvent[]> => {
    requests.push(dayKey);
    return photos.filter((item) => localDayKey(item.observed_at) === dayKey);
  };
  return { load, requests };
}

const NOW = localTime(0, 23, 30);
const now = () => NOW;

describe('PhotoNavigator', () => {
  it('walks backwards inside one day', async () => {
    const photos = [localTime(0, 9), localTime(0, 10), localTime(0, 11)].map(photo);
    const loader = makeLoader(photos);
    const navigator = new PhotoNavigator({ load: loader.load, retentionDays: 30, now });

    await navigator.select(photos[2]!);
    expect((await navigator.previous())?.event_id).toBe(photos[1]!.event_id);
    expect((await navigator.previous())?.event_id).toBe(photos[0]!.event_id);
  });

  it('crosses into the previous day at the edge', async () => {
    const photos = [localTime(-1, 23), localTime(0, 1)].map(photo);
    const loader = makeLoader(photos);
    const navigator = new PhotoNavigator({ load: loader.load, retentionDays: 30, now });

    await navigator.select(photos[1]!);
    expect((await navigator.previous())?.event_id).toBe(photos[0]!.event_id);
  });

  it('skips days with no photos', async () => {
    const photos = [localTime(-3, 12), localTime(0, 12)].map(photo);
    const loader = makeLoader(photos);
    const navigator = new PhotoNavigator({ load: loader.load, retentionDays: 30, now });

    await navigator.select(photos[1]!);
    expect((await navigator.previous())?.event_id).toBe(photos[0]!.event_id);
  });

  it('stops at the oldest photo instead of looping', async () => {
    const photos = [localTime(-1, 12)].map(photo);
    const loader = makeLoader(photos);
    const navigator = new PhotoNavigator({ load: loader.load, retentionDays: 30, now });

    await navigator.select(photos[0]!);
    expect(await navigator.previous()).toBeNull();
  });

  it('stops at the newest photo', async () => {
    const photos = [localTime(0, 12)].map(photo);
    const loader = makeLoader(photos);
    const navigator = new PhotoNavigator({ load: loader.load, retentionDays: 30, now });

    await navigator.select(photos[0]!);
    expect(await navigator.next()).toBeNull();
  });

  it('never requests a day outside the retention window', async () => {
    const loader = makeLoader([]);
    const navigator = new PhotoNavigator({ load: loader.load, retentionDays: 30, now });

    await navigator.newest();
    const oldestRequested = loader.requests.sort()[0]!;
    expect(oldestRequested >= localDayKey(NOW - 31 * 86_400)).toBe(true);
    expect(loader.requests.length).toBeLessThanOrEqual(32);
  });

  it('finds the newest photo by scanning back from today', async () => {
    const photos = [localTime(-5, 12), localTime(-2, 8)].map(photo);
    const loader = makeLoader(photos);
    const navigator = new PhotoNavigator({ load: loader.load, retentionDays: 30, now });

    expect((await navigator.newest())?.event_id).toBe(photos[1]!.event_id);
  });

  it('jumps to the first photo at or after the chosen moment', async () => {
    const photos = [localTime(-2, 8), localTime(-2, 14), localTime(-2, 20)].map(photo);
    const loader = makeLoader(photos);
    const navigator = new PhotoNavigator({ load: loader.load, retentionDays: 30, now });

    expect((await navigator.jumpTo(localTime(-2, 13)))?.event_id).toBe(photos[1]!.event_id);
  });

  it('falls back to a later day when the chosen day is empty', async () => {
    const photos = [localTime(-1, 9)].map(photo);
    const loader = makeLoader(photos);
    const navigator = new PhotoNavigator({ load: loader.load, retentionDays: 30, now });

    expect((await navigator.jumpTo(localTime(-4, 12)))?.event_id).toBe(photos[0]!.event_id);
  });

  it('falls back to an earlier photo when nothing follows the chosen moment', async () => {
    const photos = [localTime(-6, 9)].map(photo);
    const loader = makeLoader(photos);
    const navigator = new PhotoNavigator({ load: loader.load, retentionDays: 30, now });

    expect((await navigator.jumpTo(localTime(-2, 12)))?.event_id).toBe(photos[0]!.event_id);
  });

  it('reports the position within the day', async () => {
    const photos = [localTime(0, 9), localTime(0, 10), localTime(0, 11)].map(photo);
    const loader = makeLoader(photos);
    const navigator = new PhotoNavigator({ load: loader.load, retentionDays: 30, now });

    await navigator.select(photos[1]!);
    expect(navigator.position()).toEqual({
      indexInDay: 2,
      countInDay: 3,
      dayKey: localDayKey(photos[1]!.observed_at),
    });
  });

  it('serves a revisited day from cache', async () => {
    const photos = [localTime(0, 9), localTime(0, 10)].map(photo);
    const loader = makeLoader(photos);
    const navigator = new PhotoNavigator({ load: loader.load, retentionDays: 30, now });

    await navigator.select(photos[1]!);
    await navigator.previous();
    await navigator.next();
    await navigator.previous();
    expect(new Set(loader.requests).size).toBe(1);
  });

  it('reloads a day after the cache is invalidated', async () => {
    const photos = [localTime(0, 9)].map(photo);
    const loader = makeLoader(photos);
    const navigator = new PhotoNavigator({ load: loader.load, retentionDays: 30, now });

    await navigator.select(photos[0]!);
    navigator.invalidate();
    await navigator.select(photos[0]!);
    expect(loader.requests).toHaveLength(2);
  });
});

describe('peek', () => {
  it('returns the neighbour without moving', async () => {
    const photos = [localTime(0, 9), localTime(0, 10)].map(photo);
    const loader = makeLoader(photos);
    const navigator = new PhotoNavigator({ load: loader.load, retentionDays: 30, now });

    await navigator.select(photos[1]!);
    expect((await navigator.peek(-1))?.event_id).toBe(photos[0]!.event_id);
    expect(navigator.photo?.event_id).toBe(photos[1]!.event_id);
  });
});

describe('newestPhoto', () => {
  it('ignores measurements', () => {
    const measurementItem = { ...photo(localTime(0, 9)), kind: 'measurement' as const };
    expect(newestPhoto([measurementItem])).toBeNull();
  });

  it('returns null when nothing is a photo', () => {
    expect(newestPhoto([])).toBeNull();
  });

  /**
   * /v1/latest returns the newest event of every (kind, source) pair, so a
   * second photo source puts two photos in the array and the array order is
   * not the order of time. Taking the first match showed a four-hour-old test
   * photo instead of the current camera view.
   */
  it('picks the most recent photo when an older source comes first', () => {
    const older = { ...photo(localTime(0, 11)), source: 'acceptance' };
    const newer = { ...photo(localTime(0, 15)), source: 'camera' };
    expect(newestPhoto([older, newer])?.event_id).toBe(newer.event_id);
    expect(newestPhoto([newer, older])?.event_id).toBe(newer.event_id);
  });
});
