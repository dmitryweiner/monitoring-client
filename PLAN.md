# Home monitoring web client — plan

Status: draft for approval, 2026-09-14. Nothing is implemented yet.
The backend is the Cloudflare Worker from the `monitoring` repository
(`../monitoring`, GitHub `dmitryweiner/monitoring`); this repository only
consumes its `/v1` API and never touches D1 or R2 directly.

## 1. Agreed requirements

- Web application, single user, hosted on GitHub Pages at
  `https://dmitryweiner.github.io/monitoring-client/`.
- Built and deployed locally, every time by hand. No CI, no GitHub Actions.
  The build output is committed into `docs/` on `main`; Pages serves `main:/docs`.
- Stack: TypeScript + Vite, no UI framework. Charts via a library (uPlot proposed).
- Charts: all measured parameters over a selectable time range in one picture.
- Camera: the latest photo, previous/next buttons, jump to a date.
- Authentication: the existing admin key is exchanged for a 7-day session;
  the session key is kept in `localStorage`, the admin key is never stored.
- UI and documentation in English.

## 2. What the backend provides (read side)

Base URL: `https://home-monitoring-poc.dmitry-weiner.workers.dev`
(machine-readable contract: `../monitoring/cloud/openapi.json`).

| Endpoint | Used for |
| --- | --- |
| `POST /v1/session` `{key}` | Login: returns `session_key` (64 hex) and `expires_at`; rate limit 10/min per IP |
| `DELETE /v1/session` | Logout of the current session |
| `GET /v1/latest` | Newest event per `(kind, source)` plus `last_seen`; includes the newest photo event |
| `GET /v1/measurements?start&end&source&limit&cursor` | Raw history, ascending `(observed_at, event_id)`, max 1000 per page |
| `GET /v1/measurements/aggregate?source&metric&start&end&bucket_seconds` | Mean/min/max per bucket, 600–86400 s, max 1000 buckets |
| `GET /v1/photos?start&end&limit&cursor` | Photo metadata, same paging as measurements |
| `GET /v1/photos/{event_id}` | The JPEG itself, `Cache-Control: no-store` |

Facts that shape the client:

- All times are Unix seconds UTC. `observed_at` is the measurement time,
  `received_at` the cloud arrival time. Retention: photos 30 days, measurements 90 days.
  `start` is clamped server-side to the retention window; `end - start` must be ≤ 91 days.
- Every event carries `source`, `status` (`ok`/`error`) and `values` (numbers only).
  Today the sources are `cpu` (`cpu_temperature_c`), `agent` (`queued`, `bytes`,
  `dropped`, `oldest_age_seconds`), `camera` (photo events, plus `status=error`
  measurements without values when capture failed). BMP280/DHT11 will appear as new
  sources later, so the client must discover sources and metrics from the data.
- Sampling interval is 10 minutes: 144 events per source per day.
- GitHub Pages and the Worker are different sites, so the Worker's
  `SameSite=Strict` cookie is useless here. Every request sends
  `Authorization: Bearer <session_key>`. With a Bearer header the Worker skips
  its CSRF check, so `DELETE /v1/session` works without extra headers.
- The browser sends an `Origin` header on cross-origin requests. The Worker
  rejects `POST /v1/session` and CORS preflights unless the origin is listed in
  `ALLOWED_ORIGINS`. Origins are scheme+host only, so the value has to be
  `https://dmitryweiner.github.io` (shared by all of this account's Pages sites)
  plus `http://localhost:5173` for the Vite dev server.
- Photos cannot be loaded with a plain `<img src>` because the request needs the
  header. The client fetches the JPEG, turns it into a blob URL and caches a few
  recent blobs in memory. Max photo size is 4 MiB.
- Rate limits: 120 API requests per minute per IP, 100 000 Worker requests per day
  on the free plan. Polling `/v1/latest` every 2 minutes costs 720 requests/day.
- The list endpoints are ascending only; there is no "newest first" mode.
  The newest photo comes from `/v1/latest`; neighbours are found through
  per-day metadata pages (see §4.4).

## 3. Decisions

| Topic | Decision |
| --- | --- |
| Build | Vite 7, TypeScript strict, `base: '/monitoring-client/'`, `build.outDir: 'docs'`, `docs/.nojekyll` |
| Routing | Hash routing (`#/dashboard`, `#/chart`, `#/photos`); no server config needed on Pages |
| Charts | uPlot: canvas, small, native time axis, several y-scales on one chart, legend toggles |
| State | Plain modules with a tiny event emitter; no framework, no global store library |
| API URL | `VITE_API_URL` in `.env` (default: the Worker above). Not a secret; committed |
| Session | `localStorage` key `monitor.session` = `{session_key, expires_at}`; cleared on 401 or logout |
| Time display | Browser local time; tooltips also show UTC. The board is in Novosibirsk, the user in Israel |
| Refresh | `/v1/latest` polled every 120 s while the tab is visible; manual refresh button |
| Errors | 401 → login screen; 429 → message with `Retry-After`; 503/network → retry banner, keep last data |
| Tests | Vitest for pure logic with mocked `fetch`; manual smoke test against the real Worker |
| Lint/format | `tsc --noEmit` as the gate; Prettier for formatting; no ESLint to keep the toolchain small |
| Deploy | `npm run build`, then commit `docs/` and push `main` |

Security notes: the site is public, the data is not. The admin key is typed into a
password field, sent once to `/v1/session`, and discarded. A `<meta>` CSP restricts
`connect-src` to the API origin, `img-src` to `'self' blob:`, and forbids inline
scripts, which limits what an injected script could do with the stored session.
Logout revokes the session server-side. Nothing from `../monitoring/secrets/` is
ever copied here.

## 4. Application structure

```
monitoring-client/
  index.html            # single page, CSP meta, <div id="app">
  vite.config.ts        # base, outDir docs, dev proxy (optional)
  src/
    main.ts             # boot: restore session, mount router
    config.ts           # API URL, poll interval, retention constants
    api/
      client.ts         # fetch wrapper: Bearer, JSON, errors, 401/429 handling
      types.ts          # StoredEvent, Latest, Page, Aggregate (from openapi.json)
      measurements.ts   # raw history with cursor paging, aggregate helper
      photos.ts         # metadata pages, per-day index, JPEG blob cache
      session.ts        # login/logout, localStorage persistence
    model/
      series.ts         # source+metric discovery, unit inference, gap handling
      range.ts          # time ranges (1h/24h/7d/30d/90d), raw vs aggregate choice
      photoNav.ts       # previous/next/jump-to-date over the day index
    ui/
      router.ts         # hash routes
      login.ts          # admin key form
      dashboard.ts      # latest values, device status, newest photo
      chart.ts          # uPlot wrapper, range selector, legend
      photos.ts         # viewer: image, prev/next, date picker, download
      layout.ts         # header, nav, status bar, error banner
    style.css
  tests/                # Vitest: range.ts, series.ts, photoNav.ts, client.ts
  docs/                 # build output, committed (GitHub Pages source)
  README.md  PLAN.md  STATUS.md
```

### 4.1 API client

- One `request(path, init)` that adds the Bearer header, parses JSON, maps HTTP
  errors to a typed `ApiError {status, detail, retryAfter}`.
- On 401 the session is dropped and the app returns to the login screen.
- `pageAll(path, params, maxPages)` follows `next_cursor` with a hard cap so a bug
  cannot loop forever; the same filters are repeated on every page as the API requires.

### 4.2 Dashboard

- Device status: `last_seen` age, green/amber/red (≤ 15 min / ≤ 1 h / older).
- Agent queue: `queued`, `bytes`, `dropped`, `oldest_age_seconds` from the newest
  `source=agent` event.
- Latest value of every numeric metric of every source, with unit and age.
- Camera: newest photo (from `/v1/latest`, `kind=photo`), its time and size,
  and the count of `source=camera status=error` events in the last 24 h.
- Warnings when the newest measurement is older than 20 minutes or
  `clock_synchronized` is false.

### 4.3 Chart

- Ranges: 1 h, 6 h, 24 h, 7 d, 30 d, 90 d, plus custom start/end.
- Up to 7 days: raw `/v1/measurements` without `source` filter, all sources in one
  paged query (7 d ≈ 3 000 events ≈ 4 pages). Longer ranges: `/v1/measurements/aggregate`
  per discovered `(source, metric)` with `bucket_seconds` chosen so that
  ≤ 1000 buckets result (30 d → 1 h, 90 d → 3 h), plotting the mean with min/max band.
- Series are discovered from the data: `source.metric`. Units are inferred from the
  metric name (`*_c` → °C, `*_pct`/`humidity` → %, `*_hpa`/`pressure*` → hPa,
  `bytes` → bytes, `*_seconds` → s, otherwise count) and each unit gets its own
  y-scale; temperature on the left axis, others on the right. Unknown units still plot.
- `status=error` events and missing samples become gaps, not zeros.
- Legend click hides/shows a series; the visible set is remembered in `localStorage`.
- Camera error events are drawn as markers along the time axis.
- Optional hover cursor with all values at that time, local and UTC timestamps.

### 4.4 Photo viewer

- Starts at the newest photo from `/v1/latest`.
- Day index: `/v1/photos?start=<day start>&end=<day end>&limit=1000` fetched on
  demand and cached per local calendar day (≤ 144 items). Previous/next move
  inside the day and load the adjacent day when the edge is reached; empty days
  are skipped up to the 30-day retention limit.
- Jump to date: `<input type="date">` bounded to the last 30 days, optional time;
  the viewer shows the nearest photo at or after the chosen moment.
- JPEG fetched with the Bearer header, shown through a blob URL; an LRU cache of
  about 10 blobs makes previous/next instant when moving back and forth; blob
  URLs are revoked on eviction. Prefetch the next photo when idle.
- Keyboard: ←/→, Home (newest), End (oldest available). Download button saves
  the JPEG as `home-<observed_at ISO>.jpg`. Shows time, size, and position (`n of m` for the day).
- 404 on a photo (deleted by retention between listing and fetch) shows a notice
  and moves on.

## 5. Milestones

1. **Scaffold.** `npm create vite` (vanilla-ts), strict `tsconfig`, Vitest, Prettier,
   npm scripts (`dev`, `build`, `check`, `test`, `preview`), `docs/` output,
   `.nojekyll`, CSP meta, README skeleton. Verify a hello-world build on this ARM64 machine.
2. **API client and auth.** Types from `openapi.json`, request wrapper, login/logout,
   session persistence and expiry, 401/429/503 handling. Unit tests with mocked `fetch`.
3. **Dashboard.** `/v1/latest` polling, status cards, latest photo thumbnail.
4. **Chart.** uPlot integration, range selector, raw vs aggregate loading, series
   discovery, units and scales, gaps, legend persistence. Tests for range/bucket
   selection and series building.
5. **Photo viewer.** Day index, navigation, jump to date, blob cache, keyboard,
   download. Tests for the navigation model over synthetic day indexes.
6. **Backend integration.** In `../monitoring/cloud/wrangler.jsonc` set
   `ALLOWED_ORIGINS` to `"https://dmitryweiner.github.io http://localhost:5173"`
   and redeploy the Worker with `wrangler deploy` (vars only; secrets stay).
   Confirm from the browser: preflight, login, data, photo, logout. Record in STATUS.md.
7. **Deploy.** Build into `docs/`, commit, push, enable Pages on `main:/docs`,
   smoke-test the live site from a phone and a desktop. Document the deploy loop.
8. **Polish.** Responsive layout for phone width, loading states, empty states,
   error banners, favicon, final README and STATUS.

Milestones 1–5 run locally against the real Worker only through the Vite dev
server; until milestone 6 the dev origin is not allowed, so development uses a
Vite proxy (`/api` → Worker, `Origin` header removed) or the origin change is
done first. Doing milestone 6 right after milestone 2 is the simpler path.

## 6. Acceptance criteria

- Login with the admin key works from the Pages site; a wrong key shows an error
  and the rate limit message after repeated failures; logout invalidates the session.
- Reloading the page within 7 days does not ask for the key again; after expiry
  or revocation it does.
- Dashboard shows current values with correct units and the device is reported
  online when the agent delivered within the last 15 minutes.
- Chart shows every discovered metric on one canvas for all ranges up to 90 days,
  with gaps for missing data, and never issues more than ~10 requests per range change.
- Photo viewer opens on the newest photo, previous/next walk the whole 30-day
  archive across day boundaries, jump to date lands on the nearest photo, and
  navigating back and forth does not refetch cached images.
- `npm run check` and `npm test` pass; `npm run build` produces `docs/` that works
  when opened at `/monitoring-client/`.
- No admin key, session key, or private photo is committed or logged.
- The site works at phone width.

## 7. Out of scope

- Any change to the Worker other than the `ALLOWED_ORIGINS` value.
- Notifications, alerts, multiple devices, editing or deleting data.
- Time-lapse playback, video, image processing.
- User accounts, roles, or a login other than the single admin key.
- Custom domain, PWA/offline mode, CI pipelines.

## 8. Open points

- GitHub Pages on a free account requires the repository to be public; the
  repository content (source, no secrets) would then be public. Confirm this is acceptable.
- Which source/metric names BMP280 and DHT11 will use is unknown; the unit
  inference map will be extended when they arrive.
- Whether the per-IP rate limit (120/min) is shared with the agent's home network
  when the browser is used from the same network. Only matters for fast photo browsing.
