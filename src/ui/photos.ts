/**
 * Photo viewer.
 *
 * Shows the newest camera photo with previous/next navigation and a jump to a
 * date. The JPEG is private, so it is fetched with the session header and shown
 * through a blob URL rather than a plain image source. A small cache of recent
 * blobs makes stepping back and forth instant.
 */

import { PHOTO_RETENTION_DAYS, SECONDS_PER_DAY } from '../config.ts';
import type { StoredEvent } from '../api/types.ts';
import { PhotoNavigator } from '../model/photoNav.ts';
import { dayKeyToTimestamp, localDayRange } from '../model/range.ts';
import { describeError, isAbort, type AppContext, type View } from './context.ts';
import { clear, el, field } from './dom.ts';
import { dateInputValue, filenameStamp, formatBytes, formatLocal, formatUtc } from './format.ts';

/** Recently viewed photos kept decoded, so previous/next does not refetch. */
const CACHE_LIMIT = 10;

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

    this.newestButton = this.button('Newest', () => this.go(() => this.navigator.newest()));
    this.previousButton = this.button('← Previous', () => this.go(() => this.navigator.previous()));
    this.nextButton = this.button('Next →', () => this.go(() => this.navigator.next()));
    this.oldestButton = this.button('Oldest', () => this.go(() => this.navigator.oldest()));
    this.downloadButton = this.button('Download', () => void this.download());

    const now = Date.now() / 1000;
    this.dateInput.min = dateInputValue(now - PHOTO_RETENTION_DAYS * SECONDS_PER_DAY);
    this.dateInput.max = dateInputValue(now);
    this.dateInput.addEventListener('change', () => {
      const timestamp = dayKeyToTimestamp(this.dateInput.value);
      if (timestamp !== null) void this.go(() => this.navigator.jumpTo(timestamp));
    });

    this.navHost.append(
      this.newestButton,
      this.previousButton,
      this.nextButton,
      this.oldestButton,
      el('span', { class: 'filters__spacer' }),
      this.dateInput,
      this.downloadButton,
    );

    this.element = el('section', { class: 'photo' }, [
      el('h2', { text: 'Camera archive' }),
      this.navHost,
      this.frame,
      this.meta,
      el('p', {
        class: 'stat__note',
        text: `Photos are kept for ${PHOTO_RETENTION_DAYS} days. Use the arrow keys to step, Home and End for the newest and oldest.`,
      }),
    ]);
  }

  mount(): void {
    document.addEventListener('keydown', this.onKeyDown);
    void this.go(() => this.start());
  }

  /**
   * The newest photo in one request: /v1/latest already carries it. Scanning
   * days backwards is the fallback for an archive with nothing recent.
   */
  private async start(): Promise<StoredEvent | null> {
    try {
      const latest = await this.context.api.latest(this.controller?.signal);
      const photo = latest.items.find((item) => item.kind === 'photo');
      if (photo) return this.navigator.select(photo);
    } catch (error) {
      if (isAbort(error)) throw error;
    }
    return this.navigator.newest();
  }

  destroy(): void {
    document.removeEventListener('keydown', this.onKeyDown);
    this.controller?.abort();
    this.cache.clear();
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
    if (target instanceof HTMLInputElement || event.metaKey || event.ctrlKey || event.altKey)
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

  /** One local calendar day of photo metadata; at most 144 items. */
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
  }

  private showEmpty(): void {
    clear(this.frame);
    clear(this.meta);
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
