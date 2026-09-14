import { describe, expect, it } from 'vitest';
import type { AggregateResponse, StoredEvent } from '../src/api/types.ts';
import {
  MAX_SERIES_PER_PANEL,
  buildChartData,
  discoverMetrics,
  humanizeMetric,
  seriesFromAggregates,
  seriesFromEvents,
} from '../src/model/series.ts';

function event(
  source: string,
  observedAt: number,
  values: Record<string, number>,
  status: 'ok' | 'error' = 'ok',
): StoredEvent {
  return {
    schema_version: 1,
    device_id: 'home',
    event_id: `${source}-${observedAt}`,
    observed_at: observedAt,
    kind: 'measurement',
    source,
    status,
    values,
    clock_synchronized: true,
    received_at: observedAt + 2,
  };
}

const T0 = 1_757_851_200;

describe('humanizeMetric', () => {
  it('drops the unit suffix and expands acronyms', () => {
    expect(humanizeMetric('cpu_temperature_c')).toBe('CPU temperature');
    expect(humanizeMetric('oldest_age_seconds')).toBe('Oldest age');
    expect(humanizeMetric('queued')).toBe('Queued');
    expect(humanizeMetric('bytes')).toBe('Bytes');
  });
});

describe('seriesFromEvents', () => {
  it('creates one series per source and metric', () => {
    const inputs = seriesFromEvents([
      event('cpu', T0, { cpu_temperature_c: 42.5 }),
      event('agent', T0 + 1, { queued: 3, dropped: 0 }),
    ]);
    expect(inputs.map((input) => input.key).sort()).toEqual([
      'agent.dropped',
      'agent.queued',
      'cpu.cpu_temperature_c',
    ]);
  });

  it('aligns events collected in the same cycle onto one tick', () => {
    const inputs = seriesFromEvents([
      event('cpu', T0 + 3, { cpu_temperature_c: 42 }),
      event('agent', T0 + 9, { queued: 1 }),
    ]);
    const ticks = new Set(inputs.flatMap((input) => input.points.map((point) => point.t)));
    expect(ticks.size).toBe(1);
  });

  it('ignores photo events and non-finite values', () => {
    const photo: StoredEvent = { ...event('camera', T0, {}), kind: 'photo' };
    const inputs = seriesFromEvents([photo, event('cpu', T0, { cpu_temperature_c: Number.NaN })]);
    expect(inputs).toEqual([]);
  });

  it('keeps error events without values out of the series', () => {
    const inputs = seriesFromEvents([event('camera', T0, {}, 'error')]);
    expect(inputs).toEqual([]);
  });
});

describe('buildChartData', () => {
  it('puts metrics of different units on separate panels', () => {
    const inputs = seriesFromEvents([
      event('cpu', T0, { cpu_temperature_c: 42 }),
      event('agent', T0, { queued: 2, bytes: 1000, oldest_age_seconds: 30 }),
    ]);
    const data = buildChartData(inputs, 1500);
    const units = data.panels.map((panel) => panel.unit.id);
    expect(units).toEqual(['celsius', 'count', 'bytes', 'seconds']);
  });

  it('aligns every panel on one shared time axis', () => {
    const inputs = seriesFromEvents([
      event('cpu', T0, { cpu_temperature_c: 42 }),
      event('cpu', T0 + 600, { cpu_temperature_c: 43 }),
      event('agent', T0, { queued: 1 }),
      event('agent', T0 + 600, { queued: 2 }),
    ]);
    const data = buildChartData(inputs, 1500);
    expect(data.timestamps).toHaveLength(2);
    for (const panel of data.panels) {
      for (const series of panel.series) {
        expect(series.values).toHaveLength(data.timestamps.length);
      }
    }
  });

  it('breaks the line across a delivery gap', () => {
    const inputs = seriesFromEvents([
      event('cpu', T0, { cpu_temperature_c: 42 }),
      event('cpu', T0 + 6 * 3600, { cpu_temperature_c: 44 }),
    ]);
    const data = buildChartData(inputs, 1500);
    expect(data.timestamps).toHaveLength(3);
    const series = data.panels[0]!.series[0]!;
    expect(series.values[1]).toBeNull();
    expect(series.values[0]).toBe(42);
    expect(series.values[2]).toBe(44);
  });

  it('leaves a null where one source reported and another did not', () => {
    const inputs = seriesFromEvents([
      event('cpu', T0, { cpu_temperature_c: 42 }),
      event('cpu', T0 + 600, { cpu_temperature_c: 43 }),
      event('agent', T0, { queued: 1 }),
    ]);
    const data = buildChartData(inputs, 1500);
    const queued = data.panels.find((panel) => panel.unit.id === 'count')!.series[0]!;
    expect(queued.values).toEqual([1, null]);
  });

  it('assigns a palette slot that does not depend on the visible set', () => {
    const full = buildChartData(
      seriesFromEvents([event('agent', T0, { queued: 1, dropped: 0 })]),
      1500,
    );
    const panel = full.panels.find((item) => item.unit.id === 'count')!;
    const slots = new Map(panel.series.map((series) => [series.key, series.colorIndex]));
    expect(slots.get('agent.dropped')).toBe(0);
    expect(slots.get('agent.queued')).toBe(1);
  });

  it('facets a unit with more series than one panel may carry', () => {
    const values: Record<string, number> = {};
    for (let index = 0; index < MAX_SERIES_PER_PANEL + 2; index += 1) values[`m${index}`] = index;
    const data = buildChartData(seriesFromEvents([event('agent', T0, values)]), 1500);
    const countPanels = data.panels.filter((panel) => panel.unit.id === 'count');
    expect(countPanels).toHaveLength(2);
    for (const panel of countPanels) {
      expect(panel.series.length).toBeLessThanOrEqual(MAX_SERIES_PER_PANEL);
    }
    expect(countPanels[0]!.title).not.toBe(countPanels[1]!.title);
  });

  it('sorts panels with temperature first', () => {
    const data = buildChartData(
      seriesFromEvents([
        event('agent', T0, { queued: 1 }),
        event('cpu', T0, { cpu_temperature_c: 40 }),
      ]),
      1500,
    );
    expect(data.panels[0]!.unit.id).toBe('celsius');
  });

  it('returns empty data for no input', () => {
    expect(buildChartData([], 1500)).toEqual({ timestamps: [], panels: [] });
  });
});

describe('seriesFromAggregates', () => {
  const response: AggregateResponse = {
    source: 'cpu',
    metric: 'cpu_temperature_c',
    bucket_seconds: 3600,
    items: [
      { bucket: T0, count: 6, mean: 42, minimum: 41, maximum: 43 },
      { bucket: T0 + 3600, count: 6, mean: 45, minimum: 44, maximum: 46 },
    ],
  };

  it('carries the bucket band', () => {
    const data = buildChartData(seriesFromAggregates([response]), 7200);
    const series = data.panels[0]!.series[0]!;
    expect(data.panels[0]!.aggregated).toBe(true);
    expect(series.values).toEqual([42, 45]);
    expect(series.minimum).toEqual([41, 44]);
    expect(series.maximum).toEqual([43, 46]);
  });

  it('skips responses with no buckets', () => {
    expect(seriesFromAggregates([{ ...response, items: [] }])).toEqual([]);
  });
});

describe('discoverMetrics', () => {
  it('lists every source and metric pair once, in a stable order', () => {
    const pairs = discoverMetrics([
      event('agent', T0, { queued: 1, dropped: 0 }),
      event('agent', T0 + 600, { queued: 2, dropped: 0 }),
      event('cpu', T0, { cpu_temperature_c: 42 }),
    ]);
    expect(pairs).toEqual([
      { source: 'agent', metric: 'dropped' },
      { source: 'agent', metric: 'queued' },
      { source: 'cpu', metric: 'cpu_temperature_c' },
    ]);
  });
});
