# Gate 0 research: gpsbabel-format (2026-10-05, researcher; UNVERIFIED unless labelled)

## Summary
GPSBabel does not read or even recognise folder or list structure. Its GDB reader handles only three record types: 'W' (waypoint), 'R' (route) and 'T' (track). A 'V' record ends the read. Every other record type is skipped silently using its length prefix, with no warning (gdb.cc L973-975 and L1013-1016 at pinned commit 7003cff). VERIFIED.

According to Herbert Oppmann's spec (2024-02-04), the BaseCamp folder/list tree is not stored in the .gdb file at all. It lives in a separate file, FolderData.gfi, which starts with the signature "DifG" and holds 'F' (folder) and 'I' (item) records. GPSBabel cannot open that file: it rejects any file that does not start with "MsRcf\0". The spec part is REPORTED; the GPSBabel check is VERIFIED.

The GFI file links its tree to the GDB objects only by parent item ID plus the object's name (and class, for waypoints). It carries no UUID. Duplicate names are therefore a real risk for BCR, and it is still open whether BaseCamp keeps names unique.

GPSBabel only accepts GDB file-format versions 1.7, 1.8 and 1.9 (its "ver 1/2/3"). It works the version out as `drec.at(1) - 'k' + 1` and range-checks it (L369-372, VERIFIED). BaseCamp 4.4.1-4.7.5 saves its own library (AllData.gdb) as version 1.88. That is REPORTED by Oppmann (p.7) and by a user in GPSBabel issue #893, where a maintainer confirmed that versions 1.15-1.88 are unsupported. So GPSBabel will stop with a fatal error on a native BaseCamp library. This is an inference from the verified code; I did not run it.

A file exported from BaseCamp through Export → GDB is REPORTED readable by GPSBabel (Robert Lipe, 2022-12-08, issue #893). Which version number such an export writes is a GUESS.

For versions 1.7-1.9 I have a byte-level spec for both reading and writing. All numbers are little-endian. Latitude and longitude are signed 32-bit integers in semicircles (value × 180 / 2^31 degrees). Timestamps are 32-bit Unix seconds behind a 1-byte "present" flag. Text is zero-terminated: Latin-1 up to version 1.8, UTF-8 at 1.9, though GPSBabel itself is inconsistent here. These points are VERIFIED in both sources, with line numbers in the findings.

For 1.46 and later (what BaseCamp actually saves), Oppmann's document is the only public spec I found, and it has gaps. As written, a track point in 1.46+ holds only a position: no elevation and no time. I could not establish whether that is incomplete documentation or a real change of layout. It needs synthetic test vectors.

GPSBabel's reference/ folder has five .gdb files: gdb-sample.gdb, gdb-sample2.gdb, gdb-sample-v3.gdb, gdb-sample-v3-ilinks.gdb and gdb-sample-v3-autoroute.gdb. They are covered only by the repository's GPL-2.0 licence, which is a licensing caveat if BCR copies them. None of them is a 1.46+ file, so they can only test the 1.7-1.9 path.

## Findings
## How this was gathered

- **GPSBabel source** came from GitHub at commit `7003cff254beb3a8f442327fdc406984de102091` (master as of 2026-10-03; I checked that master and this SHA give identical gdb.cc and gdb.h). I fetched it as text with `gh api` and ran nothing.
  - Line citations below are for that SHA, e.g. https://github.com/GPSBabel/gpsbabel/blob/7003cff254beb3a8f442327fdc406984de102091/gdb.cc#L369
  - The repository licence is GPL-2.0, read from the GitHub API.
- **Oppmann's PDF** is "Garmin MapSource (MPS), GPS Database (GDB) and Folder and Item (GFI) File Format", Herbert Oppmann, dated 2024-02-04, 34 pages, from https://www.memotech.franken.de/FileFormats/Garmin_MPS_GDB_and_GFI_Format.pdf. GPSBabel's gdb.cc L23-24 links to it.
  - WebFetch would not reproduce the text, but the tool saved the PDF automatically in its own results folder. **Note:** I read that one file (my own fetch result, not a session log) once, copied it to the scratchpad, and extracted the text with PyMuPDF (`fitz`, already installed). Key tables were re-extracted by word position to avoid layout errors.
  - Page numbers below are the PDF's own page numbers.
  - The index page https://www.memotech.franken.de/FileFormats/ says "Last change: 2024-02-04" and gives **no licence or usage terms** for the PDFs. That page was read through the WebFetch summary.
- Labels used throughout:
  - **VERIFIED**: I read the primary source myself.
  - **REPORTED**: Oppmann or a GitHub commenter says so.
  - **INFERENCE**: deduced from verified code plus reported facts, not tested.
  - **GUESS**: my own unconfirmed reasoning.

---

## 1. KEY QUESTION: does GPSBabel handle folder, list or collection structure?

**No.** VERIFIED.

The main read loop (gdb.cc L957-1064) works like this:
- it reads a `uint32` length and a 1-byte type;
- it stops on `'V'`;
- otherwise it copies exactly `len` bytes into a scratch buffer and dispatches on the type byte.

```c
    int len = FREAD_i32;                         // L969
    if (FREAD(&typ, 1) < 1) {                    // L970
    ...
    if (typ == 'V') {                            // L973
      break;  /* break the loop */               // L974
    }
    ...
    gbfcopyfrom(ftmp, fin, len);                 // L979  (record body consumed by length)
    ...
    switch (typ) {                               // L988
    case 'W': ...                                // L989
    case 'R': ...                                // L1001
    case 'T': ...                                // L1007
    default:                                     // L1013
      dump = 0;	/* make a dump only for main types */   // L1014
      break;                                     // L1015
    }
```

What this means:
- Every type other than W, R and T is skipped silently, because `dump=0` suppresses the leftover-bytes warning at L1027. That covers 'L' map sections, 'G'/'O'/'j'/'J' images and BirdsEye, 'C' geocache, 'E', 'X' and anything unknown.
- Nothing after 'V' is read at all.
- There is no code anywhere in gdb.cc or gdb.h for folders, lists, collections, 'F' records, 'I' records or GFI files. VERIFIED by reading both files in full.

**Where the structure actually lives.** REPORTED by Oppmann:
- "BaseCamp automatically saves the last state to C:\Users\<username>\AppData\Roaming\Garmin\BaseCamp\Database\<Version> as AllData.gdb. In addition, it stores its user interface data in a very similar *.gfi format in the same directory as FolderData.gfi" (p.3).
- The GFI signature is `"DifG"` (p.5).
- GFI records are `'F'* 'I'* 'R'* 'T'* 'W'* 'K'* 'J'*` (p.32).
- GPSBabel would reject a GFI file at the signature check `strcmp(buf, "MsRcf") != 0` → `gbFatal` (L350-360). INFERENCE.
- Oppmann gives only Windows paths. Mac file names and locations are **unknown** from these sources.

### GFI layout (REPORTED, Oppmann p.32-33)

The common container is described in §2: the signature is "DifG" instead of "MsRc", and the primary format value is 0x0066.

**'F' Folder information record**

| Version | Type | Field |
|---|---|---|
| ≥1.15 | uint | Folder ID. IDs start at 0. `0xFFFFFFFF` is the predefined "My Collection" folder. |
| ≥1.15 | string | Folder name |
| ≥1.15 | uint | Parent folder ID. "My Collection" points to itself. |
| ≥1.15 | uint | Number of child elements, N |
| ≥1.15 | N × {uint type, uint id} | Child references. Type 0 = Item, 1 = Folder. |
| ≥1.15 | byte | Unknown1 = 1 |
| 1.15-1.38 and 1.69 | uint | Unknown2 = 0 |

**'I' Item record.** Oppmann's type table calls it "Inventory item".

| Version | Type | Field |
|---|---|---|
| ≥1.15 | uint | Item ID |
| ≥1.15 | string | Item name (UTF-8) |
| ≥1.15 | uint | Created by: 0 = User, 1 = auto-created on import, 8 = the "Unlisted Data" item |
| 1.29/1.31/1.32/1.38 only | byte, uint | Unknown1 = 1, then Unknown2 (seems to be the Item ID repeated) |
| 1.8/1.9/1.46/1.54/1.69/1.88 only | uint | Parent Folder ID |
| same versions, only if Created by ≠ 0 | byte, uint, uint | 1, 1, 9 |

Two further notes on items:
- "In 1.15, 1.29, 1.31, 1.32 and 1.38, folders could not be nested."
- That a BaseCamp "List" corresponds to an 'I' item is a GUESS based on naming and the "Unlisted Data" item.

**Object records inside GFI.** These are references, not geometry:

| Record | Fields |
|---|---|
| 'R' | uint Parent Item ID, string route name, byte (0 = route made from a track by the program, 1 = made by the user) |
| 'T' | uint Parent Item ID, string track name; for 1.8, 1.9, 1.69 and 1.88 also uint Unknown1 (0 or 1) |
| 'W' | uint Parent Item ID, string waypoint name, uint waypoint class (0 or 1 seen); for 1.8, 1.15, 1.29, 1.31 and 1.38 also string country code and Subclass |
| 'K' | uint Parent Item ID, string BirdsEye name (≥1.29) |
| 'J' | uint Parent Item ID, string BirdsEye name (≥1.31) |

**Implication for BCR (INFERENCE from Oppmann's tables):**
- The GFI tree points at GDB objects by **(record type, name[, waypoint class])** only. GDB ≥1.46 tracks carry a UUID string (p.26), but no GFI field references it.
- If two tracks in a library share a name, the documented layout cannot say which one belongs in which list. Whether BaseCamp enforces unique names is **unknown**.
- No end-of-file record is listed for GFI (p.32). A reader should just read records until EOF. GUESS.

---

## 2. Container: header, framing, primitive types

### Primitive types

| Name | Encoding | Source |
|---|---|---|
| Endianness | All values little-endian | Oppmann p.3 "All values are serialized in little-endian byte order" (REPORTED). GPSBabel opens files with `gbfopen_le` (gdb.cc L922-923, L1612-1613), which is plain `gbfopen` with `big_endian=0` (gbfile.h L93-96, field L70). `gbfgetint32` uses `le_read32` when not big-endian (gbfile.cc L909-923). VERIFIED. |
| u8 / flag | 1 byte. A flag is 0 or 1. | Oppmann p.3 |
| i16 / u16 | 2 bytes LE (gbfile.cc L929-943, L1193-1204) | VERIFIED |
| i32 / u32 | 4 bytes LE. `gbfgetuint32` just reinterprets `gbfgetint32` (gbfile.h L122-125). | VERIFIED |
| f64 | IEEE-754 double, 8 bytes LE (gbfile.cc L949-959 → `endian_read_double`, util.cc L403-427; write at gbfile.cc L1227-1234) | VERIFIED. Oppmann p.3 cites IEEE 754. |
| version | u16 = major×100 + minor, so "1.88" is 188 and "1.9" is 109. **Compare as integers: 1.9 (109) < 1.15 (115) < 1.88 (188).** | Oppmann p.3 (REPORTED). Consistent with GPSBabel writing `gdb_ver + 0x6a`, i.e. 107/108/109 (L1097), and program version `605` meaning "6.5" (L1101). VERIFIED. |
| cstr | Bytes up to and including 0x00. An empty string is a single 0x00. | Reader `gbfgetnativecstr` (gbfile.cc L981-1001, fatal on EOF before the NUL). Writer `gbfputcstr` writes len+1 bytes, or a single 0 (L1253-1263), and `gdb_write_cstr` writes 0 for empty (gdb.cc L284-295). VERIFIED. |
| coord | i32 semicircles. Degrees = v × 180 / 2^31. | GPSBabel `GPS_Math_Semi_To_Deg` / `GPS_Math_Deg_To_Semi` (jeeps/gpsmath.cc L260-279; the writer rounds with `round()`). Macros `FREAD_LATLON` and `FWRITE_LATLON` at gdb.cc L134 and L303. VERIFIED. Oppmann p.3 gives "×360.0° / 2^32", the same thing (REPORTED). |
| position | coord latitude, then coord longitude | Oppmann p.4. Order confirmed at gdb.cc L434-435 and L1168-1169. |
| fdouble | u8 flag; if flag==1, an f64 follows | Reader examples L437-447. Writer `gdb_write_dbl(value, default)` writes 0 if value==default, else 1 plus the double (L316-325). VERIFIED. Oppmann p.4: for file format ≤1.6 the value is present even when the flag is 0; for >1.6 it is absent (REPORTED). This only matters for MPS and the 1.6 beta GDB. |
| fint | u8 flag; if flag==1, an i32 follows | L602-604 and L890-892. Writer `gdb_write_time` writes the value only if `time > 0` (L327-336). VERIFIED. |
| fstring | u8 flag; if flag==1, a cstr follows | Oppmann p.4 (REPORTED). GPSBabel never models this type explicitly; see the discrepancies in §6. |

**Sentinels in GPSBabel (VERIFIED):**
- `unknown_alt = -99999999.0` (defs.h L1033) is the "absent" default for altitude, depth and proximity. Temperature uses 0 for waypoints (L1244) and -99999 for track points (L1431-1432).
- The reader drops altitudes ≥ 1.0e24 (L439, L886).

**Timestamps:**
- They are Unix seconds since 1970-01-01 UTC, signed 32-bit. The reader calls `SetCreationTime(FREAD_i32)`, which is `setMSecsSinceEpoch(t*1000)` (waypt.cc L535-539). VERIFIED.
- Oppmann says "Unix time, seconds since 1970-01-01" (p.13, p.25). REPORTED.
- The writer emits nothing (flag 0) for times that are invalid, negative, or ≥ 2^32 (`toTime_t` returns UINT32_MAX, which is -1 as an int and so fails `> 0`; src/core/datetime.h L88-98, gdb.cc L330). VERIFIED.
- Being signed i32, the field overflows in 2038. GUESS from the type.

### Record framing (VERIFIED, and agrees with Oppmann p.5)

`u32 len` + `u8 type` + `len` bytes of body. The length **excludes** both the length field and the type byte.
- Reader: L969-979.
- Writer `finalize_item`: writes `len = gbftell(tmp)`, then the type, then the body (L1455-1469).
- Every record can therefore be skipped by length. A reader can parse the fields it knows and jump to the end of the record. GPSBabel does exactly this and prints a hex "delta" warning for leftover bytes in W/R/T records (L1018-1049).

### File header (VERIFIED in code; REPORTED meanings from Oppmann p.5-12)

| Offset | Bytes | Meaning |
|---|---|---|
| 0 | `4D 73 52 63` "MsRc" | Signature. GFI uses "DifG". |
| 4 | u16 primary file format | 0x0064 = MPS, 0x0065 = 1.1 (MapSource 6.0.2 beta GDB), **0x0066 = 1.2 (GDB and GFI)** (Oppmann p.5). The GPSBabel writer emits `FWRITE("MsRc",4); FWRITE_i16(0x66);` (L1092-1093). The reader reads 6 bytes and `strcmp`s against "MsRcf", so it effectively requires `MsRc 66 00` (L350-360). |
| 6 | 'D' record: `02 00 00 00` `44` `u16 version` | File-format version. GPSBabel writes len 2, 'D', u16 `gdb_ver+0x6a` (L1095-1097). See the version table below. |
| … | 'A' record: u32 len, `41`, u16 program version, cstr builder, cstr build date, cstr build time | GPSBabel writes 605, "GPSBabel-<version>", "Apr 14 2011", "01:30:01" (L1101-1112, fixed date at L1107). Oppmann lists GPSBabel 1.5.2 with exactly these strings (p.11), an independent cross-check. BaseCamp examples: builder "SQA"/"sqa"/"dagsqa"; BaseCamp 4.7.5 is "2/27/2023" "15:19:13-07:00" (p.11). The GPSBabel **reader** caps this record at 127 bytes (`reclen + 1 > sizeof(buf[128])` → fatal, L378-382) and prints the builder only in verbose mode (L383-391). |
| … | **bare cstr, not a record**: application field | "MapSource", "HomePort" or "BaseCamp". It is present only if the primary format is > 1.0 (Oppmann p.5, p.12). GPSBabel writes "MapSource" (L1114). The reader accepts only `"MapSource"` or `"BaseCamp"` and otherwise fatals with "Not a recognized signature in header" (L393-396). So a **HomePort** GDB would be rejected (INFERENCE). |
| … | records … | Order per Oppmann p.12: `'W'* 'R'* 'T'* 'G'* 'O'* 'L'* 'j'* 'J'* 'C'* 'V' 'E'? 'X'?`. 'G', 'O' and 'X' arrived in 1.29 (BaseCamp 3.0.1); 'j' and 'J' in 1.31 (BaseCamp 3.0.3) (p.12). |
| end | 'V' record | Oppmann p.31: cstr map-set name (may be empty) + u8 auto-name flag. GPSBabel writes `02 00 00 00 56 00 01`: len 2, 'V', empty name, auto-named (L1677-1679), and does not write 'L' or 'X'. The GPSBabel reader stops at 'V' (L973-975). |
| optional | 'E' (u32 0), 'X' (cstr "EndOfFile", ≥1.29) | Oppmann p.31. GPSBabel never reads them. |

**How GPSBabel parses the version (VERIFIED, L362-372):**
- It reads the 'D' record body as a C string that starts at the type byte ('D', then the version's low byte, then the high byte 0x00 as terminator).
- It then computes `gdb_ver = drec.at(1) - 'k' + 1` and requires 1..3 (`kGDBVerMin`/`kGDBVerMax`, gdb.h L105-111).
- So only 0x6B (1.7), 0x6C (1.8) and 0x6D (1.9) pass. UTF-8 is used for ver ≥3 (gdb.h L109).

**Product → 'D' version (REPORTED, Oppmann p.6-7):**
- MapSource 6.0-6.3: 1.7 ("Ver 1")
- MapSource 6.5-6.11.6 and GPSBabel: 1.8 ("Ver 2")
- MapSource 6.12.2-6.16.3: 1.9 ("Ver 3")
- BaseCamp 2.x: 1.15
- BaseCamp 3.0.x: 1.29-1.32
- BaseCamp 3.1.x: 1.38
- BaseCamp 3.2.x: 1.46-1.48
- BaseCamp 3.3.x: 1.54
- BaseCamp 4.0.x: 1.58-1.60
- BaseCamp 4.1.0: 1.64
- BaseCamp 4.2.x: 1.72-1.80
- BaseCamp 4.3.0.1-4.3.1: 1.86
- BaseCamp 4.3.2-4.3.5: 1.87
- **BaseCamp 4.4.1-4.7.5: 1.88**
- HomePort: 1.19 / 1.54 / 1.69

**INFERENCE:** for a 1.88 file, `drec.at(1)` is the byte 0xBC. That gives `gdb_ver` = -174 if `char` is signed, or 82 if unsigned. Either way it falls outside 1..3, so GPSBabel calls `gbFatal("Unknown or/and unsupported GDB version ...")`. A user hit exactly this with "basecamp 4.7.4 ... fileversion 1.88" in GPSBabel issue #893 (REPORTED).

### Writer defaults (VERIFIED, gdb.h L181-211, gdb.cc L1610-1627)

- Output version option `ver` defaults to 2, so the default output is 1.8.
- `cat` 1..16 becomes the bitmask `1<<(cat-1)`; `bitscategory` takes a raw u16 mask.
- Default icon is 18 (WptDot) (gdb.h L113).
- Write order: all W records (user waypoints first, then the "hidden" route-point waypoints of class 8 = map point), then R records, then T records, then V (L1651-1680).

---

## 3. Waypoint 'W' layout, versions 1.7/1.8/1.9

The 1.7-1.9 layouts are backed by GPSBabel code and tests. Oppmann's rows are from p.12-13.

| # | Field | Type | Version | GPSBabel read / write | Notes |
|---|---|---|---|---|---|
| 1 | Name | cstr | all | L416 / L1148 | The writer makes it unique (MakeShort, L1071-1085, L1554) |
| 2 | Waypoint class | u32 | all | L417 / L1149 | 0 user, 1 airport, 2 intersection, 3 NDB, 4 VOR, 5 runway threshold, 6 airport intersection, 7 airport NDB, 8 map point, 9 map area, 10 map intersection, 11 map address, 12 map line (garmin_tables.h L36-50). GPSBabel treats class ≠0 as "hidden" (L419-421, L991-999). |
| 3 | Country code | cstr | all | L423 / L1150 | |
| 4 | Subclass | 22 bytes = i32 map segment ID, i32 map object ID, i64 subclass1, i16 subclass2, i32 subclass3 | all (>1.2) | read and skipped L432 (or kept under `GMSD_EXPERIMENTAL` L426) / written L1162-1165 as `00×4, FF×12, 00×2, FF×4` | Oppmann p.4-5: a user waypoint has segment 0, object -1, subclass1 -1, subclass2 0, subclass3 -1, which matches GPSBabel's bytes |
| 5 | Latitude, longitude | coord, coord | all | L434-435 / L1168-1169 | |
| 6 | Altitude (m) | fdouble | all | L437-447 / L1170 | |
| 7 | Comment | cstr | all | L455 → `notes` / L1171-1175 (notes, else description) | |
| 8 | Proximity (m) | fdouble | all | L462-469 / L1176 | |
| 9 | Display mode | u32 | all | L470-487 / L1177 | GDB values: 0 symbol, 1 symbol+name, 2 symbol+comment (garmin_tables.h L66-70). Oppmann adds 3 image, 4 image+name (p.14). |
| 10 | Color | u32 | all | read and ignored L489 / written as 0 L1178 | Index 0-17 (Oppmann p.14-15; GPSBabel table garmin_tables.cc L348-367, stored as BGR) |
| 11 | Icon / symbol | u32 | all | L490 / L1179 | Oppmann p.15-20 lists 0..248. GPSBabel maps through `gt_find_desc_from_icon_number(icon, GDB)` (L616) and has a GDB special case for 500-563 (garmin_tables.cc L430), which I did not examine further. |
| 12 | City, state, facility | cstr ×3 | all | L492-494 / L1180-1182 | |
| 13 | "Map line 8" | u8 | all | skipped L496 / written 0 L1183 | Oppmann p.12 |
| 14 | Depth (m) | fdouble | all | L498-505 / L1184 | |
| 15a | **1.7/1.8:** street cstr, fstring unknown1, u32 predicted leg time (s), cstr directions, cstr link | see type | 1.7-1.8 | GPSBabel reads heuristically: 2 bytes, then a "waypt_flag" byte, then 3 or 2 bytes, then an unused cstr, then the link cstr (L509-535); it reads one extra byte later if waypt_flag≠0 (L597-601). Writer: 7 zero bytes, then a cstr (link, or description for class ≥8) (L1187-1201). | Oppmann p.13. The writer's 7 zero bytes equal empty street (1) + fstring flag 0 (1) + u32 0 (4) + empty directions (1). |
| 15b | **1.9:** street/address cstr | cstr | 1.9 | L540 / L1207-1212 | |
| 16 | fstring unknown1 | fstring | 1.9 | GPSBabel reads **1 fixed byte** (L542) | Correct only when the flag is 0 |
| 17 | Predicted leg time (s) | u32 | 1.9 | L543 → `duration` for class 10/12 (L546-554) / writer's 5 zero bytes at L1213 cover rows 16 and 17 | Oppmann: "for auto-routed routes" |
| 18 | Directions ("instruction") | cstr | 1.9 | L545 → `description` / L1218-1225 | |
| 19 | Links | u32 count + cstr × count | 1.9 | L555-566 / L1237-1240 | |
| 20 | Categories | u16 bitmask | all (≥1.6) | L577 / L1243 | |
| 21 | Temperature (°C) | fdouble | all (≥1.6) | L587-594 / L1244 | |
| 22 | Creation time | fint (Unix s) | all (≥1.6) | L602-604 / L1245 | |
| 23 | Phone numbers | u32 count; per entry cstr number + fstring category | 1.9 | GPSBabel handles only count==1 and reads cstr + cstr (L608-611); writes 0, or 1 + cstr + empty cstr (L1249-1256) | Oppmann p.13 |
| 24 | Country | cstr | 1.9 | L612 / L1257 | |
| 25 | Postal code | cstr | 1.9 | L613 / L1258 | End of record for 1.9 |

Oppmann adds rows for ≥1.15: show-direction-icon flag, direction icon, thumbnail flag with origin, PNG size and PNG bytes, Unknown6/7, and ≥1.29 Unknown8/9 (p.13). These belong to the BaseCamp formats below 1.46.

---

## 4. Route 'R' layout, versions 1.7/1.8/1.9

**Header**

| Field | Type | GPSBabel read / write | Oppmann (p.21-22) |
|---|---|---|---|
| Name | cstr | L649 / L1298 | yes |
| Auto-name | u8 flag | L652 / writes 0 L1299 | yes |
| "No bounds" flag | u8; if 0: coord maxlat, coord maxlon, fdouble maxalt, coord minlat, coord minlon, fdouble minalt | L654-667 / L1272-1286 (writes 0 + bounds when valid, else 1) | yes; the altitude parts are <1.46 only |
| Route point count | u32 | L669 / L1304-1305 | <1.46 position |

**Each route point** (Oppmann p.22-24)

| Field | Type | GPSBabel read / write | Notes |
|---|---|---|---|
| Name | cstr | L683 / L1336 | |
| Class | u32 | L684 / L1340 | |
| Country code | cstr | L685 / L1341 | <1.46 |
| Subclass | 22 bytes | L686 / L1348-1351 | <1.46 |
| Unknown1 | fstring | GPSBabel: `if (byte != 0)` skip 8 bytes, plus 8 more in v3 (L688-694, "aviation data (?); only seen with class 1 (Airport)") / writes 0 (L1354) | **Discrepancy with Oppmann** |
| Unknown2-6 (18 bytes) | u32 Unknown2 (0/1/3), u32 Unknown3, u32 Unknown4, u16 Unknown5, u32 Unknown6 (0/1/2; 1 = "autoroute point follows") | Read as 18 bytes; warns if the first byte is not 0/1/3 (L696-709) / writes `03 00 00 00 FF FF FF FF 00×10` (L1355-1358) | |
| Link points | u32 count; each = coord lat, coord lon, fdouble alt | L711-745 / L1360-1377 | |
| "Omit bbox" flag | u8; if 0: coord, coord, fdouble, coord, coord, fdouble | L750-761 / L1362, L1376 | |
| Unknown7 | 8 bytes `FF×8` | ≥1.8: L780-781 / L1381-1382 | Oppmann "≥1.8 byte[8] Unknown7" |
| Unknown11 + end time | fint + fint (Unix s) | 1.9: GPSBabel reads **2 fixed bytes** (L782-784) / writes 2 zero bytes (L1383-1385) | Correct only when both flags are 0 (Oppmann p.23) |

How GPSBabel interprets and writes the link points:
- The first link point is the route point's own position (L729-733).
- The list describes the leg geometry from this point toward the next. For autoroutes these are the road-following shape points ("ilinks", stored in `garmin_fs_t::ilinks`, garmin_fs.h L45-49 and L102).
- The writer emits 2 links per leg (this point, then the next) and 0 for the last point (L1360-1377).
- **A point with 0 links has no coordinates in the R record.** GPSBabel resolves it by name against the W records already read, and fatals with "Sleeping route point without coordinates!" if none is found (L763-777). It also cross-checks positions to within 100 m (L234-241).
- So W records must precede R records, and route points join to waypoints **by name**. VERIFIED.

**Trailer**

1.7/1.8:
- cstr link (L807-808 / L1390-1395).

1.9, in order:
1. u32 link count + cstr each. GPSBabel `gdb_fread_strlist` keeps only the last non-empty string (L166-183, L810).
2. u32 color index (L812). The writer defaults to 14 (Magenta) (L1403).
3. u8 auto-route flag (L814).
4. If the flag is 1, the auto-route block:
   - 6 bytes. GPSBabel calls them "unknown" (L816); Oppmann says they are 6 flags: avoid toll, unpaved, u-turns, carpool, ferries, date/time closures.
   - u8 route style
   - u32 calculation type (0 faster, 1 shorter)
   - u8 vehicle (Oppmann p.25 table)
   - u32 road selection (-3..3)
   - 5 × f64 driving speeds
   - 8 bytes. GPSBabel calls them "unknown" (L827); Oppmann says u32 area-avoidance count + areas, then u32 road-avoidance count + roads (p.22, p.24).
   - GPSBabel's whole block is L815-841.
5. cstr notes/description (L843).

The writer emits: strlist, color, u8 0, cstr description (L1396-1406).

---

## 5. Track 'T' layout, versions 1.7/1.8/1.9

| Field | Type | GPSBabel read / write | Oppmann p.25 |
|---|---|---|---|
| Name | cstr | L868 / L1414 | yes |
| Display | u8 (0 = no, 1 = yes per Oppmann) | skipped L871 / **writes 0** L1415 | yes |
| Color index | u32 | L872-873 / L1417 (0 = "Unknown" default) | yes |
| Point count | u32 | L875 / L1419 | yes |
| Each point | coord lat, coord lon, fdouble altitude (m), fint time (Unix s), fdouble depth (m), fdouble temperature (°C) | L882-898 / L1425-1432 | Temperature is ≥1.6. Oppmann adds 2 fdoubles and 2 optional bytes from 1.29 (p.25-26). |
| Links | 1.7/1.8: cstr; 1.9: u32 count + cstr each | L904-908 / L1438-1450 | Notes cstr only from 1.15 |

---

## 6. GPSBabel vs Oppmann: places where they disagree

GPSBabel's 1.8 and 1.9 parsing is exercised by `testo.d/gdb.test`:
- It reads `reference/gdb-sample.gdb` (a v2 file, per its comment at L10-12), `gdb-sample-v3.gdb` and `gdb-sample-v3-autoroute.gdb`.
- It round-trips the data through ver=1, 2 and 3.
- I read that the test exists (VERIFIED); I did not run it. That gives GPSBabel's layouts real-file backing **only in the common case where optional fields are empty**.

The disagreements:
1. **Route point Unknown1.** Oppmann says it is an fstring. GPSBabel skips a fixed 8 bytes (16 in v3) when the byte is non-zero (L688-694).
2. **Waypoint 1.9 fstring.** GPSBabel reads 1 byte and assumes the flag is 0 (L542).
3. **Waypoint 1.7/1.8 middle block.** GPSBabel uses a `waypt_flag` heuristic (L509-517, L597-601). Oppmann gives the clean sequence: street cstr, fstring, u32 leg time, directions cstr, link cstr.
4. **Phone numbers.** GPSBabel handles a count of 1 only and reads the fstring category as a cstr (L608-611). That works by accident for one entry: flag 0 looks like an empty cstr, and flag 1 + text reads as a single cstr starting with 0x01.
5. **Route auto-route trailer.** GPSBabel's "8 unknown bytes" (L827) are Oppmann's two avoidance counts. GPSBabel misparses when avoidances exist, which Oppmann says MapSource uses from 6.16.3.
6. **Driving-speed units.** GPSBabel's debug text says "kph" (L831). Oppmann says "in 1/10 meter per second". Unresolved.
7. **Route point trailer in 1.9.** GPSBabel reads 2 fixed bytes (L782-784). Oppmann says fint + fint, so if an end time is present, GPSBabel is off by 4 bytes.
8. **Link point.** Oppmann has an uncertain row "1.6 ? 1.60? 8 x byte = 0" (p.24). GPSBabel reads no such bytes. The test files with links parse in GPSBabel's CI, which suggests no extra bytes in 1.9 (GUESS).
9. **String encoding inside GPSBabel itself (VERIFIED).**
   - `fread_cstr` uses UTF-8 for ver ≥3 and Latin-1 below (L149-164).
   - But `FREAD_CSTR_AS_QSTR` is `gbfgetcstr`, which is **always** UTF-8 (L147; gbfile.cc L1003-1007). It is used for the 1.7/1.8 waypoint unknown string and link (L520-528), the 1.9 directions (L545), the 1.9 URLs (L557) and the 1.7/1.8 track link (L907).
   - The writer uses Latin-1 or UTF-8 by version for every string (L284-295).
   - The source comment admits this (L138-145).
   - Oppmann says only "either ISO/IEC 8859-1 or UTF-8" (p.3). Which applies for ≥1.46 is **unknown**; UTF-8 is a GUESS. The GFI item name is stated to be UTF-8 (p.32).

Because every record carries a length prefix, these misparses stay inside one record. GPSBabel resynchronises at the next record and warns (L1018-1049).

---

## 7. What BaseCamp itself writes: formats ≥ 1.46

This section is REPORTED from Oppmann only. No GPSBabel support exists for it.

**Waypoint ≥1.46 (p.13-14), in order:**
1. cstr name
2. u32 class
3. position (2 × coord)
4. cstr comment
5. fdouble proximity
6. u32 display
7. u32 icon
8. u32 color
9. u8 Unknown1=0 (Oppmann: "fstring as above?")
10. [≥1.54] flag "Subclass1 present", then Subclass1
11. [≥1.54] flag "Subclass2 present", then Subclass2
12. fdouble altitude
13. u8 Unknown2=0
14. u32 link count + cstr links
15. fdouble temperature
16. fint creation time
17. u8 Unknown3=0
18. flag thumbnail present; if set: cstr origin, cstr UUID, 8 × u8 = 0

Notes on this layout:
- The country code, city, state, facility, depth and category fields are gone.
- **It is unknown** what "Subclass1" and "Subclass2" are here, and how big they are. They may be the 22-byte Subclass structure split in two, or something else. The table does not say.

**Route ≥1.46 (p.21-24):**
- The order changes: name, auto-name, then u32 point count + route points, then 3 × u8 = 0, then the no-bounds flag + max/min positions (no altitudes).
- After that come the 1.9 trailer fields plus ≥1.15 extras (create-waypoints settings, distance, filtered-route flag and points, Unknown10 with link points, ≥1.29 byte) and ≥1.46 u32 activity profile (0 Custom … 6 Direct).
- Each route point is: name, class, fstring, the 18-byte Unknown2-6 block, link points (position only, no altitude), bbox (no altitudes), 8 × FF, fint, fint, ≥1.29 fdouble duration (only if an end time is present), then u32 autoroute-point count + autoroute points.
- The autoroute point table (p.23) mixes in annotation prose. Its byte counts (`byte[16+2] Subclass, byte[11]=0, byte[4]=0xFF, byte[6]=0, uint=1`) are **not reliable enough to implement from** without test files.

**Track ≥1.46 (p.26):**
- Fields in order: cstr name, u8 display, u32 color, u32 link count + links, cstr notes, f64 area (m²), fdouble Unknown2, u8 Unknown3=0, position max, position min, fdouble duration (s), f64 length (m), fint start time, u32 segment count + segments, u32 total point count, cstr UUID.
- Each segment: u8 Unknown1=0, position max, position min, u32 point count + points.
- **Each point is listed as `position` only.** I re-extracted the page by word position and nothing else follows on the page.
- **Per-point elevation and timestamps for ≥1.46 tracks are therefore not documented.** It is unknown whether the table is incomplete or BaseCamp stores them some other way. This is the biggest gap for BCR if users bring a native 1.88 AllData.gdb.

**Other records (≥1.29 / ≥1.31):** 'G' and 'j' image records, 'O' and 'J' BirdsEye records (p.26-31), 'L' map section (p.28-29: u16 product ID, u16 family ID, u32 segment ID, 3 cstr names, then 4 × {flag, 4 bytes if flag}), and 'C' geocaching (layout "..." / undocumented, p.31).

---

## 8. BaseCamp-specific notes in the GPSBabel source and history

All VERIFIED.
- Header check accepts the string "BaseCamp" (L394).
- `xmldoc/formats/gdb.xml` says the format "is also used by Garmin BaseCamp for Mac and Windows" and that the default write version is 2 (MapSource 6.3/6.5).
- PR #585 (commit 0c3341c844, 2020-06-07), "Extract expected travel durations from Garmin BaseCamp GDB output", added `garmin_fs_t::duration` and the class-10/12 duration notes (L546-554). The author lintondf says the autoroute route points "are generated by Basecamp".
- PR #566 (tsteven4, 2020-05-24) "teach gdb reader to read autoroute information" added `reference/gdb-sample-v3-autoroute.gdb`. The PR body is empty and the producing program is not stated.
- **Issue #893** (2022, closed "completed" 2022-12-08), REPORTED:
  - The reporter got the wrong-version error on BaseCamp 4.7.4, "fileversion 1.88".
  - tsteven4 replied that only 1.7/1.8/1.9 are supported, "Known later versions, mostly from basecamp, 1.15-1.88 are not supported", and that the W, R and T record formats "have all changed". He pointed to Oppmann's PDF and suggested a clean rewrite.
  - robertlipe said GDB "barely hung in there" on a list of formats proposed for removal.
  - robertlipe then exported from a fresh BaseCamp "4.8.12" to GDB and GPSBabel read it ("believable mix of waypoint and track data"). He did not say which version number the export had. That a BaseCamp export writes 1.9 is a GUESS.

---

## 9. GPSBabel reference/ test vectors (listed only, not downloaded)

| File | Size (bytes) | Added | Notes |
|---|---|---|---|
| reference/gdb-sample.gdb | 66829 | before 2015-09-12 (oldest visible commit is the "Move everything up" commit 55508d19b2) | A v2 (1.8) file per testo.d/gdb.test L10-12, containing a Latin-1 "Völkerschlachtdenkmal" |
| reference/gdb-sample2.gdb | 6314 | before 2015-09-12 | Version not stated |
| reference/gdb-sample-v3.gdb | 69073 | before 2015-09-12 | gdb.test L26-27 expects it to give the same GPX as gdb-sample.gdb, so the two are a v2/v3 pair of the same data (VERIFIED from the test script) |
| reference/gdb-sample-v3-ilinks.gdb | 10001 | 2020-07-01, PR #598 (lintondf) | Route interlinks |
| reference/gdb-sample-v3-autoroute.gdb | 12439 | 2020-05-24, PR #566; changed 2020-06-10, PR #595 | Auto-route block |

Related expected-output files: gdb-sample.gpx, gdb-sample-v3-ilinks.gpx, gdb-sample-v3-autoroute.gpx, route/gdbroutenametest.csv and route/gdbroutenametest~csv.csv. `reference/basecamp.gpx` and `basecamp~gpx.gpx` are **GPX, not GDB**.

**Licence:**
- The repository is GPL-2.0 (GitHub API, COPYING). There is no per-file licence or provenance note for the GDB samples; the only `.license` files in reference/ are two OSM shapefile licences.
- None of the samples is a 1.46+ BaseCamp-native file, as far as the names, tests and PRs show. Versions are taken from names and test comments; I did not inspect the bytes.
- GUESS, not legal advice: shipping these files inside a non-GPL BCR repository could carry GPL obligations, and code copied from gdb.cc would definitely carry them. Re-implementing from the facts documented above is the cleaner route.

---

## 10. Practical takeaways for a BCR reader and writer

These are design notes; the GUESS labels apply where stated.
- Implement the container (§2) once. Every record is length-prefixed, so parse the leading fields you trust and **always seek to `start + len`**. This tolerates every unknown or misparsed tail. VERIFIED framing.
- Branch on the 'D' version as an integer: 107-109 is MapSource-style (§3-5), ≥146 is BaseCamp-style (§7), 115-138 is a third layout family.
- Route points with 0 link points need a by-name join to W records (VERIFIED for 1.7-1.9; GUESS that ≥1.46 behaves the same).
- Folder and list structure needs FolderData.gfi plus a by-name join (§1). GPSBabel offers nothing to reuse here.
- For writing GDB (if ever needed), GPSBabel's 1.8 writer recipe (§2-5) is the only test-backed one. Its output is accepted by MapSource and BaseCamp per Oppmann's "seen" table, which lists GPSBabel 1.3.4/1.3.6/1.5.2 files (REPORTED).

## Open questions
- Where does Mac BaseCamp keep its library, and are the files also called AllData.gdb and FolderData.gfi? Oppmann gives only the Windows path (p.3); the Mac location is unknown.
- Where do 1.46+ track points keep elevation and time? As written (Oppmann p.26), a 1.46+ track point holds only a position. Is the table incomplete, or does BaseCamp store these elsewhere? This decides whether BCR can recover elevation and time from a native 1.88 AllData.gdb.
- In the 1.46+ waypoint layout (Oppmann p.14), what exactly are 'Subclass1' and 'Subclass2', and how many bytes is each (with and without the 1.54+ presence flags)?
- What are the real byte counts of the 1.46+ 'Autoroute point' structure (Oppmann p.23)? The table is mixed with annotation text and is not reliable enough to implement from.
- Which 'D' version does BaseCamp write when exporting to .gdb (File > Export)? Robert Lipe says GPSBabel reads such exports, so 1.9 is a guess. Does an export keep any folder or list information?
- Does BaseCamp enforce unique names among tracks, routes and waypoints? The GFI file links to GDB objects only by type plus name (plus class for waypoints), so duplicate names would be ambiguous.
- How does a GFI file end? Oppmann lists no 'V' or 'X' record for GFI.
- Which text encoding do GDB files at 1.46+ use? Oppmann says only 'Latin-1 or UTF-8'; UTF-8 is a guess. Only the GFI item name is stated to be UTF-8.
- Driving-speed units in the route auto-route block: GPSBabel's comment says km/h, Oppmann says 1/10 m/s.
- Can the kbm1959/Garmin_gdb_reconstruction script (outside my topic) confirm the 1.46+ waypoint, track and GFI layouts? It is the only other public implementation I know of that handles the folder tree.
- Licensing: can GPSBabel's GPL-2.0 reference .gdb files be used as BCR test vectors without GPL obligations, or should BCR build its own synthetic test files? Oppmann's PDF states no licence terms either way.

## Sources
- [V] https://github.com/GPSBabel/gpsbabel/blob/7003cff254beb3a8f442327fdc406984de102091/gdb.cc — GPSBabel GDB reader and writer; all layout line citations (header L342-397, waypoint L401-638, route L642-856, track L860-915, read loop L957-1064, writer L1089-1680)
- [V] https://github.com/GPSBabel/gpsbabel/blob/7003cff254beb3a8f442327fdc406984de102091/gdb.h — Version constants kGDBVer1..3 and kGDBVerUTF8 (L105-111), default icon (L113), writer options with ver default 2 (L181-211)
- [V] https://github.com/GPSBabel/gpsbabel/blob/7003cff254beb3a8f442327fdc406984de102091/gbfile.cc — Little-endian int and double readers and writers (L909-959, L1193-1234), C-string reading (L981-1007) and writing (L1253-1263)
- [V] https://github.com/GPSBabel/gpsbabel/blob/7003cff254beb3a8f442327fdc406984de102091/gbfile.h — gbfopen_le is plain gbfopen (L93-96); gbfgetuint32 reinterprets the signed read (L122-125)
- [V] https://github.com/GPSBabel/gpsbabel/blob/7003cff254beb3a8f442327fdc406984de102091/util.cc — endian_read_double: IEEE-754 byte-order handling (L403-427)
- [V] https://github.com/GPSBabel/gpsbabel/blob/7003cff254beb3a8f442327fdc406984de102091/jeeps/gpsmath.cc — Degree/semicircle conversion (L260-279)
- [V] https://github.com/GPSBabel/gpsbabel/blob/7003cff254beb3a8f442327fdc406984de102091/garmin_tables.h — Waypoint class enum (L36-50) and GDB display-mode enum (L66-70)
- [V] https://github.com/GPSBabel/gpsbabel/blob/7003cff254beb3a8f442327fdc406984de102091/garmin_tables.cc — Garmin color index table, stored as BGR (L348-367)
- [V] https://github.com/GPSBabel/gpsbabel/blob/7003cff254beb3a8f442327fdc406984de102091/garmin_fs.h — garmin_ilink_t struct (L45-49), duration and ilinks fields (L100-102)
- [V] https://github.com/GPSBabel/gpsbabel/blob/7003cff254beb3a8f442327fdc406984de102091/defs.h — unknown_alt = -99999999.0 (L1033)
- [V] https://github.com/GPSBabel/gpsbabel/blob/7003cff254beb3a8f442327fdc406984de102091/waypt.cc — SetCreationTime(seconds) treats the value as a Unix epoch (L535-539)
- [V] https://github.com/GPSBabel/gpsbabel/blob/7003cff254beb3a8f442327fdc406984de102091/src/core/datetime.h — toTime_t clamps invalid, negative or too-large times to UINT32_MAX (L88-98)
- [V] https://github.com/GPSBabel/gpsbabel/blob/7003cff254beb3a8f442327fdc406984de102091/testo.d/gdb.test — GDB regression tests and which reference files they use; the v2 Latin-1 comment (L10-12); v2/v3 sample pairing (L26-27)
- [V] https://github.com/GPSBabel/gpsbabel/blob/7003cff254beb3a8f442327fdc406984de102091/xmldoc/formats/gdb.xml — GPSBabel's own documentation: format used by MapSource 6+ and BaseCamp for Mac and Windows; default write version 2
- [V] https://api.github.com/repos/GPSBabel/gpsbabel/git/trees/7003cff254beb3a8f442327fdc406984de102091?recursive=1 — Full file listing used to enumerate reference/*.gdb files and sizes; repo licence GPL-2.0 from the repo API
- [V] https://www.memotech.franken.de/FileFormats/Garmin_MPS_GDB_and_GFI_Format.pdf — Herbert Oppmann, 'Garmin MapSource (MPS), GPS Database (GDB) and Folder and Item (GFI) File Format', 2024-02-04, 34 pages. Read in full (text extracted locally): types p.3-5, header and framing p.5, version tables p.6-11, W/R/T layouts p.12-26, other records p.26-31, GFI p.32-33
- [V] https://www.memotech.franken.de/FileFormats/ — Index page: 'Last change: 2024-02-04'; no licence or usage terms stated for the PDFs (read via WebFetch summary)
- [V] https://github.com/GPSBabel/gpsbabel/issues/893 — 'gpsbabel does not support gdb from basecamp 4.7.4' (file version 1.88). Maintainer comments: 1.15-1.88 unsupported; a BaseCamp export to GDB was read fine
- [V] https://github.com/GPSBabel/gpsbabel/pull/585 — 'Extract expected travel durations from Garmin BaseCamp GDB output' (2020); BaseCamp autoroute durations
- [V] https://github.com/GPSBabel/gpsbabel/pull/566 — 'teach gdb reader to read autoroute information'; added gdb-sample-v3-autoroute.gdb (body empty, file provenance not stated)
- [V] https://github.com/GPSBabel/gpsbabel/pull/598 — 'Write garmin specific ilinks as gpxx:rpt elements'; added gdb-sample-v3-ilinks.gdb test data
