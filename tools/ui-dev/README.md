# tools/ui-dev: development-only helpers for the app page

Nothing here is copied into `dist/` (tools/build.js copies only `site/` and `src/`).

| File | What it does |
|---|---|
| `fake-worker.js` | Speaks the worker protocol (see `src/app/ui.js`) with a made-up library, so the page can be built and checked before the real reader exists. Every name in it is invented. |
| `fake-config.js` | A `CONFIG` that is "on sale" (placeholder checkout URL on example.invalid), to see the licence panel. |
| `fake-license.js` | Accepts the synthetic key `FT-TEST-0000` and refuses anything else, after a short pause. No network. An accepted key is kept in `sessionStorage`, so a reload exercises the saved-key restore (`restoreLicense`). |
| `shoot.js` | Builds the site into a scratch folder, serves it with tools/serve.js (fakes swapped in by URL), drives headless Chrome over the DevTools protocol, and saves a screenshot of every step in light and dark, at 1280 px and 390 px. Run it through the heavy-job wrapper. |

```sh
node tools/ui-dev/shoot.js --out <scratch-dir> [--real-worker]
```
