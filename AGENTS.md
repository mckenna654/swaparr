# Swaparr — agent instructions

Mobile-first web dashboard for Dispatcharr (IPTV stream monitoring and source switching). Static
front end (`index.html`, `app.js`, `source-picker.js`, `style.css`) served by nginx, which proxies the
Dispatcharr API. Ships as `ghcr.io/mckenna654/swaparr`. Global rules: `mckenna654/agent-config`.

## Layout
- `nginx.conf.template` plus `40-generate-config.sh` render nginx config from env at container start.
- `run_server.py` is a local dev server and proxy (port 8080) for working without Docker.
- `tests/`: `stream-quality.test.cjs` and `escaping.test.cjs` (`node --test`), `test_proxy.py`
  (`python -m unittest`), `source-picker.browser.cjs` (browser check).
- API strings (channel, group, stream, provider, client) are set with `textContent`, never
  interpolated into `innerHTML`. Use `SourcePicker.element()` or the `build*` helpers in `app.js`.

## Commands
- Dev: `python run_server.py`, or `docker compose up --build`
- Tests: `node --test tests/*.test.cjs` and `python -m unittest discover -s tests`

## Rules
- The Dispatcharr API key reaches the browser only through the proxy. Never hard-code it.
- Screenshots in `docs/screenshots` use example data or blur channel and provider identities.
- Keep the compact charcoal UI. It must still work on small touch screens.
- Commit style: conventional prefixes (`feat:`, `fix:`, `docs:`).

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human` and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root, created when first needed. See `docs/agents/domain.md`.
