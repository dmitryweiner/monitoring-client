/**
 * Photo viewer.
 *
 * Shows the newest camera photo with previous/next navigation and a jump to a
 * date. The JPEG is private, so it is fetched with the session header and shown
 * through a blob URL rather than a plain image source. A small cache of recent
 * blobs makes stepping back and forth instant.
 *
 * Above the viewer a timeline shows where photos and audio clips fall in the
 * chosen range. At the bottom, under the photo and its details, sits the audio
 * clip recorded around it, when there is one, in the browser's own player; the
 * clip is private as well and reaches the player the same way as the JPEG.
 */

import { PHOTO_RANGE_STORAGE_KEY, PHOTO_RETENTION_DAYS, SECONDS_PER_DAY } from '../config.ts';
import type { StoredEvent } from '../api/types.ts';
import { PhotoNavigator, newestPhoto } from '../model/photoNav.ts';
import { dayKeyToTimestamp, localDayKey, localDayRange } from '../model/range.ts';
import { PHOTO_RANGE_PRESETS, audioForPhoto, clipInterval } from '../model/timeline.ts';
import { describeError, isAbort, type AppContext, type View } from './context.ts';
import { clear, el, field } from './dom.ts';
import {
  dateInputValue,
  filenameStamp,
  formatBytes,
  formatLocal,
  formatLocalTime,
  formatUtc,
} from './format.ts';
import { RangePicker } from './rangePicker.ts';
import { Timeline } from './timeline.ts';

/** Recently viewed photos kept decoded, so previous/next does not refetch. */
const CACHE_LIMIT = 10;

/**
 * A clip that starts shortly before local midnight can hold a photo taken just
 * after it, so each day's clip listing reaches this far into the day before.
 */
const CLIP_LOOKBACK_SECONDS = 120;

/** Ogg/Opus, as the agent records it. Safari before 18.4 cannot play it. */
const AUDIO_TYPE = 'audio/ogg; codecs="opus"';

interface CachedPhoto {
  url: string;
  size: number;
}

class BlobCache {
  private readonly entries = new Map<string, CachedPhoto>();

  constructor(private readonly load: (eventId: string, signal?: AbortSignal) => Promise<Blob>) {}

  async get(eventId: string, signal?: AbortSignal): Promise<CachedPhoto> {
    const existing = this.entries.get(eventId);
    if (existing) {
      // Refresh recency so the least recently used entry is evicted first.
      this.entries.delete(eventId);
      this.entries.set(eventId, existing);
      return existing;
    }

    const blob = await this.load(eventId, signal);
    const entry: CachedPhoto = { url: URL.createObjectURL(blob), size: blob.size };
    this.entries.set(eventId, entry);
    while (this.entries.size > CACHE_LIMIT) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const evicted = this.entries.get(oldest.value);
      if (evicted) URL.revokeObjectURL(evicted.url);
      this.entries.delete(oldest.value);
    }
    return entry;
  }

  has(eventId: string): boolean {
    return this.entries.has(eventId);
  }

  clear(): void {
    for (const entry of this.entries.values()) URL.revokeObjectURL(entry.url);
    this.entries.clear();
  }
}

export class PhotosView implements View {
  readonly element: HTMLElement;

  private readonly frame = el('div', { class: 'photo__frame' });
  private readonly audioHost = el('div', { class: 'photo__audio' });
  private readonly meta = el('div', { class: 'photo__meta' });
  private readonly navHost = el('div', { class: 'photo__nav' });
  private readonly dateInput = el('input', {
    attrs: { type: 'date', 'aria-label': 'Jump to date' },
  });

  private readonly newestButton: HTMLButtonElement;
  private readonly previousButton: HTMLButtonElement;
  private readonly nextButton: HTMLButtonElement;
  private readonly oldestButton: HTMLButtonElement;
  private readonly downloadButton: HTMLButtonElement;

  private readonly navigator: PhotoNavigator;
  private readonly cache: BlobCache;
  private readonly audioCache: BlobCache;
  private readonly timeline: Timeline;
  private readonly rangePicker: RangePicker;
  /** Audio clips per local day, loaded when a photo of that day is shown. */
  private readonly clipDays = new Map<string, StoredEvent[]>();
  private controller: AbortController | null = null;
  private busy = false;
  private readonly onKeyDown = (event: KeyboardEvent) => this.handleKey(event);

  constructor(private readonly context: AppContext) {
    this.navigator = new PhotoNavigator({
      load: (dayKey) => this.loadDay(dayKey),
      retentionDays: PHOTO_RETENTION_DAYS,
      now: () => Date.now() / 1000,
    });
    this.cache = new BlobCache((eventId, signal) => this.context.api.photoBlob(eventId, signal));
    this.audioCache = new BlobCache((eventId, signal) =>
      this.context.api.audioBlob(eventId, signal),
    );
    this.timeline = new Timeline(context, {
      onPick: (photo) => void this.go(() => this.navigator.select(photo)),
    });
    this.rangePicker = new RangePicker({
      presets: PHOTO_RANGE_PRESETS,
      defaultId: '24h',
      storageKey: PHOTO_RANGE_STORAGE_KEY,
      kind: 'photo',
      onChange: () => void this.timeline.load(this.rangePicker.range()),
    });

    this.newestButton = this.button('Newest', () => this.go(() => this.navigator.newest()));
    this.previousButton = this.button('← Previous', () => this.go(() => this.navigator.previous()));
    this.nextButton = this.button('Next →', () => this.go(() => this.navigator.next()));
    this.oldestButton = this.button('Oldest', () => this.go(() => this.navigator.oldest()));
    this.downloadButton = this.button('Download', () => void this.download());

    this.updateDateBounds();
    this.dateInput.addEventListener('change', () => {
      const timestamp = dayKeyToTimestamp(this.dateInput.value);
      if (timestamp !== null) void this.go(() => this.navigator.jumpTo(timestamp));
    });

    // Left to right runs from older to newer, matching the arrows between them.
    this.navHost.append(
      this.oldestButton,
      this.previousButton,
      this.nextButton,
      this.newestButton,
      el('span', { class: 'filters__spacer' }),
      this.dateInput,
      this.downloadButton,
    );

    // Refresh and what is loaded, then the range and the ruler, as on the chart page.
    const filters = el('div', { class: 'filters filters--stack' }, [
      el('div', { class: 'filters__row' }, [
        el('button', {
          class: 'button button--primary',
          text: 'Refresh',
          attrs: { type: 'button' },
          on: { click: () => this.refresh() },
        }),
        this.timeline.summary,
      ]),
      this.rangePicker.element,
      this.timeline.element,
    ]);

    this.element = el('section', { class: 'photo' }, [
      el('h2', { text: 'Camera archive' }),
      filters,
      this.navHost,
      this.frame,
      this.meta,
      this.audioHost,
      el('p', {
        class: 'stat__note',
        text: `Photos and audio are kept for ${PHOTO_RETENTION_DAYS} days. Click the timeline to open the photo nearest that moment. Use the arrow keys to step, Home and End for the newest and oldest.`,
      }),
    ]);
  }

  mount(): void {
    document.addEventListener('keydown', this.onKeyDown);
    void this.go(() => this.start());
    void this.timeline.load(this.rangePicker.range());
  }

  /**
   * Take in what arrived since the page opened: the ruler, the per-day photo
   * and clip listings, and the current photo's place in its day. The photo on
   * screen stays; Next and Newest reach the new ones.
   */
  private refresh(): void {
    this.navigator.invalidate();
    this.clipDays.clear();
    this.updateDateBounds();
    void this.timeline.load(this.rangePicker.range());
    const photo = this.navigator.photo;
    void this.go(() => (photo ? this.navigator.select(photo) : this.start()));
  }

  private updateDateBounds(): void {
    const now = Date.now() / 1000;
    this.dateInput.min = dateInputValue(now - PHOTO_RETENTION_DAYS * SECONDS_PER_DAY);
    this.dateInput.max = dateInputValue(now);
  }

  /**
   * The newest photo in one request: /v1/latest already carries it. Scanning
   * days backwards is the fallback for an archive with nothing recent.
   */
  private async start(): Promise<StoredEvent | null> {
    try {
      const latest = await this.context.api.latest(this.controller?.signal);
      const photo = newestPhoto(latest.items);
      if (photo) return this.navigator.select(photo);
    } catch (error) {
      if (isAbort(error)) throw error;
    }
    return this.navigator.newest();
  }

  destroy(): void {
    document.removeEventListener('keydown', this.onKeyDown);
    this.controller?.abort();
    this.timeline.destroy();
    this.stopAudio();
    this.cache.clear();
    this.audioCache.clear();
  }

  private button(label: string, onClick: () => void): HTMLButtonElement {
    return el('button', {
      class: 'button',
      text: label,
      attrs: { type: 'button' },
      on: { click: onClick },
    });
  }

  private handleKey(event: KeyboardEvent): void {
    const target = event.target;
    // The audio player takes the arrow keys for seeking.
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLMediaElement ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    )
      return;
    const actions: Record<string, (() => Promise<StoredEvent | null>) | undefined> = {
      ArrowLeft: () => this.navigator.previous(),
      ArrowRight: () => this.navigator.next(),
      Home: () => this.navigator.newest(),
      End: () => this.navigator.oldest(),
    };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault();
    void this.go(action);
  }

  /** One local calendar day of photo metadata; up to 1440 items in attention mode. */
  private async loadDay(dayKey: string): Promise<StoredEvent[]> {
    const timestamp = dayKeyToTimestamp(dayKey);
    if (timestamp === null) return [];
    const range = localDayRange(timestamp);
    return this.context.api.allPhotos({ ...range, signal: this.controller?.signal });
  }

  /** Run a navigation step, then show whatever it landed on. */
  private async go(step: () => Promise<StoredEvent | null>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.setBusy(true);
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;

    try {
      const photo = await step();
      if (controller.signal.aborted) return;
      this.context.clearNotice();
      if (!photo) {
        this.showEmpty();
        return;
      }
      await this.show(photo, controller.signal);
      void this.prefetchNeighbours();
    } catch (error) {
      if (isAbort(error) || controller.signal.aborted) return;
      this.context.notify(describeError(error), 'error');
    } finally {
      this.busy = false;
      if (this.controller === controller) this.setBusy(false);
      this.updateButtons();
    }
  }

  private setBusy(busy: boolean): void {
    this.frame.classList.toggle('is-refetching', busy);
    for (const button of [
      this.previousButton,
      this.nextButton,
      this.newestButton,
      this.oldestButton,
    ]) {
      button.disabled = busy;
    }
  }

  private updateButtons(): void {
    const photo = this.navigator.photo;
    this.downloadButton.disabled = !photo || !this.cache.has(photo.event_id);
    if (photo) this.dateInput.value = dateInputValue(photo.observed_at);
    this.timeline.setCurrent(photo);
  }

  private showEmpty(): void {
    clear(this.frame);
    clear(this.meta);
    this.clearAudio();
    this.frame.append(
      el('p', { class: 'empty', text: 'No photo was found in the retained archive.' }),
    );
  }

  private async show(photo: StoredEvent, signal: AbortSignal): Promise<void> {
    let entry: CachedPhoto;
    try {
      entry = await this.cache.get(photo.event_id, signal);
    } catch (error) {
      if (isAbort(error)) return;
      clear(this.frame);
      clear(this.meta);
      this.clearAudio();
      // Retention can remove a photo between listing it and fetching it.
      this.frame.append(el('p', { class: 'empty', text: describeError(error) }));
      return;
    }
    if (signal.aborted) return;

    clear(this.frame);
    this.frame.append(
      el('img', {
        class: 'photo__image',
        attrs: {
          src: entry.url,
          alt: `Camera view at ${formatLocal(photo.observed_at)}`,
          decoding: 'async',
        },
      }),
    );

    const position = this.navigator.position();
    const changed = photo.values['changed_percent'];
    clear(this.meta);
    this.meta.append(
      field('Taken', formatLocal(photo.observed_at)),
      field('UTC', formatUtc(photo.observed_at)),
      field('Size', formatBytes(entry.size)),
      field('Delivered', formatLocal(photo.received_at)),
      position
        ? field('In day', `${position.indexInDay} of ${position.countInDay}`)
        : field('In day', '—'),
    );
    if (photo.values['attention'] === 1) this.meta.append(field('Mode', 'attention'));
    if (changed !== undefined) this.meta.append(field('Changed', `${changed.toFixed(1)} %`));

    this.clearAudio();
    void this.showAudio(photo, signal);
  }

  /** Clips recorded on the photo's local day, plus the tail of the day before. */
  private async clipsAround(photo: StoredEvent, signal: AbortSignal): Promise<StoredEvent[]> {
    const dayKey = localDayKey(photo.observed_at);
    const cached = this.clipDays.get(dayKey);
    if (cached) return cached;
    const range = localDayRange(photo.observed_at);
    const clips = await this.context.api.allAudio({
      start: range.start - CLIP_LOOKBACK_SECONDS,
      end: range.end,
      signal,
    });
    // Today is still being recorded, so only finished days are kept.
    if (range.end < Date.now() / 1000) this.clipDays.set(dayKey, clips);
    return clips;
  }

  /**
   * The player for the clip recorded around the photo. It loads after the
   * photo is on screen, so stepping through photos never waits for audio.
   */
  private async showAudio(photo: StoredEvent, signal: AbortSignal): Promise<void> {
    const stillShown = () => !signal.aborted && this.navigator.photo?.event_id === photo.event_id;
    try {
      const clip = audioForPhoto(photo, await this.clipsAround(photo, signal));
      if (!stillShown()) return;
      if (!clip) {
        if (photo.values['attention'] === 1) {
          this.audioHost.append(
            el('p', {
              class: 'stat__note',
              text: 'No audio around this photo: the room was quieter than the recording threshold.',
            }),
          );
        }
        return;
      }

      const entry = await this.audioCache.get(clip.event_id, signal);
      if (!stillShown()) return;
      this.renderAudio(clip, entry);
    } catch (error) {
      if (isAbort(error) || !stillShown()) return;
      this.audioHost.append(el('p', { class: 'stat__note', text: describeError(error) }));
    }
  }

  private renderAudio(clip: StoredEvent, entry: CachedPhoto): void {
    const interval = clipInterval(clip);
    const peak = clip.values['peak_dbfs'];
    const player = el('audio', {
      class: 'photo__player',
      attrs: {
        controls: 'controls',
        preload: 'metadata',
        src: entry.url,
        'aria-label': `Audio from ${formatLocal(interval.start)}`,
      },
    });
    const playable = player.canPlayType(AUDIO_TYPE) !== '';

    this.audioHost.append(
      playable
        ? player
        : el('p', {
            class: 'notice notice--warning',
            text: 'This browser cannot play Ogg/Opus audio. Download the clip to listen to it.',
          }),
      el('div', { class: 'photo__meta' }, [
        field('Audio', `${formatLocalTime(interval.start)} – ${formatLocalTime(interval.end)}`),
        field('Length', `${Math.round(interval.end - interval.start)} s`),
        peak !== undefined ? field('Peak', `${peak.toFixed(1)} dBFS`) : null,
        field('Size', formatBytes(entry.size)),
        el('a', {
          class: 'photo__audio-link',
          text: 'Download audio',
          attrs: { href: entry.url, download: `home-${filenameStamp(clip.observed_at)}.ogg` },
        }),
      ]),
    );
  }

  /** A detached <audio> keeps playing, so the player is paused before it goes. */
  private stopAudio(): void {
    for (const player of this.audioHost.querySelectorAll('audio')) player.pause();
  }

  private clearAudio(): void {
    this.stopAudio();
    clear(this.audioHost);
  }

  /** Warm the cache in both directions so stepping does not wait on the network. */
  private async prefetchNeighbours(): Promise<void> {
    for (const direction of [-1, 1] as const) {
      try {
        const neighbour = await this.navigator.peek(direction);
        if (neighbour && !this.cache.has(neighbour.event_id)) {
          await this.cache.get(neighbour.event_id);
        }
      } catch {
        // Prefetching is best effort; a failure is retried when the reader steps.
      }
    }
  }

  private async download(): Promise<void> {
    const photo = this.navigator.photo;
    if (!photo) return;
    try {
      const entry = await this.cache.get(photo.event_id);
      const link = el('a', {
        attrs: { href: entry.url, download: `home-${filenameStamp(photo.observed_at)}.jpg` },
      });
      link.click();
    } catch (error) {
      this.context.notify(describeError(error), 'error');
    }
  }
}
