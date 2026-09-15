# Project status — 2026-09-14

What has been built and what was actually verified. The target is described in
[PLAN.md](PLAN.md); this file records facts, not intentions.

## Done

Milestones 1 to 7 of the plan are done: scaffold, API client and
authentication, overview, charts, photo viewer, the backend origin change, and
the deployment. The application builds, type-checks, passes 102 tests, and the
built bundle has been driven through all three pages.

| Area | State |
| --- | --- |
| Build | Vite 7, TypeScript strict, output committed to `docs/`, `base` `/monitoring-client/` |
| Bundle | 89.5 kB JavaScript (36.2 kB gzipped), 8.5 kB CSS; no source map in the committed build |
| Tests | 102 passing across 7 files: model, API client, session, and views in a DOM |
| Bundle check | `npm run smoke` drives the built bundle through all three pages: 39 checks passing |
| Dependencies | uPlot at runtime; Vite, TypeScript, Vitest, Prettier, happy-dom for development. `npm audit` reports 0 vulnerabilities |
| Deployment | Live at https://dmitryweiner.github.io/monitoring-client/ from `main:/docs` |

## Fixed after review

The overview and the photo viewer opened on a four-hour-old photo. `/v1/latest`
returns the newest event of every (kind, source) pair, and the archive has two
photo sources: the camera and a leftover `acceptance` photo from the backend
acceptance test. The API lists the older source first, and the client took the
first match instead of the latest by time. Both views now select by
`observed_at`. Tests reproduce the real ordering and fail against the old code.

## One departure from the plan

PLAN.md proposed a single plot with one y-scale per unit. That was changed to a
column of separate panels, one per unit, sharing the time axis and a single
crosshair. Two y-scales on one plot make the alignment of the two scales
arbitrary and imply a correlation that is not in the data. The result still
answers the requirement of seeing every parameter in one picture, and the
panels behave as one chart.

A later review asked for a switch between one chart and separate charts. The
combined layout keeps the real axis when the selected series share a unit. When
they do not, it rescales each series to its own range rather than seating two
y-scales on one plot, and says so under the title; the legend and the table
still show the measured values. That layout may carry eight series, the count
the palette validates for lines compared with their neighbours; separate panels
stay capped at three, the count that holds when any two panels are compared.

## Verified against the live Worker

Checked on 2026-09-14 from the Orange Pi with curl, using the existing
`secrets/admin.key` of the `monitoring` project. No key or session token was
written to any file.

- `GET /healthz` returns `{"status":"ok"}`.
- `POST /v1/session` returns a 64-character session key and an expiry.
- `GET /v1/latest` returns four sources: `cpu` with `cpu_temperature_c`,
  `agent` with `queued`, `bytes`, `dropped` and `oldest_age_seconds`, a
  `camera` measurement with `status=error` and no values, and the newest photo.
  There is also a leftover `acceptance` source with `test_value`, from the
  earlier end-to-end test. The client shows it like any other metric.
- `GET /v1/measurements` over three hours returned 36 events, 18 each from
  `cpu` and `agent`, matching the 10-minute interval, with `next_cursor` null.
- `GET /v1/measurements/aggregate` for `cpu_temperature_c` over seven days with
  `bucket_seconds=3600` returned 10 buckets, each with mean, minimum and
  maximum. Only about ten hours of history exists so far.
- `GET /v1/photos` over two days returned 33 items; the newest JPEG downloaded
  as 37 275 bytes with `Content-Type: image/jpeg`.
- `DELETE /v1/session` returned 204.

## Worker change

`ALLOWED_ORIGINS` in `monitoring/cloud/wrangler.jsonc` was changed from the
empty string to `https://dmitryweiner.github.io`, and the Worker was
redeployed. This is the only backend change the client needs.

- Deployed version: `31173b5d-9f56-4c9e-a390-aaad818155b1`.
- Only the one variable changed; `DEVICE_ID`, the D1 and R2 bindings, the rate
  limits and the cron trigger are unchanged, and `DEVICE_HASH`/`ADMIN_HASH`
  survived the deploy.
- A preflight from `https://dmitryweiner.github.io` answers 204 with
  `Access-Control-Allow-Origin`, `-Credentials`, `-Methods` and `-Headers`.
- A preflight from another origin is refused with 403.
- Signing in and reading `/v1/latest` with the Pages origin both return 200
  with the correct CORS headers, which confirms the secrets are still in place.
- `localhost` was deliberately left out of the list. Development goes through
  the Vite proxy, which removes the `Origin` header, so no local origin needs
  to be trusted by the production Worker.

## Published

- Committed and pushed to `main`; GitHub Pages enabled on `main:/docs` through
  the GitHub API. The repository was already public.
- https://dmitryweiner.github.io/monitoring-client/ answers 200, and both
  hashed assets and `.nojekyll` are served correctly.
- The committed bundle was then loaded into a DOM and driven through sign-in,
  the overview, the chart page with a range change, and the photo viewer.
  All 26 checks passed with no runtime error, which covers the wiring of the
  file that actually ships.

## Not verified

- **No browser run.** This machine is the headless Orange Pi and has no
  browser installed, so nothing has been rendered on a real screen. The DOM
  used for the checks has no canvas, so a recording context and a `Path2D`
  stub stand in: the panel structure, the requests and the readouts are
  checked, but not drawing, fonts, colour, or the layout at phone width.
  The published Content-Security-Policy has likewise never been enforced by a
  real browser.
- **Long ranges with real history.** The archive only reaches back about ten
  hours, so the 30- and 90-day views have been exercised against the API but
  not against data that fills them.
- **Retention edges.** Stepping past the oldest photo and the behaviour when a
  photo is deleted between listing and fetching are covered by unit tests with
  synthetic data, not observed against the real archive.

## Notes for whoever continues

- The `monitoring` working copy was being modified by another process during
  this session: `STATUS.md`, `docs/HANDOFF.md`, `docs/NETWORK.md`, `.gitignore`
  and new files under `deploy/` and `docs/` all changed without any action from
  this work. Only `cloud/wrangler.jsonc` was touched here, and it was clean in
  git beforehand. That change is uncommitted in the `monitoring` repository.
- Sensor support for BMP280 and DHT11 is the second part of the work. No code
  change should be needed for them to plot: series are discovered from the data
  and the unit comes from the metric name, with rules already in place for
  `*_c`, `*_hpa`, `*_pct` and `humidity`. Their real metric names are unknown,
  so the inference rules should be checked once the agent sends them.
- At most three series share one chart panel, which is the limit the colour
  palette was validated for. A unit with more series is split across further
  panels automatically.
