# tools/fixtures: the independent library writer

A synthetic Garmin BaseCamp library writer, written from `docs/FORMAT.md` alone (built against the working-tree copy
of 2026-10-05 23:23 CDT, sha1 `1250926d`; the H-MAC48 additions of 2026-10-07 against §15 and its reader contract
§15.11; later on 2026-10-07 the oracle took §3.3 rule 8's program-version tie-break (B43) and the exported heart rate
and temperature (B44), changed in the same pass as the reader, so those parts are not an independent check). It never opens, lists, greps or imports `src/format/`, because the reader
there is written separately from the same document. If the writer and the reader agree, they agree on *FORMAT.md*.
That proves nothing about real BaseCamp files; only Gate 1 does (FORMAT.md §13).

Every name, coordinate and time is made up. Nothing generated is checked in: tests build the bytes in memory.

## Files

| File | What it does |
|---|---|
| `writer.js` | Primitives (§2), header and framing (§3), W/T/R record bodies (§5-§7), FolderData.gfi (§8), TrackSegments (§9), and `buildLibrary(spec)`. It has no `node:` imports, so it also runs in a browser. |
| `backup.js` | `buildBackup(built, options)`: a `.Backup` ZIP of `<name>/Database/<version>/…`, built with `src/export/zip.js`. |
| `expect.js` | `deriveExpected(spec, built)`: what a correct reader must produce, from FORMAT.md's rules, plus the `PROBLEMS` vocabulary. |
| `inspect.js` | A self-check walker, also from FORMAT.md. It proves each W/T record validates under exactly its intended hypothesis and each TrackSegments file under exactly its intended point size. It is not a reader. |
| `scenarios.js` | The 34 named scenarios, plus `buildScenario(name)`, which returns `{scenario, built, expected, exercises}`. |
| `build.js` | CLI: `node tools/fixtures/build.js --list`, or `node tools/fixtures/build.js <out-dir> [names…]`. Point it at `scratch/`. |

Test: `node --test --test-concurrency=2 test/fixtures-writer.test.js`.

## Using it from a reader test

```js
import { SCENARIOS, buildScenario } from '../tools/fixtures/scenarios.js';
import { buildBackup } from '../tools/fixtures/backup.js';

const { built, expected, scenario, exercises } = buildScenario('nested-tree');
built.files;      // Map: "AllData.gdb" | "FolderData.gfi" | "TrackSegments/<uuid>" → Uint8Array (relative to Database/<version>)
built.databaseVersion; // "4.8"
await buildBackup(built, { compression: 'store' | 'auto', zip64: 'auto' | 'always', directories: true, name: 'BaseCamp_x' });
```

### Expected result (`expected`)

It does not depend on reader ids. Match items by `(kind, name)`; when several items share a name, compare them as a
multiset. Match lists by their name path from the root. Compare list membership, and `tree` itself, as sets of
`(path, type)`: FORMAT.md fixes no order, and `tree` is listed depth-first only for readability.

| Field | Meaning |
|---|---|
| `fatal` | `{file: 'AllData.gdb', code}` when the library cannot be used at all. Then `items` is `[]`, and `tree` is `null` (not asserted). |
| `versions` | The raw 'D' versions of AllData.gdb and FolderData.gfi. `gdb` is `null` only when the header is unreadable (bad signature, bad 'D' record, garbage); `gfi` is `null` without a GFI. |
| `experimental` | `true` for 146-187 and above 188. |
| `tree` | `[{path, type}]`, where `path[0]` is the root's name ("My Collection"). It is `[]` without a GFI. |
| `items` | Every item the export writes. A waypoint has `{name, comment, icon, class, lat, lon, ele, time}`. A track has `{name, colorIndex, segments: [[{lat, lon, ele, time}]]}`. A route has `{name, points: [{name, lat, lon}]}`. Every item also has `placement` (`lists`, `not-in-any-list`, `duplicate-names` or `flat`), `lists` (the paths that hold it) and `specId` (the scenario's own id, for debugging only). |
| `notDecoded` | Tracks listed by name with no geometry (§6.5), with their lists. |
| `routesNotConverted` | `{name, reason, lists}`. The reason is `autoroute` (A > 0, parse stopped), `not_decoded` (a point failed) or `via_unresolved`. |
| `duplicates` | `{kind, name, class, copies, referencedBy}` for each duplicated link key (§10). |
| `problems` | `{code, count}` for each case FORMAT.md says is **reported**. |
| `counted` | `{code, count}` for each case FORMAT.md says is **counted** (in the report or the dump). |
| `tolerated` | Codes a correct reader *may* add, because FORMAT.md does not settle them (each one is explained in the scenario's `notes`). |

- `lat` and `lon` are exactly `v × 180 / 2^31` of the written semicircle integer. That is the same double as
  `v × 360 / 2^32`. A reader that computes `v / 2^31 × 180` can differ in the last bit, so compare with a tolerance of
  1e-12.
- Times are in ms. Elevations are metres or `null`.
- A waypoint carries its `icon` number, not a `<sym>` name, because the icon table is separate work (B31). A track
  carries its `colorIndex` (§6.3), not a colour name.
- `count` is given in the unit in `PROBLEMS[code].per`. `null` means "at least one, granularity not fixed by
  FORMAT.md". A harness can compare codes strictly and counts only where they are numbers.

### Problem vocabulary (`PROBLEMS` in expect.js)

**Reported:** `not_a_library_file`, `unreadable_file_header`, `exported_file_not_library`, `unsupported_version`,
`experimental_version`, `folder_data_version_differs`, `record_truncated`, `data_after_end_record`, `track_not_decoded`,
`track_total_count_unexpected`, `track_segments_missing`, `track_segments_not_decoded`, `track_segments_mismatch`,
`route_not_converted`, `no_folder_data`, `listed_but_not_found`, `duplicate_names`, `item_in_several_lists`,
`name_matched_after_normalising`, `list_folder_disagreement`, `list_not_in_tree`, `folder_in_two_places`,
`smart_lists_left_out` (B40), `track_sensor_data_kept` (B44; was `track_sensor_data_not_exported`, B41).

**Counted:** `waypoint_details_not_decoded`, `waypoint_class_not_exported`, `unknown_record_type`, `no_end_record`,
`record_order`, `author_record_unexpected`, `text_not_utf8`, `empty_segment`, `value_treated_as_absent`,
`folder_tail_unexpected`, `list_tail_unexpected`, `dangling_child`, `duplicate_id`, `not_converted_kind`,
`not_in_any_list`, `route_via_point_record` (B42).

The reader's own codes will differ. Map them in the integration harness; do not rename either side to match.

## Choices where FORMAT.md is silent or contradicts itself

`expect.js` throws instead of guessing when a description reaches a case FORMAT.md does not settle. These are the
choices that the bytes or the expectations do depend on:

1. **An unreferenced class 0/1 waypoint goes to "Not in any list".** §5.4 says BCR exports class 0/1 waypoints "that
   the GFI references"; §10 says items with no GFI reference go to `Not in any list.gpx`. I chose §10, which fits B11's
   flat export without a GFI. Only `orphans-and-classes` depends on this.
2. **The `.Backup` is built with `src/export/zip.js`, as the task asked.** FORMAT.md §12 and ARCHITECTURE.md §14 instead
   describe a `node:zlib` writer, and say tools/fixtures imports nothing from `src/`. The import is confined to
   `backup.js`. Stored archives are byte-identical everywhere. The deflated variant uses the engine's CompressionStream,
   so it is less independent of the reader's DecompressionStream path than §12 intends. Info-ZIP `unzip -l` listed a
   stored backup correctly (checked by hand once, not in the test).
3. **The root folder** has ID 0xFFFFFFFF, is its own parent, is named "My Collection", and is the first element of every
   expected path.
4. **Folder IDs and list IDs** are separate spaces that both start at 0 (§8.4 GUESS), so they overlap on purpose.
5. **Record tails.** An F record ends in one byte, 1. An I record with created-by ≠ 0 ends in `u8 1, u32 1, u32 9`; with
   created-by 0 it has no tail. §8.1 accepts "exactly one byte" after the children, so only an F tail's length counts
   as unexpected.
6. **GFI references.** The T Unknown1 is 0, the R origin byte is 0, and the W class is the waypoint's class. Order is
   R\* T\* W\* K\* J\*; within a type, by list order, then by the list's item order.
7. **GDB record order** is W\* R\* T\* V E X. 'V' is `00 01` (empty name, auto-named).
8. **Header defaults** are builder "bcr-fixture", date "Jan 01 2026", time "00:00:00" and application "BaseCamp". GFI
   and TrackSegments files reuse the GDB header (same 'D' version) unless overridden. The TrackSegments signature is
   "MsRc" (a GUESS); one variant uses "TrSg".
9. **Waypoint time under H-KBM.** The model time is written to K22, or to K18 with `timeIn: 'A'`. The expected time is
   K22 if present, otherwise K18 (§5.4). The ≤ 0 rule is applied after that choice; no scenario has a present K22 ≤ 0.
10. **Bounds** are tight raw-semicircle min/max by default. An empty segment's bounds, and a pointless track's bounds,
    are all zeros (§6.4 leaves them unspecified and skips checking them).
11. **Unvalidated track fields.** Start time is the first point's time, duration is last minus first (seconds), and
    length and area are 0 unless a scenario sets them.
12. **Route point fields.** Unknown1 is an absent fstring. Unknown2-5 are 0. Unknown6 is 1 only when an autoroute block
    follows. The link points are the via position, then any shaping points. L = 0 for a by-name via point. The bbox is
    omitted (flag 1) exactly when L = 0. Unknown11 and end time are absent, so there is no duration byte. The route
    bounds cover every link point, or the no-bounds flag is set. A > 0 is followed by `junk` opaque bytes (the layout
    after A is unreliable, §7.2). The trailer is the one listed in §12.
13. **By-name via resolution** compares raw name bytes and class only. FORMAT.md is silent on NFC there, so no scenario
    depends on it. An expected route point is `{name, lat, lon}`; `ele` and `symbol` are not asserted.
14. **A TrackSegments file with M = 0** (an S = 0 track) is consumed exactly by both sizes. Per §9.3 step 4 it gets no
    elevation or time, which loses nothing. Whether a reader reports it is unsettled, so the case is tolerated.
15. **Overlap counts with empty segments** are unsettled (§9.3 step 5 talks about first and last positions), so no
    scenario uses them.
16. **Track notes and route comments** are not mapped onto the model's `comment`; expected tracks and routes have no
    `comment` field. Only `Loose bounds` has non-empty notes.
17. **Latin-1 names** avoid 0x80-0x9F except 0x80 (€), which pins windows-1252 over ISO-8859-1 (§11). 0x81, 0x8D,
    0x8F, 0x90 and 0x9D are never written.
18. **Text fallback** is `text_not_utf8` with count `null` whenever any decoded name, comment or list name is not
    UTF-8.
19. **An absurd record length** (0xFFFFFFF0) is the same case as a record past EOF: `record_truncated` (§3.3 rule 2).
20. **Duplicate-name items** are still decoded and exported (to `_Duplicate names/`) with full geometry. Without a GFI,
    duplicates are not special, because everything is flat.
21. **An unreached list** whose I.parent is the root goes under the root with `list_not_in_tree`;
    `list_folder_disagreement` is tolerated there (see that scenario's notes).
22. **A broken *prefix* field** (for example a bad proximity flag) is never written. B12 says waypoints always get name,
    position, comment and symbol, but the symbol comes after the proximity, so that case is unsettled.
23. **Fatal-file scenarios** (bad signature, bad 'D' record, 107-109, 115-138, garbage) assert only the fatal code, not
    what a reader does with the GFI.
24. **H-MAC48 (FORMAT.md §15.11).** `layout: 'mac48'` on a waypoint writes the H-KBM tail plus 8 bytes (`opaque48`);
    on a track, H-KBM through the uuid plus the 24- or 40-byte tail (flags from the points unless `tailFlags`; A = 0.5
    and B = 0 when any point has an elevation); on a route, the Mac 4.8 layout: every via point but the last carries
    the link points [this, next] (class 8 unless set), the last resolves by name through a waypoint record, and the
    trailer has colour 14 and activity profile 6. Mac 4.8 hooks: `badTailFlag`, `nonZeroRun` (indexes 6-18 only, so the
    byte is not where H-OP would read an autoroute count, which would make the route "autoroute" there instead of "not
    decoded"), `autorouteSettings`. `gdb.eLength: 8`, `gfi.folderTail: 'mac48'` and `createdBy: 3` write the Mac 4.8
    'E', F and smart-list I records. Track points may carry `atemp` and `hr`, written in slots 6 and 7 of the 17-slot
    point; `extraByte` with N = 17 may only name a slot of unknown width.
25. **Smart lists** (created-by 3, B40) are left out of the expected tree, and their item references place nothing.
    A route's via points are "parsed" (for `route_via_point_record`) when the route decodes, and up to the autoroute
    point when an H-OP route stops there.

## Coverage labels

Every scenario has `supportedPath`. Scenarios that use H-OP, or that are made only of broken records, are labelled
`false` and never count as supported-path coverage (FORMAT.md §12). `buildScenario` also returns `exercises`
(`{W: [...], T: [...], TS: [...]}`), which says which hypotheses and point sizes the bytes actually contain. The test
checks those labels against the self-check walker.

## Limits

- These fixtures prove that a reader matches **FORMAT.md**, not BaseCamp.
- FORMAT.md §12 lists a few variants that are not built here: a ZIP64 archive that is genuinely large (only forced
  ZIP64 records are built), a node:zlib-built ZIP (choice 2), a 'J' reference (only 'K' is built), and a folder cycle
  that the root cannot reach (unsettled).
- `privacy-sentinels` exposes `scenario.sentinels.{strings, numbers}` for the dump test (ARCHITECTURE.md §11). The
  numbers include the semicircle integers. The writer only plants the sentinels; it cannot test the dump.
