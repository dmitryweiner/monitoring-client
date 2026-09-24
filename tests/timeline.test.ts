import { describe, expect, it } from 'vitest';
import type { StoredEvent } from '../src/api/types.ts';
import {
  PHOTO_RANGE_PRESETS,
  audioForPhoto,
  axisTicks,
  binPhotos,
  mergeIntervals,
  nearestEvent,
} from '../src/model/timeline.ts';

const T = 1_790_000_000;

function event(
  kind: 'photo' | 'audio',
  observedAt: number,
  values: Record<string, number> = {},
  source = kind === 'photo' ? 'camera' : 'microphone',
): StoredEvent {
  return {
    schema_version: 1,
    device_id: 'home',
    event_id: `${kind}-${source}-${observedAt}`,
    observed_at: observedAt,
    kind,
    source,
    status: 'ok',
    values,
    clock_synchronized: true,
    received_at: observedAt + 5,
  };
}

const clip = (start: number, duration = 60, source?: string) =>
  event('audio', start, { duration_seconds: duration, peak_dbfs: -20 }, source);

describe('range presets', () => {
  it('offers the chart ranges that fit in photo retention', () => {
    expect(PHOTO_RANGE_PRESETS.map((preset) => preset.id)).toEqual([
      '1h',
      '6h',
      '24h',
      '7d',
      '30d',
    ]);
  });
});

describe('audioForPhoto', () => {
  it('pairs a photo with the clip that contains it', () => {
    const clips = [clip(T - 200), clip(T - 30), clip(T + 300)];
    expect(audioForPhoto(event('photo', T), clips)?.observed_at).toBe(T - 30);
  });

  it('accepts a clip starting a few seconds after the photo', () => {
    expect(audioForPhoto(event('photo', T), [clip(T + 4)])?.observed_at).toBe(T + 4);
  });

  it('prefers the clip the photo opens when two minutes meet at it', () => {
    const clips = [clip(T - 60), clip(T)];
    expect(audioForPhoto(event('photo', T), clips)?.observed_at).toBe(T);
  });

  it('prefers a clip containing the photo over a nearer start outside it', () => {
    const clips = [clip(T - 59), clip(T + 2)];
    expect(audioForPhoto(event('photo', T), clips)?.observed_at).toBe(T - 59);
  });

  it('finds nothing when the nearest clip is far away', () => {
    expect(audioForPhoto(event('photo', T), [clip(T + 120), clip(T - 200)])).toBeNull();
  });

  it('uses a minute when the clip does not state its length', () => {
    const bare = event('audio', T - 50);
    expect(audioForPhoto(event('photo', T), [bare])).toBe(bare);
  });

  it('ignores the acceptance test tone', () => {
    expect(audioForPhoto(event('photo', T), [clip(T - 1, 3, 'acceptance')])).toBeNull();
  });
});

describe('nearestEvent', () => {
  const photos = [event('photo', T), event('photo', T + 600), event('photo', T + 660)];

  it('picks the closest photo on either side', () => {
    expect(nearestEvent(photos, T + 200)?.observed_at).toBe(T);
    expect(nearestEvent(photos, T + 400)?.observed_at).toBe(T + 600);
    expect(nearestEvent(photos, T + 650)?.observed_at).toBe(T + 660);
  });

  it('clamps to the ends', () => {
    expect(nearestEvent(photos, T - 1000)?.observed_at).toBe(T);
    expect(nearestEvent(photos, T + 5000)?.observed_at).toBe(T + 660);
  });

  it('returns null for an empty list', () => {
    expect(nearestEvent([], T)).toBeNull();
  });
});

describe('binPhotos', () => {
  it('groups photos into slices and flags attention mode', () => {
    const range = { start: T, end: T + 1000 };
    const bins = binPhotos(
      [
        event('photo', T + 10),
        event('photo', T + 50, { attention: 1, changed_percent: 20 }),
        event('photo', T + 999),
        event('photo', T + 1000),
        event('photo', T - 5),
      ],
      range,
      10,
    );
    expect(bins).toEqual([
      { index: 0, count: 2, attention: true },
      { index: 9, count: 2, attention: false },
    ]);
  });
});

describe('mergeIntervals', () => {
  it('joins consecutive minutes and keeps separate runs apart', () => {
    const merged = mergeIntervals([clip(T + 60), clip(T), clip(T + 125), clip(T + 600)], 10);
    expect(merged).toEqual([
      { start: T, end: T + 185 },
      { start: T + 600, end: T + 660 },
    ]);
  });
});

describe('axisTicks', () => {
  it('labels an hour on round local times', () => {
    const start = new Date(2026, 8, 24, 10, 7).getTime() / 1000;
    const ticks = axisTicks({ start, end: start + 3600 }, 6);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.length).toBeLessThanOrEqual(6);
    for (const tick of ticks) {
      const date = new Date(tick.at * 1000);
      expect(date.getMinutes() % 10).toBe(0);
      expect(date.getSeconds()).toBe(0);
    }
  });

  it('marks local midnights on a day that crosses one', () => {
    const start = new Date(2026, 8, 24, 10, 0).getTime() / 1000;
    const ticks = axisTicks({ start, end: start + 86_400 }, 6);
    const midnights = ticks.filter((tick) => tick.midnight);
    expect(midnights).toHaveLength(1);
    expect(new Date(midnights[0]!.at * 1000).getHours()).toBe(0);
  });

  it('uses whole days for a month', () => {
    const end = new Date(2026, 8, 24, 10, 0).getTime() / 1000;
    const ticks = axisTicks({ start: end - 30 * 86_400, end }, 6);
    expect(ticks.length).toBeLessThanOrEqual(6);
    expect(ticks.every((tick) => tick.midnight)).toBe(true);
  });
});
