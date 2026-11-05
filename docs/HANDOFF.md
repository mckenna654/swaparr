# Handoff

Read this first when picking Swaparr up on another device or in another session.
Update it at the end of every non-trivial session.

## Current state (5 November 2026)

Branch `claude/review-fixes` (after v1.2.0) fixes the four correctness findings from a
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

## Verified

- `node --test tests/*.test.cjs`: 7 pass.
- `python3 -m unittest discover -s tests`: 3 pass.
- `tests/source-picker.browser.cjs`: PASS, run with Playwright 1.49.1 installed outside
  the repo and `CHROME_PATH` pointing at Google Chrome. Screenshots regenerated from it.
- Rendered against a mock Dispatcharr on desktop and at 375px wide in the Claude
  desktop browser: dashboard, expanded client list, picker, edit-order mode, settings
  dialog, channels table. No console errors.

## Not verified

- Not run against a real Dispatcharr instance or on a phone. The visual check used
  example data only.
- Docker image not rebuilt.

## Next steps

- Released as v1.2.0 on 4 November 2026 (tag, GitHub release, versioned image). The
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
