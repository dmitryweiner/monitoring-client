# Home monitoring web client

Web interface for the home monitoring API. It signs in with the access key,
charts every measured parameter over a chosen time range, and browses the
camera archive. The backend is the Cloudflare Worker in the companion
`monitoring` repository; this project only reads its `/v1` API and never
touches D1 or R2 directly.

Plan and scope: [PLAN.md](PLAN.md). What has actually been done and verified:
[STATUS.md](STATUS.md).

- Live site: https://dmitryweiner.github.io/monitoring-client/
- API: https://home-monitoring-poc.dmitry-weiner.workers.dev
- Stack: TypeScript, Vite, uPlot. No UI framework.

## Requirements

Node 22 or newer. Install dependencies once:

```sh
npm ci
```

## Development

```sh
npm run dev
```

The dev server proxies `/api` to the Worker and strips the `Origin` header, so
development needs no CORS entry and no local copy of the backend. Point
`VITE_API_URL` at something else in `.env.local` to work against another
deployment.

`npm run preview` serves the built bundle, but that bundle calls the Worker
directly, and the Worker only allows the GitHub Pages origin. Use `npm run dev`
for anything that talks to the API.

## Checks

```sh
npm run check   # TypeScript, no emit
npm test        # Vitest
npm run smoke   # drives the built bundle; run after npm run build
npm run format  # Prettier
```

The tests cover the model layer (time ranges, series building, photo
navigation), the API client, and the views rendered in a DOM. uPlot needs a
real canvas, so the chart tests run against a stub and assert the panel
layout rather than pixels.

`npm run smoke` is the check on the artifact that actually ships: it loads
`docs/assets/*.js` into a DOM, signs in, and walks all three pages against a
stubbed API. Run it after building and before committing the output.

## Build and deploy

GitHub Pages serves `main:/docs`, and the build is committed. There is no CI:

```sh
npm run build
npm run smoke
git add docs
git commit -m "Deploy"
git push
```

`npm run build` type-checks first and writes `docs/`, replacing the previous
output. `docs/.nojekyll` is published from `public/` so Pages serves the
`assets/` directory as-is. Source maps are off because the output is committed;
debug with `npm run dev`.

Repository settings must have Pages set to branch `main`, folder `/docs`.

## Configuration

| Setting | Where | Value |
| --- | --- | --- |
| API base URL | `.env` | The Worker URL, used by the build |
| API base URL in development | `.env.development` | `/api`, proxied by Vite |
| Site path | `vite.config.ts` `base` | `/monitoring-client/` |
| Allowed origin | Worker `ALLOWED_ORIGINS` | `https://dmitryweiner.github.io` |

Neither file holds a secret. The only backend change this client needs is the
allowed origin, which is set in `cloud/wrangler.jsonc` of the `monitoring`
repository and applied with `wrangler deploy`. Without it the browser's
preflight is refused and nothing loads. Note that the value is scheme and host
only, so it covers every GitHub Pages site of that account.

## Where the access key comes from

There is no registration: the Worker has no user accounts. The key was
generated once while the backend was set up and lives in the `monitoring`
project, next to this one:

```
monitoring/secrets/admin.key
```

It is 43 characters of url-safe base64, that is 32 random bytes, with
permissions 0600, and `secrets/` is excluded from Git. Open the file and paste
the line into the sign-in form.

Cloudflare holds only the SHA-256 of that key, as the Worker secret
`ADMIN_HASH`, so the key itself cannot be read back out of Cloudflare. **That
file is the only copy.** Losing it means issuing a new key.

To replace the key, from the `monitoring` checkout:

```sh
head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n' > secrets/admin.key
chmod 600 secrets/admin.key
printf '%s' "$(cat secrets/admin.key)" | sha256sum | cut -d' ' -f1 \
  | npx wrangler secret put ADMIN_HASH --config cloud/wrangler.jsonc
```

Changing `ADMIN_HASH` invalidates every session that was issued against the old
key, including the one stored in the browser, so the next page load asks for
the new key. The device upload token is a separate secret and is not affected.

## How access works

The access key is typed once and exchanged at `POST /v1/session` for a session
key valid for seven days. The key itself is never stored; the session key goes
to `localStorage` and travels as `Authorization: Bearer` on every request.
The Worker's own cookie is useless here because the page and the API are
different sites.

Signing out revokes the session on the server. A rejected session returns the
page to the sign-in form immediately. A Content-Security-Policy in the built
page restricts connections to the API origin and forbids inline scripts.

Photos are private: they cannot be loaded through a plain image source, because
that request would carry no session header. The client fetches the JPEG, holds
it as a blob and shows that, keeping the ten most recent decoded so stepping
back and forth does not refetch.

## What the pages show

**Overview** polls `/v1/latest` every two minutes while the tab is visible. It
reports whether the device is delivering, the newest value of every metric, the
agent's queue, warnings for stale data, an unsynchronised clock and camera
failures in the last 24 hours, and the most recent photo.

**Charts** draw every discovered metric as a column of aligned panels with one
shared time axis and a single crosshair. Series are grouped by unit, one panel
per unit: degrees and byte counts on one pair of axes would imply a
relationship that is not in the data. Ranges up to a week are drawn from raw
events; longer ranges use the server's aggregation, showing the bucket mean
with its min/max band. A break in delivery draws as a gap, not a straight line.
Each panel's legend doubles as the value readout and switches series on and
off, and each has a table view with the same numbers.

**Photos** opens on the newest photo, steps with the previous and next buttons
or the arrow keys, jumps to a date within the 30-day archive, and downloads the
current JPEG. Home and End go to the newest and oldest photo.

Metrics are discovered from the data rather than hard-coded, and the unit is
inferred from the metric name, so the BMP280 and DHT11 sensors will appear on
the right panels once the agent starts sending them.

## Layout

```
src/api/      fetch wrapper, endpoint facade, session persistence, types
src/model/    time ranges, series building, unit inference, photo navigation
src/ui/       shell and routing, sign-in, overview, charts, photo viewer
tests/        Vitest suites for the model, the client and the views
scripts/      smoke check that runs the built bundle in a DOM
docs/         build output, committed and served by GitHub Pages
```
