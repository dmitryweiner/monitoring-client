/**
 * Turns API responses into the aligned arrays uPlot needs.
 *
 * Series are discovered from the data, never hard-coded, so a new sensor
 * appears on the chart without a code change. Series that share a unit go on
 * one panel; different units get their own panel stacked below, sharing the
 * time axis. At most three series share a panel, which is the limit the
 * categorical palette validates for.
 */

import type { AggregateResponse, StoredEvent } from '../api/types.ts';
import { UNIT_ORDER, unitForMetric, type Unit } from './units.ts';

/** Series beyond this count are moved to an additional panel of the same unit. */
export const MAX_SERIES_PER_PANEL = 3;

export interface SeriesPoint {
  t: number;
  value: number;
  minimum?: number;
  maximum?: number;
}

export interface SeriesInput {
  key: string;
  source: string;
  metric: string;
  points: SeriesPoint[];
}

export interface Series {
  /** `source.metric`, stable across reloads and used for the hidden-series set. */
  key: string;
  source: string;
  metric: string;
  /** Metric name in prose, without the source. */
  label: string;
  unit: Unit;
  /** Palette slot, derived from the full discovered set rather than the visible one. */
  colorIndex: number;
  values: Array<number | null>;
  /** Present only for aggregated data, where each bucket carries a range. */
  minimum: Array<number | null> | null;
  maximum: Array<number | null> | null;
}

export interface UnitPanel {
  unit: Unit;
  /** Panel title, including a part number when one unit needs several panels. */
  title: string;
  series: Series[];
  /** True when the series carry bucket minimum/maximum bands. */
  aggregated: boolean;
}

export interface ChartData {
  /** Unix seconds UTC, ascending, shared by every panel. */
  timestamps: number[];
  panels: UnitPanel[];
}

const ACRONYMS = new Set(['cpu', 'id', 'rssi', 'io']);

const STRIPPED_SUFFIXES = ['_c', '_seconds', '_bytes', '_pct', '_percent', '_hpa'];

/** `cpu_temperature_c` -> `CPU temperature`. The unit is shown by the axis. */
export function humanizeMetric(metric: string): string {
  let name = metric.toLowerCase();
  for (const suffix of STRIPPED_SUFFIXES) {
    if (name.length > suffix.length && name.endsWith(suffix)) {
      name = name.slice(0, -suffix.length);
      break;
    }
  }
  const words = name.split('_').filter(Boolean);
  if (words.length === 0) return metric;
  return words
    .map((word, position) => {
      if (ACRONYMS.has(word)) return word.toUpperCase();
      if (position === 0) return word.charAt(0).toUpperCase() + word.slice(1);
      return word;
    })
    .join(' ');
}

/** Collect one input series per (source, metric) found in raw measurements. */
export function seriesFromEvents(events: StoredEvent[], alignSeconds = 60): SeriesInput[] {
  const inputs = new Map<string, SeriesInput>();
  for (const event of events) {
    if (event.kind !== 'measurement') continue;
    // Events collected in one cycle are milliseconds apart; rounding to a common
    // tick lets them share an x position instead of producing interleaved gaps.
    const t = Math.round(event.observed_at / alignSeconds) * alignSeconds;
    for (const [metric, value] of Object.entries(event.values)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const key = `${event.source}.${metric}`;
      let input = inputs.get(key);
      if (!input) {
        input = { key, source: event.source, metric, points: [] };
        inputs.set(key, input);
      }
      input.points.push({ t, value });
    }
  }
  return [...inputs.values()];
}

/** Collect one input series per aggregate response, carrying the min/max band. */
export function seriesFromAggregates(responses: AggregateResponse[]): SeriesInput[] {
  const inputs: SeriesInput[] = [];
  for (const response of responses) {
    if (response.items.length === 0) continue;
    inputs.push({
      key: `${response.source}.${response.metric}`,
      source: response.source,
      metric: response.metric,
      points: response.items.map((bucket) => ({
        t: bucket.bucket,
        value: bucket.mean,
        minimum: bucket.minimum,
        maximum: bucket.maximum,
      })),
    });
  }
  return inputs;
}

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

/**
 * Merge input series onto one time axis.
 *
 * A synthetic all-null sample is inserted inside any interval longer than
 * `gapSeconds` so a break in delivery draws as a gap rather than a straight
 * line joining the two sides.
 */
export function buildChartData(inputs: SeriesInput[], gapSeconds: number): ChartData {
  const unique = new Set<number>();
  for (const input of inputs) {
    for (const point of input.points) unique.add(point.t);
  }
  const sorted = [...unique].sort((left, right) => left - right);

  const timestamps: number[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index] as number;
    const previous = sorted[index - 1];
    if (previous !== undefined && current - previous > gapSeconds) {
      timestamps.push(previous + Math.floor((current - previous) / 2));
    }
    timestamps.push(current);
  }

  const position = new Map<number, number>();
  timestamps.forEach((value, index) => position.set(value, index));

  const groups = new Map<string, { unit: Unit; inputs: SeriesInput[] }>();
  for (const input of inputs) {
    const unit = unitForMetric(input.metric);
    let group = groups.get(unit.id);
    if (!group) {
      group = { unit, inputs: [] };
      groups.set(unit.id, group);
    }
    group.inputs.push(input);
  }

  const panels: UnitPanel[] = [];
  for (const group of groups.values()) {
    // Sorting by key makes the palette slot a property of the series itself,
    // so hiding one series never repaints the others.
    group.inputs.sort((left, right) => left.key.localeCompare(right.key));
    const parts = chunk(group.inputs, MAX_SERIES_PER_PANEL);
    parts.forEach((part, partIndex) => {
      const series = part.map((input, slot) =>
        toSeries(
          input,
          group.unit,
          partIndex * MAX_SERIES_PER_PANEL + slot,
          timestamps.length,
          position,
        ),
      );
      panels.push({
        unit: group.unit,
        title: parts.length > 1 ? `${group.unit.label} (${partIndex + 1})` : group.unit.label,
        series,
        aggregated: series.some((item) => item.minimum !== null),
      });
    });
  }

  panels.sort((left, right) => unitRank(left.unit) - unitRank(right.unit));
  return { timestamps, panels };
}

function unitRank(unit: Unit): number {
  const rank = UNIT_ORDER.indexOf(unit.id);
  return rank === -1 ? UNIT_ORDER.length : rank;
}

function toSeries(
  input: SeriesInput,
  unit: Unit,
  colorIndex: number,
  length: number,
  position: Map<number, number>,
): Series {
  const values = new Array<number | null>(length).fill(null);
  const banded = input.points.some((point) => point.minimum !== undefined);
  const minimum = banded ? new Array<number | null>(length).fill(null) : null;
  const maximum = banded ? new Array<number | null>(length).fill(null) : null;

  for (const point of input.points) {
    const index = position.get(point.t);
    if (index === undefined) continue;
    values[index] = point.value;
    if (minimum && point.minimum !== undefined) minimum[index] = point.minimum;
    if (maximum && point.maximum !== undefined) maximum[index] = point.maximum;
  }

  return {
    key: input.key,
    source: input.source,
    metric: input.metric,
    label: humanizeMetric(input.metric),
    unit,
    colorIndex,
    values,
    minimum,
    maximum,
  };
}

/** Every (source, metric) pair present in a set of events, for aggregate queries. */
export function discoverMetrics(events: StoredEvent[]): Array<{ source: string; metric: string }> {
  const pairs = new Map<string, { source: string; metric: string }>();
  for (const event of events) {
    if (event.kind !== 'measurement') continue;
    for (const [metric, value] of Object.entries(event.values)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      pairs.set(`${event.source}.${metric}`, { source: event.source, metric });
    }
  }
  return [...pairs.values()].sort((left, right) =>
    `${left.source}.${left.metric}`.localeCompare(`${right.source}.${right.metric}`),
  );
}
