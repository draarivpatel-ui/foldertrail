# Gate 0 research: mac-library (2026-10-05, researcher; UNVERIFIED unless labelled)

## Summary
Garmin's own download pages confirm the version split: BaseCamp for Mac is 4.8.13 (March 31, 2023, Intel Macs only), and Windows is 4.7.5 (March 27, 2023). On a Mac the default library is an ordinary folder at ~/Library/Application Support/Garmin/BaseCamp/Database/<version>/, for example 4.8, and it holds AllData.gdb and a TrackSegments/ subfolder. Several independent forum posts agree on that layout (JaVaWa 2025, Holger 2020, a 2013 poster who said it "retains the PC folder structure"). Libraries that users create themselves are .bclibrary macOS packages. Nobody has documented the byte-level format of a Mac 4.8 AllData.gdb. That it is the same 'MsRc' record format as Windows 4.7.5 (file-format version 1.88) is a strong inference, not a verified fact. It is not SQLite: a benchmark's notes say so, but they are contradicted by the spec and by working parsers. On Windows, at least three independent forum sources say the folder and list structure lives in FolderData.gfi. Its record layout comes from Oppmann's 2024 spec, and kbm1959 confirmed it against one Windows 4.7.5 database (kbm is built on Oppmann, so the two are not independent). F records are folders, I records are lists, and T/W/R records give each item's list ID plus its name. Items are matched to AllData.gdb records by name, not by ID. No source shows FolderData.gfi on a Mac. kbm1959 has no license, targets Windows 4.7.5, skips routes, and needs the TrackSegments folder for track elevation and time. Oppmann does document the route record (pages 21–25). File > Backup on the Mac makes a .Backup file that is a ZIP of the Database/<version> tree. The Mac manual says it includes "all data, lists, and folders", but Mac Restore does not put TrackSegments back. Exporting to GPX or GDB loses the folder and list structure (Garmin forum, 2012, still reported 2021–2026). For the drop step, the folder or a .Backup file is the simplest input, and the key open question is what each browser allows. Chrome/Edge's directory picker (showDirectoryPicker) refuses ~/Library — verified in Chromium source. Whether dragging the folder or a webkitdirectory file input works there is untested and should be tested first.

## Findings
# BaseCamp for Mac: where the library lives, what is in it, how to get it into a browser

Labels: **VERIFIED** = I opened the primary source myself (URL, plus file and line numbers for code). **REPORTED** = someone else says so (where given). **GUESS** = my inference. The research date is 2026-10-05.

---

## 0. Decision-critical answers

**(a) Mac library container format**

- **Folder layout: yes, at least two independent sources agree.**
  - The default Mac library is a plain folder at `~/Library/Application Support/Garmin/BaseCamp/Database/<version>/`, for example `4.8`.
  - It contains `AllData.gdb` and a `TrackSegments/` subfolder. This is the same Database/<version> layout as Windows.
  - Sources:
    - JaVaWa, Garmin forum, 2025-05-08: gives the path `.../Database/4.8/TrackSegments/`.
    - Holger, Garmin forum, 2020: found `.../Database/4.6/AllData.gdb` and `.../4.7/AllData.gdb` on a Mac running BaseCamp 4.8.
    - "JP" quoted in a reply, 2013: "the default library on the Mac retains the PC folder structure. So I can import 4.2 folders from my PC by replacing the default folders with the PC ones."
    - mgasser, 2025: zipping and copying the whole `~/Library/Application Support/Garmin/BaseCamp` folder worked.
  - All of these are REPORTED.
- **Libraries that users create are `.bclibrary` macOS packages.** Several REPORTED sources agree: Garmin forum threads from 2013 and 2014, and bobgps in 2025. What exactly sits inside a `.bclibrary` is **unknown**. A 2014 post says it contains `AllData.gdb` (REPORTED). bobgps says you need "Show Package Contents" to reach "the folder structure" (REPORTED).
- **Byte-level format of a Mac 4.8 `AllData.gdb`: no direct source.**
  - Oppmann's version table stops at Windows "Basecamp 4.4.1-4.7.5" = file-format version 1.88, and has no Mac rows (VERIFIED, PDF p.7).
  - The case for "same MsRc record format" is indirect:
    - Windows backups restored on a Mac (MarcE, 2016: everything except track-point extras survived).
    - A Garmin rep in 2014 said Windows→Mac restore "should work".
    - Mac 4.8, on first start, copies the newest older version folder to `4.8` (Holger, 2020).
  - Counter-signals:
    - "Invalid File Format" when restoring a Windows backup on a Mac (2014).
    - Windows BaseCamp crashing when restoring a Mac backup (2013).
  - **GUESS:** same record format, but the D-record version and the A-record program version may differ (for example program version 4.8). The parser should accept any version ≥ 1.88 and log what it sees.
- **It is not SQLite.** The cmu-l3/gym-anything notes say "AllData.gdb (SQLite)" (REPORTED). That claim is contradicted by:
  - Oppmann's signature `MsRc` (VERIFIED, PDF p.5).
  - kbm1959's working parser (VERIFIED).
  - GPSBabel's reader (VERIFIED).
  - gym-anything's own backup verifier, which reads the file as raw bytes (VERIFIED).

**(b) Where folder/list records live, and how items are linked**

- **Where: `FolderData.gfi`, next to `AllData.gdb`. At least three independent sources agree, but all of them are Windows.**
  - Oppmann p.3: BaseCamp "stores its user interface data in a very similar *.gfi format in the same directory as FolderData.gfi" (VERIFIED).
  - SUSSAMB, 2024-03: FolderData.gfi "is the one that contains the list data" (REPORTED).
  - 2016 thread: someone with `AllData.gdb` but without its matching `.gfi` got "all the list and folder structure" lost, with everything flat in My Collection. Restoring the matching `FolderData.gfi` brought it back (REPORTED).
  - Peobody, 2026-04: "folder info is stored in FolderData.gfi" (REPORTED).
- **On a Mac, no source I found shows `FolderData.gfi` directly.** Thread 69390 mentions `FoldaerData.gfi.bak`, but that poster says in the next post "I'm not a Mac user", so it is not Mac evidence. **GUESS:** it is present on the Mac, because the layout matches Windows and the Mac manual says a backup covers "lists, and folders".
- **How items are linked: two sources, and they are not independent.** kbm1959 cites Oppmann as its basis; it is Oppmann checked against one real Windows 4.7.5 database.
  - **`F` record (folder):** folder ID, name, parent folder ID, number of children, then each child as (type: 0 = Item/list, 1 = Folder; ID). ID 0xFFFFFFFF is "My Collection", and its parent is itself (Oppmann p.32, VERIFIED; kbm `garmin_tools.py` L278-324, VERIFIED).
  - **`I` record:** this is what the BaseCamp UI calls a **list**. It holds item ID, UTF-8 name, a "created by" field (0 = user, 1 = auto-created on import, 8 = "Unlisted Data") and, for format 1.88, a parent folder ID. Extra fields follow when "created by" is not 0 (Oppmann p.32; kbm L326-353, where L41 says "this is a Basecamp List element").
  - **`T`, `W`, `R` records in the gfi:** parent item (list) ID plus the item's **name**. W adds the waypoint class; R adds an origin byte (0 = made from a track, 1 = user-made). Oppmann p.33; kbm L355-424.
  - **The link from gfi to gdb is by name, not by ID.** VERIFIED in kbm:
    - L106-114 stores gdb T/W/R records in dicts keyed by name.
    - L1691-1704 looks up `self.gdb_t_records[track_name]`.
    - L1658-1671 does the same for waypoints.
    - So two items of the same type with the same name collide.
  - The BaseCamp Mac manual says "You can include a single item in multiple lists" (VERIFIED). That shows up as several gfi records with the same name and different parent list IDs.
  - Whether BaseCamp allows two items of the same type with the same name is **unknown** to me.
  - The BaseCamp UI's "list folder" corresponds to F, and "list" corresponds to I (Mac manual p.12: "A list folder can contain only lists and other list folders"; "Items that have not been added to a list appear in Unlisted Data").

---

## 1. Location, files and versions

**Versions (VERIFIED, Garmin download pages)**

- Mac: "BaseCamp for Mac software version 4.8.13 as of March 31, 2023". Needs an "Intel based Mac running OS 10.13 or higher".
  - The page warns "Apple plans to end support for Rosetta in a future version of MacOS".
  - The change history includes "Changes made from version 4.7.0 to 4.8.3: Upgraded app to 64-bit."
  - Source: https://www8.garmin.com/support/download_details.jsp?id=4450
- Windows: "BaseCamp software version 4.7.5 as of March 27, 2023". Source: https://www8.garmin.com/support/download_details.jsp?id=4435
- Neither platform has had a release since March 2023.

**Mac default path (REPORTED, several sources)**

- `/Users/{you}/Library/Application Support/Garmin/BaseCamp/Database/4.8/` (JaVaWa, 2025-05-08, https://forums.garmin.com/apps-software/mac-windows-software/f/basecamp-mac/411212/track-information-gone — I opened the page, so the post and its date are VERIFIED).
- The `~/Library` folder is hidden in Finder.
- **Stale version folders can sit side by side.** Holger: "When 4.8 gets started the first time, it copies the highest versioned folder it finds (in my case 4.7) to 4.8" (https://forums.garmin.com/apps-software/mac-windows-software/f/basecamp-mac/80010/where-is-my-collection-file-stored/1174523, post dated 2020). The tool should prefer the highest-numbered folder, or list the folders with their modified dates.
- Overlays (BirdsEye, Custom Maps) are kept in separate folders under `Garmin/BaseCamp`, not under Database (2011 Mac forum, REPORTED).

**Windows reference layout**

- `C:\Users\<user>\AppData\Roaming\Garmin\BaseCamp\Database\<Version>\AllData.gdb` plus `FolderData.gfi` (Oppmann PDF p.3, VERIFIED).
- Other subfolders: "Adventures, GeocacheLogs, Thumbnails, TrackSegments etc." (Eyelet99, 2025-03, thread 405228, REPORTED).
- BaseCamp writes `AllData.gdb.bak` every time it closes (2016 thread 112416, REPORTED).

**Container format details**

- GDB signature `MsRc`, GFI signature `DifG`. Primary version 0x0066 = 1.2 for "GDB and GFI". Records are a uint32 length, a 1-byte type, then the content. The file starts with a 'D' record (file-format version), an 'A' record (author info), then an application string (Oppmann pp.5-6, VERIFIED).
- kbm reads exactly that structure: `garmin_tools.py` L164-276 (VERIFIED).

**Track geometry vs. track details**

- For format ≥ 1.46, the gdb `T` record holds positions only, organised in segments, followed by a UUID string (Oppmann p.26, VERIFIED; kbm L661-811, UUID at L801-805).
- Elevation and time live in `TrackSegments/<uuid>`, a file with its own D/A header. Per point there is an fdouble elevation and an fint time, then 11 or 17 bytes kbm skips depending on program version. This is kbm L1137-1175, VERIFIED as code; it is kbm's empirical finding and is not in Oppmann.
- **Consequence: a drop that contains only `AllData.gdb` and `FolderData.gfi` gives tracks with no elevation or time. `TrackSegments/` is required.**

**Version lock-in:** BaseCamp 4.6 rejected an `AllData.gdb` from 4.5 with "Unsupported version" (2016, Windows, REPORTED).

---

## 2. kbm1959/Garmin_gdb_reconstruction (code read only, at commit a2ad367, 2026-09-15)

**Repository facts (VERIFIED via GitHub API)**

- Created 2026-08-22, last pushed 2026-09-15, 0 stars, Python.
- **`license: null`**, meaning all rights reserved. Do not copy its code; read it for format knowledge only.
- Commits: 36c5103 "First commit" → fc4bc8e "Implementation of folder and waypoints reconstruction finished" (2026-08-26) → a2ad367 "First production Version" (2026-09-15).

**Which OS, version and files it reads**

- README L11: "...from a Garmin Basecamp V 4.7.5 database".
- `reconstruct_garmin_db.py` L13: "tested and works with Basecamp Version 4.7 databases (primary version 1.2, file format version 1.88)". L28 uses a default directory of `'4.7/'`.
- Required inputs: `AllData.gdb`, `FolderData.gfi` and a `TrackSegments` folder (`garmin_tools.py` L60-83).
- The word "Mac" appears nowhere in the code or README (VERIFIED by grep).
- **GUESS:** it is the Windows 4.7.5 layout, given the `4.7` folder name. The README calls it "a Garmin basecamp backup", so it may be run on an unzipped .Backup.

**How it rebuilds the tree**

- It loads gdb T, W (class 0 or 1 only) and R records keyed by name (L99-116), and gfi F, I, T, W, R records (L131-152).
- `build_folder_tree` (L837-867): an F child of type 1 recurses into a sub-folder; a child of type 0 (an I record, i.e. a list) becomes a directory and records `item.folder_path`. Lists therefore become directories, and each item is written as its own GPX inside its list's directory.
- `restore_waypoints` (L1644-1676) writes `<name>_(wp).gpx`. `restore_tracks` (L1678-1718) writes `<name>.gpx` and drops elevation/time when the segment count does not match (L1711-1713).
- The whole tree is built twice, once under `./waypoints/` and once under `./tracks/` (reconstruct L32, L42).

**Where it disagrees with Oppmann**

- In the T record, kbm reads a display byte, **skips 4 unknown bytes**, then reads color (L674-688). Oppmann p.26 lists display byte → color with no gap. Either the 1.88 format differs or the spec is wrong. kbm itself says Oppmann "is not complete and has some errors" (reconstruct L15-16).
- Waypoint parsing relies on several hard-coded skips (L549-556, L602-603, L630-631), so it is fragile.

**What it cannot do**

- No routes, Adventures or BirdsEye (README L4, L17).
- For routes it reads only the gdb `R` name (`analyze_record_R` L650-659). It parses the gfi `R` placement (L355-379) but never uses it.
- **Routes are documented, though:** Oppmann pp.21-25 gives the full `R` record, including fields for ≥ 1.46 (route points, link points, autoroute points, avoidances, activity profile). So where a route sits in the tree is recoverable now, and its body is documented but complex.

**`basecamp_migration.py`:** the README L22 calls it AI-generated and "not usable". Its `I` record layout (L341-355) contradicts Oppmann. Ignore it.

**Other public code and write-ups**

- **Oppmann spec**, "Garmin MapSource (MPS), GPS Database (GDB) and Folder and Item (GFI) File Format", 2024-02-04, 34 pp. (VERIFIED): https://www.memotech.franken.de/FileFormats/Garmin_MPS_GDB_and_GFI_Format.pdf . This is the only public description of the GFI format I found.
- **GPSBabel `gdb.cc`** (VERIFIED, read only):
  - It only reads MsRc GDB D-records with version byte 'k'..'m': `gdb.cc` L358-372 and `gdb.h` L105-111 (`kGDBVerMin=1`, `kGDBVerMax=3`).
  - My arithmetic from that code: this means file-format 1.7–1.9, so BaseCamp's internal 1.88 file would be rejected as an "Unknown or/and unsupported GDB version".
  - It has no GFI support; the only "gfi" text is the Oppmann URL at L24.
- **cmu-l3/gym-anything `garmin_basecamp_env`:** a Windows 4.7.5 benchmark (VERIFIED read). It treats the database as opaque files. Its `archive_database_backup/verifier.py` L90-100 treats a `.Backup` as a ZIP containing `AllData.gdb`. Its `notes.md` L19/L99/L200 "SQLite" claim is contradicted, as above.
- **GitHub code search** (VERIFIED): `"FolderData.gfi"` finds only kbm1959. `"AllData.gdb"` finds kbm1959 and gym-anything. `DifG` finds nothing relevant. There are no other GFI parsers.
- **Demand signal:** mindalyze-com/mtl-explorer issue #7 (2026-08-28) asks to read the BaseCamp database directly, "keeping existing tags/folder names". The user says BaseCamp runs out of memory exporting many tracks (REPORTED).

---

## 3. Backup and export on the Mac

**What the Mac manual says (VERIFIED)**

- Source: BaseCamp Mac Owner's Manual PDF, created 2020-06-27, https://www8.garmin.com/manuals/webhelp/basecampmac/EN-US/BaseCamp_Help_-_Mac_EN-US.pdf , p.14.
- "You can back up all data, lists, and folders to a single archive file. The archive file can be restored to a different BaseCamp installation." The steps are File > Backup.
- Restore: "all existing data, lists, and folders are removed and overwritten by the backup data."
- Overlay data (Garmin Custom Maps, BirdsEye) "cannot be exported to a file. To export overlay data, you must back up your data."

**The backup file**

- **Extension `.Backup`, and it is a ZIP** (REPORTED):
  - JaVaWa 2025 (Mac): "Rename the backup file BaseCamp_xxxxxx.Backup to BaseCamp_xxxxxx.zip / Extract this zip file / ... BaseCamp_xxxxxx/Database/4.8/TrackSegments/".
  - Eyelet99 2025 (Windows): ".Backup files are simply zipped files of all the database folders". Zipping `Database/4.7` yourself and renaming it `.Backup` restores fine.
  - 2014 Mac forum: "BC backups are in the ZIP format".
  - fileinfo.com, 2022.
- **Contents:** a `Database/<version>/...` tree, at least `TrackSegments` (REPORTED). Inclusion of `FolderData.gfi` is a GUESS, based on the manual's "lists, and folders".
- **Mac Restore bug:** TrackSegments are in the backup but are not restored. bobgps says Garmin support replied "It will not be fixed in Mac Basecamp so use Windows Basecamp" (2025, REPORTED; MarcE saw the same in 2016).
  - Implication for BCR: reading the `.Backup` directly is *better* than restoring it.
- **Size:** backups can be multi-GB, e.g. 2.3 GB (2011 Mac forum) and 0.4–1.4 GB (2015 Windows) (REPORTED). A browser reader should seek the ZIP central directory with `File.slice`, and should expect ZIP64 for files over 4 GB (GUESS).

**Export**

- The Mac manual lists File > Export 'My Collection', Export Selected User Data and Export [Device]. The user then chooses a file format (VERIFIED).
- **Folder/list structure is not kept in GPX or GDB exports:**
  - Garmin Windows forum, 2012-12-13, poster "Former Member" (staff status implied by "We are definitely investigating different export formats", not confirmed): "there is no good way to export your folder and list structure. This information gets stripped out when saving as gpx and gdb." VERIFIED quote: https://forums.garmin.com/apps-software/mac-windows-software/f/basecamp-windows/60079/folder-list-export
  - Still reported later: GEORG2012 (about 2021-22): "You can export to the gdb-format, but you cannot import without loosing all structure (folders, lists)". 2014: "GPX files do NOT support folders or lists". kweagle, 2026-04: exporting GPX means "I lose all my lists". All REPORTED.
  - No release since 2023, so this cannot have changed. That is an inference from the VERIFIED release dates.

---

## 4. Simplest way for a non-technical user to hand the files to a web page

**Option A — while BaseCamp still runs (before macOS 28): File > Backup, then drop the `.Backup` file.**

- One file. It includes TrackSegments and (per the manual) lists and folders, and it works the same for users with a custom `.bclibrary`.
- Downsides: it can be several GB, and the page needs a ZIP reader.

**Option B — no BaseCamp needed (needed after it stops running): drag the folder.**

- In Finder, hold Option and choose Go > Library (VERIFIED, Apple support page). Or use Go > Go to Folder and type `~/Library/Application Support/Garmin/BaseCamp/Database` (VERIFIED, Finder only).
- Drag the **highest-numbered** folder (e.g. `4.8`) onto the page. It must include `TrackSegments/`.
- Custom-library users: BaseCamp > Preferences > Advanced > Library shows where the library is (Mac manual p.15, VERIFIED). They would drag the `.bclibrary`. How browsers handle a dragged package is unknown.

**Option C — zip it yourself.** Zip `~/Library/Application Support/Garmin/BaseCamp` (it worked for mgasser, 2025, REPORTED) and drop the zip. This route is the same as A.

**Browser constraints**

- **VERIFIED in Chromium source** (`chrome/browser/file_system_access/chrome_file_system_access_permission_context.cc`, main at commit 664464f, 2026-10-05):
  - On macOS the File System Access blocklist includes `DIR_APP_DATA` (`~/Library/Application Support`) at L477-478 and `~/Library` at L489-490, both `kBlockAllChildren`.
  - So `showDirectoryPicker()` in Chrome/Edge will refuse the BaseCamp folder.
- **GUESS, must test first:** whether `<input type=file webkitdirectory>` and drag-and-drop via `DataTransferItem.webkitGetAsEntry()` get around this. Those are separate code paths. The same is unknown for:
  - Safari and Firefox behaviour.
  - Whether Cmd+Shift+G and Cmd+Shift+. work inside a browser's Open panel (unverified here).
  - How a dropped `.bclibrary` is presented (as a folder or as a file).
- Recommended primary design (GUESS until tested): drag-and-drop from Finder of either the version folder or a `.Backup`/`.zip`, with a file-picker fallback for `.Backup`/`.zip` files.


## Open questions
- Byte-level format of a Mac BaseCamp 4.8.x AllData.gdb: is it the same MsRc format, which D-record (file-format) version does it carry, and which A-record program version? No public source documents it; the only way to know is a synthetic or volunteered sample that has the user's consent.
- Is FolderData.gfi present in the Mac Database/4.8 folder, and is its layout identical to Windows (the F/I/T/W/R records in Oppmann p.32-33)? No Mac-specific source confirms it.
- What exactly is inside a user-created .bclibrary package (a Database/<version>/... tree, or files at its root)?
- Browser test needed first: in Chrome, Safari and Firefox on macOS, does dragging ~/Library/Application Support/Garmin/BaseCamp/Database/4.8 from Finder (webkitGetAsEntry) or picking it with <input webkitdirectory> work, given that Chromium's File System Access blocklist refuses ~/Library for showDirectoryPicker? How is a dragged .bclibrary package presented?
- Does a Mac .Backup ZIP contain FolderData.gfi and the full Database/4.8 tree, and does it use ZIP64 when it is over 4 GB?
- Does BaseCamp allow two items of the same type with the same name? kbm1959 and the GFI format link gfi entries to gdb records by name, so duplicates would collide.
- kbm1959 found 4 extra bytes in the 1.88 track record compared with Oppmann (garmin_tools.py L674-688). That needs confirming, along with the TrackSegments per-point record size (11 vs 17 bytes by program version, L1155-1172), which only kbm has derived.
- Does a BaseCamp GDB export ('Export My Collection' as .gdb) contain any folder/list information at all? Reports say the structure is lost on re-import, but nobody has published the record contents of such a file.

## Sources
- [V] https://github.com/kbm1959/Garmin_gdb_reconstruction — Read the full code at commit a2ad367 via the GitHub API: README.md, reconstruct_garmin_db.py, garmin_tools.py (F/I/T/W/R parsing, by-name linking, TrackSegments), basecamp_migration.py. Repository metadata: created 2026-08-22, 0 stars, license null.
- [V] https://www.memotech.franken.de/FileFormats/Garmin_MPS_GDB_and_GFI_Format.pdf — Herbert Oppmann spec, 2024-02-04: Windows path (p.3), MsRc/DifG signatures (p.5), version table up to BaseCamp 4.7.5 = 1.88 (p.7), Route record (pp.21-25), Track record (pp.25-26), GFI F/I/R/T/W/K/J records (pp.32-33).
- [V] https://www8.garmin.com/support/download_details.jsp?id=4450 — Garmin download page: BaseCamp for Mac 4.8.13 as of March 31, 2023; Intel Mac with OS 10.13+; Rosetta warning; change history (4.7.0 to 4.8.3: 64-bit).
- [V] https://www8.garmin.com/support/download_details.jsp?id=4435 — Garmin download page: BaseCamp (Windows) 4.7.5 as of March 27, 2023.
- [V] https://www8.garmin.com/manuals/webhelp/basecampmac/EN-US/BaseCamp_Help_-_Mac_EN-US.pdf — BaseCamp Mac Owner's Manual (PDF created 2020-06-27): lists and list folders (p.12), Export / Backup 'all data, lists, and folders to a single archive file' / Restore overwrites (p.14), Preferences > Advanced > Library (p.15).
- [V] https://forums.garmin.com/apps-software/mac-windows-software/f/basecamp-mac/411212/track-information-gone — JaVaWa 2025-05-08: Mac path .../Database/4.8/TrackSegments/; .Backup is a ZIP containing BaseCamp_xxxxxx/Database/4.8/TrackSegments/; Mac restore skips TrackSegments. bobgps: Garmin support won't fix it; custom .bclibrary needs Show Package Contents. (Page and posts opened by me; the format facts are REPORTED.)
- [V] https://forums.garmin.com/apps-software/mac-windows-software/f/basecamp-mac/80010/where-is-my-collection-file-stored/1174523 — Holger (2020): Mac BaseCamp 4.8 on Catalina; AllData.gdb under Database/4.6 and 4.7; 4.8 copies the highest-numbered version folder to 4.8 on first start.
- [V] https://forums.garmin.com/apps-software/mac-windows-software/f/basecamp-mac/64020/cannot-switch-database-with-mac-bc-4-2-1 — 2013 posts: .bclibrary libraries are 'bundles'; 'the default library on the Mac retains the PC folder structure'; Windows BaseCamp crashing when restoring a Mac backup.
- [V] https://forums.garmin.com/apps-software/mac-windows-software/f/basecamp-mac/75647/reducing-a-database-s-size — 2014: Mac .bclibrary container holds AllData.gdb; 'BC backups are in the ZIP format'.
- [V] https://forums.garmin.com/apps-software/mac-windows-software/f/basecamp-mac/69390/alldata-gdb — 2014: Mac data under ~/Library/Application Support/Garmin; .bclibrary files can live anywhere. The FolderData.gfi.bak poster says 'I'm not a Mac user', so it is not Mac evidence.
- [V] https://forums.garmin.com/apps-software/mac-windows-software/f/basecamp-windows/405228/basecamp-onto-new-desktop-pc-how-do-i-point-it-to-existing-data-on-the-nas — Eyelet99 2025-03: .Backup files are zipped database folders; the minimum needed is AllData.gdb plus FolderData.gfi, plus folders such as Adventures, GeocacheLogs, Thumbnails, TrackSegments.
- [V] https://forums.garmin.com/apps-software/mac-windows-software/f/basecamp-windows/364150/basecamp-initialization---cannot-load-the-following-areas-list-data-file — SUSSAMB 2024-03: FolderData.gfi contains the list data; Windows path Database\4.7.
- [V] https://forums.garmin.com/apps-software/mac-windows-software/f/basecamp-windows/112416/importing-from-previous-alldata-gdb — 2016: without the matching FolderData.gfi all list/folder structure was lost; 'Unsupported version' when importing an older AllData.gdb; AllData.gdb.bak written on close.
- [V] https://forums.garmin.com/apps-software/mac-windows-software/f/basecamp-windows/435180/basecamp-database-crashes-upon-exit-and-won-t-restore-backups — 2026-04/05: Peobody says data lives in AllData.gdb and folder info in FolderData.gfi; exporting GPX loses lists.
- [V] https://forums.garmin.com/apps-software/mac-windows-software/f/basecamp-windows/60079/folder-list-export — 2012-12-13 'Former Member' (staff status implied, not confirmed): folder/list structure 'gets stripped out when saving as gpx and gdb'.
- [V] https://forums.garmin.com/apps-software/mac-windows-software/f/basecamp-mac/71738/multiple-database-in-basecamp — Mac forum: GPX has no folders/lists; GEORG2012 (about 2021-22): a GDB export cannot be re-imported without losing folders/lists; New Library via Preferences > Advanced.
- [R] https://forums.garmin.com/apps-software/mac-windows-software/f/basecamp-mac/123502/losing-data-when-importing-windows-backup-to-basecamp-on-mac/687512 — MarcE (2016): Windows backup restored on a Mac kept the data but lost track time/elevation/temperature/HR (read via WebFetch summary).
- [R] https://forums.garmin.com/apps-software/mac-windows-software/f/basecamp-mac/95264/moving-from-windows-to-mac — 2014: 'Invalid File Format' restoring a Windows backup on a Mac; a Garmin rep said it should work (read via WebFetch summary).
- [R] https://forums.garmin.com/de/apps-und-software/mac-windows-software/f/garmin-basecamp-mac/223225/garmin-basecamp-4-7-1---datenbank-auf-windows-pc-und-mac-gemeinsam-nutzen — German thread: Windows 4.7.1 vs Mac 4.8.8; the poster believes the database formats differ (.bclibrary vs a folder with AllData.gdb); no binary evidence (read via WebFetch translation).
- [R] https://forums.garmin.com/apps-software/mac-windows-software/f/basecamp-mac/60486/where-are-data-files-stored — 2012-13 Mac: data under ~/Library/Application Support/Garmin; a 'DataBase/4.0' folder with track segment files (read via WebFetch summary).
- [V] https://github.com/GPSBabel/gpsbabel/blob/master/gdb.cc — GPSBabel GDB reader: MsRc signature check, D-record version range 1..3 (gdb.cc L358-372; gdb.h L105-111); no GFI support.
- [V] https://github.com/chromium/chromium/blob/main/chrome/browser/file_system_access/chrome_file_system_access_permission_context.cc — Chromium File System Access blocklist on macOS: DIR_APP_DATA (L477-478) and ~/Library (L489-490), kBlockAllChildren; main at commit 664464f (2026-10-05).
- [V] https://support.apple.com/guide/mac-help/go-directly-to-a-specific-folder-on-mac-mchlp1236/mac — Apple: Finder Go > Go to Folder with ~ paths; hold Option and choose Go > Library.
- [V] https://github.com/cmu-l3/gym-anything/tree/main/benchmarks/cua_world/environments/garmin_basecamp_env — Windows BaseCamp 4.7.5 benchmark env: notes.md claims AllData.gdb is SQLite (contradicted); archive_database_backup/verifier.py treats .Backup as a ZIP containing AllData.gdb.
- [V] https://github.com/mindalyze-com/mtl-explorer/issues/7 — 2026-08-28 user wish: import BaseCamp tracks directly keeping folder names; BaseCamp runs out of memory exporting many tracks.
- [R] https://fileinfo.com/extension/backup — Says a BaseCamp .BACKUP is a Zip archive (page dated 2022-03-01).
