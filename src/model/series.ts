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
import { UNIT_ORDER, UNITS, unitForMetric, type Unit } from './units.ts';

/**
 * Series beyond this count are moved to an additional panel of the same unit.
 * Three is what the categorical palette validates for when any two panels may
 * be compared side by side.
 */
export const MAX_SERIES_PER_PANEL = 3;

/**
 * Series on one combined plot. Lines on a single plot are compared with their
 * neighbours, which the eight-slot palette is validated for; a ninth series
 * would have to reuse a hue.
 */
export const MAX_COMBINED_SERIES = 8;

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
  /** What is plotted. Rescaled when a combined plot mixes units. */
  values: Array<number | null>;
  /** Present only for aggregated data, where each bucket carries a range. */
  minimum: Array<number | null> | null;
  maximum: Array<number | null> | null;
  /** Values as measured, set only when `values` has been rescaled. */
  displayValues: Array<number | null> | null;
  /** The unit those measured values carry. */
  displayUnit: Unit | null;
}

export interface UnitPanel {
  unit: Unit;
  /** Panel title, including a part number when one unit needs several panels. */
  title: string;
  series: Series[];
  /** True when the series carry bucket minimum/maximum bands. */
  aggregated: boolean;
  /** Shown under the title when the plot needs explaining. */
  note: string | null;
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

/** True when an event carries at least one plottable number. */
function hasValues(event: StoredEvent): boolean {
  return Object.values(event.values).some(
    (value) => typeof value === 'number' && Number.isFinite(value),
  );
}

/**
 * Collect one input series per (source, metric) found in raw measurements.
 *
 * The agent reads its sources one after another, so the events of one cycle
 * carry their own observed_at seconds apart: a DHT11 read retries every 2 s and
 * can take about 10 s, and the agent status is written after it. Rounding each
 * event to a minute split any cycle that straddled the half minute across two
 * ticks, which drew a gap beside every point.
 *
 * Events are grouped into cycles instead. A new tick starts when an event is
 * more than `cycleWindowSeconds` after the first event of the current tick, or
 * when its source already appears in the current tick, and the tick sits at
 * the time of its first event. Measuring from the first event rather than the
 * previous one stops a slow cycle from chaining into the next. The repeated
 * source separates two cycles run back to back, which a restarted agent does
 * seconds apart; time alone would merge them and drop one reading of each.
 *
 * Events without a value, such as a failed camera capture or a failed sensor
 * read, neither contribute a point nor anchor a tick, so they cannot count as
 * a repeat either. The measured times themselves are never altered.
 */
export function seriesFromEvents(events: StoredEvent[], cycleWindowSeconds = 60): SeriesInput[] {
  const measured = events
    .filter((event) => event.kind === 'measurement' && hasValues(event))
    .sort((left, right) => left.observed_at - right.observed_at);

  const inputs = new Map<string, SeriesInput>();
  let tick: number | null = null;
  const sourcesInTick = new Set<string>();
  for (const event of measured) {
    if (
      tick === null ||
      event.observed_at - tick > cycleWindowSeconds ||
      sourcesInTick.has(event.source)
    ) {
      tick = event.observed_at;
      sourcesInTick.clear();
    }
    sourcesInTick.add(event.source);
    for (const [metric, value] of Object.entries(event.values)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const key = `${event.source}.${metric}`;
      let input = inputs.get(key);
      if (!input) {
        input = { key, source: event.source, metric, points: [] };
        inputs.set(key, input);
      }
      input.points.push({ t: tick, value });
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
        note: null,
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
    displayValues: null,
    displayUnit: null,
  };
}

/** Smallest and largest finite value across a series and any band it carries. */
function extent(series: Series): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const list of [series.values, series.minimum, series.maximum]) {
    if (!list) continue;
    for (const value of list) {
      if (value === null) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
}

/** Map a series onto 0..100 of its own range, keeping the measured values. */
function rescale(series: Series, colorIndex: number): Series {
  const bounds = extent(series);
  const map = (value: number | null): number | null => {
    if (value === null || !bounds) return null;
    // A series that never changes sits mid-axis rather than on an edge.
    if (bounds.max === bounds.min) return 50;
    return ((value - bounds.min) / (bounds.max - bounds.min)) * 100;
  };
  return {
    ...series,
    colorIndex,
    values: series.values.map(map),
    minimum: series.minimum ? series.minimum.map(map) : null,
    maximum: series.maximum ? series.maximum.map(map) : null,
    displayValues: series.values,
    displayUnit: series.unit,
  };
}

/**
 * Fold every panel into one plot.
 *
 * Series that already share a unit keep their real axis. Mixed units cannot
 * share an axis honestly, so each series is rescaled to its own range and the
 * axis says so; the legend and the table still carry the measured values.
 */
export function combinePanels(data: ChartData): ChartData {
  const all = data.panels.flatMap((panel) => panel.series);
  if (all.length === 0) return { timestamps: data.timestamps, panels: [] };

  // Sorting by key keeps a series on the same palette slot whatever else is shown.
  const ordered = [...all].sort((left, right) => left.key.localeCompare(right.key));
  const sameUnit = new Set(ordered.map((series) => series.unit.id)).size === 1;
  const unit = sameUnit ? (ordered[0] as Series).unit : UNITS.NORMALIZED;
  const series = ordered.map((item, index) =>
    sameUnit ? { ...item, colorIndex: index } : rescale(item, index),
  );

  return {
    timestamps: data.timestamps,
    panels: [
      {
        unit,
        title: sameUnit ? unit.label : 'All parameters',
        series,
        aggregated: series.some((item) => item.minimum !== null),
        note: sameUnit
          ? null
          : 'The series use different units, so each is rescaled to its own range. Values in the legend and the table are as measured.',
      },
    ],
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
