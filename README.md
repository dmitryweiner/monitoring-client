# Home monitoring web client

Web interface for the home monitoring API. It signs in with the access key,
charts every measured parameter over a chosen time range, and browses the
camera archive. The backend is the Cloudflare Worker of the companion project
[dmitryweiner/monitoring](https://github.com/dmitryweiner/monitoring), which
also holds the Python agent on the board; this project only reads its `/v1` API
and never touches D1 or R2 directly.

Plan and scope: [PLAN.md](PLAN.md). What has actually been done and verified:
[STATUS.md](STATUS.md).

- Live site: https://dmitryweiner.github.io/monitoring-client/
- API: https://home-monitoring-poc.dmitry-weiner.workers.dev
- Backend and agent: https://github.com/dmitryweiner/monitoring
- API contract: [`cloud/openapi.json`](https://github.com/dmitryweiner/monitoring/blob/main/cloud/openapi.json) in that repository
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
allowed origin, which is set in
[`cloud/wrangler.jsonc`](https://github.com/dmitryweiner/monitoring/blob/main/cloud/wrangler.jsonc)
of the backend repository and applied with `wrangler deploy` from there. Without it the browser's
preflight is refused and nothing loads. Note that the value is scheme and host
only, so it covers every GitHub Pages site of that account.

## Where the access key comes from

There is no registration: the Worker has no user accounts. The key was
generated once while the backend was set up, and it lives only in a local
checkout of [dmitryweiner/monitoring](https://github.com/dmitryweiner/monitoring),
at this path inside it:

```
secrets/admin.key
```

On the machine used so far that checkout sits beside this one, so the full path
is `../monitoring/secrets/admin.key`. The file is 43 characters of url-safe
base64, that is 32 random bytes, with permissions 0600. It is not in the
repository: `secrets/` is excluded from Git, which is why the key cannot be
found on GitHub. Open the file and paste the line into the sign-in form.

Cloudflare holds only the SHA-256 of that key, as the Worker secret
`ADMIN_HASH`, so the key itself cannot be read back out of Cloudflare. **That
file is the only copy.** Losing it means issuing a new key.

To replace the key, from the root of that checkout:

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

**Charts** carry a filter block above everything, in four rows: Refresh with a
note on what is loaded, then three framed blocks holding the layout choice, the
time ranges, and a checkbox for every series with a Select all button. The
range, the layout and the cleared series are remembered in `localStorage`, and
everything is shown until a checkbox is cleared.

The default layout is one panel per unit, aligned in a column sharing one time
axis and a single crosshair. Degrees and byte counts on one pair of axes would
imply a relationship that is not in the data, so each unit gets its own panel.
The other layout puts everything on one plot. When the selected series share a
unit that plot keeps the real axis. When they do not, each unit is rescaled to
its own range and the axis says so, while the legend and the table keep the
measured values. Series sharing a unit share that range, so two temperatures
keep their order and their relative size. One plot carries at most eight
series, which is what the colour palette is validated for.

Ranges up to a week are drawn from raw events; longer ranges use the server's
aggregation, showing the bucket mean with its min/max band. The agent reads its
sources in turn, so one cycle's events arrive seconds apart; they are grouped
into one point on the time axis, placed at the first event of the cycle. A
break in delivery, or a sensor that returned no value, draws as a gap rather
than a straight line. Each panel's legend doubles as the value
readout and switches series on and off, and each has a table view with the same
numbers.

**Photos** opens on the newest photo, steps with the previous and next buttons
or the arrow keys, jumps to a date within the 30-day archive, and downloads the
current JPEG. Home and End go to the newest and oldest photo.

Metrics are discovered from the data rather than hard-coded, and the unit is
inferred from the metric name. The BMP280 and DHT11 sensors, delivered as the
sources `barometer` and `room`, appeared on the right panels without a code
change.

## Layout

```
src/api/      fetch wrapper, endpoint facade, session persistence, types
src/model/    time ranges, series building, unit inference, photo navigation
src/ui/       shell and routing, sign-in, overview, charts, photo viewer
tests/        Vitest suites for the model, the client and the views
scripts/      smoke check that runs the built bundle in a DOM
docs/         build output, committed and served by GitHub Pages
```
