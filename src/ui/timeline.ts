/**
 * The ruler above the photo viewer.
 *
 * A time axis for the range chosen above it, with a mark wherever photos were taken,
 * attention-mode photos set apart, a band for every stretch with recorded
 * audio, and a line at the photo on screen. Clicking the ruler opens the photo
 * nearest to that moment.
 *
 * A month can hold tens of thousands of photos, so photos are drawn as one
 * mark per slice of the range and audio as merged runs, which keeps the SVG to
 * a few hundred elements whatever the range.
 */

import { TIMELINE_MAX_PAGES } from '../config.ts';
import type { StoredEvent } from '../api/types.ts';
import type { TimeRange } from '../model/range.ts';
import {
  axisTicks,
  binPhotos,
  fraction,
  mergeIntervals,
  nearestEvent,
  visibleClips,
} from '../model/timeline.ts';
import { describeError, isAbort, type AppContext } from './context.ts';
import { clear, el } from './dom.ts';
import { formatLocal, formatLocalDay, formatLocalTime } from './format.ts';

/** Slices of the range that photos are grouped into, one mark each. */
const PHOTO_BINS = 400;

/** Axis labels on the ruler; few enough to fit a phone. */
const MAX_AXIS_LABELS = 6;

/** Labels closer than this to either end would be clipped, so they are left out. */
const LABEL_EDGE = 0.04;

/** Narrowest audio band, as a share of the ruler, so a lone clip stays visible. */
const MIN_BAND = 0.003;

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
}

function percent(share: number): string {
  return `${(share * 100).toFixed(3)}%`;
}

export interface TimelineOptions {
  /** Open a photo the reader picked on the ruler. */
  onPick: (photo: StoredEvent) => void;
}

export class Timeline {
  readonly element: HTMLElement;
  /** What the loaded range holds; the page places it beside its Refresh button. */
  readonly summary = el('span', { class: 'stat__note' });
  private readonly readout = el('span', { class: 'timeline__readout' });
  private readonly ruler = svg('svg', {
    class: 'timeline__ruler',
    width: '100%',
    height: 60,
    role: 'img',
    'aria-label': 'Photo timeline',
  });
  private readonly content = svg('g');
  private readonly hoverLine = svg('line', {
    class: 'timeline__hover',
    y1: 0,
    y2: 44,
    visibility: 'hidden',
  });
  private readonly currentLine = svg('line', {
    class: 'timeline__current',
    y1: 0,
    y2: 44,
    visibility: 'hidden',
  });
  private range: TimeRange | null = null;
  private photos: StoredEvent[] = [];
  private current: StoredEvent | null = null;
  private controller: AbortController | null = null;

  constructor(
    private readonly context: AppContext,
    private readonly options: TimelineOptions,
  ) {
    // A transparent surface under everything catches the pointer anywhere on the ruler.
    const surface = svg('rect', {
      class: 'timeline__surface',
      x: 0,
      y: 0,
      width: '100%',
      height: '100%',
    });
    this.ruler.append(surface, this.content, this.hoverLine, this.currentLine);
    this.ruler.addEventListener('click', (event) => this.pick(event));
    this.ruler.addEventListener('pointermove', (event) => this.hover(event));
    this.ruler.addEventListener('pointerleave', () => this.endHover());

    this.element = el('div', { class: 'filters__block timeline' }, [
      this.ruler,
      el('div', { class: 'timeline__legend' }, [
        this.legendKey('timeline__key--photo', 'Photo'),
        this.legendKey('timeline__key--attention', 'Attention mode'),
        this.legendKey('timeline__key--audio', 'Audio'),
        this.readout,
      ]),
    ]);
  }

  destroy(): void {
    this.controller?.abort();
  }

  /** Mark the photo on screen. Outside the loaded range the marker is hidden. */
  setCurrent(photo: StoredEvent | null): void {
    this.current = photo;
    this.placeCurrent();
  }

  private legendKey(modifier: string, label: string): HTMLElement {
    return el('span', { class: 'timeline__legend-item' }, [
      el('span', { class: `timeline__key ${modifier}` }),
      label,
    ]);
  }

  async load(range: TimeRange): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.element.classList.add('is-refetching');

    const query = { ...range, signal: controller.signal, maxPages: TIMELINE_MAX_PAGES };

    try {
      const [photos, clips] = await Promise.all([
        this.context.api.allPhotos(query),
        this.context.api.allAudio(query),
      ]);
      if (controller.signal.aborted) return;
      this.range = range;
      this.photos = [...photos].sort((left, right) => left.observed_at - right.observed_at);
      this.render(visibleClips(clips));
    } catch (error) {
      if (isAbort(error) || controller.signal.aborted) return;
      this.context.notify(describeError(error), 'error');
    } finally {
      if (this.controller === controller) this.element.classList.remove('is-refetching');
    }
  }

  private render(clips: StoredEvent[]): void {
    const range = this.range;
    clear(this.content);
    if (!range) return;

    const attention = this.photos.filter((photo) => photo.values['attention'] === 1).length;
    const parts = [`${this.photos.length} photo${this.photos.length === 1 ? '' : 's'}`];
    if (attention > 0) parts.push(`${attention} in attention mode`);
    parts.push(`${clips.length} audio clip${clips.length === 1 ? '' : 's'}`);
    parts.push(`${formatLocal(range.start)} → ${formatLocal(range.end)}`);
    this.summary.textContent = parts.join(' · ');

    // Audio runs along the top.
    const span = range.end - range.start;
    for (const interval of mergeIntervals(clips, span / PHOTO_BINS)) {
      const start = Math.max(0, fraction(range, interval.start));
      const end = Math.min(1, fraction(range, interval.end));
      if (end <= 0 || start >= 1) continue;
      const band = svg('rect', {
        class: 'timeline__audio',
        x: percent(start),
        y: 2,
        width: percent(Math.max(MIN_BAND, end - start)),
        height: 8,
        rx: 2,
      });
      const title = svg('title');
      title.textContent = `Audio ${formatLocal(interval.start)} – ${formatLocalTime(interval.end)}`;
      band.append(title);
      this.content.append(band);
    }

    // One mark per slice with photos; attention-mode slices stand taller.
    const width = 1 / PHOTO_BINS;
    for (const bin of binPhotos(this.photos, range, PHOTO_BINS)) {
      this.content.append(
        svg('rect', {
          class: bin.attention ? 'timeline__photo timeline__photo--attention' : 'timeline__photo',
          x: percent(bin.index * width),
          y: bin.attention ? 14 : 22,
          width: percent(width),
          height: bin.attention ? 26 : 18,
        }),
      );
    }

    this.content.append(
      svg('line', { class: 'timeline__axis', x1: 0, x2: '100%', y1: 40.5, y2: 40.5 }),
    );
    for (const tick of axisTicks(range, MAX_AXIS_LABELS)) {
      const share = fraction(range, tick.at);
      this.content.append(
        svg('line', {
          class: 'timeline__axis',
          x1: percent(share),
          x2: percent(share),
          y1: 40,
          y2: 45,
        }),
      );
      if (share < LABEL_EDGE || share > 1 - LABEL_EDGE) continue;
      const label = svg('text', {
        class: tick.midnight ? 'timeline__label timeline__label--day' : 'timeline__label',
        x: percent(share),
        y: 57,
        'text-anchor': 'middle',
      });
      label.textContent = tick.midnight ? formatLocalDay(tick.at) : formatLocalTime(tick.at);
      this.content.append(label);
    }

    if (this.photos.length === 0) {
      const empty = svg('text', {
        class: 'timeline__label',
        x: '50%',
        y: 28,
        'text-anchor': 'middle',
      });
      empty.textContent = 'No photos in this range';
      this.content.append(empty);
    }

    this.placeCurrent();
  }

  private placeCurrent(): void {
    const range = this.range;
    const photo = this.current;
    const share = range && photo ? fraction(range, photo.observed_at) : -1;
    if (share < 0 || share > 1) {
      this.currentLine.setAttribute('visibility', 'hidden');
      return;
    }
    this.currentLine.setAttribute('x1', percent(share));
    this.currentLine.setAttribute('x2', percent(share));
    this.currentLine.setAttribute('visibility', 'visible');
  }

  /** The moment under the pointer, or null before anything is loaded. */
  private timeAt(event: MouseEvent): number | null {
    const range = this.range;
    if (!range) return null;
    const box = this.ruler.getBoundingClientRect();
    if (box.width <= 0) return null;
    const share = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    return range.start + share * (range.end - range.start);
  }

  private pick(event: MouseEvent): void {
    const timestamp = this.timeAt(event);
    if (timestamp === null) return;
    const photo = nearestEvent(this.photos, timestamp);
    if (photo) this.options.onPick(photo);
  }

  private hover(event: MouseEvent): void {
    const timestamp = this.timeAt(event);
    const range = this.range;
    if (timestamp === null || !range) return;
    const share = percent(fraction(range, timestamp));
    this.hoverLine.setAttribute('x1', share);
    this.hoverLine.setAttribute('x2', share);
    this.hoverLine.setAttribute('visibility', 'visible');
    const photo = nearestEvent(this.photos, timestamp);
    this.readout.textContent = photo
      ? `${formatLocal(timestamp)} · nearest photo ${formatLocal(photo.observed_at)}`
      : formatLocal(timestamp);
  }

  private endHover(): void {
    this.hoverLine.setAttribute('visibility', 'hidden');
    this.readout.textContent = '';
  }
}
