import { describe, expect, it } from 'vitest';
import {
  BUCKET_LADDER,
  MAX_BUCKETS,
  canStepBack,
  steppedRange,
  MAX_SPAN_SECONDS,
  RANGE_PRESETS,
  chooseBucketSeconds,
  chooseMode,
  clampRange,
  dayKeyToTimestamp,
  findPreset,
  localDayKey,
  localDayRange,
  presetRange,
  shiftDayKey,
} from '../src/model/range.ts';

const DAY = 86_400;
const NOW = 1_757_851_200; // 2025-09-14T12:00:00Z, an arbitrary fixed instant

describe('presets', () => {
  it('covers the span ending now', () => {
    const preset = findPreset('24h');
    expect(preset).toBeDefined();
    expect(presetRange(preset!, NOW)).toEqual({ start: NOW - DAY, end: NOW });
  });

  it('offers only ranges the API accepts', () => {
    for (const preset of RANGE_PRESETS) {
      expect(preset.seconds).toBeLessThanOrEqual(MAX_SPAN_SECONDS);
    }
  });
});

describe('clampRange', () => {
  it('pulls the start up to the retention window', () => {
    const range = clampRange({ start: NOW - 200 * DAY, end: NOW }, 'measurement', NOW);
    expect(range.start).toBe(NOW - 90 * DAY);
  });

  it('uses the shorter photo retention', () => {
    const range = clampRange({ start: NOW - 200 * DAY, end: NOW }, 'photo', NOW);
    expect(range.start).toBe(NOW - 30 * DAY);
  });

  it('never asks for more than the maximum span', () => {
    const range = clampRange({ start: 0, end: NOW }, 'measurement', NOW);
    expect(range.end - range.start).toBeLessThanOrEqual(MAX_SPAN_SECONDS);
  });

  it('does not request the future beyond the accepted skew', () => {
    const range = clampRange({ start: NOW - DAY, end: NOW + 10 * DAY }, 'measurement', NOW);
    expect(range.end).toBe(NOW + 300);
  });

  it('keeps start at or before end for an inverted input', () => {
    const range = clampRange({ start: NOW, end: NOW - DAY }, 'measurement', NOW);
    expect(range.start).toBeLessThanOrEqual(range.end);
  });
});

describe('chooseMode', () => {
  it('reads raw events up to a week', () => {
    expect(chooseMode({ start: NOW - 7 * DAY, end: NOW })).toBe('raw');
  });

  it('aggregates longer spans', () => {
    expect(chooseMode({ start: NOW - 8 * DAY, end: NOW })).toBe('aggregate');
  });
});

describe('chooseBucketSeconds', () => {
  it('stays within the server bucket limit for every preset', () => {
    for (const preset of RANGE_PRESETS) {
      const range = presetRange(preset, NOW);
      const bucket = chooseBucketSeconds(range);
      expect(BUCKET_LADDER).toContain(bucket);
      expect(bucket).toBeGreaterThanOrEqual(600);
      expect(bucket).toBeLessThanOrEqual(86_400);
      expect((range.end - range.start) / bucket).toBeLessThanOrEqual(MAX_BUCKETS);
    }
  });

  it('stays within the limit at the maximum span', () => {
    const range = { start: NOW - MAX_SPAN_SECONDS, end: NOW };
    expect(MAX_SPAN_SECONDS / chooseBucketSeconds(range)).toBeLessThanOrEqual(MAX_BUCKETS);
  });

  it('picks the finest bucket that fits', () => {
    expect(chooseBucketSeconds({ start: NOW - 30 * DAY, end: NOW })).toBe(3600);
    expect(chooseBucketSeconds({ start: NOW - 90 * DAY, end: NOW })).toBe(10_800);
  });
});

describe('local day helpers', () => {
  it('round-trips a day key', () => {
    const midnight = new Date(2026, 2, 15, 0, 0, 0, 0).getTime() / 1000;
    expect(localDayKey(midnight)).toBe('2026-03-15');
    expect(dayKeyToTimestamp('2026-03-15')).toBe(midnight);
  });

  it('rejects a malformed key', () => {
    expect(dayKeyToTimestamp('2026-3-5')).toBeNull();
    expect(dayKeyToTimestamp('yesterday')).toBeNull();
  });

  it('covers the whole local day', () => {
    const noon = new Date(2026, 2, 15, 12, 30, 0, 0).getTime() / 1000;
    const range = localDayRange(noon);
    expect(localDayKey(range.start)).toBe('2026-03-15');
    expect(range.end - range.start).toBeGreaterThan(0);
    expect(localDayKey(Math.floor(range.end))).toBe('2026-03-15');
  });

  it('shifts across month boundaries', () => {
    expect(shiftDayKey('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDayKey('2026-02-28', 1)).toBe('2026-03-01');
    expect(shiftDayKey('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('stepping through windows', () => {
  const HOUR = 3600;

  it('is the live window at step 0, whatever the anchor', () => {
    expect(steppedRange(DAY, 0, NOW - 999, NOW)).toEqual({ start: NOW - DAY, end: NOW });
  });

  it('lays earlier windows end to end back from the anchor', () => {
    const anchor = NOW - 30;
    expect(steppedRange(DAY, 1, anchor, NOW)).toEqual({
      start: anchor - 2 * DAY,
      end: anchor - DAY,
    });
    expect(steppedRange(DAY, 2, anchor, NOW)).toEqual({
      start: anchor - 3 * DAY,
      end: anchor - 2 * DAY,
    });
    // Later clicks do not shift a window that has already been shown.
    expect(steppedRange(DAY, 1, anchor, NOW + 5000)).toEqual(steppedRange(DAY, 1, anchor, NOW));
  });

  it('stops once the next window would hold nothing retained', () => {
    // Photos: 30 days. The last 30 days is already all of it.
    expect(canStepBack(30 * DAY, 0, NOW, 'photo', NOW)).toBe(false);
    expect(canStepBack(7 * DAY, 0, NOW, 'photo', NOW)).toBe(true);
    // Four weeks back is day 28 to 35: partly retained, so allowed; five is not.
    expect(canStepBack(7 * DAY, 3, NOW, 'photo', NOW)).toBe(true);
    expect(canStepBack(7 * DAY, 4, NOW, 'photo', NOW)).toBe(false);
    // Measurements: 90 days.
    expect(canStepBack(90 * DAY, 0, NOW, 'measurement', NOW)).toBe(false);
    expect(canStepBack(30 * DAY, 1, NOW, 'measurement', NOW)).toBe(true);
    expect(canStepBack(30 * DAY, 2, NOW, 'measurement', NOW)).toBe(false);
    expect(canStepBack(HOUR, 0, NOW, 'measurement', NOW)).toBe(true);
  });
});
