/**
 * Chart panels.
 *
 * Every measured parameter is shown in one picture, as a column of aligned
 * panels that share the time axis and a single synchronised crosshair. Series
 * are grouped by unit: plotting degrees and byte counts against two y-scales
 * on one plot would invent a relationship that is not in the data, so each
 * unit gets its own panel instead.
 *
 * Each panel carries a legend that doubles as the live readout, and a table
 * view, so every value is reachable without hovering.
 */

import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

import type { ChartData, Series, UnitPanel } from '../model/series.ts';
import { clear, el } from './dom.ts';
import { formatLocal, formatUtc } from './format.ts';

/** Charts with this cursor key move their crosshair together. */
const SYNC_KEY = 'monitoring';

const SERIES_VARS = ['--series-1', '--series-2', '--series-3'];

const PLOT_HEIGHT = 190;
const TABLE_ROW_LIMIT = 500;

function cssValue(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function seriesColor(colorIndex: number): string {
  const name = SERIES_VARS[colorIndex % SERIES_VARS.length] as string;
  return cssValue(name, '#2a78d6');
}

/** Same hue as the line, at the wash opacity used for area fills. */
function bandFill(colorIndex: number): string {
  const color = seriesColor(colorIndex);
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!match) return 'rgba(42, 120, 214, 0.1)';
  const [, r, g, b] = match;
  return `rgba(${parseInt(r as string, 16)}, ${parseInt(g as string, 16)}, ${parseInt(b as string, 16)}, 0.1)`;
}

interface SeriesSlot {
  series: Series;
  /** Index of the mean/value series in the uPlot data array. */
  valueIndex: number;
  /** Indices of the band edges, for aggregated data only. */
  maximumIndex: number | null;
  minimumIndex: number | null;
}

export interface ChartPanelDeps {
  /** Series keys the reader has switched off; shared by every panel. */
  hidden: Set<string>;
  onToggle: (key: string, visible: boolean) => void;
}

export class ChartPanel {
  readonly element: HTMLElement;

  private readonly plotHost: HTMLElement;
  private readonly legendHost: HTMLElement;
  private readonly tableHost: HTMLElement;
  private readonly cursorLabel: HTMLElement;
  private readonly valueNodes = new Map<string, HTMLElement>();
  private readonly slots: SeriesSlot[] = [];
  private readonly observer: ResizeObserver;

  private plot: uPlot | null = null;
  private tableOpen = false;

  constructor(
    private readonly panel: UnitPanel,
    private readonly timestamps: number[],
    private readonly deps: ChartPanelDeps,
  ) {
    let index = 1;
    for (const series of panel.series) {
      const banded = series.minimum !== null && series.maximum !== null;
      const slot: SeriesSlot = {
        series,
        valueIndex: index,
        maximumIndex: banded ? index + 1 : null,
        minimumIndex: banded ? index + 2 : null,
      };
      this.slots.push(slot);
      index += banded ? 3 : 1;
    }

    this.plotHost = el('div', { class: 'panel__plot' });
    this.legendHost = el('div', { class: 'legend' });
    this.tableHost = el('div', {});
    this.cursorLabel = el('span', { class: 'stat__note' });

    const tableToggle = el('button', {
      class: 'button button--quiet',
      text: 'Table',
      attrs: { type: 'button', 'aria-expanded': 'false' },
      on: {
        click: () => {
          this.tableOpen = !this.tableOpen;
          tableToggle.setAttribute('aria-expanded', String(this.tableOpen));
          this.renderTable();
        },
      },
    });

    this.element = el('figure', { class: 'panel' }, [
      el('div', { class: 'panel__head' }, [
        el('h2', { class: 'panel__title', text: panel.title }),
        this.cursorLabel,
        tableToggle,
      ]),
      this.plotHost,
      this.legendHost,
      this.tableHost,
    ]);

    this.renderLegend();
    this.observer = new ResizeObserver(() => this.resize());
  }

  /** Create the plot once the host is in the document and has a width. */
  mount(): void {
    this.create();
    this.observer.observe(this.plotHost);
  }

  destroy(): void {
    this.observer.disconnect();
    this.plot?.destroy();
    this.plot = null;
  }

  private width(): number {
    return Math.max(240, Math.floor(this.plotHost.clientWidth) || 600);
  }

  private resize(): void {
    this.plot?.setSize({ width: this.width(), height: PLOT_HEIGHT });
  }

  private create(): void {
    const muted = cssValue('--text-muted', '#898781');
    const grid = cssValue('--grid', '#e1e0d9');
    const axis = cssValue('--axis', '#c3c2b7');
    const surface = cssValue('--surface', '#fcfcfb');
    const font = `12px ${cssValue('--font', 'system-ui, sans-serif')}`;

    const data: Array<Array<number | null>> = [this.timestamps];
    const series: uPlot.Series[] = [{}];
    const bands: uPlot.Band[] = [];

    for (const slot of this.slots) {
      const visible = !this.deps.hidden.has(slot.series.key);
      const color = seriesColor(slot.series.colorIndex);

      data.push(slot.series.values);
      series.push({
        label: slot.series.label,
        stroke: color,
        width: 2,
        show: visible,
        points: { show: false },
        // The crosshair marker carries a ring in the surface colour so it stays
        // legible where two lines cross.
        scale: 'y',
      });

      if (slot.maximumIndex !== null && slot.minimumIndex !== null) {
        data.push(slot.series.maximum as Array<number | null>);
        data.push(slot.series.minimum as Array<number | null>);
        const edge: uPlot.Series = {
          stroke: 'transparent',
          width: 0,
          show: visible,
          points: { show: false },
          scale: 'y',
        };
        series.push({ ...edge }, { ...edge });
        bands.push({
          series: [slot.maximumIndex, slot.minimumIndex],
          fill: bandFill(slot.series.colorIndex),
        });
      }
    }

    const options: uPlot.Options = {
      width: this.width(),
      height: PLOT_HEIGHT,
      // The panel heading names the plot; uPlot's own title and legend are off.
      legend: { show: false },
      cursor: {
        // One crosshair for the whole column: hovering any panel reads them all.
        sync: { key: SYNC_KEY, setSeries: false },
        y: false,
        points: { size: 8, width: 2, stroke: () => surface },
      },
      scales: { x: { time: true }, y: { auto: true } },
      axes: [
        {
          stroke: muted,
          font,
          grid: { stroke: grid, width: 1 },
          ticks: { stroke: axis, width: 1, size: 4 },
        },
        {
          scale: 'y',
          stroke: muted,
          font,
          size: 60,
          grid: { stroke: grid, width: 1 },
          ticks: { stroke: axis, width: 1, size: 4 },
          values: (_self, splits) => splits.map((value) => this.panel.unit.formatTick(value)),
        },
      ],
      series,
      bands,
      hooks: {
        setCursor: [(self) => this.updateReadout(self.cursor.idx ?? null)],
      },
    };

    this.plot = new uPlot(options, data as uPlot.AlignedData, this.plotHost);
    this.updateReadout(null);
  }

  /** Legend entries double as the live readout and as visibility switches. */
  private renderLegend(): void {
    clear(this.legendHost);
    this.valueNodes.clear();

    const multipleSources = new Set(this.panel.series.map((item) => item.source)).size > 1;

    for (const slot of this.slots) {
      const { series } = slot;
      const visible = !this.deps.hidden.has(series.key);
      const value = el('span', { class: 'legend__value', text: '—' });
      this.valueNodes.set(series.key, value);

      const label = multipleSources ? `${series.source} · ${series.label}` : series.label;
      const key = el('span', { class: 'legend__key' });
      key.style.background = seriesColor(series.colorIndex);

      const item = el(
        'button',
        {
          class: 'legend__item',
          attrs: {
            type: 'button',
            'aria-pressed': String(visible),
            title: `${series.source} · ${series.metric}`,
          },
          on: {
            click: () => this.toggle(slot, item),
          },
        },
        [key, el('span', { class: 'legend__label', text: label }), value],
      );
      this.legendHost.append(item);
    }
  }

  private toggle(slot: SeriesSlot, item: HTMLElement): void {
    const visible = this.deps.hidden.has(slot.series.key);
    this.deps.onToggle(slot.series.key, visible);
    item.setAttribute('aria-pressed', String(visible));

    const plot = this.plot;
    if (!plot) return;
    for (const index of [slot.valueIndex, slot.maximumIndex, slot.minimumIndex]) {
      if (index !== null) plot.setSeries(index, { show: visible });
    }
    if (this.tableOpen) this.renderTable();
  }

  /** Show the values at the crosshair, or the latest sample when it is away. */
  private updateReadout(index: number | null): void {
    const position = index ?? this.lastSampleIndex();
    if (position === null) {
      this.cursorLabel.textContent = '';
      for (const node of this.valueNodes.values()) node.textContent = '—';
      return;
    }

    const timestamp = this.timestamps[position];
    if (timestamp !== undefined) {
      const prefix = index === null ? 'Latest' : 'At cursor';
      this.cursorLabel.textContent = `${prefix}: ${formatLocal(timestamp)} · ${formatUtc(timestamp)}`;
    }

    for (const slot of this.slots) {
      const node = this.valueNodes.get(slot.series.key);
      if (!node) continue;
      const value = slot.series.values[position];
      node.textContent =
        value === null || value === undefined ? '—' : this.panel.unit.format(value);
    }
  }

  /** Index of the newest sample that any series in this panel actually has. */
  private lastSampleIndex(): number | null {
    for (let index = this.timestamps.length - 1; index >= 0; index -= 1) {
      for (const slot of this.slots) {
        const value = slot.series.values[index];
        if (value !== null && value !== undefined) return index;
      }
    }
    return null;
  }

  /** The accessible twin of the plot: the same numbers, newest first. */
  private renderTable(): void {
    clear(this.tableHost);
    if (!this.tableOpen) return;

    const visible = this.slots.filter((slot) => !this.deps.hidden.has(slot.series.key));
    const head = el('tr', {}, [
      el('th', { text: 'Time', attrs: { scope: 'col' } }),
      ...visible.map((slot) => el('th', { text: slot.series.label, attrs: { scope: 'col' } })),
    ]);

    const rows: HTMLElement[] = [];
    for (
      let index = this.timestamps.length - 1;
      index >= 0 && rows.length < TABLE_ROW_LIMIT;
      index -= 1
    ) {
      const timestamp = this.timestamps[index];
      if (timestamp === undefined) continue;
      const cells = visible.map((slot) => {
        const value = slot.series.values[index];
        return el('td', {
          text: value === null || value === undefined ? '—' : this.panel.unit.format(value),
        });
      });
      if (cells.every((cell) => cell.textContent === '—')) continue;
      rows.push(el('tr', {}, [el('td', { text: formatLocal(timestamp) }), ...cells]));
    }

    const caption =
      rows.length >= TABLE_ROW_LIMIT
        ? `Newest ${TABLE_ROW_LIMIT} samples of ${this.panel.title}.`
        : `${this.panel.title}, newest first.`;

    this.tableHost.append(
      el('div', { class: 'table-wrap' }, [
        el('table', {}, [
          el('caption', { class: 'visually-hidden', text: caption }),
          el('thead', {}, [head]),
          el('tbody', {}, rows),
        ]),
      ]),
      el('p', { class: 'stat__note', text: caption }),
    );
  }
}

/** Build one panel per unit and return them in display order. */
export function renderChart(
  host: HTMLElement,
  data: ChartData,
  deps: ChartPanelDeps,
): ChartPanel[] {
  clear(host);
  const panels = data.panels.map((panel) => new ChartPanel(panel, data.timestamps, deps));
  for (const panel of panels) host.append(panel.element);
  // uPlot measures its host, so it is created only after the panels are attached.
  for (const panel of panels) panel.mount();
  return panels;
}
