# Browser compatibility of src/ and site/

Research note, 2026-10-06. Every version number below was read on that date from MDN's browser-compat-data (BCD),
through MDN's per-feature endpoint `https://bcd.developer.mozilla.org/bcd/api/v0/current/<key>.json`, unless the row
says otherwise. Where BCD has no entry (an engine limit, the behaviour before a feature existed), the source is WebKit's
own code, and the row says so. **No Safari or Firefox was run for this note**; see §8.

`test/compat.test.js` keeps the results true: it scans every shipped module's syntax tree for what the targets cannot
run, runs every fixture scenario with the built-ins Safari 15.0 and Firefox 115 lack deleted, and checks the CSS.

## 1. Targets

| Target | Why | Checked |
|---|---|---|
| Safari 15.0 and later on macOS | Decision B21: below 15 the page asks the user to update | — |
| Chrome 116 | The last Chrome for macOS 10.13 and 10.14 | VERIFIED: Chromium commit e56fff98 "Remove 10.13, 10.14 support in chrome/" landed at main position #1168728 on 2023-07-11; chromiumdash gives M116's branch point as #1160321 and M117's as #1181205, so the removal first shipped in 117 (chromium.googlesource.com, chromiumdash.appspot.com). Google's own help pages did not show the 117 note any more. |
| Firefox ESR 115 | The last Firefox for macOS 10.12-10.14 | VERIFIED: Firefox 116 release notes, "Firefox is no longer supported on macOS 10.14 and below", and 116's system requirements, "macOS 10.15 or later" (firefox.com). The Mozilla support article on the ESR move did not load; a search summary of it says 115 ESR gets security updates until March 2027 (NOT verified). |
| Current Chrome, Firefox, Safari | — | Everything below is older than them. |

Safari's last versions on macOS 10.13 and 10.14 (13.1 and 14.1) are general knowledge, not re-checked here.

## 2. Findings

| # | What | Affects | Status |
|---|---|---|---|
| 1 | **The worker cannot start in Safari 15.0-15.4.** The CSP has `default-src 'none'` and `worker-src 'self'`, but Safari learned `worker-src` only in 15.5 (BCD). Before that WebKit checks a new Worker against `child-src`, which falls back to `default-src` (WebKit source, below). So `new Worker()` throws a SecurityError and the user sees "Something went wrong inside the converter". | Safari 15.0-15.4: nothing can be converted | **Fixed** by the integrator (decision B38: `child-src 'self'` and `frame-src 'none'` added to the policy in site/_headers and everywhere it is pinned). Test: the CSP test in test/compat.test.js (was `todo`, now passes). Not run in Safari. |
| 2 | **"One GPX per item" crashes on a list (or, without FolderData.gfi, a type) of more than 65,536 items.** `files.push(...perItemFiles(...))` passes every item as an argument; JavaScriptCore throws a RangeError above 65,536 arguments (WebKit source, below); V8 fails at about 124,000 (measured in Node 26). | Safari 15 (and Chrome above ~124k items) | **Fixed** in src/app/pipeline.js (a loop). Tests fail before the fix |
| 3 | `overflow-wrap: anywhere` (7 rules) is Safari 15.4; in 15.0-15.3 the declaration is dropped and a long name without spaces runs out of its box (tree rows, the database path, report, names lists). | Safari 15.0-15.3 | **Fixed**: `overflow-wrap: break-word` before each one (site/assets/app.css, site.css) |
| 4 | `user-select: none` on tree rows has no effect in any Safari: Safari has only `-webkit-user-select` (BCD: unprefixed in Technology Preview only). Double-clicking a row to open it selects its text. | every Safari | **Fixed**: `-webkit-user-select` added (site/assets/app.css) |
| 5 | Everything else in src/ runs on all targets, or is feature-detected with a working fallback. | — | OK (tables below) |

## 3. JavaScript syntax

Found by parsing every shipped module (all of `src/**/*.js` except `app/probe.js`) with the acorn copy bundled in
Node, not by reading. "Where" gives one example; the test lists them all.

| Feature | Where | Safari | Chrome | Firefox | Verdict |
|---|---|---|---|---|---|
| ES modules, static `import`/`export` | everywhere | 10.1 | 61 | 60 | OK |
| static `import` in a module worker | app/worker.js | 15 | 80 | 114 | OK (the module-worker floor) |
| dynamic `import()` | app/main.js:55, :70 | 11.1 | 63 | 67 | OK |
| `import.meta` | app/view-app.js:66 | 11.1 | 64 | 62 | OK |
| async functions | 67 places | 10.1 | 55 | 52 | OK |
| `for await ... of` | export/zip.js:465 (over generators, never a stream) | 12 | 63 | 57 | OK |
| generators | export/gpx.js, kml.js, paths.js | 10 | 39 | 26 | OK |
| classes, `extends Error` | intake.js, zip.js, unzip.js | 9 | 49 | 45 | OK |
| private fields `#x` | export/zip.js:243-255, format/container.js:81 | 14.1 | 74 | 90 | OK |
| private methods `#m()` | app/pipeline.js:122 and 11 more | 15 | 84 | 90 | OK (exactly at the floor) |
| public class fields | none | 16 (partial 14.1-15.6) | 72 | 69 | not used; the test keeps it so |
| field initializer with extra parentheses | none (`#root = pathNode(0)` and `#encoder = new TextEncoder()` are plain calls) | ReferenceError in Safari 14.1-15.6 (BCD note; WebKit bug 236843, fixed 2022-03-21) | — | — | not used; the test keeps it so |
| class static blocks | none | 16.4 | 94 | 93 | not used |
| `?.` | 78 places | 13.1 | 80 | 74 | OK |
| `??` | 157 places | 13.1 | 80 | 72 | OK |
| `??=` | export/zip.js:603, format/unzip.js:342 | 14 | 85 | 79 | OK |
| `**` | format/container.js:48 and more | 10.1 | 52 | 52 | OK |
| numeric separators `1_000` | app/intake.js:37 and more | 13 | 75 | 70 | OK |
| object spread `{...o}` | 31 places | 11.1 | 60 | 55 | OK |
| optional catch binding `catch {}` | 87 places | 11.1 | 66 | 58 | OK |
| regex Unicode property escape `\p{Cn}` | export/paths.js:325, export/zip.js:982 | 11.1 | 64 | 78 | OK; see §7 on Unicode versions |
| regex lookbehind `(?<=` `(?<!` | none (every regex literal was listed) | 16.4 | 62 | 78 | not used |
| regex named groups, `s`, `d`, `v` flags | none | — | — | — | not used (`v` would need Firefox 116) |
| `new RegExp(...)` | none | — | — | — | all patterns are literals, so all were checked |
| top-level `await`, BigInt, import attributes, `using` | none | — | — | — | not used |

## 4. JavaScript built-ins

| Built-in | Where | Safari | Chrome | Firefox | Verdict |
|---|---|---|---|---|---|
| `String.prototype.isWellFormed` | export/zip.js:564 | 16.4 | 111 | 119 | OK: feature-detected, loop fallback (zip.js:995) |
| `Intl.Segmenter` | export/paths.js:395 | 14.1 | 87 | **125** | OK: feature-detected; Firefox 115 cuts long names by code point (§7) |
| `globalThis` | app/license.js:205, ui.js:437 | 12.1 | 71 | 65 | OK (not in main.js) |
| `Array.prototype.flat` / `flatMap` | view-dom.js:63, library.js:955, report.js:140 | 12 | 69 | 62 | OK |
| `Symbol.asyncIterator` | export/zip.js:445 | 11.1 | 63 | 57 | OK |
| `Promise.prototype.finally`, `Promise.race`, `Promise.all` | ui.js, license.js, intake.js | 11.1 / 8 / 8 | 63 / 32 / 32 | 58 / 29 / 29 | OK |
| `String.prototype.padStart`, `normalize` | several | 10 / 10 | 57 / 34 | 48 / 31 | OK |
| `String.fromCharCode.apply(null, chunk)` | format/gdb.js:347, :405 | engine limit 65,536 args (§8) | about 124,000 (measured for spread in Node) | not looked up | OK: chunks of 4,096 (`CHUNK`) |
| spread arguments `f(...arr)` | app/pipeline.js:436, :467 (before the fix); view-preview.js:460 (3 fixed items) | engine limit 65,536 args (§8) | about 124,000 (measured) | not looked up | **FIXED** (finding 2); the view-preview one is bounded |
| `Array.prototype.at`, `findLast`, `Object.hasOwn`, `structuredClone` | none (ui.js:831 and dump.js:1883 have their own `hasOwn`) | 15.4 | 92 / 97 / — | 90 / 104 / — | not used; the test keeps it so |
| `toSorted`, `Array.fromAsync`, `Promise.withResolvers`, `ReadableStream.from`, `Blob.bytes` | none | 16 / 16.4 / 17.4 / 27 / 18 | 110 / 121 / 119 / no / 144 | 115 / 115 / 121 / 117 / 128 | not used |

## 5. Web APIs

| API | Where | Safari | Chrome | Firefox | Verdict |
|---|---|---|---|---|---|
| module worker (`new Worker(url, {type: 'module'})`) | app/view-app.js:66 | 15 | 80 | 114 | OK: the floor. main.js tests for it (reads the `type` option of a worker that cannot start) and says "too old" without it |
| `Worker` `error` event / `messageerror` event | view-app.js:68-72 | 4 / **16.4** | 4 / **no** (BCD: false) | 3.5 / 57 | OK: `error` is the one that matters; `messageerror` is extra |
| `CompressionStream` (`gzip`, `deflate-raw`) | export/zip.js:709, :1102, :1129 | 16.4 | 80 (`deflate-raw` 103) | 113 | OK: detected (zip.js:825, :1102); without it every entry is STORED with crc32.js |
| `DecompressionStream('deflate-raw')` | format/unzip.js:862, intake.js:470 | 16.4 | 103 | 113 | OK: detected; a deflated `.Backup` gets "unzip it in Finder" |
| `ReadableStream` constructor, `getReader`, `pipeThrough` | zip.js:1118, unzip.js:883, :821 | 10.1 | 52 / 43 / 59 | 65 / 65 / 102 | OK (pipeThrough is used only with Compression Streams, so 16.4/113) |
| `ReadableStream` async iteration, transfer | none (ARCHITECTURE §4 already avoids transfer) | 27 | 124 / 87 | 110 / 103 | not used |
| `WritableStream.getWriter` | zip.js:710 | 14.1 | 59 | 100 | OK (only behind CompressionStream) |
| `Blob`, `Blob.slice`, `Blob.arrayBuffer` | pipeline.js:407, intake.js:1972, :2033 | 6 / 7 / 14 | 20 / 21 / 76 | 13 / 13 / 69 | OK |
| `TextEncoder.encodeInto` | app/pipeline.js:560 | 14.1 | 74 | 66 | OK |
| `TextDecoder` with `fatal`, `ignoreBOM`, `stream` | format/gdb.js:382, unzip.js:633, license.js:157 | 10.1 | 38 | 36 / 63 | OK |
| `fetch` with `redirect`, `cache`, `credentials`, `mode` | app/license.js:344-354 | 10.1 | 42-64 | 39-48 | OK |
| `fetch` `referrerPolicy` init | license.js:352 | 11.1 | 52 | 52 | OK |
| `AbortController` + fetch `signal` | license.js:329 | 12.1 (11.1-12 defined but did not abort fetch) | 66 | 57 | OK: also guarded with typeof, and a timer resolves regardless |
| `URLSearchParams` as a fetch body | license.js:418 | 10.1 (fetch) | — | — | OK |
| `DataTransferItem.webkitGetAsEntry` | intake.js:372 | 11.1 | 13 | 50 | OK (guarded with typeof) |
| `FileSystemDirectoryReader.readEntries`, `FileSystemFileEntry.file` | intake.js:1318, :1478 | 11.1 | 8 | 50 | OK |
| `<input webkitdirectory>`, `File.webkitRelativePath` | site/app/index.html, intake.js:1380 | 11.1 | 7 / 13 | 50 | OK |
| `navigator.clipboard.writeText` | view-app.js:461 | 13.1 (must be in a user gesture) | 66 | 63 | OK: called at the start of the click handler; `execCommand('copy')` (Safari 10, Chrome 42, Firefox 41) and then a selection as fallbacks |
| `HTMLElement.focus({preventScroll})` | view-app.js:410, view-preview.js:524 | 15 | 64 | 68 | OK (exactly at the floor) |
| `window.scrollTo({top, behavior})` | view-app.js:411 | 14 (`behavior`), 10.1 (`top`) | 61 | 36 | OK |
| `URL.createObjectURL`, `<a download>` | view-app.js:334, :349 | 6 / 10.1 | 19 / 15 | 19 / 20 | OK. Whether Safari starts a script-clicked download after an async export is not established; "Download again" is there for that |
| `Element.closest` | view-preview.js:304, :549 | — | — | — | OK (long supported; not re-checked; guarded at :304) |
| `localStorage` / `sessionStorage` | license.js | — | — | — | OK (not re-checked): every access in try/catch |

## 6. Content-Security-Policy (site/_headers)

| Directive | Safari | Chrome | Firefox | Verdict |
|---|---|---|---|---|
| `default-src`, `script-src`, `style-src`, `img-src`, `font-src`, `connect-src`, `frame-src` | 7 | 25 | 23 | OK |
| `form-action`, `base-uri`, `frame-ancestors` | 10 | 40 | 36 / 35 / 58 | OK |
| `child-src` | 10 | 40 | 45 | not set today: **needed** (finding 1) |
| `worker-src` | **15.5** | 59 | 58 | set, but Safari 15.0-15.4 ignore it |

**What Safari before 15.5 does** (read from WebKit's source; not run): on the `safari-612-branch` (Safari 15.0-15.3),
`AbstractWorker::resolveURL` returns a SecurityError when `contentSecurityPolicy()->allowChildContextFromSource(url)`
fails, and `ContentSecurityPolicyDirectiveList::violatedDirectiveForChildContext` checks
`operativeDirective(m_childSrc)`, which is `m_childSrc` or else `m_defaultSrc`; the file has no `workerSrc` at all.
`worker-src` arrived with WebKit bug 235260 (r288701, 2022-01-27), whose patch replaces that check with
`allowWorkerFromSource`, falling back worker-src → child-src → script-src → default-src. BCD dates it to Safari 15.5,
so 15.4 is taken to behave like 15.3.

**The change** (ready to apply, all files at once; it merges with the security review's narrower `connect-src`):
add `child-src 'self'` so the worker can start in Safari 15.0-15.4, and `frame-src 'none'`, because a browser that
knows `frame-src` but finds none falls back to `child-src` for frames, which would otherwise start allowing same-origin
frames. Browsers with `worker-src` keep using it for workers. The policy then reads:

```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; child-src 'self'; frame-src 'none'; worker-src 'self'; connect-src https://api.polar.sh https://api.gumroad.com; form-action 'none'; base-uri 'none'; frame-ancestors 'none'
```

Files that pin it: site/_headers, tools/serve.js `FALLBACK_CSP`, test/headers.test.js (`B22_CSP` and the directive
list at line 147), docs/ARCHITECTURE.md §10 (test/site.test.js compares it with _headers). Then
remove the `todo` from the CSP test in test/compat.test.js.

## 7. CSS and HTML

| Feature | Where | Safari | Chrome | Firefox | Verdict |
|---|---|---|---|---|---|
| `-webkit-mask` + `mask` (icons) | base.css:233-311, app.css:112, :1082 | 15.4 unprefixed (3.1-15.3: unprefixed recognised but has no effect); `-webkit-` 3.1 | 120 (`-webkit-` 1) | 53 | OK: every rule has both |
| `user-select` | app.css (`.row`) | `-webkit-` only | 54 | 69 | **FIXED** (finding 4) |
| `overflow-wrap: anywhere` | app.css (5 rules), site.css (2) | 15.4 | 80 | 65 | **FIXED** (finding 3); `break-word` is Safari 1 |
| `:focus-visible` | base.css:181, app.css:564, :1044 | 15.4 | 86 | 85 | OK: Safari 15.0-15.3 drop these rules and fall back to the browser's own `:focus` ring (general knowledge of WebKit's default style sheet, not re-checked); nothing removes outlines except `[tabindex="-1"]` headings, `.main` and `.home` (focus targets, not controls) |
| `gap` in flex layouts | many | 14.1 | 84 | 63 | OK |
| `inset` | base.css:297, app.css:262, :460 | 14.1 | 87 | 66 | OK |
| `inline-size`, `block-size` | many | — | — | — | OK (long supported; not re-checked) |
| `accent-color` | base.css:108 | 15.4 | 93 | 92 | OK: decoration only |
| `text-wrap: balance` | base.css:123, app.css:287 | 17.5 | 114 | 121 | OK: decoration only |
| `overscroll-behavior` | app.css:547 | 16 | 63 | 59 | OK: decoration only |
| `prefers-color-scheme`, `prefers-reduced-motion`, `hover`, `pointer` media | base.css, app.css | 12.1 / 10.1 / 9 / 9 | 76 / 74 / 38 / 41 | 67 / 63 / 64 / 64 | OK |
| media range syntax `(width >= …)` | none (all `max-width:`) | 16.4 | 104 | 102 | not used; the test keeps it so |
| `@layer`, `@container`, `@scope`, `:has()`, nesting | none | 15.4 / 16 / 26.4 / 15.4 / 17.2 | 99 / 105 / 118 / 105 / 120 | 97 / 110 / 146 / 121 / 117 | not used; each would drop whole rules in a target |
| HTML: `<dialog>`, `inert`, `popover`, `loading=`, `nomodule` | none | — | — | — | not used (grep of every page) |

Behaviour that differs between targets and is accepted:

- **Firefox 115 without `Intl.Segmenter`:** a name cut to fit 120 bytes is cut between code points, not graphemes, so
  an emoji sequence or a letter with a separate accent at the cut can lose its second half. The cut never splits a
  surrogate pair (paths.js `units`; test/paths.test.js and the stripped run in test/compat.test.js).
- **`\p{Cn}` follows each engine's Unicode version.** An older engine counts a newer emoji as unassigned: paths.js
  replaces it in a file name, and zip.js refuses such a path. Names inside the GPX are not affected. Not measured.
- **Safari 15.0-16.3:** no Compression Streams, so the ZIP is stored (larger), and a deflated `.Backup` must be unzipped
  in Finder first (already in ARCHITECTURE §8 and §13).

## 8. Engine limit: arguments per call

JavaScriptCore throws a stack-overflow RangeError when a call through `apply` or spread has more than `maxArguments`
arguments: `Interpreter.cpp` `sizeOfVarargs`, `if (length > maxArguments) throwStackOverflowError(...)`, and the
spread case is the `JSImmutableButterflyType` branch. `maxArguments` is `0x10000` (65,536) on the `safari-612-branch`
(Safari 15) and `0x100000` on WebKit `main` today; when it changed was not looked up. V8 in Node 26 fails at 124,391
arguments to `push(...)` (measured).

## 9. main.js on old browsers

main.js uses `var`, `function`, `Object.defineProperty`, promises and `import()`, and nothing newer (the test checks
for `?.`, `??`, logical assignment, numeric separators, class fields, `await`, static imports, `globalThis`, `flat`,
`allSettled` and the like). So:

- no module support (Safari before 10.1): main.js never runs; the boot note in the page appears after 1.5 s by CSS
  animation;
- modules but no `import()` (Safari 10.1-11.0, Chrome 61-62, Firefox 60-66): main.js fails to parse; the same boot note
  appears;
- `import()` but no module workers (Safari 11.1-14.x, including 13.1 and 14.1 on macOS 10.13 and 10.14; Firefox
  67-113; Chrome 63-79): main.js runs and shows "This browser is too old … use a current version of Chrome or
  Firefox";
- module workers: the app loads.

The module-worker test reads the `type` member of the options while the browser converts them; BCD gives the `type`
option the same versions as module workers (Safari 15, Chrome 80, Firefox 114), which is what the test relies on. It
was not run in an old browser.

## 10. Not done

- No Safari, Firefox or old Chrome was run. Finding 1 is read from WebKit's source and BCD; the fix for it is not
  applied (§6). The other fixes are checked in Node only.
- The CSS fixes were not looked at in a browser. In current browsers they change nothing (the later declaration wins).
- The run without Safari 15's missing built-ins covers the worker's code (pipeline, reader, writers) and `intake()` on
  a backup. The page's own modules (ui.js, view-*.js) are covered by the syntax and API scan only.
- main.js's module-worker test was not run in a browser older than Safari 15.
- BCD's own accuracy was taken on trust; each value was read once through a summarising fetch that was asked to copy
  values, not checked against a second source.
