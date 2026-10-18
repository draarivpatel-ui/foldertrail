# Foldertrail

**Copyright (c) 2026 Foldertrail. All rights reserved.** The source is published for reference only; no permission is
granted to copy, modify, distribute or sell it. See [LICENSE](LICENSE).

Foldertrail is a static web page that turns a Garmin BaseCamp library into GPX files laid out in the same folders and
lists the user built in BaseCamp, plus one KML file that keeps the whole folder tree and a report of what converted and
what did not. The library is read in the browser, on the user's own computer; nothing is uploaded. The design has a
free preview (the folder tree, the counts, and what will not convert) and a license key that unlocks the download.

"Foldertrail" is a placeholder brand (the codename is BCR); the final name waits on a trademark search. It is an
independent tool, not affiliated with, endorsed by, or sponsored by Garmin Ltd. or its subsidiaries. Garmin and
BaseCamp are trademarks of Garmin Ltd. or its subsidiaries.

## Status: ON HOLD since 2026-10-08

Work on Foldertrail is paused; nothing is being developed or supported right now. Where it stood when it stopped:

- **Gate 1 has been run against real BaseCamp 4.8.13 for Mac, with made-up content only.** Gate 1 is the check that
  the reader agrees with files a real BaseCamp wrote ([tools/gate1/STEPS.md](tools/gate1/STEPS.md)). Run 1 (commit
  `a5e157b` added the samples) produced real Mac libraries; the Mac layouts were then measured on those samples and
  implemented (`96ee54d`, "H-MAC48"), with tests against the real samples, a mutation sweep and an end-to-end run on
  real folders and BaseCamp's own `.Backup` ([testdata/basecamp-real/](testdata/basecamp-real/README.md)). Run 2 added
  structured lists and BaseCamp's own exports. A third run kit (made-up GPX files exercising Garmin extension
  features, `ece17e3`) was prepared. After this, the site and help copy was changed to say the converter has been
  checked against real BaseCamp 4.8.13 for Mac libraries (`8a90001`).
- **Windows libraries are still unchecked.** They may work but no real Windows library has been tried.
- **Only made-up content has been tested.** No library with real places or names is in this repository.
- **Nothing is on sale and nothing is deployed.** The checkout link and the payment provider's ID in
  [src/config.js](src/config.js) are empty, so the page says "not on sale yet" and the download is switched off. No
  payment account exists, and no support address is published.
- The latest full test run in this copy: 846 tests, 844 passed, 0 failed, 2 skipped (the skipped ones are opt-in
  browser runs). Run `node tools/gate1/build.js` once first; one suite reads the generated check page.

## Run it locally

You need Node.js 22 or newer. There is nothing to install: the app and the tools use only browser and Node built-ins
(no `npm install`, no runtime dependencies).

```sh
node tools/build.js      # assembles dist/ from site/ and src/, and refuses anything the CSP would block
node tools/serve.js      # serves dist/ at http://127.0.0.1:8787/ (the converter is at /app/)
```

`tools/serve.js` listens on 127.0.0.1 only and sends every file with the headers from `site/_headers`, the module
worker included, so the page runs under its real Content-Security-Policy. Options: `--port`, `--root`, `--headers`.
`node tools/build.js --out <dir>` builds somewhere else; the build only ever replaces a folder it made itself.

To try a library without a real one, build a synthetic one with `node tools/fixtures/build.js <out-dir> [scenario…]`
(`--list` shows the scenarios; every name, place and time in them is made up).

## Test

```sh
npm test                                              # every suite: node --test --test-concurrency=2 "test/**/*.test.js"
node --test --test-concurrency=2 test/ui.test.js      # one suite
node tools/check-no-network.js                        # only src/app/license.js may make a network request
```

Tests use `node:test` and synthetic data only. `tools/ui-dev/shoot.js` takes screenshots of every step of the
converter in light and dark, at 1280 and 390 px, with a locally installed Google Chrome running headless
([tools/ui-dev/README.md](tools/ui-dev/README.md)); it is a development tool and never ships.

## Folder layout

```
src/model.js      the library model shared by the reader and the writers
src/config.js     brand, price shown, checkout link, payment provider ID, support address (empty until launch)
src/format/       the library reader: ZIP, record container, waypoints/tracks/routes, folder tree, TrackSegments,
                  the structure-only diagnostic dump; pure code that runs in Node and in the worker
src/export/       the writers: GPX, KML, ZIP, safe file paths, the report
src/app/          the converter page (main.js, ui.js, view-*.js), intake (what the user drops), the worker and its
                  pipeline, and license.js (the license check)
site/             the static site: landing, converter (app/), guide, FAQ, privacy, 404, assets, _headers
test/             node:test suites
tools/            build.js, serve.js, check-no-network.js; fixtures/ (synthetic library writer), gate1/ (the Gate 1
                  kit), ui-dev/ (development fakes and screenshots)
docs/             FORMAT, ARCHITECTURE, DECISIONS, brand, help articles, research/
```

`tools/build.js` copies `site/` as it is and `src/**/*.js` to `dist/js/`, so `src/app/main.js` is served as
`/js/app/main.js`. `dist/` is not checked in.

## Privacy model

- **The library never leaves the computer.** The page reads the files in a module worker in the browser tab and
  builds the download there. The only data that leaves is the license check: the license key and a public product ID,
  sent to the payment provider (Polar, or Gumroad as the fallback) when the user unlocks, and again at most once per
  browser session to re-check a key saved in the browser.
- **The code is the guarantee; the CSP is a second layer.** Only `src/app/license.js` may use a network API, and only
  toward the two provider origins; `tools/check-no-network.js` checks that. Every file is served with a strict
  Content-Security-Policy (`site/_headers`): scripts, styles and fonts from this site only, images from this site or
  inline `data:` URIs, connections only to the two providers, no forms, no framing.
- **No analytics, cookies, ads, third-party scripts or web fonts.** `localStorage` holds an accepted license key and
  nothing else; `sessionStorage` notes that it was re-checked this session.
- **The diagnostic report is structure only** (sizes, counts, lengths, version numbers; no names, places, times or
  paths), is shown to the user, and is never sent by the app.
- **Links to other sites** (the guide's sources) are plain links the user clicks, with `rel="noopener noreferrer"`;
  the build refuses any other reference to another site.

The privacy page ([site/privacy/index.html](site/privacy/index.html)) says the same in plain words.

## Documents

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): modules, data flow, worker protocol, outputs, limits, license gate, CSP.
- [docs/FORMAT.md](docs/FORMAT.md): the library file format as far as it is known, with sources and confidence labels.
- [docs/DECISIONS.md](docs/DECISIONS.md): numbered decisions (B1, B2, ...).
- [docs/brand/BRAND.md](docs/brand/BRAND.md) and [docs/help/](docs/help/README.md): brand rules and draft help articles.
- [tools/fixtures/README.md](tools/fixtures/README.md), [tools/gate1/STEPS.md](tools/gate1/STEPS.md),
  [tools/ui-dev/README.md](tools/ui-dev/README.md), [tools/e2e/README.md](tools/e2e/README.md).

## License

Copyright (c) 2026 Foldertrail. All rights reserved. The source is published for reference only; no permission is
granted to copy, modify, distribute or sell it. `package.json` declares the license as `UNLICENSED`.
