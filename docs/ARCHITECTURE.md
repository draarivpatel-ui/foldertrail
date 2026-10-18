# ARCHITECTURE.md: BCR (codename; placeholder brand "Foldertrail", final brand TBD, see decisions)

Gate 0, corrected after a skeptical review, 2026-10-05; §1, §3, §4, §6, §9 and §10
brought in line with the code on 2026-10-06 (file names, the worker protocol, the exact header block from
`site/_headers`). FORMAT.md is the byte-level companion. Labels used here: VERIFIED, REPORTED, GUESS, as in FORMAT.md §0.
Where this file and the code disagree, the code is right and this file is out of date.

## 1. Purpose and promise

A Mac user drops their Garmin BaseCamp library onto a web page. The browser reads it on the user's own computer and produces:
- GPX files laid out in the same folder and list tree they built in BaseCamp;
- a KML file with nested folders;
- a report of what converted and what did not.

**Promise:** your files never leave this computer.
- The code makes no network request except one kind: the license-key check (`src/app/license.js`). It sends the key
  and a public ID (Polar: `organization_id`; Gumroad: `product_id`, plus `increment_uses_count=false`), and it goes
  **to the payment provider** (Polar, or Gumroad as the fallback). It runs when the user unlocks, and again at most
  once per browser session when the converter page opens with a key saved in the browser (`restoreLicense`), so that a
  refunded key stops working. The unlock panel, the landing page, the FAQ and the privacy page say so in plain words.
- The Content-Security-Policy (§10) is **defense in depth** behind that design: it makes an accidental or injected
  upload much harder. It is not a guarantee the user can verify for themselves, and the copy never calls it one.

## 2. Constraints

- A static site: no backend and no build step needed to run it.
- **Zero runtime dependencies.** The code is plain ES modules with JSDoc types.
  - Type-checking with `tsc --checkJs --noEmit` is a dev-only tool, and only if an already-installed TypeScript is available or the founder approves the dev dependency.
  - Tests use `node:test` on Node 22 or later.
- **Safari on macOS first**, then Chrome and Firefox. (Edge behaves like Chrome.)
- Clean-room: no GPSBabel code or reference files (GPL), and no kbm1959 code (no license). FORMAT.md is written in our own words from facts, with sources cited.
- Test data is 100% synthetic. No real BaseCamp library, real GPX file or personal data ever goes into the repository.

## 3. Modules

Every file below exists (checked against the tree on 2026-10-06). The shared data
model is `src/model.js`. `tools/build.js` copies `site/` as it is and every `src/**/*.js` (except the probe) to
`dist/js/` with its path kept, so `src/app/main.js` is served as `/js/app/main.js`.

```
src/model.js          the neutral library model shared by reader and writers (JSDoc types only)
src/config.js         CONFIG: brand, price shown, checkout URL, provider and its public ID, support address, version;
                      isConfigured() is false until the maintainer fills it in, and the page then
                      says "not on sale yet" instead of drawing a broken buy button
src/format/           the library reader: pure code, no DOM; runs in Node (tests) and in the worker
  unzip.js            ZIP reader (central directory, ZIP64, every CRC checked); entries inflated on demand through
                      DecompressionStream('deflate-raw')
  container.js        the record container shared by AllData.gdb ("MsRc") and FolderData.gfi ("DifG"): header, 'D'
                      and 'A' records, u32 length + u8 type records over views of the caller's bytes (FORMAT.md §3, §4)
  gdb.js              W/T/R record parsers for format 1.88, the H-KBM / H-OP / H-MAC48 layout hypotheses and their
                      validators,
                      and the bounds-checked primitives and text decoder (strict UTF-8, then windows-1252) that
                      gfi.js and tracksegments.js share (FORMAT.md §3.3, §5-§7)
  gfi.js              F/I/T/W/R/K/J records of FolderData.gfi and the tree build (no recursion, cycle guard, depth 64)
  tracksegments.js    per-track elevation and time; point size chosen by exact consumption (FORMAT.md §9)
  library.js          readLibrary(): assembles the model (tree, items, links, duplicates, orphans) and the counted
                      problems; every problem code and its plain words are in LIBRARY_PROBLEMS
  symbols.js          icon number to GPX <sym> table (clean-room, sources in docs/research/symbols-sources.md)
  dump.js             the structure-only diagnostic dump (§11)
src/export/           the writers; they see only the model, never raw bytes
  zip.js, crc32.js    ZIP writer (UTF-8 names, DEFLATE through CompressionStream or STORE, ZIP64) and CRC-32
  gpx.js              GPX 1.1 writer
  kml.js              KML 2.2 writer with nested <Folder>s
  paths.js            the folder/list tree as safe cross-platform ZIP paths
  xml.js              XML escaping, XML 1.0 character filtering, the writers' problem tally
  report.js           report.txt and report.html: what converted, what did not and why (REASONS)
src/app/              the web UI and the worker
  main.js             the page's entry: feature-tests module workers, then loads view-app.js, config.js and
                      license.js (the last two optional); written in old JavaScript so an old Safari can say why
                      it cannot run the app
  ui.js               the app's logic without the DOM: state machine, worker protocol, the words on the page,
                      the tree from the worker's flat rows (test/ui.test.js drives it with a fake worker)
  view-app.js         wires the page to the controller: drops, pickers, the worker, the step rail, each view
  view-preview.js     the preview: summary, folder tree (WAI-ARIA tree), what will not convert, reading notes
  view-unlock.js      the download panel: price and license key when on sale, "not on sale yet" otherwise
  view-dom.js         a tiny element builder: text only, refuses style/on*/javascript:
  intake.js           what the user gives (drop, folder picker, .Backup/.zip, loose files) to a located library;
                      toWorkerSource() / fromWorkerSource() carry it to the worker
  pipeline.js         the worker's logic as plain functions: parse, preview, dump, export
  worker.js           the module worker (served at /js/app/worker.js); only wires pipeline.js to postMessage
  license.js          the license check (Polar first, Gumroad second): verifyLicense, restoreLicense and the saved
                      key; the ONLY module allowed to make a network request
  probe.js, probe.html  the M0 drop probe (a local development page; not copied into dist/)
site/                 the static site: landing, converter (app/), guide, FAQ, privacy, 404; assets/; _headers (§10)
test/                 node:test suites (*.test.js); all data synthetic
tools/
  build.js            builds dist/ and refuses anything the CSP would block or that loads from another origin
  serve.js            local static server for dist/ that applies site/_headers (127.0.0.1 only)
  check-no-network.js only src/app/license.js may use a network API, and only toward the two provider origins (§10)
  fixtures/           independent synthetic library writer and its 32 scenarios (FORMAT.md §12); imports nothing
                      from src/
  gate1/              the Gate 1 kit (synthetic GPX, step list, structure-only check page)
  ui-dev/             development fakes (worker, config, license) and shoot.js (headless-Chrome screenshots)
```

## 4. Data flow

1. **The page finds the library** (intake.js, on the UI thread).
   - It walks a drop (`webkitGetAsEntry`, calling `readEntries` until it returns an empty batch), a folder picker's
     FileList, a `.Backup`/`.zip` file or loose files, and looks for `AllData.gdb`, `FolderData.gfi` and
     `TrackSegments/*`, in a `Database/<version>` folder at any depth or at the top level.
   - With several candidates it prefers a usable one, then one in BaseCamp's layout, then the highest version number,
     and says so in a note.
   - It reads almost no bytes: only a ZIP's table of contents, and the first 4 bytes of a few loose files when nothing
     was found by name. Everything else is listed and statted only.
   - `toWorkerSource(found)` turns the result into plain data plus `File`/`Blob` objects, sent by structured clone.
     Streams are not transferred, because transferable `ReadableStream` needs Safari 27 (VERIFIED, MDN BCD). The worker
     rebuilds it with `fromWorkerSource` (a backup's table of contents is read again there).
2. **The worker reads** (pipeline.js → `readLibrary` in library.js):
   - FolderData.gfi first (it is small): this gives the tree.
   - AllData.gdb and FolderData.gfi are each read whole, through `SourceFile.bytes()` in 16 MiB windows into one
     buffer, under size caps (AllData.gdb: 1 GiB, a GUESS at what a tab can hold). container.js frames records as
     views over that buffer (no copies).
     - W records become plain values;
     - T records keep their positions packed (an `Int32Array` per track plus segment starts); a track's `segments`
       is a getter that builds fresh Point arrays on every read (model.js);
     - R records are best-effort.
   - TrackSegments files are read during the read phase, one at a time, and released after their elevation and time
     are attached to the matching track.
3. **Preview (free).** The worker posts back the tree of folder and list names with per-list counts, what will not
   convert (by name, with a reason code), counted problems in plain words, version information and the structure-only
   dump. The full library stays in the worker. Names are shown only on the page. Nothing is sent anywhere.
4. **Export (unlocked).** Only after the license check passed (an honesty gate, §9), the page posts `export`. The worker:
   - writes GPX and KML text into the ZIP writer (`src/export/zip.js` `ZipWriter`), streaming each file as it is
     made, two files at a time (`EXPORT_PARALLEL` in pipeline.js), the archive keeping the order they were added;
   - deflates each file with `CompressionStream('gzip')` and strips the gzip wrapper, which leaves raw DEFLATE; the
     CRC-32 and length come from the gzip trailer (RFC 1952), and the length is checked against the bytes written; a
     header or trailer that does not parse fails cleanly with `compression_failed` instead of writing a broken ZIP. Each file
     is held only compressed. Without `CompressionStream` (Safari before 16.4) the file is stored uncompressed and
     `crc32.js` computes the CRC. (The gzip path was run in Node 26 and Chrome only; Safari and Firefox not yet.)
   - posts the archive to the page as a `Blob`; the page calls `URL.createObjectURL` and clicks an `<a download>`.
5. **Progress:** the worker emits `progress` messages. Canceling a read terminates the worker (a new one starts with
   the next library); canceling an export leaves the worker and its library alone and drops that export's answer.

**Worker protocol** (documented in `src/app/ui.js` and `src/app/pipeline.js`; every message carries the page's `id`):

```
page → worker   {type:'parse',  id, source}                 source = toWorkerSource(found)
worker → page   {type:'progress', id, phase, done, total}   phase: reading | parsing | linking | exporting
worker → page   {type:'parsed', id, preview, dump}          dump = {text, json}, structure only
page → worker   {type:'export', id, options:{kml, perItem}} only after the license check passed
worker → page   {type:'exported', id, zip, filename, report:{text, html}}
worker → page   {type:'error',  id, code, message}          plain words, never a name, coordinate or path
```

- **An `export` must reuse the `id` of the `parse` that read the library.** The worker keeps one library, under the
  id it was parsed with, and answers an export for any other id (or with nothing parsed, or after a fatal read) with
  `{type:'error', code:'not_parsed'}`. The page starts a new id for every new library, so a late answer about an old
  library is recognized by its id and dropped.
- The worker answers in order, one message at a time, and every export ends with exactly one `exported` or `error`.
  The page relies on that to drop the answer of an export it canceled.
- Messages are hostile input on both sides: anything malformed or for another id is ignored or becomes a plain error.

## 5. User flow (how the user supplies the library)

**When BaseCamp stops opening.** Mac BaseCamp 4.8.13 is Intel-only. Apple says that starting with macOS 28, Rosetta
will be available only for certain older, unmaintained games, and that Rosetta is available on macOS 27 or earlier
(support document 102527, VERIFIED [K]). So BaseCamp stops opening **only on Apple-silicon Macs that upgrade to
macOS 28**. Intel Macs run it natively, and Apple-silicon Macs that stay on macOS 27 or earlier keep it. A macOS 12-27
virtual machine is another way to keep it (one report: BaseCamp 4.8.13 runs in a Monterey VM, thread 429491, REPORTED). The copy never says that BaseCamp stops working on every Mac.

The page offers three routes, best first.

**A. BaseCamp still opens:**
- In BaseCamp, choose File > Backup and save the `.Backup` file.
- Drop it onto the page, or pick it with the file button. No renaming is needed, because BCR detects a ZIP by its bytes.
- This is the best route: one file, and it includes TrackSegments. The Mac Restore bug that skips TrackSegments does not matter, because BCR never restores (REPORTED, JaVaWa / bobgps 2025).

**B. BaseCamp no longer opens (the main case on an Apple-silicon Mac after macOS 28):**
1. In Finder, choose Go > Go to Folder…
2. The page has a "Copy" button for the path `~/Library/Application Support/Garmin/BaseCamp/Database`. Paste it into the Go to Folder box.
3. Drag the highest-numbered folder (for example `4.8`) onto the page.
   - Alternatively, drag the whole `BaseCamp` folder; BCR finds `Database/<version>` inside.
- `~/Library` is hidden in Finder, but Go to Folder still reaches it (VERIFIED, Apple support page, researcher).

**C. A custom library (`.bclibrary`):**
- BaseCamp > Preferences > Advanced > Library shows where it is (Mac manual p.15, VERIFIED by researcher).
- Drag the `.bclibrary` onto the page.
- If the browser presents the package as a single file (UNKNOWN; tested in M0), the page tells the user to right-click it, choose Show Package Contents, and drag the folder inside.

**Browser notes**
- **Drag-and-drop is the primary intake.**
  - Chrome's `webkitdirectory` picker shows "Upload N files to this site?" (VERIFIED, Chromium source), which contradicts the promise. Where that button is offered, the UI explains the dialog in advance.
  - `showDirectoryPicker` is never used. It is Chrome-only, and Chromium blocks `~/Library` for it (VERIFIED, Chromium source).
- **Folder drag:** whether dragging a folder from inside `~/Library` works in each browser through `webkitGetAsEntry` is UNKNOWN. It is the first thing M0 tests.

## 6. Outputs

The download is one ZIP named `<brand> export YYYY-MM-DD.zip` (local date; `src/app/pipeline.js`). Its layout, as
`pipeline.js` writes it:

```
GPX/<top folder>/<folder>/…/<list>.gpx      one GPX per BaseCamp list: its waypoints, routes and tracks
GPX/Not in any list.gpx                     items no list names (only when there are any)
GPX/_Duplicate names/<Kind> - <name>.gpx    one file per copy whose list could not be decided (FORMAT.md §10)
GPX/All items.gpx                           everything that was converted, in one file
GPX/Waypoints.gpx, Tracks.gpx, Routes.gpx   instead of the tree, when there is no usable FolderData.gfi (B11)
KML/<top folder>.kml                        optional; one document with nested Folders
report.txt, report.html                     what converted, what did not and why; versions; counts
READ-ME-FIRST.txt                           what each part of the download is
```

Optional setting: "one GPX per item": each list becomes a folder holding one GPX per item, for apps that import
single items more easily.

**report.html** is opened from disk, where no `_headers` policy applies, so it carries its own `<meta>` CSP
(`REPORT_CSP` in report.js): `default-src 'none'`, its one inline style allowed by its sha256 hash, and `base-uri` and
`form-action` `'none'`. Library names in it are HTML-escaped (verified in Chrome only).

**GPX 1.1**
- Encoded as UTF-8, with `creator` set to the brand.
- `<metadata><desc>` holds the list's folder path.
- **Waypoints:** `wpt` with name, cmt and desc (from the comment), `sym` when mapped, and ele and time when they were decoded.
- **Tracks:** `trk` with name, one `trkseg` per segment, and `trkpt` lat/lon with ele and time when decoded. Track color is written as a Garmin `gpxx:TrackExtension/gpxx:DisplayColor` (the namespace is Garmin's GpxExtensions v3).
- **Routes:** `rte` / `rtept` through the via points only (straight lines; the device recalculates).
- **Coordinates:** 7 decimals with trailing zeros trimmed (`formatLat`/`formatLon` in xml.js, `degrees()` in gpx.js):
  about 1 cm. Rounding moves a point by at most 5e-8° (about 6 mm), a little less than the semicircle resolution of
  about 8.4e-8°.
- **Times:** ISO-8601 UTC ending in `Z`.

**An item in several lists** is written into each list's file, and the report gives the count.

**File names**
- Strip `/ : \ * ? " < > |`, control characters and leading dots.
- Normalize to NFC, cap each name at 120 UTF-8 bytes, and add " (2)" and so on when two names collide.
- The original name stays inside the GPX unchanged.

**KML 2.2** (`http://www.opengis.net/kml/2.2`)
- Waypoints are Point placemarks; tracks and routes are LineString placemarks with `tessellate=1`.
- Coordinates are written `lon,lat[,alt]`. No `gx:` extensions in v1.
- Nested folders are kept for Google Earth and Guru Maps.
- CalTopo keeps folders only from GeoJSON (VERIFIED, researcher). A GeoJSON output is a v1.1 candidate.

## 7. Limits (v1; each is stated in the report and on the page)

- **Supported:** library file format 1.88 (raw version 188), which BaseCamp 4.4.1-4.7.5 writes (OP's table). Mac 4.8.x is
  assumed to be the same until Gate 1, which is a GUESS with one failed direct test against it (FORMAT.md §1.1).
  - 146-187 and anything above 188 are "experimental". Versions are compared as raw integers, never as decimals.
  - 115-138 are rejected.
  - Exported 1.7-1.9 `.gdb` files are explained, not converted, because they contain no tree.
- **Waypoints:** name, position, comment and symbol always. Altitude and time only when exactly one layout hypothesis
  validates, or several do and AllData.gdb's program version picks one (B43, FORMAT.md §3.3 rule 8) (H-MAC48 on Mac
  BaseCamp 4.8.13, measured on real output, FORMAT.md §15.11; H-KBM on KBM's 1.88 library; H-OP is expected not to
  validate on 1.88). The time is BaseCamp's creation time (B42). Classes 0 and 1 are both
  exported, and the class is never labelled, because its meaning is unsettled (FORMAT.md §5.4); class 8 records are
  route via points and are not exported as waypoints.
- **Tracks:** positions when the track layout validates, including the mandatory bounds checks. Positions rest on one
  source (FORMAT.md §6), so a track that fails is listed by name as "not decoded". Elevation and time only when
  TrackSegments decode cleanly (the 17-slot point of FORMAT.md §15.11). Heart rate and air temperature go with them
  onto the points and into the GPX as Garmin's TrackPointExtension v2 (B44, which reverses B41's "not exported"); KML
  holds neither, and the report says so. Cadence is not read (no sample holds it).
- **Routes:** straight lines through the via points, and only when every via point resolves and no via point carries
  road-following (autoroute) data, whose layout is unknown. Any other route is NOT converted: it is listed by name,
  with the lists that name it, under the reason `route_autoroute`, `route_via_unresolved` or `route_not_decoded`
  (library.js; the page and the report give each reason its own sentence). No avoidances or activity profile.
- **Not converted, only counted:** BirdsEye, custom maps, Adventures, geocache logs, photos and thumbnails, map sections, and unknown record types.
- **Smart lists** (FolderData.gfi lists with created-by 3, such as "Last Week") are not exported as lists; their items
  are saved in their own lists or in "Not in any list", and the report says so (B40, FORMAT.md §15.11).
- **Duplicate names** are not placed by guesswork (FORMAT.md §10). GPSBabel's GDB writer forces unique names, so this
  is probably rare (GUESS), but the rule stays.
- **Windows libraries** probably work: KBM ran on a 4.7.5 library, and that it was a Windows library is a GUESS (high
  confidence; FORMAT.md §0). They are not marketed until a test library has been checked (B32).

## 8. Error handling

- **Every record is parsed inside its own try/catch,** and the reader always resumes at start+len.
  - Failures increment typed counters, for example `W.detailsUndecoded`, `T.notDecoded`, `R.stoppedAtAutoroute`.
  - Errors carry a code, a byte offset and a field index. **They never carry names, coordinates or paths.**
- **Whole-file problems each get a plain-English message,** and the user can always download the diagnostic dump:
  - a bad signature;
  - an unsupported version;
  - a truncated file;
  - a missing `AllData.gdb`;
  - an unreadable ZIP;
  - a ZIP that needs ZIP64 when the reader is incomplete.
- **A missing FolderData.gfi** gives a flat export by type, with a warning that no tree exists to recover.
- **A missing TrackSegments** folder gives tracks with positions only, with a warning.
- **Several version folders:** BCR uses the highest and names the others.
- **Hostile input:**
  - every count is checked against the bytes remaining before anything is allocated;
  - a cycle guard protects the F tree;
  - recursion depth is capped at 64;
  - the total work is bounded by the input size;
  - if the worker dies (an `error` or `messageerror` event), the UI says "something went wrong" in plain words and
    keeps the preview when there is one. There is no heartbeat: a worker that hangs without dying is stopped only by
    the user's Cancel.
- **Old Safari (before 16.4) without `DecompressionStream`:**
  - `.Backup` input shows "Double-click the backup in Finder (rename it to .zip first if Finder will not open it), then drag the folder that appears".
  - Output falls back to STORE (no compression).

## 9. License gate

- **Free:** the full preview (tree, counts, what will not convert, reading notes). The report comes with the download.
- **Paid unlock:** the ZIP export. Whether to charge, and how much, is a founder decision (decision B25). Until
  `isConfigured()` in `src/config.js` is true, the page says "not on sale yet" and the download stays off.
- **Module interface** (`src/app/license.js`; every function returns a result and never throws):
  `verifyLicense(key) → {ok, code, message, …}`, `restoreLicense() → result | null` (the saved key, re-checked at most
  once per browser session), `getStoredLicense()`, `storeLicense(key)`, `clearLicense()`. The page (`ui.js`) calls
  `restoreLicense` once when the converter opens, and `verifyLicense` when the user unlocks or downloads with a key that
  was not yet checked.
- **Primary: Polar.**
  - Endpoint: `POST https://api.polar.sh/v1/customer-portal/license-keys/validate` with JSON `{key, organization_id}`.
  - Polar documents it as unauthenticated and safe for public clients. A live probe returned `access-control-allow-origin: *` (VERIFIED, researcher).
  - The organization ID comes from `src/config.js` and must come back in the response (`organization_id`, with
    `status: "granted"`), so keys from other stores are rejected. No benefit ID is checked.
  - The response fields were checked against Polar's documentation on 2026-10-06 (license.js header); not against a
    live store, since none exists yet.
- **Fallback: Gumroad.**
  - Endpoint: `POST https://api.gumroad.com/v2/licenses/verify` with `product_id`, `license_key` and `increment_uses_count=false`.
  - It sends CORS `*` and needs no token (VERIFIED, researcher, from live probe and source).
- **Lemon Squeezy is not used.** Its CEO post of January 2026 points to a migration to Stripe Managed Payments (VERIFIED, researcher).
- **Checkout** is a link out to the merchant's hosted page. No overlay iframe is drawn on our page; this follows clause 2.2.1(h) of Cloudflare's free plan.
- **Key storage:** a key the provider accepted is kept in `localStorage` (`foldertrail.license.v1`), wrapped in
  try/catch, as a convenience. The stored record is exactly `{v: 1, provider, key}`; older entries that also carry
  `validatedAt` still load (the extra field is ignored). A `sessionStorage` flag (`foldertrail.license.rechecked`) makes `restoreLicense` ask the
  provider at most once per browser session. A saved key the provider now refuses (invalid or refunded) is removed; if
  the provider cannot be reached, the saved key is trusted, so a buyer is never locked out by a network problem.
- **If the merchant drops CORS, the fallback order is:**
  1. switch to the other adapter;
  2. a roughly 20-line Cloudflare Worker proxy at our own origin, with `connect-src 'self'`. **This is a server**, on the free plan, and needs the founder's approval;
  3. unlock codes the founder signs by hand, verified with WebCrypto ECDSA P-256. That browser support is a GUESS to verify.
- **Honesty:** a client-only check can be patched out. It is an honesty gate, not DRM, and the page treats it that way.

## 10. Privacy and CSP

**What actually keeps files local** is the code: nothing in `src/` sends data, `src/app/license.js` is the only module
allowed to use a network API, and `tools/check-no-network.js` enforces that (test/no-network.test.js runs it over the
real `src/` and `site/`). The Content-Security-Policy is **defense in depth** behind that: it makes an accidental or
injected upload much harder. It is not something users can verify, and the copy never calls it a guarantee.
`connect-src` alone does not stop every leak: a form post is not a fetch, which is why the policy also sets
`form-action 'none'` and `base-uri 'none'`; and no CSP directive stops a script from navigating the page to another site
(general knowledge, not re-checked here), so only the code rules above stand against that.

**The policy is an HTTP response header on every path**, including the module-worker script and every other file the
site serves (one `/*` rule in `site/_headers`).
- Reason: a dedicated worker loaded from a URL takes its CSP from **its own response**, not from the page that started
  it. A `<meta>` CSP in the page would therefore leave the worker, which is where the library is parsed, unrestricted.
  (REPORTED [K] from the HTML "run a worker" algorithm and the CSP policy-container model; not re-read line by line.)
- So BCR does not rely on a `<meta>` CSP at all. (A meta tag also cannot set `frame-ancestors`.)
- Netlify and Cloudflare Pages read a `_headers` file; that comes from general knowledge, so check it at build time.
  Whether Cloudflare Workers static assets honor `_headers` is a GUESS to verify; if not, use that host's own header
  configuration. Either way the same policy must reach every path.
- `tools/serve.js` applies the same file locally, so the tests and the headless-Chrome runs see the real policy.

The rule exactly as `site/_headers` has it (copied from the file; test/site.test.js checks that this block matches):

```
/*
  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; child-src 'self'; frame-src 'none'; worker-src 'self'; connect-src https://api.polar.sh/v1/customer-portal/license-keys/validate https://api.gumroad.com/v2/licenses/verify; form-action 'none'; base-uri 'none'; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: accelerometer=(), bluetooth=(), browsing-topics=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), hid=(), magnetometer=(), microphone=(), midi=(), payment=(), serial=(), usb=(), xr-spatial-tracking=()
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Resource-Policy: same-origin
  X-Frame-Options: DENY
  Cache-Control: public, max-age=0, must-revalidate
```

- `connect-src` names the **two licence endpoints exactly** (Polar's `validate` and Gumroad's `verify`, B38), not their
  whole hosts: Polar also has an unauthenticated `activate` endpoint that stores free-form `label` and `meta` fields
  (security review, from Polar's docs, 2026-10-06), which injected script could otherwise use to write data into an
  attacker's own Polar account. A source path without a trailing slash matches only that path, and paths are ignored
  after a redirect, which `license.js` refuses anyway (`redirect: 'error'`). That matching rule is general CSP
  knowledge (CSP Level 2 and later), not re-checked here in Safari. Gumroad stays as the fallback (§9). If the provider
  set changes, change this line, `POLAR_VALIDATE_URL`/`GUMROAD_VERIFY_URL` and `LICENSE_ORIGINS` in `license.js`, and
  `ALLOWED_ORIGINS` in `tools/check-no-network.js` together (test/headers.test.js checks that they agree). If the
  Cloudflare Worker proxy fallback (§9) is ever approved, `connect-src` becomes `'self'`.
- `child-src 'self'` is there only for Safari 15.0-15.4, which does not know `worker-src` (it arrived in Safari 15.5)
  and checks a new worker against `child-src`, falling back to `default-src 'none'`: without it the worker cannot start
  there and nothing converts (compat review, read from WebKit's source and MDN browser-compat-data, not run in Safari;
  docs/research/compat.md). `frame-src 'none'` keeps frames refused, since browsers that know `frame-src` fall back from
  it to `child-src`.
- No analytics, no third-party scripts, no web fonts (system font stack), no inline scripts or styles.
- **Links to other sites.** `tools/build.js` refuses every remote URL in the HTML except one kind: `<a href="https://…">`
  with `rel="noopener noreferrer"` on the same tag (the guide's and the landing page's sources). A link the user clicks is
  their own navigation, not a resource the page loads: it pulls in no code and sends no library data, and with
  `Referrer-Policy: no-referrer` the other site is not told which page the visitor came from. `http:`, `//host`,
  `<area>`, `ping=""` and every other attribute stay refused.
- **Checks:**
  - `tools/check-no-network.js` (and test/no-network.test.js) fails on a network API (`fetch`, `XMLHttpRequest`,
    `WebSocket`, `WebSocketStream`, `EventSource`, `sendBeacon`, `fetchLater`, `RTCPeerConnection` and its prefixed
    forms, `WebTransport`) anywhere but `license.js`, including an API looked up by a joined or computed name; on any
    URL in `license.js` other than the two provider origins; on remote or computed code loading; on a computed URL in a
    resource property or attribute, navigation to a computed URL, `new Audio`, and `createElement` of loader elements;
    on HTML or CSS strings and files that load a resource from another host; on `eval`, `new Function` and string
    timers (kind `csp-inline`); and on HTML sinks such as `innerHTML` (kind `dom-sink`). It deliberately does not flag
    plain URL strings (XML namespaces) or links the user clicks.
  - test/headers.test.js asserts the exact policy in `_headers`, set once on `/*`, and that `tools/serve.js` sends it on
    the worker script's URL, the page and a stylesheet.
  - `tools/build.js` refuses inline scripts and styles, `style=""`, `on…=""`, `javascript:` URLs and remote URLs (except
    the links above) in every page it builds. It also refuses a build with no `_headers`, and for this repository's own
    `site/` it requires a strict CSP on `/*` (`default-src 'none'`, `script-src 'self'`, no `unsafe-*` or wildcards).
  - After any deploy (the founder's go only), the same header check runs once against the live URLs.
- **The privacy page** says, in plain words: what is read (the files you give it, on your computer); what is sent (your
  license key and a product ID, to the payment provider, Polar or Gumroad, when you unlock and at most once per browser
  session to re-check a saved key); what is stored (the key, in your browser); and that the CSP is an extra safety
  layer, not the promise itself.

## 11. Structure-only diagnostic dump

The dump is a JSON file that the user can view and save. **The app never sends it.** The user may email it if they want help.

**Included:**
- the tool version and the browser engine family and major version (not the full user-agent string);
- the input kind (folder, ZIP or package), and counts of files by role (AllData, FolderData, TrackSegments, other);
- for each file:
  - the signature: a known ASCII value, otherwise the hex of the first 4 bytes;
  - the primary and D versions and the A-record program version, as raw u16 integers;
  - the application string, only if it is one of {MapSource, BaseCamp, HomePort}, otherwise "other";
- for each record type: count, total bytes, minimum/median/maximum length, which hypothesis validated (counts), histograms of leftover and missing bytes, failure codes with field index; for AllData.gdb's W, T and R, how the program version decided ties (B43: its family in fixed words, counts per layout, and routes refused in a Mac 4.8 file);
- flag-byte patterns (0/1 only), for example the TrackSegments extra-flag pattern and the file length modulo the point count;
- end of file: whether an 'X' record was present, and how many bytes followed it (a count only);
- GFI shape: folder count, maximum depth, list count, histogram of items per list, histogram of created-by values, unresolved references, duplicate keys, multi-list items (all as numbers).

**Never included:** any name, comment or link text; coordinates or bounds; times; UUIDs; file names or paths; builder or date strings; areas; lengths of named objects.

**Test:** fixtures seeded with sentinel strings, sentinel coordinates (in degrees and as their semicircle integers), sentinel times and UUIDs. The test asserts that none of them appears in the dump, in any encoding.

## 12. Performance and memory

- AllData.gdb and FolderData.gfi are each read whole into one buffer, under a size cap (AllData.gdb: 1 GiB; the cap is
  a GUESS at what a tab can hold), because container.js frames records as views over the file. (The plan was a
  chunked record iterator; it was not built.)
  - **Folder input:** the buffer is filled through `File.slice` windows of 16 MiB.
  - **ZIP input:** the entry is inflated through `DecompressionStream('deflate-raw')`, and its CRC and declared size are
    checked.
  - TrackSegments files are read one at a time and released.
- Track positions are stored packed in `Int32Array`s (8 bytes per point), with elevation and time in `Float64Array`s
  when decoded; Point objects are built only when a writer reads `segments` (model.js).
- Output is generated list by list and streamed into the ZIP writer as chunks, never as one giant string.
- Target (GUESS, to be measured in M4): a synthetic library of 10,000 tracks, 5 million points and 50,000 waypoints finishes in under 90 s in Safari on a 2015-era Intel MacBook.
- **Measured (perf pass, Node 26, 2026-10-06, the full-size synthetic library of test/perf.test.js; run it with
  `BCR_PERF=1 node --test test/perf.test.js`):** the export takes about 4.8 s and adds about 230 MB of RSS, 137 MB of
  it the finished ZIP, which Node has to hold in memory. Parsing alone peaks at about 456 MB RSS (311 MB right after
  AllData.gdb and FolderData.gfi are read, 126 MB of it ArrayBuffers for a 34 MB AllData.gdb), so the whole process
  peaks at about 686 MB: the < 500 MB peak target is **not met**. The fix belongs in the reader (likely causes, not
  verified: the 16 MiB window copies in `SourceFile.bytes()` and per-file TrackSegments buffers waiting for GC).
  test/perf.test.js asserts only the export's own rise (< 300 MB), so a green run does not mean the total target is met.
  Browser export speed was not measured at normal priority (headless Chrome runs only at background priority here).
- **Many tiny waypoints** (fuzz pass, measured): 400,000 minimal waypoint records (25.8 MB) add about 320 MB of RSS
  while reading, about 800 bytes each. container.js allows up to 2 million records, which by extrapolation (not
  measured) is about 1.6 GB. Lowering that cap could refuse a real large library, so it is the founder's call.
- Safari's per-tab memory ceiling and Blob limits are UNKNOWN. Chrome keeps up to 2 GB of blob data in memory on x64 desktop (VERIFIED, researcher).
- `.Backup` files can be several GB (REPORTED), and ZIP64 is handled. BCR touches only the entries it needs.

## 13. Browser support

Every version below is VERIFIED from MDN browser-compat-data by a researcher.

| Feature | Safari | Chrome | Firefox | Fallback |
|---|---|---|---|---|
| Folder drag (`webkitGetAsEntry`), `webkitdirectory` | 11.1 | 13 / 7 | 50 | single-file `.Backup` input |
| `DecompressionStream` / `CompressionStream` with `'deflate-raw'` | 16.4 | 103 | 113 | old Safari: unzip in Finder; output stored uncompressed |
| Module worker | 15 | 80 | 114 | none (require these versions) |
| `Blob.stream` | 14.1 | 76 | 69 | none |

- **Catalina:** Safari stops at 15.6.1 on Catalina (VERIFIED, Apple). By the table above, that version has folder intake and module workers but no Compression Streams. So on Intel Macs stuck on Catalina, `.Backup` files must be unzipped in Finder first, and the output is stored uncompressed. This follows from the version numbers and has not been tested; M0 records what actually works.
- **Minimum: feature detection, never version sniffing.** The page tests for what it needs (module workers first, then
  Compression Streams for the optional paths) and decides from the result, never from the user-agent string.
  - Without module workers, the page says to use a current Chrome or Firefox. It does **not** simply say "update Safari":
    BaseCamp 4.8.13 supports macOS 10.13 and later (VERIFIED, Garmin download page, per the gate-0 dossier), and on 10.13
    and 10.14 Safari cannot be updated to 15 [K]. Those users need Chrome or Firefox.
  - VERIFIED (compat pass, 2026-10-06, docs/research/compat.md): Chrome 116 is the last Chrome for macOS 10.13 and
    10.14 (Chromium commit e56fff98 "Remove 10.13, 10.14 support in chrome/" landed at main #1168728 on 2023-07-11,
    between M116's branch point #1160321 and M117's #1181205, per chromiumdash), and Firefox ESR 115 is the last Firefox
    for macOS 10.12-10.14 (the Firefox 116 release notes: "Firefox is no longer supported on macOS 10.14 and below";
    116's system requirements: "macOS 10.15 or later"). Both are above the table's minimums for module workers and
    `'deflate-raw'`.
- **More floors** (MDN browser-compat-data, read 2026-10-06; no Safari or Firefox was run):
  - `worker-src` needs Safari 15.5. Safari 15.0-15.4 checks workers against `child-src`, so the policy sets
    `child-src 'self'` (and `frame-src 'none'`), decision B38 (§10).
  - Private class methods (`#m()`) and `focus({preventScroll})` are exactly at the Safari 15 floor.
  - The Worker `messageerror` event is Safari 16.4 and not in Chrome, so failure handling must keep relying on
    `error`.
  - The full feature table, with a source for each row, is docs/research/compat.md; test/compat.test.js keeps it true
    (syntax scan of every shipped module, fixture runs with the built-ins Safari 15.0 and Firefox 115 lack deleted, CSS
    guards).

## 14. Test strategy

- **Runner:** `node --test --test-concurrency=2` on Node 22 or later. Heavy or slow suites go through the machine's heavy-job wrapper.
- **Unit tests:**
  - primitives (each type, every truncation point);
  - container (framing, `len` past EOF, unknown types, no stop at 'V');
  - version classification;
  - each W/T/R hypothesis, including accepting, rejecting and the "matched more than one layout" case;
  - the mandatory track bounds checks (a point outside its segment's bounds, a segment outside the track's bounds);
  - GFI tree (depth, cycles, orphans, the F.children vs I.parent mismatch);
  - linking (multi-list items, duplicates, missing .gfi, missing items, byte vs NFC match);
  - TrackSegments (N = 17 or 11 chosen by exact consumption whatever the program version, a flag of 1, count mismatch,
    the shared-endpoint match).
- **Coverage of the supported path** counts only H-KBM and H-MAC48 waypoint and track fixtures and the TrackSegments
  layout. Fixtures
  written under H-OP test that the reader tells the layouts apart; they never count as supported-path coverage
  (FORMAT.md §5, §12).
- **Independent writer versus reader:**
  - `tools/fixtures/` is written independently by someone who sees only FORMAT.md (§12 and the tables), never `src/`. A lint
    rule forbids `src/` imports from `tools/fixtures/`.
  - An adversarial reviewer then looks for places where reader and writer agree on something FORMAT.md does not actually say.
  - ZIP fixtures are built with `node:zlib`. ZIP output is read back with a small test-only reader that uses `node:zlib`
    `inflateRawSync`. Neither shares code with `src/format/unzip.js` or `src/export/zip.js`.
- **Golden outputs (planned, not built):** byte-exact GPX, KML, report and dump for each scenario. Today the GPX and KML
  writers are checked against subsets of their schemas (test/gpx.test.js, test/kml.test.js) and the reader against the
  independent fixtures (test/reader-vs-fixtures.test.js).
- **Fuzzing:** deterministic and seeded, with byte truncations and bit flips over every fixture. Each case must have no uncaught exception, must finish within the time budget, and must always produce a report. Kept small (the machine's CPU guard applies).
- **Privacy:**
  - the dump sentinel test (§11);
  - `check-no-network`;
  - the CSP string test, and the test that fetches the worker script's URL from a local server applying `_headers` and
    checks its CSP header (§10);
  - a test that the worker, `src/format/` and `src/export/` never touch `fetch`.
- **Browser:**
  - The M0 drop-probe checklist, run by hand on Safari, Chrome and Firefox on macOS. It records whether folder drag from `~/Library/Application Support`, `.bclibrary` drag and `.Backup` file input work, and what dialog wording appears.
  - The results are logged in docs.
- **Honest limit:**
  - Passing tests prove that the code is consistent with FORMAT.md. **They do not prove that it works on BaseCamp files.**
  - Gate 1 (FORMAT.md §13) is the only real-format check. Its oracle is BaseCamp's own per-list GPX export of a library that holds only made-up content.

## 15. Hosting and release

- **Host:** Cloudflare Workers static assets ("Start new projects with Workers", VERIFIED, researcher) or Netlify Free.
  - Not GitHub Pages: its terms forbid running an online business or commercial software as a service on it.
  - Not Vercel Hobby: non-commercial use only.
- **Founder decisions:** the domain (it costs money) and all publishing are the founder's to approve. Nothing is published without his go.
- **Footer:** "<Brand> is an independent tool, not affiliated with, endorsed by, or sponsored by Garmin Ltd. or its subsidiaries. Garmin and BaseCamp are trademarks of Garmin Ltd. or its subsidiaries."

## 16. Build order

**The Mac byte check comes before the record parsers are relied on, not just before charging** (FORMAT.md §1.1, §13).
The only direct test found of Windows 4.7 files in Mac 4.8 failed (Chris_68, 2020), and the 4.8 64-bit port gives a
plausible mechanism for drift. Cheapest order: drop probe, then a container-only reader with the structure-only dump,
then Gate 1 (or volunteer dumps), then the W/T/R parsers.

| Milestone | Content |
|---|---|
| M0 | Drop-probe page: lists names and sizes only, locally. It settles folder, package and ZIP intake per browser. The founder can test it in 5 minutes by making a dummy folder under `~/Library/Application Support`; no BaseCamp is needed. |
| M1 | Container-only reader (`bytes`, `container`) and the structure-only dump tool: signatures, 'D' and 'A' values, record type counts and lengths only. With the Gate 1 kit, this is what Gate 1 runs. |
| Gate 1 | A real Mac BaseCamp 4.8.13 library with only made-up content (FORMAT.md §13.2 scenarios), or structure-only dumps from volunteers (B4). Pass: every record consumed exactly, and the oracle comparison. |
| M2 | GFI tree, GDB W/T, TrackSegments, `library`; GPX, KML and report with golden tests; the independent fixture writer. |
| M3 | ZIP read and write (ZIP64, STORE fallback). (The ZIP writer and the ZIP reader exist already.) |
| M4 | Worker, UI, Safari pass, performance smoke test (synthetic, kept modest in size). |
| M5 | Diagnostic dump in the app and the privacy test suite, including the worker CSP-header test. |
| M6 | License adapters behind a flag (Polar, Gumroad). There is no live merchant until the founder sets one up. |
| M7 | Routes, best-effort. |
| Launch | After Gate 1 has passed, the founder decides on a paid launch. Before that, at most a free "experimental" preview (B3). |

- **Parser code written before Gate 1 is provisional.** It may be built against FORMAT.md (the original plan did
  this), but nothing relies on it, and nothing is called supported, until a Gate 1 dump has been run through it and
  every record was consumed exactly. Anything the dump contradicts is fixed in FORMAT.md first, then in the code.
- **Gate 1 can run now.** Rosetta is available on macOS 27 or earlier (Apple 102527, VERIFIED [K]), so the founder's
  Apple-silicon Mac on macOS 27 can run BaseCamp 4.8.13 today, once Rosetta and BaseCamp are installed. The window closes
  if that Mac moves to macOS 28. A macOS 12-27 virtual machine is the fallback (thread 429491, REPORTED). Installing
  Rosetta or BaseCamp (EULA acceptance, administrator package) is the founder's call (B4).
