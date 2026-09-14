/**
 * The chart page: one filter row, then every measured parameter below it.
 *
 * Short ranges are drawn from raw events at full resolution. Beyond a week the
 * server aggregates into buckets and the panel shows the bucket mean with a
 * min/max band, which keeps the response inside the documented limits.
 */

import {
  HIDDEN_SERIES_STORAGE_KEY,
  RANGE_STORAGE_KEY,
  SAMPLE_INTERVAL_SECONDS,
} from '../config.ts';
import type { AggregateResponse } from '../api/types.ts';
import {
  DEFAULT_RANGE_ID,
  RANGE_PRESETS,
  type RangeId,
  chooseBucketSeconds,
  chooseMode,
  clampRange,
  findPreset,
  presetRange,
} from '../model/range.ts';
import {
  buildChartData,
  discoverMetrics,
  seriesFromAggregates,
  seriesFromEvents,
  type ChartData,
} from '../model/series.ts';
import { renderChart, type ChartPanel } from './chart.ts';
import { describeError, isAbort, type AppContext, type View } from './context.ts';
import { clear, el } from './dom.ts';
import { formatLocal } from './format.ts';

/** How much of a delivery gap draws as a break rather than a straight line. */
const GAP_FACTOR = 2.5;

function readStoredRange(): RangeId {
  try {
    const stored = globalThis.localStorage?.getItem(RANGE_STORAGE_KEY);
    if (stored && findPreset(stored)) return stored as RangeId;
  } catch {
    // Stored preferences are a convenience; the default is always valid.
  }
  return DEFAULT_RANGE_ID;
}

function readHiddenSeries(): Set<string> {
  try {
    const stored = globalThis.localStorage?.getItem(HIDDEN_SERIES_STORAGE_KEY);
    if (!stored) return new Set();
    const parsed: unknown = JSON.parse(stored);
    if (Array.isArray(parsed)) return new Set(parsed.filter((item) => typeof item === 'string'));
  } catch {
    // As above.
  }
  return new Set();
}

function persist(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // As above.
  }
}

export class ChartView implements View {
  readonly element: HTMLElement;

  private readonly filters = el('div', { class: 'filters' });
  private readonly summary = el('span', { class: 'stat__note' });
  private readonly panelHost = el('div', {});
  private readonly hidden = readHiddenSeries();

  private rangeId: RangeId = readStoredRange();
  private panels: ChartPanel[] = [];
  private controller: AbortController | null = null;

  constructor(private readonly context: AppContext) {
    this.element = el('section', {}, [this.filters, this.panelHost]);
    this.renderFilters();
  }

  mount(): void {
    void this.load();
  }

  destroy(): void {
    this.controller?.abort();
    this.disposePanels();
  }

  private disposePanels(): void {
    for (const panel of this.panels) panel.destroy();
    this.panels = [];
  }

  /** A single row of range presets, scoping every panel below it. */
  private renderFilters(): void {
    clear(this.filters);
    const group = el('div', { class: 'filters__group' });
    for (const preset of RANGE_PRESETS) {
      group.append(
        el('button', {
          class: 'chip',
          text: preset.label,
          attrs: { type: 'button', 'aria-pressed': String(preset.id === this.rangeId) },
          on: {
            click: () => {
              if (this.rangeId === preset.id) return;
              this.rangeId = preset.id;
              persist(RANGE_STORAGE_KEY, preset.id);
              this.renderFilters();
              void this.load();
            },
          },
        }),
      );
    }
    this.filters.append(
      group,
      this.summary,
      el('span', { class: 'filters__spacer' }),
      el('button', {
        class: 'button',
        text: 'Refresh',
        attrs: { type: 'button' },
        on: { click: () => void this.load() },
      }),
    );
  }

  private async load(): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.panelHost.classList.add('is-refetching');

    const preset = findPreset(this.rangeId) ?? RANGE_PRESETS[0]!;
    const now = Date.now() / 1000;
    const range = clampRange(presetRange(preset, now), 'measurement', now);

    try {
      const data =
        chooseMode(range) === 'raw'
          ? await this.loadRaw(range, controller.signal)
          : await this.loadAggregated(range, controller.signal);
      if (controller.signal.aborted) return;
      this.context.clearNotice();
      this.render(data, range);
    } catch (error) {
      if (isAbort(error) || controller.signal.aborted) return;
      this.context.notify(describeError(error), 'error');
    } finally {
      if (this.controller === controller) this.panelHost.classList.remove('is-refetching');
    }
  }

  private async loadRaw(
    range: { start: number; end: number },
    signal: AbortSignal,
  ): Promise<ChartData> {
    const events = await this.context.api.allMeasurements({ ...range, signal });
    this.summary.textContent = `${events.length} samples · ${formatLocal(range.start)} → ${formatLocal(range.end)}`;
    return buildChartData(seriesFromEvents(events), GAP_FACTOR * SAMPLE_INTERVAL_SECONDS);
  }

  private async loadAggregated(
    range: { start: number; end: number },
    signal: AbortSignal,
  ): Promise<ChartData> {
    // The aggregate endpoint takes one source and metric at a time, so the set
    // of series is discovered from the newest event of every source first.
    const latest = await this.context.api.latest(signal);
    const pairs = discoverMetrics(latest.items);
    const bucketSeconds = chooseBucketSeconds(range);

    const responses: AggregateResponse[] = [];
    for (const pair of pairs) {
      if (signal.aborted) break;
      responses.push(
        await this.context.api.aggregate({ ...range, ...pair, bucketSeconds, signal }),
      );
    }

    const buckets = responses.reduce((total, response) => total + response.items.length, 0);
    const minutes = Math.round(bucketSeconds / 60);
    this.summary.textContent = `${buckets} buckets of ${minutes} min · ${formatLocal(range.start)} → ${formatLocal(range.end)}`;
    return buildChartData(seriesFromAggregates(responses), GAP_FACTOR * bucketSeconds);
  }

  private render(data: ChartData, range: { start: number; end: number }): void {
    this.disposePanels();
    if (data.panels.length === 0) {
      clear(this.panelHost);
      this.panelHost.append(
        el('p', {
          class: 'empty',
          text: `No measurements between ${formatLocal(range.start)} and ${formatLocal(range.end)}.`,
        }),
      );
      return;
    }
    this.panels = renderChart(this.panelHost, data, {
      hidden: this.hidden,
      onToggle: (key, visible) => {
        if (visible) this.hidden.delete(key);
        else this.hidden.add(key);
        persist(HIDDEN_SERIES_STORAGE_KEY, JSON.stringify([...this.hidden]));
      },
    });
  }
}
