// @vitest-environment happy-dom

/**
 * Wiring tests for the shell and the views.
 *
 * uPlot needs a real canvas, which no DOM implementation provides, so the chart
 * page is exercised against a stub. What is checked here is that each view
 * asks the API for the right thing and puts the right text on the page.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const plotInstances: Array<{ destroy: () => void }> = [];

vi.mock('uplot', () => {
  class FakePlot {
    constructor() {
      plotInstances.push(this as unknown as { destroy: () => void });
    }
    setSize(): void {}
    setSeries(): void {}
    destroy(): void {}
  }
  return { default: FakePlot };
});
vi.mock('uplot/dist/uPlot.min.css', () => ({}));

import { ApiClient } from '../src/api/client.ts';
import { MonitoringApi } from '../src/api/monitoring.ts';
import { SessionStore } from '../src/api/session.ts';
import type { StoredEvent } from '../src/api/types.ts';
import { App } from '../src/ui/app.ts';

const NOW = Date.now() / 1000;

function measurement(
  source: string,
  values: Record<string, number>,
  observedAt = NOW - 60,
  status: 'ok' | 'error' = 'ok',
): StoredEvent {
  return {
    schema_version: 1,
    device_id: 'home',
    event_id: `m-${source}-${observedAt}`,
    observed_at: observedAt,
    kind: 'measurement',
    source,
    status,
    values,
    clock_synchronized: true,
    received_at: observedAt + 2,
  };
}

function photo(observedAt: number): StoredEvent {
  return {
    schema_version: 1,
    device_id: 'home',
    event_id: `p-${observedAt}`,
    observed_at: observedAt,
    kind: 'photo',
    source: 'camera',
    status: 'ok',
    values: {},
    clock_synchronized: true,
    received_at: observedAt + 5,
  };
}

/**
 * Two photo sources, as the live archive has: a leftover acceptance photo and
 * the camera. The API lists the older one first, so anything that takes the
 * first match shows a stale photo.
 */
/**
 * Up to `seconds` before `timestamp`, but never across local midnight. The
 * viewer counts photos per local day, so a fixed four-hour offset put the two
 * photos on different days whenever the suite ran before 04:00.
 */
function sameDayEarlier(timestamp: number, seconds: number): number {
  const midnight = new Date(timestamp * 1000);
  midnight.setHours(0, 0, 0, 0);
  return timestamp - Math.min(seconds, (timestamp - midnight.getTime() / 1000) / 2);
}

const NEW_PHOTO = { ...photo(NOW - 40), source: 'camera' };
const OLD_PHOTO = { ...photo(sameDayEarlier(NOW - 40, 14_400)), source: 'acceptance' };

const LATEST = {
  device_id: 'home',
  last_seen: NOW - 30,
  items: [
    measurement('cpu', { cpu_temperature_c: 65.9 }),
    measurement('agent', { queued: 1, bytes: 236, dropped: 36, oldest_age_seconds: 0.4 }),
    OLD_PHOTO,
    NEW_PHOTO,
  ],
};

interface Routed {
  path: string;
  query: URLSearchParams;
}

function route(url: string): Routed {
  const parsed = new URL(url, 'https://api.example');
  return { path: parsed.pathname, query: parsed.searchParams };
}

/** A fetch double serving the shapes the live Worker returns. */
function makeFetch() {
  const seen: Routed[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const request = route(String(input));
    seen.push(request);

    if (request.path === '/v1/session') {
      return new Response(
        JSON.stringify({ session_key: 'a'.repeat(64), expires_at: NOW + 604_800 }),
        {
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
    if (request.path === '/v1/latest') {
      return new Response(JSON.stringify(LATEST), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (request.path === '/v1/measurements') {
      const items =
        request.query.get('source') === 'camera' ? [] : [LATEST.items[0]!, LATEST.items[1]!];
      return new Response(JSON.stringify({ items, next_cursor: null }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (request.path === '/v1/photos') {
      const start = Number(request.query.get('start'));
      const end = Number(request.query.get('end'));
      const items = [OLD_PHOTO, NEW_PHOTO].filter(
        (item) => item.observed_at >= start && item.observed_at <= end,
      );
      return new Response(JSON.stringify({ items, next_cursor: null }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (request.path.startsWith('/v1/photos/')) {
      return new Response(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])]), {
        headers: { 'Content-Type': 'image/jpeg' },
      });
    }
    return new Response(JSON.stringify({ detail: 'not found' }), { status: 404 });
  }) as unknown as typeof fetch;

  return { impl, seen };
}

function mount(withSession: boolean) {
  const root = document.createElement('div');
  document.body.append(root);
  const session = new SessionStore(null);
  if (withSession) session.set({ session_key: 'a'.repeat(64), expires_at: NOW + 604_800 });

  const { impl, seen } = makeFetch();
  const client = new ApiClient({
    baseUrl: '',
    getToken: () => session.token,
    onUnauthorized: () => session.clear(),
    fetchImpl: impl,
  });
  const app = new App(root, new MonitoringApi(client), session);
  app.start();
  mounted.push(app);
  return { root, session, seen };
}

/** Every shell created by a test, torn down afterwards so none keep listening. */
const mounted: App[] = [];

/** Let queued promises settle; the views load their data asynchronously. */
async function settle(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

beforeEach(() => {
  window.location.hash = '';
  plotInstances.length = 0;
  // Chart preferences live in localStorage; each test starts from the defaults.
  window.localStorage.clear();
  globalThis.URL.createObjectURL = () => 'blob:fake';
  globalThis.URL.revokeObjectURL = () => undefined;
});

afterEach(() => {
  for (const app of mounted.splice(0)) app.destroy();
  document.body.replaceChildren();
});

describe('sign-in', () => {
  it('asks for the access key when there is no session', () => {
    const { root } = mount(false);
    expect(root.textContent).toContain('Access key');
    expect(root.querySelector('input[type="password"]')).not.toBeNull();
  });

  it('does not offer the sections before signing in', () => {
    const { root } = mount(false);
    expect(root.querySelector('.tabs')?.hasAttribute('hidden')).toBe(true);
  });

  it('exchanges the key and shows the dashboard', async () => {
    const { root, seen } = mount(false);
    const input = root.querySelector<HTMLInputElement>('input[type="password"]')!;
    input.value = 'k'.repeat(40);
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();

    expect(seen.some((request) => request.path === '/v1/session')).toBe(true);
    expect(root.textContent).toContain('Device home');
    // The key is cleared from the form once it has been exchanged.
    expect(input.value).toBe('');
  });
});

describe('dashboard', () => {
  it('shows the device as delivering and lists the latest readings', async () => {
    const { root } = mount(true);
    await settle();

    expect(root.textContent).toContain('Delivering');
    expect(root.textContent).toContain('65.9 °C');
    expect(root.textContent).toContain('CPU temperature · cpu');
    expect(root.textContent).toContain('Oldest age · agent');
  });

  it('renders the latest photo through a blob URL', async () => {
    const { root } = mount(true);
    await settle();

    const image = root.querySelector<HTMLImageElement>('.photo__image');
    expect(image?.getAttribute('src')).toBe('blob:fake');
  });

  it('shows the newest photo, not the first one the API lists', async () => {
    const { seen } = mount(true);
    await settle();

    const requested = seen.filter((request) => request.path.startsWith('/v1/photos/'));
    expect(requested.map((request) => request.path)).toContain(`/v1/photos/${NEW_PHOTO.event_id}`);
    expect(requested.map((request) => request.path)).not.toContain(
      `/v1/photos/${OLD_PHOTO.event_id}`,
    );
  });

  it('reports a silent device when nothing arrived for hours', async () => {
    const stale = { ...LATEST, last_seen: NOW - 20_000 };
    const original = LATEST.last_seen;
    Object.assign(LATEST, { last_seen: stale.last_seen });
    try {
      const { root } = mount(true);
      await settle();
      expect(root.textContent).toContain('Silent');
    } finally {
      Object.assign(LATEST, { last_seen: original });
    }
  });
});

describe('charts', () => {
  it('builds one plot per unit for the default range', async () => {
    window.location.hash = '#/chart';
    const { root } = mount(true);
    await settle();

    expect(root.textContent).toContain('Last 24 hours');
    // cpu temperature, agent counts, agent bytes, agent age.
    expect(plotInstances).toHaveLength(4);
    expect(root.textContent).toContain('Temperature, °C');
  });

  it('offers a layout switch and a checkbox per series, all on by default', async () => {
    window.location.hash = '#/chart';
    const { root } = mount(true);
    await settle();

    const chips = [...root.querySelectorAll<HTMLButtonElement>('.chip')].map(
      (chip) => chip.textContent,
    );
    expect(chips).toContain('One chart');
    expect(chips).toContain('Separate charts');

    const boxes = [...root.querySelectorAll<HTMLInputElement>('.source input')];
    expect(boxes).toHaveLength(5);
    expect(boxes.every((box) => box.checked)).toBe(true);
    expect(root.textContent).toContain('Select all');
  });

  it('puts Refresh above the choices and frames the two selection blocks', async () => {
    window.location.hash = '#/chart';
    const { root } = mount(true);
    await settle();

    const rows = [...root.querySelectorAll<HTMLElement>('.filters__row')];
    expect(rows).toHaveLength(4);

    const refresh = rows[0]!.querySelector('button')!;
    expect(refresh.textContent).toBe('Refresh');
    // Coloured so it does not read as one more choice.
    expect(refresh.classList.contains('button--primary')).toBe(true);

    expect(rows[1]!.textContent).toContain('Layout');
    expect(rows[1]!.classList.contains('filters__block')).toBe(true);

    expect(rows[2]!.textContent).toContain('Range');
    expect(rows[2]!.classList.contains('filters__block')).toBe(true);

    expect(rows[3]!.textContent).toContain('Show');
    expect(rows[3]!.classList.contains('filters__block')).toBe(true);
  });

  it('draws one plot when the combined layout is chosen', async () => {
    window.location.hash = '#/chart';
    const { root } = mount(true);
    await settle();
    expect(plotInstances).toHaveLength(4);

    plotInstances.length = 0;
    [...root.querySelectorAll<HTMLButtonElement>('.chip')]
      .find((chip) => chip.textContent === 'One chart')!
      .click();
    await settle();

    expect(plotInstances).toHaveLength(1);
    // Mixed units cannot share a real axis, so the plot says what it shows.
    expect(root.textContent).toContain('rescaled');
    expect(root.querySelectorAll('.legend__item')).toHaveLength(5);
  });

  it('remembers the layout across mounts', async () => {
    window.location.hash = '#/chart';
    const first = mount(true);
    await settle();
    [...first.root.querySelectorAll<HTMLButtonElement>('.chip')]
      .find((chip) => chip.textContent === 'One chart')!
      .click();
    await settle();

    plotInstances.length = 0;
    mount(true);
    await settle();
    expect(plotInstances).toHaveLength(1);
  });

  it('removes a series, and its panel, when its checkbox is cleared', async () => {
    window.location.hash = '#/chart';
    const { root } = mount(true);
    await settle();

    const temperature = [...root.querySelectorAll<HTMLElement>('.source')].find((item) =>
      item.textContent?.includes('CPU temperature'),
    )!;
    const box = temperature.querySelector<HTMLInputElement>('input')!;
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    expect(root.textContent).not.toContain('Temperature, °C');
    expect(root.querySelectorAll('.panel')).toHaveLength(3);
    expect(root.querySelectorAll('.legend__item')).toHaveLength(4);
    // The checkbox stays available so the series can be brought back.
    expect(root.querySelectorAll('.source input')).toHaveLength(5);
  });

  it('persists the cleared series and restores them with Select all', async () => {
    window.location.hash = '#/chart';
    const { root } = mount(true);
    await settle();

    const box = [...root.querySelectorAll<HTMLElement>('.source')]
      .find((item) => item.textContent?.includes('CPU temperature'))!
      .querySelector<HTMLInputElement>('input')!;
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    expect(window.localStorage.getItem('monitor.hiddenSeries')).toContain('cpu.cpu_temperature_c');

    [...root.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Select all')!
      .click();
    await settle();

    expect(root.querySelectorAll('.panel')).toHaveLength(4);
    expect(window.localStorage.getItem('monitor.hiddenSeries')).toBe('[]');
    expect(
      [...root.querySelectorAll<HTMLInputElement>('.source input')].every((item) => item.checked),
    ).toBe(true);
  });

  it('says so when nothing is selected', async () => {
    window.location.hash = '#/chart';
    const { root } = mount(true);
    await settle();

    for (const box of [...root.querySelectorAll<HTMLInputElement>('.source input')]) {
      box.checked = false;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      await settle(2);
    }

    expect(root.textContent).toContain('Nothing is selected');
    expect(root.querySelectorAll('.panel')).toHaveLength(0);
  });

  it('asks the aggregate endpoint for ranges longer than a week', async () => {
    window.location.hash = '#/chart';
    const { root, seen } = mount(true);
    await settle();
    seen.length = 0;

    const chips = [...root.querySelectorAll<HTMLButtonElement>('.chip')];
    chips.find((chip) => chip.textContent === 'Last 90 days')!.click();
    await settle(20);

    const aggregates = seen.filter((request) => request.path === '/v1/measurements/aggregate');
    expect(aggregates.length).toBeGreaterThan(0);
    expect(aggregates[0]!.query.get('bucket_seconds')).toBe('10800');
  });
});

describe('photo viewer', () => {
  it('opens on the newest photo with its navigation', async () => {
    window.location.hash = '#/photos';
    const { root } = mount(true);
    await settle(20);

    expect(root.textContent).toContain('Camera archive');
    expect(root.querySelector<HTMLImageElement>('.photo__image')?.getAttribute('src')).toBe(
      'blob:fake',
    );
    // Opens on the newest of the day's two photos, not the first one listed.
    expect(root.textContent).toContain('2 of 2');
    // Older on the left, newer on the right, in step with the arrows.
    const buttons = [...root.querySelectorAll('.photo__nav button')].map(
      (button) => button.textContent,
    );
    expect(buttons.slice(0, 4)).toEqual(['Oldest', '← Previous', 'Next →', 'Newest']);
  });

  it('limits the date picker to the retained archive', async () => {
    window.location.hash = '#/photos';
    const { root } = mount(true);
    await settle(20);

    const input = root.querySelector<HTMLInputElement>('input[type="date"]')!;
    expect(input.min).not.toBe('');
    expect(input.max).not.toBe('');
    expect(input.min < input.max).toBe(true);
  });
});

describe('session expiry', () => {
  it('returns to the sign-in form when the server rejects the session', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new SessionStore(null);
    session.set({ session_key: 'a'.repeat(64), expires_at: NOW + 604_800 });

    const impl = (async () =>
      new Response(JSON.stringify({ detail: 'invalid or expired session' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;
    const client = new ApiClient({
      baseUrl: '',
      getToken: () => session.token,
      onUnauthorized: () => session.clear(),
      fetchImpl: impl,
    });
    const app = new App(root, new MonitoringApi(client), session);
    app.start();
    mounted.push(app);
    await settle(20);

    expect(session.active).toBe(false);
    expect(root.textContent).toContain('Access key');
  });
});
