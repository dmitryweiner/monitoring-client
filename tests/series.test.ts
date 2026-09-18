import { describe, expect, it } from 'vitest';
import type { AggregateResponse, StoredEvent } from '../src/api/types.ts';
import {
  MAX_SERIES_PER_PANEL,
  buildChartData,
  combinePanels,
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

describe('combinePanels', () => {
  function chart(values: Record<string, number>, extra: Record<string, number> = {}) {
    return buildChartData(
      seriesFromEvents([
        event('cpu', T0, values),
        event('cpu', T0 + 600, values),
        ...(Object.keys(extra).length
          ? [event('agent', T0, extra), event('agent', T0 + 600, extra)]
          : []),
      ]),
      1500,
    );
  }

  it('returns nothing for no panels', () => {
    expect(combinePanels({ timestamps: [], panels: [] }).panels).toEqual([]);
  });

  it('keeps the real axis when every series shares a unit', () => {
    const combined = combinePanels(chart({ cpu_temperature_c: 42, other_temp_c: 30 }));
    expect(combined.panels).toHaveLength(1);
    const panel = combined.panels[0]!;
    expect(panel.unit.id).toBe('celsius');
    expect(panel.note).toBeNull();
    expect(panel.series.map((series) => series.values[0])).toEqual([42, 30]);
    expect(panel.series.every((series) => series.displayValues === null)).toBe(true);
  });

  it('rescales onto a shared axis when units differ', () => {
    const data = buildChartData(
      seriesFromEvents([
        event('cpu', T0, { cpu_temperature_c: 40 }),
        event('cpu', T0 + 600, { cpu_temperature_c: 60 }),
        event('agent', T0, { bytes: 1000 }),
        event('agent', T0 + 600, { bytes: 5000 }),
      ]),
      1500,
    );
    const panel = combinePanels(data).panels[0]!;

    expect(panel.unit.id).toBe('normalized');
    expect(panel.note).toContain('rescaled');
    for (const series of panel.series) {
      expect(series.values).toEqual([0, 100]);
    }
  });

  it('keeps the measured values for the readout', () => {
    const data = buildChartData(
      seriesFromEvents([
        event('cpu', T0, { cpu_temperature_c: 40 }),
        event('cpu', T0 + 600, { cpu_temperature_c: 60 }),
        event('agent', T0, { bytes: 1000 }),
        event('agent', T0 + 600, { bytes: 5000 }),
      ]),
      1500,
    );
    const panel = combinePanels(data).panels[0]!;
    const temperature = panel.series.find((series) => series.metric === 'cpu_temperature_c')!;

    expect(temperature.displayValues).toEqual([40, 60]);
    expect(temperature.displayUnit?.id).toBe('celsius');
  });

  it('puts a series that never changes in the middle of the axis', () => {
    const data = buildChartData(
      seriesFromEvents([
        event('cpu', T0, { cpu_temperature_c: 40 }),
        event('cpu', T0 + 600, { cpu_temperature_c: 60 }),
        event('agent', T0, { queued: 7 }),
        event('agent', T0 + 600, { queued: 7 }),
      ]),
      1500,
    );
    const panel = combinePanels(data).panels[0]!;
    const queued = panel.series.find((series) => series.metric === 'queued')!;

    expect(queued.values).toEqual([50, 50]);
  });

  it('rescales an aggregated band on the same scale as its line', () => {
    const responses = [
      {
        source: 'cpu',
        metric: 'cpu_temperature_c',
        bucket_seconds: 3600,
        items: [{ bucket: T0, count: 6, mean: 50, minimum: 40, maximum: 60 }],
      },
      {
        source: 'agent',
        metric: 'bytes',
        bucket_seconds: 3600,
        items: [{ bucket: T0, count: 6, mean: 200, minimum: 100, maximum: 300 }],
      },
    ];
    const panel = combinePanels(buildChartData(seriesFromAggregates(responses), 7200)).panels[0]!;

    for (const series of panel.series) {
      // The band spans the whole range, so the mean sits at its midpoint.
      expect(series.minimum).toEqual([0]);
      expect(series.values).toEqual([50]);
      expect(series.maximum).toEqual([100]);
    }
  });

  it('assigns palette slots by series key, not by panel order', () => {
    const panel = combinePanels(chart({ cpu_temperature_c: 42 }, { queued: 1, bytes: 10 }))
      .panels[0]!;
    const slots = new Map(panel.series.map((series) => [series.key, series.colorIndex]));

    expect(slots.get('agent.bytes')).toBe(0);
    expect(slots.get('agent.queued')).toBe(1);
    expect(slots.get('cpu.cpu_temperature_c')).toBe(2);
  });
});

/**
 * The agent reads its sources one after another, so the events of one cycle
 * carry their own observed_at seconds apart: DHT11 (`room`) retries every 2 s
 * and can take up to ~10 s, and `agent` is written after it. Rounding each
 * event to the nearest minute split a cycle that straddled :30 across two
 * ticks, leaving every line with a null beside each point.
 */
describe('cycle grouping', () => {
  // T0 is a whole minute, so +28 s rounds down and +34 s rounds up.
  const cycle = (start: number) => [
    event('cpu', start + 28, { cpu_temperature_c: 42 }),
    event('room', start + 34, { temperature_c: 23, humidity_pct: 40 }),
    event('agent', start + 34.1, { queued: 1 }),
  ];

  const ticks = (inputs: ReturnType<typeof seriesFromEvents>) =>
    new Set(inputs.flatMap((input) => input.points.map((point) => point.t)));

  it('puts a cycle that straddles the half minute on one tick', () => {
    expect(ticks(seriesFromEvents(cycle(T0))).size).toBe(1);
  });

  it('keeps cycles 600 s apart on separate ticks', () => {
    expect(ticks(seriesFromEvents([...cycle(T0), ...cycle(T0 + 600)])).size).toBe(2);
  });

  it('draws unbroken lines through such cycles', () => {
    const data = buildChartData(
      seriesFromEvents([...cycle(T0), ...cycle(T0 + 600), ...cycle(T0 + 1200)]),
      1500,
    );
    expect(data.timestamps).toHaveLength(3);
    for (const panel of data.panels) {
      for (const series of panel.series) expect(series.values).not.toContain(null);
    }
  });

  it('places the tick at the first event of the cycle', () => {
    expect([...ticks(seriesFromEvents(cycle(T0)))]).toEqual([T0 + 28]);
  });

  it('measures the window from the first event, so a long cycle cannot chain on', () => {
    const inputs = seriesFromEvents([
      event('cpu', T0, { cpu_temperature_c: 42 }),
      event('room', T0 + 50, { temperature_c: 23 }),
      event('agent', T0 + 100, { queued: 1 }),
    ]);
    // 100 s is only 50 s after the previous event but 100 s after the first.
    expect([...ticks(inputs)].sort()).toEqual([T0, T0 + 100]);
  });

  it('groups events that arrive out of order', () => {
    const [cpu, room, agent] = cycle(T0);
    expect(ticks(seriesFromEvents([agent!, cpu!, room!])).size).toBe(1);
  });

  it('does not let an event without values anchor a tick', () => {
    const inputs = seriesFromEvents([
      event('camera', T0, {}, 'error'),
      event('cpu', T0 + 55, { cpu_temperature_c: 42 }),
      event('agent', T0 + 70, { queued: 1 }),
    ]);
    // Anchored at the empty camera event, +70 would have split from +55.
    expect(ticks(inputs).size).toBe(1);
  });
});

describe('back-to-back cycles', () => {
  /**
   * A restarted agent can run a second cycle seconds after the first. Seen on
   * 17 September at 4.7 s and 29 s apart. Time alone cannot separate them, so
   * a source seen again also starts a new cycle; otherwise one of the two
   * readings would be dropped when both land on the same tick.
   */
  it('starts a new tick when a source repeats, keeping both readings', () => {
    const inputs = seriesFromEvents([
      event('cpu', T0, { cpu_temperature_c: 40 }),
      event('room', T0 + 4.3, { temperature_c: 23 }),
      event('agent', T0 + 4.3, { queued: 1 }),
      event('cpu', T0 + 4.7, { cpu_temperature_c: 41 }),
      event('room', T0 + 4.9, { temperature_c: 24 }),
      event('agent', T0 + 4.9, { queued: 2 }),
    ]);
    const cpu = inputs.find((input) => input.key === 'cpu.cpu_temperature_c')!;
    expect(cpu.points).toEqual([
      { t: T0, value: 40 },
      { t: T0 + 4.7, value: 41 },
    ]);
    const room = inputs.find((input) => input.key === 'room.temperature_c')!;
    expect(room.points.map((point) => point.t)).toEqual([T0, T0 + 4.7]);
  });

  it('keeps every reading through the chart builder', () => {
    const data = buildChartData(
      seriesFromEvents([
        event('cpu', T0, { cpu_temperature_c: 40 }),
        event('agent', T0 + 0.4, { queued: 1 }),
        event('cpu', T0 + 29.3, { cpu_temperature_c: 41 }),
        event('agent', T0 + 29.6, { queued: 2 }),
      ]),
      1500,
    );
    const cpu = data.panels
      .flatMap((panel) => panel.series)
      .find((s) => s.metric === 'cpu_temperature_c')!;
    expect(cpu.values).toEqual([40, 41]);
  });

  it('does not split a cycle whose sources are all distinct', () => {
    const inputs = seriesFromEvents([
      event('cpu', T0 + 28, { cpu_temperature_c: 42 }),
      event('room', T0 + 34, { temperature_c: 23, humidity_pct: 40 }),
      event('agent', T0 + 34.1, { queued: 1 }),
    ]);
    const ticks = new Set(inputs.flatMap((input) => input.points.map((point) => point.t)));
    expect(ticks.size).toBe(1);
  });
});

/**
 * Reported 18 September: One chart, Last hour, barometer pressure and
 * temperature with room humidity and temperature selected, and only two lines
 * on screen. The barometer had just come online, so each series had two
 * samples in the hour. Rescaling every series to its own range turns any two
 * samples into 0 → 100 or 100 → 0, and three of the four were drawn on top of
 * each other. The values are the real ones from that window.
 */
describe('combined plot with few samples', () => {
  const window = [
    event('room', T0, { humidity_percent: 46.3, temperature_c: 24.3 }),
    event('barometer', T0 + 0.2, { pressure_hpa: 1005.8128, temperature_c: 22.3199 }),
    event('room', T0 + 600, { humidity_percent: 49.2, temperature_c: 23.2 }),
    event('barometer', T0 + 600.2, { pressure_hpa: 1005.7367, temperature_c: 22.0124 }),
  ];

  const plotted = () => {
    const panel = combinePanels(buildChartData(seriesFromEvents(window), 1500)).panels[0]!;
    return new Map(panel.series.map((series) => [series.key, series.values]));
  };

  it('keeps four selected series as four distinct lines', () => {
    const lines = plotted();
    const shapes = new Set([...lines.values()].map((values) => JSON.stringify(values)));
    expect(lines.size).toBe(4);
    expect(shapes.size).toBe(4);
  });

  it('puts series of one unit on a shared scale, so their order survives', () => {
    const lines = plotted();
    const room = lines.get('room.temperature_c')!;
    const barometer = lines.get('barometer.temperature_c')!;
    // The room was warmer at both samples, and the plot has to show it.
    for (let index = 0; index < room.length; index += 1) {
      expect(room[index]!).toBeGreaterThan(barometer[index]!);
    }
    // The shared range spans both, so neither is stretched to fill it alone.
    expect(Math.max(...(room as number[]))).toBe(100);
    expect(Math.min(...(barometer as number[]))).toBe(0);
    expect(Math.min(...(room as number[]))).toBeGreaterThan(0);
    expect(Math.max(...(barometer as number[]))).toBeLessThan(100);
  });

  it('still reads the measured values back for the legend', () => {
    const panel = combinePanels(buildChartData(seriesFromEvents(window), 1500)).panels[0]!;
    const room = panel.series.find((series) => series.key === 'room.temperature_c')!;
    expect(room.displayValues).toEqual([24.3, 23.2]);
  });
});
