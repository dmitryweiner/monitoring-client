/**
 * Boots the committed production bundle in a DOM and drives it.
 *
 * `npm test` checks the sources; this checks the file that actually ships, so
 * a broken build is caught before it is committed to `docs/`. Run it after
 * `npm run build`.
 *
 * The DOM implementation has no canvas, so a recording 2D context and a Path2D
 * stub are supplied. Nothing here verifies drawing, only that the bundle runs
 * and builds the expected structure.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const assetsDir = new URL('../docs/assets/', import.meta.url);
const bundleName = readdirSync(assetsDir).find((name) => name.endsWith('.js'));
if (!bundleName) {
  console.error('No bundle in docs/assets. Run `npm run build` first.');
  process.exit(1);
}
const bundle = readFileSync(new URL(bundleName, assetsDir), 'utf8');
console.log(`Bundle: ${fileURLToPath(new URL(bundleName, assetsDir))}`);

const NOW = Date.now() / 1000;
let failures = 0;

function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${detail}`}`);
}

function measurement(source, values, offsetSeconds = 60) {
  return {
    schema_version: 1,
    device_id: 'home',
    event_id: `e-${source}-${offsetSeconds}`,
    observed_at: NOW - offsetSeconds,
    kind: 'measurement',
    source,
    status: 'ok',
    values,
    clock_synchronized: true,
    received_at: NOW - offsetSeconds + 2,
  };
}

const history = [];
for (let step = 0; step < 24; step += 1) {
  history.push(measurement('cpu', { cpu_temperature_c: 60 + step * 0.3 }, step * 600));
  history.push(
    measurement(
      'agent',
      { queued: step % 3, bytes: 200 + step, dropped: 36, oldest_age_seconds: step },
      step * 600,
    ),
  );
}
history.sort((left, right) => left.observed_at - right.observed_at);

// Two photo sources, as the live archive has. The API lists the older one
// first, so taking the first match would show a stale photo.
const oldPhoto = {
  ...measurement('acceptance', {}, 14_400),
  kind: 'photo',
  event_id: 'photo-old',
};
const newPhoto = { ...measurement('camera', {}, 40), kind: 'photo', event_id: 'photo-new' };

const latest = {
  device_id: 'home',
  last_seen: NOW - 30,
  items: [
    measurement('cpu', { cpu_temperature_c: 65.9 }),
    measurement('agent', { queued: 1, bytes: 236, dropped: 36, oldest_age_seconds: 0.4 }),
    oldPhoto,
    newPhoto,
  ],
};

/** A window with the served page, a stubbed API and just enough canvas. */
function makeWindow(hash, session) {
  const window = new Window({ url: `https://dmitryweiner.github.io/monitoring-client/${hash}` });
  window.document.body.innerHTML = '<div id="app"></div>';

  const context = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === 'measureText') return () => ({ width: 20 });
        if (property === 'canvas') return { width: 600, height: 190 };
        if (property === 'createLinearGradient') return () => ({ addColorStop() {} });
        return () => undefined;
      },
      set: () => true,
    },
  );
  window.HTMLCanvasElement.prototype.getContext = () => context;
  class FakePath2D {
    moveTo() {}
    lineTo() {}
    closePath() {}
    rect() {}
    arc() {}
    addPath() {}
  }
  window.Path2D = FakePath2D;
  globalThis.Path2D = FakePath2D;
  window.devicePixelRatio = 1;
  window.URL.createObjectURL = () => 'blob:smoke';
  window.URL.revokeObjectURL = () => {};

  const stored = new Map();
  if (session) {
    stored.set(
      'monitor.session',
      JSON.stringify({ session_key: 'a'.repeat(64), expires_at: NOW + 604_800 }),
    );
  }
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, value),
      removeItem: (key) => stored.delete(key),
      clear: () => stored.clear(),
      key: () => null,
      get length() {
        return stored.size;
      },
    },
  });

  const calls = [];
  window.fetch = async (input) => {
    const url = new URL(String(input), 'https://x.invalid');
    calls.push(`${url.pathname}?${url.searchParams.toString()}`);
    const json = (body) =>
      new window.Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json' },
      });

    if (url.pathname === '/v1/session') {
      return json({ session_key: 'a'.repeat(64), expires_at: NOW + 604_800 });
    }
    if (url.pathname === '/v1/latest') return json(latest);
    if (url.pathname === '/v1/measurements') {
      return json({
        items: url.searchParams.get('source') === 'camera' ? [] : history,
        next_cursor: null,
      });
    }
    if (url.pathname === '/v1/measurements/aggregate') {
      return json({
        source: url.searchParams.get('source'),
        metric: url.searchParams.get('metric'),
        bucket_seconds: Number(url.searchParams.get('bucket_seconds')),
        items: [
          { bucket: NOW - 7200, count: 6, mean: 62, minimum: 60, maximum: 64 },
          { bucket: NOW - 3600, count: 6, mean: 65, minimum: 63, maximum: 67 },
        ],
      });
    }
    if (url.pathname === '/v1/photos') {
      const start = Number(url.searchParams.get('start'));
      const end = Number(url.searchParams.get('end'));
      return json({
        items: [oldPhoto, newPhoto].filter(
          (item) => item.observed_at >= start && item.observed_at <= end,
        ),
        next_cursor: null,
      });
    }
    if (url.pathname.startsWith('/v1/photos/')) {
      return new window.Response(new window.Blob([new Uint8Array([255, 216, 255, 217])]), {
        headers: { 'Content-Type': 'image/jpeg' },
      });
    }
    return json({ items: [], next_cursor: null });
  };

  const errors = [];
  window.addEventListener('error', (event) => errors.push(String(event.message ?? event)));
  const consoleError = console.error;
  console.error = (...args) => errors.push(args.map(String).join(' '));

  window.eval(bundle);
  return { window, calls, errors, restoreConsole: () => (console.error = consoleError) };
}

const settle = async (rounds = 60) => {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

// ---- sign-in and overview ----------------------------------------------

{
  const { window, calls, errors, restoreConsole } = makeWindow('', false);
  await settle();
  const root = window.document.querySelector('#app');

  check('bundle runs without error', errors.length === 0, errors.join('; '));
  check('sign-in form rendered', root.textContent.includes('Access key'));

  const input = root.querySelector('input[type="password"]');
  input.value = 'k'.repeat(40);
  root.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await settle();

  check(
    'access key exchanged for a session',
    calls.some((call) => call.startsWith('/v1/session')),
  );
  check('access key cleared from the form', input.value === '');
  check('overview rendered', root.textContent.includes('Device home'));
  check('device reported as delivering', root.textContent.includes('Delivering'));
  check('temperature shown with its unit', root.textContent.includes('65.9 °C'));
  check('queue metrics shown', root.textContent.includes('Queued · agent'));
  check(
    'photo shown through a blob URL',
    root.querySelector('.photo__image')?.getAttribute('src') === 'blob:smoke',
  );
  check(
    'overview shows the newest photo, not the first listed',
    calls.some((call) => call.startsWith('/v1/photos/photo-new')) &&
      !calls.some((call) => call.startsWith('/v1/photos/photo-old')),
    calls.filter((call) => call.startsWith('/v1/photos/')).join(', '),
  );
  check(
    'sections offered',
    root.textContent.includes('Charts') && root.textContent.includes('Photos'),
  );
  check('no error after sign-in', errors.length === 0, errors.join('; '));

  restoreConsole();
  await window.happyDOM.close();
}

// ---- charts -------------------------------------------------------------

{
  const { window, calls, errors, restoreConsole } = makeWindow('#/chart', true);
  await settle();
  const root = window.document.querySelector('#app');

  check('chart page rendered', root.textContent.includes('Last 24 hours'));
  check('no error while building the plots', errors.length === 0, errors.slice(0, 2).join(' | '));

  const titles = [...root.querySelectorAll('.panel__title')].map((node) => node.textContent);
  check('one panel per unit', titles.length === 4, titles.join(', '));
  check('temperature panel first', titles[0] === 'Temperature, °C', titles.join(', '));
  check('every series has a legend entry', root.querySelectorAll('.legend__item').length === 5);
  check('plots created', root.querySelectorAll('canvas').length >= 4);

  const tableToggle = [...root.querySelectorAll('button')].find(
    (button) => button.textContent === 'Table',
  );
  tableToggle.click();
  await settle(10);
  check('table view lists the same samples', root.querySelectorAll('tbody tr').length > 0);

  calls.length = 0;
  [...root.querySelectorAll('.chip')].find((chip) => chip.textContent === 'Last 90 days').click();
  await settle(80);
  check(
    'long range uses the aggregate endpoint',
    calls.some((call) => call.startsWith('/v1/measurements/aggregate')),
    calls.slice(0, 2).join(' | '),
  );
  check(
    'bucket size stays within the server limit',
    calls.some((call) => call.includes('bucket_seconds=10800')),
    calls.slice(0, 2).join(' | '),
  );
  check('no error after the range change', errors.length === 0, errors.slice(0, 2).join(' | '));

  restoreConsole();
  await window.happyDOM.close();
}

// ---- photo viewer -------------------------------------------------------

{
  const { window, calls, errors, restoreConsole } = makeWindow('#/photos', true);
  await settle();
  const root = window.document.querySelector('#app');

  check('photo viewer opens', root.textContent.includes('Camera archive'));
  check(
    'photo displayed',
    root.querySelector('.photo__image')?.getAttribute('src') === 'blob:smoke',
  );
  // The first JPEG fetched must be the newest one; prefetching pulls the
  // neighbour in afterwards, so only the first request proves the starting point.
  const fetched = calls.filter((call) => call.startsWith('/v1/photos/'));
  check(
    'viewer opens on the newest photo',
    fetched[0]?.startsWith('/v1/photos/photo-new') === true,
    fetched.join(', '),
  );
  check('position counted within the day', root.textContent.includes('2 of 2'));
  const buttons = [...root.querySelectorAll('.photo__nav button')].map(
    (button) => button.textContent,
  );
  check(
    'navigation ordered from older to newer',
    JSON.stringify(buttons.slice(0, 4)) ===
      JSON.stringify(['Oldest', '← Previous', 'Next →', 'Newest']),
    buttons.join(', '),
  );
  const dateInput = root.querySelector('input[type="date"]');
  check('date picker bounded to the archive', Boolean(dateInput?.min && dateInput?.max));
  check('no error in the viewer', errors.length === 0, errors.slice(0, 2).join(' | '));

  restoreConsole();
  await window.happyDOM.close();
}

console.log(
  failures === 0 ? '\nAll bundle checks passed.' : `\n${failures} bundle check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
