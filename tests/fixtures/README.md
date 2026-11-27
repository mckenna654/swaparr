# Captured Dispatcharr samples

Files here come from **Server settings → Capture sample data** in Swaparr, run against a
real Dispatcharr. Names, addresses, links and keys are already replaced with stand-ins
(`text-12` and so on) before the file is saved, so they are safe to commit.

`tests/fixtures.test.cjs` replays every `*.json` file here through Swaparr's parsers on
each push. Add a fresh capture after Dispatcharr updates to catch API changes early.
