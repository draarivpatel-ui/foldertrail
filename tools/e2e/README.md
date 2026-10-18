# tools/e2e: the real app page in headless Chrome, over every fixture scenario

Development only. Nothing here is copied into `dist/` (tools/build.js copies only `site/` and `src/`).

| File | What it does |
|---|---|
| `cdp.js` | A minimal DevTools-protocol client (Node's own WebSocket, no packages) and a headless Chrome launcher. Chrome is started with `--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"`, so it cannot reach any host but the local server, whatever the page or the run does. |
| `expect.js` | What the page and the ZIP must show for a scenario, derived from the fixture writer's own expectation (`tools/fixtures/expect.js`); a minimal GPX and KML reader; the comparisons. It imports nothing from `src/`. |
| `run.js` | The run itself, and a CLI. |

## What one run checks

For each of the 32 scenarios in `tools/fixtures`, handed over as a folder (`DOM.setFileInputFiles` on `#folder-input`
with the folder that holds `Database/4.8`) and as a `.Backup` file (`#file-input`), plus two scenarios handed over as
the `4.8` folder itself, plus `e2e-bulk` (a bigger made-up library built with the fixture writer, about 11 MB, only for
the memory and time figures):

1. The site is built into a scratch folder and only that copy of `js/config.js` is patched, so the app is "on sale"
   (placeholder checkout link on `example.invalid`, made-up Polar organization id). The run stops if the patch no
   longer applies. `src/config.js` is never edited.
2. `tools/serve.js` serves it with the Content-Security-Policy from `site/_headers`.
3. Every run gets a fresh browser context (so a saved licence key never leaks into the next run).
4. Preview: the summary totals, every tree row by name path and type, per-list counts, the "experimental" and "no
   folders" notices, "Not in any list" and "Duplicate names" counts, and every not-converted track or route named.
5. Unlock: the licence check is answered by `Fetch` interception (the CORS preflight with 204, the POST with a canned
   `granted` answer for the made-up organization). The request body must be exactly `{key, organization_id}`, with no
   cookie and no referrer. One extra run answers 404 and checks that the download stays locked.
6. Download: `Browser.setDownloadBehavior` saves the ZIP; it is opened with `src/format/unzip.js` in Node. Checked:
   each list's GPX (found by its `<metadata>` title and folder path, then its ZIP path: exact for plain names, safe-name
   properties otherwise) holds exactly the expected items, with names, positions (1e-7°), elevations, times, comments
   and route points; `Not in any list.gpx`, `_Duplicate names/`, the by-type files without a tree, and `All items.gpx`;
   no unexpected GPX file; the KML has every waypoint at its position; every GPX and KML passes `xmllint --noout`;
   `report.txt`, `report.html` and `READ-ME-FIRST.txt` exist, and `report.txt` equals the report shown on the page.
7. A library that cannot be used must end on the error view with plain words and the diagnostic report offered.
8. Every run records console errors and uncaught exceptions (page and worker), Content-Security-Policy violations
   (`securitypolicyviolation`, `Log` security entries, `Audits` issues), and any request to an origin other than the
   local server and the intercepted licence URL. Each must be zero. The only exception: in the refused-key run, Chrome's
   own "Failed to load resource: 404" line for the licence URL is kept as a note, because that 404 is the provider's
   documented answer for a bad key.
9. Memory: the page's `JSHeapUsedSize` after the preview and after the export, and the peak page and worker heap
   sampled every 250 ms. These are V8 heap figures: the ZIP `Blob` and `ArrayBuffer` contents are not in them.

A run that compared no GPX file fails. `test/e2e.test.js` also has a self-check that wraps the test build's GPX writer
to move every waypoint 2e-7° and expects the run to fail.

## Real BaseCamp output (`real.js`)

Two libraries written by Garmin BaseCamp for Mac 4.8.13 that hold only made-up content (`testdata/basecamp-real/`,
see its README) run as well: `real-run1` (the Gate 1 run) as a folder and as the `4.8` folder itself, and `real-run2`
(user lists, a nested folder, items in two lists) as a folder and as **BaseCamp's own File > Backup**
(`run2-exports/BaseCamp_261007.Backup`, byte-identical inside to `run2-structured/4.8`). They are copied into the scratch
folder; `testdata/` is never written to.

Their expectation is built from `tools/gate1/expected.json` (what the imported GPX held) and what BaseCamp measurably
did on import (FORMAT.md §15): one import list `gate1-ocean`, the smart lists "Last Week" and "Last Month" left out
(B40), "Unlisted Data" kept and empty, the renamed twin track "Gate1 Twin Track 001", the two GPX segments stored as
one, the import time as the creation time of waypoints without a GPX time (B42). On top of the checks above:
the exact ZIP listing, the KML folder nesting with each folder's placemarks, no smart list anywhere, and the report's
counts and notes. `test/e2e.test.js` also runs the app's own path on these samples in Node through the same ZIP checks
(always on, no browser; the page preview is checked in the browser only), so a wrong expectation cannot hide behind a browser failure.

## Running it

Through the heavy-job wrapper (one headless Chrome at a time):

```sh
env BCR_E2E=1 node --test test/e2e.test.js
node tools/e2e/run.js --out <scratch-dir> [--no-bulk] [scenario …]
```

`BCR_E2E_OUT=<dir>` keeps the build, fixtures, downloads, `summary.md` and `results.json`; `BCR_E2E_ONLY=a,b` limits
the scenarios (real samples by their names, `real-run1`, `real-run2`); the CLI runs every real sample unless given
`--no-real` or a list of names. Without `BCR_E2E=1` only the harness's own fast tests run. Needs Google Chrome in /Applications (or
`BCR_E2E_CHROME`) and `/usr/bin/xmllint` (part of macOS).
