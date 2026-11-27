# Handoff

Read this first when picking Swaparr up on another device or in another session.
Update it at the end of every non-trivial session.

## Current state (27 November 2026)

An ideation run (`docs/ideation/2026-11-27-open-ideation.html`) ranked 7 directions.
Jake asked to build them. They ship in two pull requests, not released or tagged:

**PR 1, branch `claude/next-features`** (ideas 1–5):
- **Proxy allowlist (idea 2).** nginx forwards only Swaparr's own method+path pairs
  (`map` at the top of `nginx.conf.template`); everything else gets 403 before the key is
  added. `run_server.py` has the same `API_ALLOWLIST`; `tests/test_proxy.py` checks both
  match. `DISABLE_PROXY` is ignored with a startup warning (it put the key in config.json).
  **Any new Dispatcharr call must be added to both lists.**
- **Real data and CI (idea 3).** Server settings → Capture sample data (`sample-capture.js`)
  saves one redacted file: keys kept only if in `KNOWN_FIELDS`, values only if they match
  `SAFE_VALUES`. Drop captures in `tests/fixtures/`; `tests/fixtures.test.cjs` replays them.
  `.github/workflows/tests.yml` runs JS, Python, the Playwright browser check and
  `tests/container-check.sh` (real image + fake Dispatcharr) on every push. The container
  health check (`healthcheck.sh`) now fails when Dispatcharr does not answer via the proxy.
- **Channels tab (idea 5).** Opens on channels playing now plus ones seen playing on this
  device (localStorage `swaparr.recentChannels`, 30 days); loads their sources one at a
  time. Search covers all channels and loads sources only when the picker opens.
- **Switch check, find a source, live rate (ideas 1 and 4).** `StreamHealth` in `app.js`
  holds the pure decisions. `switchStream` returns `{ check }` right after the POST;
  `confirmSwitch` polls status every 2.5 s for up to 25 s. "Find a working source" walks
  the other sources in priority order. "Bitrate now" uses byte deltas between readings;
  Stalled means 15 s since the byte counter last grew (time, not a reading count, because switch checks poll faster). Source changes this page did not make show on the card.

**PR 2, branch `claude/watcher-and-pin`** (ideas 6 and 7, stacked on PR 1):
- **Watcher (idea 6), off unless `WATCHER=true`.** `watcher/swaparr_watcher.py` (stdlib
  Python, started by `50-start-watcher.sh`, restarts itself) reads `/proxy/ts/status`
  every 5 s straight from Dispatcharr, records started/stopped/source_changed/stalled/
  recovered to `/data/events.jsonl` (2000 kept) and serves them read-only on
  127.0.0.1:8099, exposed by nginx at `/watcher/` (GET only). `NOTIFY_URL` +
  `NOTIFY_FORMAT` (text for ntfy, json for Apprise/webhooks) alert on source changes and
  stalls, max one per channel and kind per 5 minutes. It cannot tell whether Swaparr or
  Dispatcharr changed a source, so its wording is neutral. The image now includes
  python3 (about 40 MB more). `config.json` gains `"watcher": true|false`.
- **Use until 3 am (idea 7), browser-side.** `Pins` in `app.js` (localStorage
  `swaparr.pins`) and `SourcePicker.pinTonight()`. Restores the original order after 3 am
  the next time Swaparr is open on that device, only if the order is still exactly the
  pinned one and has the same sources; otherwise leaves it. The watcher does not restore
  pins (no write API on purpose).

## Verified (27 November 2026)

- `node --test tests/*.test.cjs`: 21 pass, 1 skipped (no captured fixture yet) on PR 2.
- `python3 -m unittest discover -s tests`: 20 pass on PR 2 (8 proxy, 12 watcher).
- `tests/source-picker.browser.cjs` (Playwright 1.49.1, local Chrome): PASS, including the
  new switch check and find-a-source scenarios against the mock.
- GitHub Actions `Tests` workflow: unit, browser and container jobs pass on the branch.
  The container job builds the real image, runs `nginx -t`, checks the allowlist with
  curl and checks the health check passes and then fails when the fake Dispatcharr stops.

## Not verified

- Nothing has run against a real Dispatcharr or on a phone. Unknowns that matter:
  whether `total_bytes`/`uptime` behave as assumed (live rate, switch check), and
  whether 25 s is the right switch timeout. A captured sample from Jake's server
  answers the first.
- Mixed cache (old `index.html` + new `app.js`) was checked once by hand in Chrome:
  renders, no errors. New element lookups in `app.js` are guarded for this reason.
- Docker was not available on the Mac (CLI only, no engine); the image was built on
  GitHub Actions only.

## Next steps

- Jake: merge PR 1, then in Swaparr tap Server settings → Capture sample data and send
  the file, so `tests/fixtures/` has real shapes.
- Then PR 2. After merging, to try the watcher on Unraid: add `WATCHER=true` and a path
  `/data` → `/mnt/user/appdata/swaparr` (README has the steps); optionally `NOTIFY_URL`.
- Older open items: `createStreamCard()` still duplicates `updateStreamCard()`;
  `formatStreamLabel()`/`populateStreamOptions()` are dead apart from tests; the settings
  modal is a div, not a `<dialog>`. Dependabot PRs #6 and #7 still unreviewed.

## Earlier state (5 November 2026)

v1.2.1 (released 5 November 2026, PR 11) fixes the four correctness findings from a
full-project code review:

- Lucide is vendored at `vendor/lucide.min.js` (v0.468.0, ISC) and copied into the image,
  so the dashboard no longer needs internet access or unpkg to start. Every icon call in
  `app.js` goes through `SourcePicker.drawIcons()`, which is a no-op if the library is
  missing.
- `docker-compose.yml` maps `${PORT}` to the same port inside the container, matching
  `NGINX_PORT`. Previously any non-default PORT gave connection refused.
- `State.apiFetch()` treats an empty 200 body as success instead of a JSON parse error,
  and attaches `error.status`. `stopStream()` falls back from DELETE to POST only on
  405 or 501; other failures are reported as they are.
- `40-generate-config.sh` exits with a clear message when `DISPATCHARR_URL` is unset and
  warns when `DISPATCHARR_API_KEY` is empty, instead of letting nginx crash-loop on
  `proxy_pass /;`.

Still open from the same review (not fixed): the channels table fires up to 150 stream
fetches at once and calls `drawIcons()` per row; `run_server.py` is single-threaded with
no upstream timeout; DISABLE_PROXY mode sends the API key to the browser, which conflicts
with the rule in AGENTS.md; `createStreamCard()` duplicates `updateStreamCard()`; the
settings modal is a hand-rolled div rather than a `<dialog>`; `formatStreamLabel()` and
`populateStreamOptions()` are dead apart from their tests.

Branch `claude/escape-provider-data` (after PR 8 merged) closes an automated security
finding: `app.js` used to interpolate API strings into `innerHTML`. Channel, group,
stream, provider and client values come from third-party playlists and players, so a
crafted name could inject markup. Now:

- The stream card template is static; `createStreamCard()` fills it with `textContent`
  and sets ids and `dataset` afterwards.
- `buildChannelRow()`, `buildSourceCell()` and `buildClientRow()` build the channels
  table and client list from elements. The only `innerHTML` left in `app.js` is static
  markup with no interpolation.
- `tests/escaping.test.cjs` runs the builders against a hostile name in a tiny fake DOM;
  the browser check also loads a hostile group name and asserts nothing executes.

Earlier the same day, PR 8 merged the interface polish pass described next.

Branch `claude/unslop` holds a polish pass over the whole interface, done with the
unslop skill in "polish mode": the charcoal palette, teal accent, system font, layout
and section order are unchanged. What changed:

- `style.css` rewritten from scratch. One neutral ramp, three text roles, one accent,
  all spacing on a 4px grid, named transitions on one easing curve. The dead gradient,
  glow, pill and navy-input rules from the old theme are gone.
- Copy in sentence case throughout. Shorter labels ("Refresh", "Channels", "Search
  channels"), no exclamation marks, no trailing periods on short strings. Connection
  badge reads "Connected" / "Disconnected" / "Not responding".
- Stream state is a small dot plus a word ("Live", "Buffering") instead of an uppercase
  pill, on cards and in the channels table. `State.formatState()` maps API states.
- Header uses a flat two-arrow mark (inline SVG) instead of a filled tile. `Swaparr.png`
  is still the installed app icon and favicon.
- Toasts are styled from CSS classes (`.toast`, `.toast-title`, `.toast-body`), no
  inline styles.
- Picker close, drag handle and move buttons use Lucide icons (`x`, `grip-vertical`,
  `arrow-up`, `arrow-down`) via `SourcePicker.icon()` and `drawIcons()`.
- Stat labels are "Streams", "Clients", "Bandwidth". Card specs read bitrate, clients,
  uptime, data sent, in that order (the old CSS `order` hack is gone).
- Channels table on phones lays each row out as a small grid: number, name, group,
  current source, button.

### Verified

- `node --test tests/*.test.cjs`: 7 pass.
- `python3 -m unittest discover -s tests`: 3 pass.
- `tests/source-picker.browser.cjs`: PASS, run with Playwright 1.49.1 installed outside
  the repo and `CHROME_PATH` pointing at Google Chrome. Screenshots regenerated from it.
- Rendered against a mock Dispatcharr on desktop and at 375px wide in the Claude
  desktop browser: dashboard, expanded client list, picker, edit-order mode, settings
  dialog, channels table. No console errors.

### Not verified

- Not run against a real Dispatcharr instance or on a phone. The visual check used
  example data only.
- Docker image not rebuilt.

### Next steps

- v1.2.0 released 4 November 2026 and v1.2.1 released 5 November 2026 (tag, GitHub
  release, versioned image). The
  `?v=` cache-busters in `index.html` move with each release.
- Lucide is now vendored; bump `vendor/lucide.min.js` deliberately when needed.
- Two Dependabot PRs are open (GitHub Actions bumps, nginx 1.27 to 1.31). Not reviewed.

## How to run the browser check without Playwright in the repo

```bash
mkdir -p /tmp/pw && cd /tmp/pw && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright
```

```bash
PLAYWRIGHT_MODULE=/tmp/pw/node_modules/playwright CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node tests/source-picker.browser.cjs
```
