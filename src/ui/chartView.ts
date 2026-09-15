/**
 * The chart page: one filter block, then the selected parameters below it.
 *
 * The filter block holds the time range, the choice between one combined plot
 * and one plot per unit, and a checkbox per series. Everything below re-renders
 * against the same selection.
 *
 * Short ranges are drawn from raw events at full resolution. Beyond a week the
 * server aggregates into buckets and the panel shows the bucket mean with a
 * min/max band, which keeps the response inside the documented limits.
 */

import {
  CHART_MODE_STORAGE_KEY,
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
  MAX_COMBINED_SERIES,
  buildChartData,
  combinePanels,
  discoverMetrics,
  seriesFromAggregates,
  seriesFromEvents,
  type ChartData,
  type Series,
} from '../model/series.ts';
import { renderChart, seriesColor, type ChartPanel } from './chart.ts';
import { describeError, isAbort, type AppContext, type View } from './context.ts';
import { clear, el } from './dom.ts';
import { formatLocal } from './format.ts';

/** How much of a delivery gap draws as a break rather than a straight line. */
const GAP_FACTOR = 2.5;

/** One plot for everything, or one plot per unit. */
export type ChartLayout = 'combined' | 'separate';

const DEFAULT_LAYOUT: ChartLayout = 'separate';

function readStored(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    // Stored preferences are a convenience; the defaults are always valid.
    return null;
  }
}

function persist(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // As above.
  }
}

function readStoredRange(): RangeId {
  const stored = readStored(RANGE_STORAGE_KEY);
  return stored && findPreset(stored) ? (stored as RangeId) : DEFAULT_RANGE_ID;
}

function readStoredLayout(): ChartLayout {
  const stored = readStored(CHART_MODE_STORAGE_KEY);
  return stored === 'combined' || stored === 'separate' ? stored : DEFAULT_LAYOUT;
}

/** Series the reader has switched off. Everything is on until one is cleared. */
function readHiddenSeries(): Set<string> {
  const stored = readStored(HIDDEN_SERIES_STORAGE_KEY);
  if (!stored) return new Set();
  try {
    const parsed: unknown = JSON.parse(stored);
    if (Array.isArray(parsed)) return new Set(parsed.filter((item) => typeof item === 'string'));
  } catch {
    // As above.
  }
  return new Set();
}

export class ChartView implements View {
  readonly element: HTMLElement;

  private readonly filters = el('div', { class: 'filters filters--stack' });
  private readonly actionRow = el('div', { class: 'filters__row' });
  private readonly layoutRow = el('div', { class: 'filters__row' });
  private readonly rangeRow = el('div', { class: 'filters__row filters__block' });
  private readonly seriesRow = el('div', { class: 'filters__row filters__block' });
  private readonly summary = el('span', { class: 'stat__note' });
  private readonly panelHost = el('div', {});
  private readonly hidden = readHiddenSeries();

  private rangeId: RangeId = readStoredRange();
  private layout: ChartLayout = readStoredLayout();
  private data: ChartData | null = null;
  private range: { start: number; end: number } | null = null;
  private panels: ChartPanel[] = [];
  private controller: AbortController | null = null;

  constructor(private readonly context: AppContext) {
    this.filters.append(this.actionRow, this.layoutRow, this.rangeRow, this.seriesRow);
    this.element = el('section', {}, [this.filters, this.panelHost]);
    this.renderActionRow();
    this.renderRangeRow();
    this.renderLayoutRow();
  }

  /** Reload, and what is currently loaded. Set apart from the choices below. */
  private renderActionRow(): void {
    clear(this.actionRow);
    this.actionRow.append(
      el('button', {
        class: 'button button--primary',
        text: 'Refresh',
        attrs: { type: 'button' },
        on: { click: () => void this.load() },
      }),
      this.summary,
    );
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

  private chip(label: string, pressed: boolean, onClick: () => void): HTMLElement {
    return el('button', {
      class: 'chip',
      text: label,
      attrs: { type: 'button', 'aria-pressed': String(pressed) },
      on: { click: onClick },
    });
  }

  /** Time range. Changing it refetches. */
  private renderRangeRow(): void {
    clear(this.rangeRow);
    const group = el('div', { class: 'filters__group' });
    for (const preset of RANGE_PRESETS) {
      group.append(
        this.chip(preset.label, preset.id === this.rangeId, () => {
          if (this.rangeId === preset.id) return;
          this.rangeId = preset.id;
          persist(RANGE_STORAGE_KEY, preset.id);
          this.renderRangeRow();
          void this.load();
        }),
      );
    }
    this.rangeRow.append(el('span', { class: 'filters__label', text: 'Range' }), group);
  }

  /** One plot or one per unit. Changing it only redraws what is already loaded. */
  private renderLayoutRow(): void {
    clear(this.layoutRow);
    const group = el('div', { class: 'filters__group' });
    const choices: Array<{ id: ChartLayout; label: string }> = [
      { id: 'combined', label: 'One chart' },
      { id: 'separate', label: 'Separate charts' },
    ];
    for (const choice of choices) {
      group.append(
        this.chip(choice.label, choice.id === this.layout, () => {
          if (this.layout === choice.id) return;
          this.layout = choice.id;
          persist(CHART_MODE_STORAGE_KEY, choice.id);
          this.renderLayoutRow();
          this.renderPanels();
        }),
      );
    }
    this.layoutRow.append(el('span', { class: 'filters__label', text: 'Layout' }), group);
  }

  /**
   * A checkbox per series, plus the button that turns them all back on.
   *
   * `drawn` maps a series to the colour it currently carries on screen. The
   * two layouts assign different slots, so the swatch is taken from what is
   * actually plotted rather than from the series itself.
   */
  private renderSeriesRow(drawn: Map<string, number>): void {
    clear(this.seriesRow);
    const all = this.allSeries();
    if (all.length === 0) return;

    const list = el('div', { class: 'sources', attrs: { role: 'group' } });
    const multipleSources = new Set(all.map((series) => series.source)).size > 1;

    for (const series of all) {
      const checked = !this.hidden.has(series.key);
      const box = el('input', {
        attrs: { type: 'checkbox', ...(checked ? { checked: 'checked' } : {}) },
        on: {
          change: (event) => {
            const target = event.target as HTMLInputElement;
            if (target.checked) this.hidden.delete(series.key);
            else this.hidden.add(series.key);
            persist(HIDDEN_SERIES_STORAGE_KEY, JSON.stringify([...this.hidden]));
            this.renderPanels();
          },
        },
      });
      const slot = drawn.get(series.key);
      const key = el('span', { class: 'source__key' });
      // A series that is switched off draws nothing, so it carries no hue.
      key.style.background = slot === undefined ? 'var(--text-muted)' : seriesColor(slot);
      const label = multipleSources ? `${series.source} · ${series.label}` : series.label;
      list.append(
        el('label', { class: 'source', title: `${series.source} · ${series.metric}` }, [
          box,
          key,
          el('span', { class: 'source__label', text: label }),
        ]),
      );
    }

    const allOn = all.every((series) => !this.hidden.has(series.key));
    this.seriesRow.append(
      el('span', { class: 'filters__label', text: 'Show' }),
      list,
      el('button', {
        class: 'button button--quiet',
        text: 'Select all',
        attrs: { type: 'button', ...(allOn ? { disabled: 'disabled' } : {}) },
        on: {
          click: () => {
            for (const series of all) this.hidden.delete(series.key);
            persist(HIDDEN_SERIES_STORAGE_KEY, JSON.stringify([...this.hidden]));
            this.renderPanels();
          },
        },
      }),
    );
  }

  /** Every series the loaded range holds, in a stable order, hidden or not. */
  private allSeries(): Series[] {
    if (!this.data) return [];
    return this.data.panels
      .flatMap((panel) => panel.series)
      .sort((left, right) => left.key.localeCompare(right.key));
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
      this.data = data;
      this.range = range;
      this.renderPanels();
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

  /** Redraw from data already in memory, against the current selection. */
  private renderPanels(): void {
    this.disposePanels();
    clear(this.panelHost);

    const data = this.data;
    if (!data) {
      this.renderSeriesRow(new Map());
      return;
    }
    const range = this.range;

    if (data.panels.length === 0) {
      this.renderSeriesRow(new Map());
      const from = range ? formatLocal(range.start) : '';
      const to = range ? formatLocal(range.end) : '';
      this.panelHost.append(
        el('p', { class: 'empty', text: `No measurements between ${from} and ${to}.` }),
      );
      return;
    }

    const selected = this.selected(data);
    if (selected.panels.length === 0) {
      this.renderSeriesRow(new Map());
      this.panelHost.append(
        el('p', { class: 'empty', text: 'Nothing is selected. Choose a series above.' }),
      );
      return;
    }

    let shown = selected;
    if (this.layout === 'combined') {
      const total = selected.panels.reduce((count, panel) => count + panel.series.length, 0);
      if (total > MAX_COMBINED_SERIES) {
        this.renderSeriesRow(new Map());
        this.panelHost.append(
          el('p', {
            class: 'notice notice--warning',
            text: `One chart shows at most ${MAX_COMBINED_SERIES} series and ${total} are selected. Clear some above, or switch to separate charts.`,
          }),
        );
        return;
      }
      shown = combinePanels(selected);
    }

    const drawn = new Map<string, number>();
    for (const panel of shown.panels) {
      for (const series of panel.series) drawn.set(series.key, series.colorIndex);
    }
    this.renderSeriesRow(drawn);

    this.panels = renderChart(this.panelHost, shown, {
      hidden: new Set(),
      onToggle: (key, visible) => {
        if (visible) this.hidden.delete(key);
        else this.hidden.add(key);
        persist(HIDDEN_SERIES_STORAGE_KEY, JSON.stringify([...this.hidden]));
        this.renderPanels();
      },
    });
  }

  /** The loaded data with unselected series, and then empty panels, removed. */
  private selected(data: ChartData): ChartData {
    const panels = data.panels
      .map((panel) => ({
        ...panel,
        series: panel.series.filter((series) => !this.hidden.has(series.key)),
      }))
      .filter((panel) => panel.series.length > 0);
    return { timestamps: data.timestamps, panels };
  }
}
