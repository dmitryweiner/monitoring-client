/**
 * Dashboard.
 *
 * Answers the three questions a glance is for: is the device delivering, what
 * is it measuring, and what does the camera see. Each headline number is a
 * stat tile rather than a one-bar chart.
 */

import {
  DEVICE_LATE_SECONDS,
  DEVICE_ONLINE_SECONDS,
  POLL_INTERVAL_MS,
  SAMPLE_INTERVAL_SECONDS,
  SECONDS_PER_DAY,
} from '../config.ts';
import type { LatestResponse, StoredEvent } from '../api/types.ts';
import { unitForMetric } from '../model/units.ts';
import { humanizeMetric } from '../model/series.ts';
import { newestPhoto } from '../model/photoNav.ts';
import { clear, el, field } from './dom.ts';
import { formatAge, formatBytes, formatLocal, formatUtc } from './format.ts';
import { describeError, isAbort, type AppContext, type View } from './context.ts';

type Tone = 'good' | 'warning' | 'critical' | 'muted';

const GLYPH: Record<Tone, string> = {
  good: '●',
  warning: '▲',
  critical: '■',
  muted: '○',
};

/** Status is never carried by colour alone: every badge has a glyph and a word. */
function badge(tone: Tone, text: string): HTMLElement {
  return el('span', { class: `badge badge--${tone}` }, [
    el('span', { class: 'badge__glyph', text: GLYPH[tone], attrs: { 'aria-hidden': 'true' } }),
    text,
  ]);
}

function statCard(label: string, value: string, note?: string, hero = false): HTMLElement {
  return el('div', { class: 'card' }, [
    el('p', { class: 'stat__label', text: label }),
    el('div', { class: `stat__value${hero ? ' stat__value--hero' : ''}`, text: value }),
    note ? el('p', { class: 'stat__note', text: note }) : null,
  ]);
}

export class DashboardView implements View {
  readonly element: HTMLElement;

  private readonly statusHost = el('div', { class: 'filters' });
  private readonly cardsHost = el('div', { class: 'cards' });
  private readonly cameraHost = el('div', {});
  private readonly warningsHost = el('div', {});

  private controller: AbortController | null = null;
  private timer: number | null = null;
  private thumbnailUrl: string | null = null;
  private readonly onVisibility = () => this.handleVisibility();

  constructor(private readonly context: AppContext) {
    this.element = el('section', {}, [
      this.statusHost,
      this.warningsHost,
      this.cardsHost,
      this.cameraHost,
    ]);
  }

  mount(): void {
    void this.load();
    this.timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void this.load();
    }, POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  destroy(): void {
    this.controller?.abort();
    if (this.timer !== null) window.clearInterval(this.timer);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.releaseThumbnail();
  }

  private handleVisibility(): void {
    if (document.visibilityState === 'visible') void this.load();
  }

  private releaseThumbnail(): void {
    if (this.thumbnailUrl) URL.revokeObjectURL(this.thumbnailUrl);
    this.thumbnailUrl = null;
  }

  private async load(): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;

    // Refetch holds the previous render, dimmed, instead of flashing a skeleton.
    this.element.classList.add('is-refetching');
    try {
      const now = Date.now() / 1000;
      const [latest, cameraErrors] = await Promise.all([
        this.context.api.latest(controller.signal),
        this.context.api
          .allMeasurements({
            start: now - SECONDS_PER_DAY,
            end: now,
            source: 'camera',
            signal: controller.signal,
          })
          .catch(() => [] as StoredEvent[]),
      ]);
      if (controller.signal.aborted) return;
      this.context.clearNotice();
      this.render(latest, cameraErrors, now);
    } catch (error) {
      if (isAbort(error) || controller.signal.aborted) return;
      this.context.notify(describeError(error), 'error');
    } finally {
      if (this.controller === controller) this.element.classList.remove('is-refetching');
    }
  }

  private render(latest: LatestResponse, cameraErrors: StoredEvent[], now: number): void {
    const measurements = latest.items.filter((item) => item.kind === 'measurement');
    const photo = newestPhoto(latest.items);

    this.renderStatus(latest, now);
    this.renderWarnings(measurements, cameraErrors, now);
    this.renderCards(measurements, now);
    this.renderCamera(photo, now);
  }

  private renderStatus(latest: LatestResponse, now: number): void {
    clear(this.statusHost);
    const lastSeen = latest.last_seen;
    const age = lastSeen === null ? null : now - lastSeen;

    let tone: Tone = 'muted';
    let word = 'No data yet';
    if (age !== null) {
      if (age <= DEVICE_ONLINE_SECONDS) {
        tone = 'good';
        word = 'Delivering';
      } else if (age <= DEVICE_LATE_SECONDS) {
        tone = 'warning';
        word = 'Late';
      } else {
        tone = 'critical';
        word = 'Silent';
      }
    }

    this.statusHost.append(
      el('h2', { text: `Device ${latest.device_id}` }),
      badge(tone, word),
      el('span', {
        class: 'stat__note',
        text: lastSeen === null ? 'never reported' : `last upload ${formatAge(age ?? 0)}`,
        title: lastSeen === null ? '' : `${formatLocal(lastSeen)} · ${formatUtc(lastSeen)}`,
      }),
      el('span', { class: 'filters__spacer' }),
      // Same action, same weight as on the chart page.
      el('button', {
        class: 'button button--primary',
        text: 'Refresh',
        attrs: { type: 'button' },
        on: { click: () => void this.load() },
      }),
    );
  }

  private renderWarnings(
    measurements: StoredEvent[],
    cameraErrors: StoredEvent[],
    now: number,
  ): void {
    clear(this.warningsHost);
    const notices: string[] = [];

    const newest = measurements.reduce<number | null>(
      (best, item) => (best === null || item.observed_at > best ? item.observed_at : best),
      null,
    );
    if (newest !== null && now - newest > 2 * SAMPLE_INTERVAL_SECONDS) {
      notices.push(
        `No measurement for ${formatAge(now - newest)}; the expected interval is 10 minutes.`,
      );
    }
    if (measurements.some((item) => !item.clock_synchronized)) {
      notices.push('The device reports its clock as not synchronised, so times may be inaccurate.');
    }
    const failed = cameraErrors.filter((item) => item.status === 'error').length;
    if (failed > 0) {
      notices.push(
        `The camera failed ${failed} time${failed === 1 ? '' : 's'} in the last 24 hours.`,
      );
    }
    for (const item of measurements) {
      if (item.status === 'error' && item.source !== 'camera') {
        notices.push(
          `Source "${item.source}" reported an error at ${formatLocal(item.observed_at)}.`,
        );
      }
    }

    for (const text of notices) {
      this.warningsHost.append(
        el('p', { class: 'notice notice--warning' }, [
          el('span', { text: GLYPH.warning, attrs: { 'aria-hidden': 'true' } }),
          text,
        ]),
      );
    }
  }

  private renderCards(measurements: StoredEvent[], now: number): void {
    clear(this.cardsHost);

    interface Reading {
      source: string;
      metric: string;
      value: number;
      observedAt: number;
    }
    const readings: Reading[] = [];
    for (const item of measurements) {
      for (const [metric, value] of Object.entries(item.values)) {
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        readings.push({ source: item.source, metric, value, observedAt: item.observed_at });
      }
    }
    readings.sort((left, right) =>
      `${left.source}.${left.metric}`.localeCompare(`${right.source}.${right.metric}`),
    );

    if (readings.length === 0) {
      this.cardsHost.append(el('p', { class: 'empty', text: 'No measurements have arrived yet.' }));
      return;
    }

    // The lead number is a temperature when there is one; there is exactly one hero.
    const heroIndex = readings.findIndex(
      (reading) => unitForMetric(reading.metric).id === 'celsius',
    );
    const ordered =
      heroIndex > 0
        ? [readings[heroIndex]!, ...readings.filter((_, index) => index !== heroIndex)]
        : readings;

    ordered.forEach((reading, index) => {
      const unit = unitForMetric(reading.metric);
      const label = `${humanizeMetric(reading.metric)} · ${reading.source}`;
      const note = `${formatAge(now - reading.observedAt)} · ${formatLocal(reading.observedAt)}`;
      this.cardsHost.append(
        statCard(label, unit.format(reading.value), note, index === 0 && heroIndex !== -1),
      );
    });
  }

  private renderCamera(photo: StoredEvent | null, now: number): void {
    clear(this.cameraHost);
    this.releaseThumbnail();

    if (!photo) {
      this.cameraHost.append(
        el('div', { class: 'card' }, [
          el('h2', { text: 'Camera' }),
          el('p', { class: 'empty', text: 'No photo has been delivered yet.' }),
        ]),
      );
      return;
    }

    const frame = el('div', { class: 'photo__frame' }, [
      el('p', { class: 'empty', text: 'Loading the latest photo…' }),
    ]);

    this.cameraHost.append(
      el('div', { class: 'card' }, [
        el('div', { class: 'panel__head' }, [
          el('h2', { class: 'panel__title', text: 'Latest photo' }),
          el('span', {
            class: 'stat__note',
            text: `${formatAge(now - photo.observed_at)} · ${formatLocal(photo.observed_at)}`,
            title: formatUtc(photo.observed_at),
          }),
          el('button', {
            class: 'button',
            text: 'Open viewer',
            attrs: { type: 'button' },
            on: { click: () => this.context.navigate('#/photos') },
          }),
        ]),
        frame,
      ]),
    );

    void this.loadThumbnail(photo, frame);
  }

  private async loadThumbnail(photo: StoredEvent, frame: HTMLElement): Promise<void> {
    const controller = this.controller;
    try {
      const blob = await this.context.api.photoBlob(photo.event_id, controller?.signal);
      if (controller?.signal.aborted) return;
      this.releaseThumbnail();
      this.thumbnailUrl = URL.createObjectURL(blob);
      clear(frame);
      frame.append(
        el('img', {
          class: 'photo__image',
          attrs: {
            src: this.thumbnailUrl,
            alt: `Camera view at ${formatLocal(photo.observed_at)}`,
          },
        }),
      );
      frame.after(el('p', { class: 'photo__meta' }, [field('Size', formatBytes(blob.size))]));
    } catch (error) {
      if (isAbort(error)) return;
      clear(frame);
      frame.append(el('p', { class: 'empty', text: describeError(error) }));
    }
  }
}
