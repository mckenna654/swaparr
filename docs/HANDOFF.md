# Handoff

Read this first when picking Swaparr up on another device or in another session.
Update it at the end of every non-trivial session.

## Current state (3 November 2026)

Branch `claude/inspiring-wilbur-432167` (PR against `main`) hardens `app.js` against
stored XSS. An automated security review of the merged polish pass (PR 8) flagged
that channel, group, stream, provider and client values from Dispatcharr were being
interpolated into `innerHTML`; those come from third-party playlists and players, so
a crafted name could run script in the dashboard. What changed:

- `createStreamCard()` keeps a static template with no interpolation at all. The
  channel name, group, status, spec values, element ids, the stop button's
  `data-channel-id` / `data-channel-name` and the clients label are set afterwards
  through `textContent`, `dataset`, `id` and `setAttribute`.
- `renderChannelsExplorer()` builds each row's cells with `SourcePicker.element()`
  and `append`; the source cell uses `replaceChildren` for the stream and provider
  names and the "No sources" placeholder.
- New `State.createClientRow()` builds the client list rows as elements, sets
  `title` as a property, and coerces `current_rate_KBps` with `Number()` so a
  string rate no longer throws on `toFixed`.
- Every remaining `innerHTML` in `app.js` is a fixed string with no API data.
- New `tests/render-escaping.test.cjs` runs the card, client list and table through
  a small fake DOM, feeds `<img src=x onerror=alert(1)>` and similar payloads in, and
  asserts they appear as text and that no HTML string ever carried them. Against the
  pre-fix `app.js` all three tests fail.

Class names, ids, button labels, DOM order and the `.spec-value` order are unchanged.

### Previous state: polish pass (merged as PR 8)

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

- `node --test tests/*.test.cjs`: 7 pass (3 new).
- `python3 -m unittest discover -s tests`: 3 pass.
- `tests/source-picker.browser.cjs`: PASS, run with Playwright installed outside the
  repo and `CHROME_PATH` pointing at Google Chrome.
- A one-off Playwright script fed the payload as channel name, group, stream name,
  provider, client IP and user agent through the real page in Chrome: no `img`
  element was created, the `onerror` never ran, every value rendered as text, no page
  errors.
- Earlier polish pass: rendered against a mock Dispatcharr on desktop and at 375px
  wide; dashboard, client list, picker, edit-order mode, settings, channels table.

## Not verified

- Not run against a real Dispatcharr instance or on a phone. The visual check used
  example data only.
- Docker image not rebuilt.

## Next steps

- Review and merge the XSS hardening PR. It is a candidate for a version bump
  (the `?v=1.1.6` cache-busters in `index.html` should move with the next release).
- Consider pinning the Lucide script to a fixed version with an integrity hash; it
  currently loads `lucide@latest` from unpkg.
- Two Dependabot PRs are open (GitHub Actions bumps, nginx 1.27 to 1.31). Not reviewed.

## How to run the browser check without Playwright in the repo

```bash
mkdir -p /tmp/pw && cd /tmp/pw && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright
```

```bash
PLAYWRIGHT_MODULE=/tmp/pw/node_modules/playwright CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node tests/source-picker.browser.cjs
```
