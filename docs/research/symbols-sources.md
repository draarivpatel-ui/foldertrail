# Waypoint icon numbers to GPX `<sym>` names: sources

Research note for `src/format/symbols.js` (decision B31), 2026-10-05. Every source below was opened on that date by the
person who wrote the table. `test/symbols.test.js` checks that the per-entry table at the end of this note lists exactly
the entries in `symbols.js`, so the two cannot drift apart.

**Nothing here has been checked against a real BaseCamp library.** The sources describe MapSource, older devices and
other people's BaseCamp files. Whether Mac BaseCamp 4.8 stores the same icon numbers, and writes the same `<sym>`
spellings, is for Gate 1 to settle (checks at the end of §4).

## 1. What the table does

A GDB waypoint record stores its symbol as a u32 "icon" number (FORMAT.md §5.1, field 7). `lookup(icon)` returns the
GPX `<sym>` name Garmin software uses for that icon, such as `Flag, Blue`, or `""` when the number is not in the table.
An unmapped icon gets no `<sym>` (B31); the table never guesses a nearest name.

**Result:** 266 entries.

| Block | Entries | Number → icon | Name spelling |
|---|---|---|---|
| GDB 0-248 | 249 | Three sources agree on every entry (OP, KBM, GB; see §3 for how independent they are). 221 of them (0-220) are also symbols in Garmin's own device specification. | 189 have evidence beyond GPSBabel (an exact match, or a match of the name family before the comma). 60 rest on GPSBabel's spelling alone. |
| GDB 249-265 | 17 | **PROVISIONAL: GPSBabel alone.** | 8 matched by B2O, 9 GPSBabel alone. |

No two numbers share a name, so the table needs no "sourced duplicate" exception.

## 2. Sources

Tags are the ones used in the per-entry table (§6).

| Tag | Source | What it supports | Licence and use |
|---|---|---|---|
| **OP** | Herbert Oppmann, "Garmin MapSource (MPS), GPS Database (GDB) and Folder and Item (GFI) File Format", 2024-02-04, https://www.memotech.franken.de/FileFormats/Garmin_MPS_GDB_and_GFI_Format.pdf, pp. 15-20 (the "Icon" value table in the waypoint record). OP says the table comes from GPSMapEdit's partial source, file `MapSourceHelpers.cpp` (OP p.15, reference [3] on p.34). | GDB icon number → icon, as short internal identifiers, for 0-248. | Licence unknown: cited by page only. This note does not reproduce OP's identifier column (B27). |
| **KBM** | kbm1959/Garmin_gdb_reconstruction, `garmin_tools.py` at commit `a2ad367`, `get_icon`, list at L1061-1089. | The same 249 identifiers in the same order (compared by script: identical for all 249). | No licence: facts only. KBM cites OP as its basis (L12-15), so for this list it is **not independent of OP**. What it adds: its author ran it on a real BaseCamp 4.7.5 library (REPORTED via FORMAT.md §0; KBM's README was not opened for this note) and did not change the list. KBM's own icon-to-GPX map (L1324-1338) is **not used**: it maps, for example, the car icon to "Gas Station", which every other source contradicts. |
| **GIS-C** | Garmin, "Garmin Device Interface Specification", 001-00063-00 Rev. C, May 19, 2006, §7.3.15 `symbol_type`, pp. 27-31. Read from the Internet Archive copy of https://www8.garmin.com/support/pdf/iop_spec.pdf (snapshot 20110124122549). | Garmin's own constant and one-line description for each device symbol, for example `sym_flag_blue` = 8284, "blue flag symbol". | Garmin's public interface document. Constant names are cited as references. |
| **GIS-3** | Garmin, "GARMIN GPS Interface Specification", 001-00063-00 Rev. 3, December 6, 1999, §7.4.9 `Symbol_Type`, pp. 33-35, https://www8.garmin.com/support/pdf/iop_spec.pdf (still online). | The older subset of the same constants (121 of our icons). | As GIS-C. The file served is 714 bytes longer than the length its own linearization header declares, and its compressed streams contain CR LF where a bare LF belongs (a text-mode transfer corruption: GUESS). Dropping the CR before each LF was enough to read §7.4.9. |
| **GB** | GPSBabel at commit `7003cff254beb3a8f442327fdc406984de102091`: `garmin_icon_tables.h` (the table, included by `garmin_tables.cc`) and `garmin_tables.cc` L427-457 (`gt_find_desc_from_icon_number`, which looks GDB numbers up in the table's first column and treats GDB 500-563 as custom symbols). | GDB number → name; device number → name. | GPL-2.0-or-later: **read only to cross-check, no code or table text copied.** The table is in `garmin_icon_tables.h`, not in `garmin_tables.c` as the task brief says. GPSBabel credits Ian Cowley, Sigurd Humerfelt and MapSource 4.13 for it, a lineage separate from OP's (GPSMapEdit). |
| **B2O** | maurizioandreotti/GPX-Basecamp-2-OsmAnd, `Gpx-Garmin2Osmand.xsl` at commit `e2377b6` (2025-11-23). | `<sym>` spellings in GPX files "produced with basecamp" (its README): **B2O** = the XSL matches our exact string; **B2O-fam** = it matches the family before the comma (`substring-before(., ',')`, for example every "Flag, ..."). | GPL-2.0: facts only. Some of its match strings are speculative (it matches both "Red Triangle" and "Triangle, Red", and marks a section "to verify"), so a match is evidence of the spelling, not proof. The repository's sample GPX files were **not** fetched (they are someone's GPS data). |
| **FGT** | Leszek Pawlowicz, "Garmin GPS Unit Waypoint Icons Table", Free Geography Tools, https://freegeographytools.com/?p=1296 (2008). | Labels as shown on a GPSMAP 60Cx, with MapSource categories. Counted only where the label equals our string exactly. | Device labels sometimes differ from GPX names ("Blue Flag" there, "Flag, Blue" in GPX), so FGT never decides a spelling on its own. |
| **GF** | Garmin forum, BaseCamp (Windows), thread 61908, reply 388336: https://forums.garmin.com/apps-software/mac-windows-software/f/basecamp-windows/61908/gpsmap-60cs-screen-cluttered-by-route-point-labels/388336 | A user edits exported GPX by replacing "Flag, Blue" with "Waypoint", so both spellings appear in real exports. | Forum post: REPORTED. |

**Looked at, not counted as evidence**

- Viking, `src/garminsymbols.c` (GPL). Its own comment says its names are written "like in gpsbabel", so it is
  GPSBabel-derived. It is used only to flag disagreements: device symbol 0 as "Marina", and "Green Diamon[d]",
  "Green Square", "White Dot" word orders (entries 0, 2, 3, 15, 16, 35).
- OpenStreetMap wiki, `GarminTagSymbols` (2011): `Custom 0` ... `Custom 23` as `<sym>` names for user-made symbols.
  This supports the custom-symbol naming, but not GPSBabel's GDB numbers 500-563 (§4).
- Sigurd Humerfelt's MapSource page (Internet Archive, 2009) and Garmin's MapSource map legend page (Internet Archive,
  2009): their symbol tables are images, with device (PCX) numbers. Not used.

## 3. How one entry is supported

Each entry needs a chain of three links. The per-entry table (§6) gives the evidence for each link.

1. **GDB number → icon.** OP and KBM give the icon at each index (one lineage, since KBM copied OP's list), and GB's
   GDB-number column gives the same icon at the same number from a separate lineage. All three agree for 0-248.
2. **Icon → Garmin symbol.** The GDB number is a dense index, *not* the device symbol number from Garmin's
   specification: GDB 20 (man overboard) is device symbol 21, GDB 37 (boat ramp) is device 150, GDB 141 (blue flag) is
   device 8284. For 0-220, each of OP's identifiers names the same symbol as one of Garmin's GIS-C constants (matched by
   spelling, after one systematic rename, "contact" to Garmin's "cntct"; 11 pairs whose spelling differs further were
   matched by hand, for example the "no anchor" icon and `sym_anchor_prohib`). As an independent check, GB's
   device-number column gives exactly the GIS-C number for all 221 of them (computed: no mismatch). GDB 221-248 were
   added in MapSource 6.12 and later (a GB comment) and are not in GIS-C.
3. **Garmin symbol → `<sym>` spelling.** GB gives the spelling for every entry. B2O, FGT and GF are the evidence that
   does not come from GPSBabel. Where none of them matches, the column says "GB only", and that spelling rests on
   GPSBabel alone.

## 4. Decisions

- **GDB 0 is `Anchor`.** GIS-C describes device symbol 0 as a white anchor, and GB and FGT spell it "Anchor". Viking
  (GPSBabel-derived) calls it "Marina", but `Marina` is a separate icon (GDB 162, GIS-C `sym_marina` = 191).
- **Word order for the old coloured shapes** (GDB 2, 3, 35, 168): GB writes "Diamond, Green" and "Dot, White". B2O
  matches "Green Diamond" and other "Colour Diamond" forms; Viking writes "Green Diamon" (sic) and "White Dot". The
  table uses the comma form, which matches the attested pattern of the newer shapes ("Flag, Blue", "Square, ...",
  "Triangle, Red", "Navaid, ..."). **This is a GUESS** for those four; Gate 1 settles it.
- **Aliases.** GB lists two names for three numbers (GDB 10, 59, 69). The table uses the one B2O matches: `Residence`,
  `Lodging`, `City (Small)`.
- **GDB 249-265 (BaseCamp 4.8 additions) are included, marked PROVISIONAL.** GB labels this block "BaseCamp 4.8.13", and
  it is the only source for these numbers; OP and KBM stop at 248. They are included because they are exactly the icons
  that Mac BaseCamp 4.8 users may have chosen, and B2O (a mapper for BaseCamp GPX files) matches 8 of the 17 spellings.
  In `symbols.js` they are a single block (`PROVISIONAL_BASECAMP_48`) that can be deleted in one edit if Gate 1 or the
  maintainer says so.
- **Custom symbols are not mapped.** GB treats GDB 500-563 as "Custom 0" ... "Custom 63". No second source gives that
  offset, so `lookup` returns `""` for them, and such waypoints get no `<sym>`.
- **Everything else returns `""`**: any number not in the table (266 and above, including 500-563), negative
  numbers, fractions, NaN, and anything that is not a number. `lookup` never throws.

### Gate 1 checks for this table

In BaseCamp 4.8.13, with made-up waypoints only: give one waypoint each of `Anchor`, `Diamond, Green`, `Dot, White`,
`Diamond, Blue`, `Flag, Blue`, `Contact, Blonde` (GDB 221), `ATV` (GDB 232), and at least `Dog Running`, `Favorite`
and `Hospital, Euro` from the 249-265 block. Then (1) export the list as GPX and read each `<sym>`, and (2) read each
waypoint's icon number from `AllData.gdb` (icon numbers are not personal data, so the structure dump may list them).
A mismatch on (1) changes a spelling; a mismatch on (2) means Mac BaseCamp numbers icons differently, and the whole
table must be re-checked.

## 5. Counts behind §1

Computed by script from the sources above, 2026-10-05.

- Number → icon: 249 entries backed by OP, KBM and GB together; 17 by GB alone (249-265).
- Garmin specification: 221 entries in GIS-C (all of 0-220), of which 121 are also in GIS-3.
- Name spelling beyond GB, for 0-248: B2O exact 105, B2O family 65, FGT 79, GF 2 (several entries have more than one).
  189 of 249 have at least one; **60 have none** ("GB only"): the four word-order guesses above (2, 3, 35, 168), the 24
  Rino contact icons (119-138, 221-224), 15 hunting icons (232-239, 241-247), the oval, rectangle and triangle colours
  not matched by B2O (169, 170, 172-174, 218, 219), and 45, 65, 115, 116, 150, 155, 158, 163, 225, 226.
- 249-265: 8 spellings matched by B2O (254-256, 259-263); 9 rest on GB alone.

## 6. Per-entry table

Columns: **GDB** is the icon number in the waypoint record. **Number → icon** cites the sources for link 1 (OP by page).
**Garmin spec** cites link 2: `C p.N` is GIS-C with Garmin's constant and *device* number, `R3 p.N` adds GIS-3;
"—" means the symbol is not in Garmin's specification. **Name evidence** cites link 3; GB is listed last because it is a
cross-check, and "GB only" means no other source matches the spelling.

| GDB | `<sym>` | Number → icon | Garmin spec | Name evidence | Notes |
|---|---|---|---|---|---|
| 0 | Anchor | OP p.15, KBM, GB | C p.27 `sym_anchor` = 0; R3 p.33 | FGT, GB | Viking (GB-derived) calls device symbol 0 "Marina"; Marina is GDB 162 here. Treated as an outlier. |
| 1 | Bell | OP p.15, KBM, GB | C p.27 `sym_bell` = 1; R3 p.33 | B2O, FGT, GB |  |
| 2 | Diamond, Green | OP p.15, KBM, GB | C p.27 `sym_diamond_grn` = 2; R3 p.33 | GB only | Word order is a GUESS: B2O matches "Green Diamond" (and other "Colour Diamond" forms), GB gives the comma form. |
| 3 | Diamond, Red | OP p.15, KBM, GB | C p.27 `sym_diamond_red` = 3; R3 p.33 | GB only | Word order is a GUESS, as for 2. |
| 4 | Diver Down Flag 1 | OP p.15, KBM, GB | C p.27 `sym_dive1` = 4; R3 p.33 | FGT, GB |  |
| 5 | Diver Down Flag 2 | OP p.15, KBM, GB | C p.27 `sym_dive2` = 5; R3 p.33 | FGT, GB |  |
| 6 | Bank | OP p.15, KBM, GB | C p.27 `sym_dollar` = 6; R3 p.33 | B2O, FGT, GB |  |
| 7 | Fishing Area | OP p.15, KBM, GB | C p.27 `sym_fish` = 7; R3 p.33 | FGT, GB |  |
| 8 | Gas Station | OP p.15, KBM, GB | C p.27 `sym_fuel` = 8; R3 p.33 | B2O, FGT, GB |  |
| 9 | Horn | OP p.15, KBM, GB | C p.27 `sym_horn` = 9; R3 p.33 | B2O, FGT, GB |  |
| 10 | Residence | OP p.15, KBM, GB | C p.27 `sym_house` = 10; R3 p.33 | B2O, FGT, GB | GB also lists "House" for this number; the first name is used, and B2O matches it. |
| 11 | Restaurant | OP p.15, KBM, GB | C p.27 `sym_knife` = 11; R3 p.33 | B2O, FGT, GB |  |
| 12 | Light | OP p.15, KBM, GB | C p.27 `sym_light` = 12; R3 p.33 | B2O, FGT, GB |  |
| 13 | Bar | OP p.15, KBM, GB | C p.27 `sym_mug` = 13; R3 p.33 | B2O, FGT, GB |  |
| 14 | Skull and Crossbones | OP p.15, KBM, GB | C p.27 `sym_skull` = 14; R3 p.33 | B2O, GB |  |
| 15 | Square, Green | OP p.15, KBM, GB | C p.27 `sym_square_grn` = 15; R3 p.33 | B2O-fam, GB | B2O matches the "Square, ..." family; Viking (GB-derived) writes "Green Square" instead. |
| 16 | Square, Red | OP p.15, KBM, GB | C p.27 `sym_square_red` = 16; R3 p.33 | B2O-fam, GB | As for 15. |
| 17 | Buoy, White | OP p.15, KBM, GB | C p.27 `sym_wbuoy` = 17; R3 p.33 | B2O-fam, GB |  |
| 18 | Waypoint | OP p.15, KBM, GB | C p.27 `sym_wpt_dot` = 18; R3 p.33 | B2O, GF, GB |  |
| 19 | Shipwreck | OP p.15, KBM, GB | C p.27 `sym_wreck` = 19; R3 p.33 | B2O, FGT, GB |  |
| 20 | Man Overboard | OP p.15, KBM, GB | C p.27 `sym_mob` = 21; R3 p.33 | FGT, GB |  |
| 21 | Navaid, Amber | OP p.15, KBM, GB | C p.27 `sym_buoy_ambr` = 22; R3 p.33 | B2O-fam, GB |  |
| 22 | Navaid, Black | OP p.15, KBM, GB | C p.27 `sym_buoy_blck` = 23; R3 p.33 | B2O-fam, GB |  |
| 23 | Navaid, Blue | OP p.15, KBM, GB | C p.27 `sym_buoy_blue` = 24; R3 p.33 | B2O-fam, GB |  |
| 24 | Navaid, Green | OP p.15, KBM, GB | C p.27 `sym_buoy_grn` = 25; R3 p.33 | B2O-fam, GB |  |
| 25 | Navaid, Green/Red | OP p.15, KBM, GB | C p.27 `sym_buoy_grn_red` = 26; R3 p.33 | B2O, GB |  |
| 26 | Navaid, Green/White | OP p.15, KBM, GB | C p.27 `sym_buoy_grn_wht` = 27; R3 p.33 | B2O-fam, GB |  |
| 27 | Navaid, Orange | OP p.15, KBM, GB | C p.27 `sym_buoy_orng` = 28; R3 p.33 | B2O-fam, GB |  |
| 28 | Navaid, Red | OP p.15, KBM, GB | C p.27 `sym_buoy_red` = 29; R3 p.33 | B2O-fam, GB |  |
| 29 | Navaid, Red/Green | OP p.15, KBM, GB | C p.27 `sym_buoy_red_grn` = 30; R3 p.33 | B2O, GB |  |
| 30 | Navaid, Red/White | OP p.15, KBM, GB | C p.27 `sym_buoy_red_wht` = 31; R3 p.33 | B2O, GB |  |
| 31 | Navaid, Violet | OP p.15, KBM, GB | C p.27 `sym_buoy_violet` = 32; R3 p.33 | B2O-fam, GB |  |
| 32 | Navaid, White | OP p.15, KBM, GB | C p.27 `sym_buoy_wht` = 33; R3 p.33 | B2O-fam, GB |  |
| 33 | Navaid, White/Green | OP p.15, KBM, GB | C p.27 `sym_buoy_wht_grn` = 34; R3 p.33 | B2O, GB |  |
| 34 | Navaid, White/Red | OP p.15, KBM, GB | C p.27 `sym_buoy_wht_red` = 35; R3 p.33 | B2O, GB |  |
| 35 | Dot, White | OP p.15, KBM, GB | C p.27 `sym_dot` = 36; R3 p.33 | GB only | Word order is a GUESS: Viking (GB-derived) writes "White Dot". |
| 36 | Radio Beacon | OP p.15, KBM, GB | C p.27 `sym_rbcn` = 37; R3 p.33 | B2O, FGT, GB |  |
| 37 | Boat Ramp | OP p.15, KBM, GB | C p.27 `sym_boat_ramp` = 150; R3 p.33 | FGT, GB |  |
| 38 | Campground | OP p.15, KBM, GB | C p.27 `sym_camp` = 151; R3 p.33 | B2O, FGT, GB |  |
| 39 | Restroom | OP p.15, KBM, GB | C p.27 `sym_restrooms` = 152; R3 p.33 | B2O, GB |  |
| 40 | Shower | OP p.16, KBM, GB | C p.27 `sym_showers` = 153; R3 p.33 | FGT, GB |  |
| 41 | Drinking Water | OP p.16, KBM, GB | C p.27 `sym_drinking_wtr` = 154; R3 p.33 | B2O, FGT, GB |  |
| 42 | Telephone | OP p.16, KBM, GB | C p.27 `sym_phone` = 155; R3 p.33 | B2O, FGT, GB |  |
| 43 | Medical Facility | OP p.16, KBM, GB | C p.27 `sym_1st_aid` = 156; R3 p.33 | FGT, GB |  |
| 44 | Information | OP p.16, KBM, GB | C p.27 `sym_info` = 157; R3 p.33 | B2O, FGT, GB |  |
| 45 | Parking Area | OP p.16, KBM, GB | C p.27 `sym_parking` = 158; R3 p.33 | GB only |  |
| 46 | Park | OP p.16, KBM, GB | C p.27 `sym_park` = 159; R3 p.33 | B2O, FGT, GB |  |
| 47 | Picnic Area | OP p.16, KBM, GB | C p.27 `sym_picnic` = 160; R3 p.33 | B2O, FGT, GB |  |
| 48 | Scenic Area | OP p.16, KBM, GB | C p.27 `sym_scenic` = 161; R3 p.33 | B2O, FGT, GB |  |
| 49 | Skiing Area | OP p.16, KBM, GB | C p.27 `sym_skiing` = 162; R3 p.33 | B2O, GB |  |
| 50 | Swimming Area | OP p.16, KBM, GB | C p.27 `sym_swimming` = 163; R3 p.33 | B2O, FGT, GB |  |
| 51 | Dam | OP p.16, KBM, GB | C p.27 `sym_dam` = 164; R3 p.33 | B2O, FGT, GB |  |
| 52 | Controlled Area | OP p.16, KBM, GB | C p.27 `sym_controlled` = 165; R3 p.33 | FGT, GB |  |
| 53 | Danger Area | OP p.16, KBM, GB | C p.27 `sym_danger` = 166; R3 p.33 | FGT, GB |  |
| 54 | Restricted Area | OP p.16, KBM, GB | C p.27 `sym_restricted` = 167; R3 p.33 | FGT, GB |  |
| 55 | Ball Park | OP p.16, KBM, GB | C p.27 `sym_ball` = 169; R3 p.33 | B2O, FGT, GB |  |
| 56 | Car | OP p.16, KBM, GB | C p.28 `sym_car` = 170; R3 p.34 | B2O, FGT, GB |  |
| 57 | Hunting Area | OP p.16, KBM, GB | C p.28 `sym_deer` = 171; R3 p.34 | FGT, GB |  |
| 58 | Shopping Center | OP p.16, KBM, GB | C p.28 `sym_shpng_cart` = 172; R3 p.34 | B2O, GB |  |
| 59 | Lodging | OP p.16, KBM, GB | C p.28 `sym_lodging` = 173; R3 p.34 | B2O, FGT, GB | GB also lists "Hotel" for this number; the first name is used, and B2O matches it. |
| 60 | Mine | OP p.16, KBM, GB | C p.28 `sym_mine` = 174; R3 p.34 | B2O, FGT, GB |  |
| 61 | Trail Head | OP p.16, KBM, GB | C p.28 `sym_trail_head` = 175; R3 p.34 | B2O, FGT, GB |  |
| 62 | Truck Stop | OP p.16, KBM, GB | C p.28 `sym_truck_stop` = 176; R3 p.34 | FGT, GB |  |
| 63 | Exit | OP p.16, KBM, GB | C p.28 `sym_user_exit` = 177; R3 p.34 | B2O, GB |  |
| 64 | Flag | OP p.16, KBM, GB | C p.28 `sym_flag` = 178; R3 p.34 | B2O, GB |  |
| 65 | Circle with X | OP p.16, KBM, GB | C p.28 `sym_circle_x` = 179; R3 p.34 | GB only |  |
| 66 | Mile Marker | OP p.16, KBM, GB | C p.28 `sym_mi_mrkr` = 8195; R3 p.34 | B2O, GB |  |
| 67 | TracBack Point | OP p.16, KBM, GB | C p.28 `sym_trcbck` = 8196; R3 p.34 | B2O, GB |  |
| 68 | Golf Course | OP p.16, KBM, GB | C p.28 `sym_golf` = 8197; R3 p.34 | B2O, FGT, GB |  |
| 69 | City (Small) | OP p.16, KBM, GB | C p.28 `sym_sml_cty` = 8198; R3 p.34 | B2O, GB | GB also lists "Small City" for this number; the first name is used, and B2O matches it. |
| 70 | City (Medium) | OP p.16, KBM, GB | C p.28 `sym_med_cty` = 8199; R3 p.34 | B2O, GB |  |
| 71 | City (Large) | OP p.16, KBM, GB | C p.28 `sym_lrg_cty` = 8200; R3 p.34 | B2O, GB |  |
| 72 | City (Capitol) | OP p.16, KBM, GB | C p.28 `sym_cap_cty` = 8203; R3 p.34 | B2O, GB |  |
| 73 | Amusement Park | OP p.16, KBM, GB | C p.28 `sym_amuse_pk` = 8204; R3 p.34 | B2O, FGT, GB |  |
| 74 | Bowling | OP p.16, KBM, GB | C p.28 `sym_bowling` = 8205; R3 p.34 | B2O, FGT, GB |  |
| 75 | Car Rental | OP p.16, KBM, GB | C p.28 `sym_car_rental` = 8206; R3 p.34 | B2O, FGT, GB |  |
| 76 | Car Repair | OP p.16, KBM, GB | C p.28 `sym_car_repair` = 8207; R3 p.34 | FGT, GB |  |
| 77 | Fast Food | OP p.16, KBM, GB | C p.28 `sym_fastfood` = 8208; R3 p.34 | B2O, FGT, GB |  |
| 78 | Fitness Center | OP p.16, KBM, GB | C p.28 `sym_fitness` = 8209; R3 p.34 | B2O, FGT, GB |  |
| 79 | Movie Theater | OP p.16, KBM, GB | C p.28 `sym_movie` = 8210; R3 p.34 | B2O, FGT, GB |  |
| 80 | Museum | OP p.16, KBM, GB | C p.28 `sym_museum` = 8211; R3 p.34 | B2O, FGT, GB |  |
| 81 | Pharmacy | OP p.16, KBM, GB | C p.28 `sym_pharmacy` = 8212; R3 p.34 | B2O, FGT, GB |  |
| 82 | Pizza | OP p.16, KBM, GB | C p.28 `sym_pizza` = 8213; R3 p.34 | B2O, FGT, GB |  |
| 83 | Post Office | OP p.16, KBM, GB | C p.28 `sym_post_ofc` = 8214; R3 p.34 | B2O, FGT, GB |  |
| 84 | RV Park | OP p.16, KBM, GB | C p.28 `sym_rv_park` = 8215; R3 p.34 | B2O, FGT, GB |  |
| 85 | School | OP p.16, KBM, GB | C p.28 `sym_school` = 8216; R3 p.34 | B2O, FGT, GB |  |
| 86 | Stadium | OP p.17, KBM, GB | C p.28 `sym_stadium` = 8217; R3 p.34 | B2O, FGT, GB |  |
| 87 | Department Store | OP p.17, KBM, GB | C p.28 `sym_store` = 8218; R3 p.34 | B2O, FGT, GB |  |
| 88 | Zoo | OP p.17, KBM, GB | C p.28 `sym_zoo` = 8219; R3 p.34 | B2O, FGT, GB |  |
| 89 | Convenience Store | OP p.17, KBM, GB | C p.28 `sym_gas_plus` = 8220; R3 p.34 | FGT, GB |  |
| 90 | Live Theater | OP p.17, KBM, GB | C p.29 `sym_faces` = 8221; R3 p.34 | B2O, GB |  |
| 91 | Scales | OP p.17, KBM, GB | C p.29 `sym_weigh_sttn` = 8226; R3 p.34 | FGT, GB |  |
| 92 | Toll Booth | OP p.17, KBM, GB | C p.29 `sym_toll_booth` = 8227; R3 p.34 | B2O, FGT, GB |  |
| 93 | Bridge | OP p.17, KBM, GB | C p.29 `sym_bridge` = 8233; R3 p.34 | B2O, FGT, GB |  |
| 94 | Building | OP p.17, KBM, GB | C p.29 `sym_building` = 8234; R3 p.34 | B2O, FGT, GB |  |
| 95 | Cemetery | OP p.17, KBM, GB | C p.29 `sym_cemetery` = 8235; R3 p.34 | B2O, FGT, GB |  |
| 96 | Church | OP p.17, KBM, GB | C p.29 `sym_church` = 8236; R3 p.34 | B2O, FGT, GB |  |
| 97 | Civil | OP p.17, KBM, GB | C p.29 `sym_civil` = 8237; R3 p.34 | B2O, FGT, GB |  |
| 98 | Crossing | OP p.17, KBM, GB | C p.29 `sym_crossing` = 8238; R3 p.34 | B2O, FGT, GB |  |
| 99 | Ghost Town | OP p.17, KBM, GB | C p.29 `sym_hist_town` = 8239; R3 p.34 | B2O, GB |  |
| 100 | Levee | OP p.17, KBM, GB | C p.29 `sym_levee` = 8240; R3 p.34 | B2O, GB |  |
| 101 | Military | OP p.17, KBM, GB | C p.29 `sym_military` = 8241; R3 p.34 | B2O, GB |  |
| 102 | Oil Field | OP p.17, KBM, GB | C p.29 `sym_oil_field` = 8242; R3 p.34 | B2O, FGT, GB |  |
| 103 | Tunnel | OP p.17, KBM, GB | C p.29 `sym_tunnel` = 8243; R3 p.34 | B2O, FGT, GB |  |
| 104 | Beach | OP p.17, KBM, GB | C p.29 `sym_beach` = 8244; R3 p.34 | B2O, FGT, GB |  |
| 105 | Forest | OP p.17, KBM, GB | C p.29 `sym_forest` = 8245; R3 p.34 | B2O, FGT, GB |  |
| 106 | Summit | OP p.17, KBM, GB | C p.29 `sym_summit` = 8246; R3 p.34 | B2O, FGT, GB |  |
| 107 | Airport | OP p.17, KBM, GB | C p.31 `sym_airport` = 16384; R3 p.35 | B2O, FGT, GB |  |
| 108 | Heliport | OP p.17, KBM, GB | C p.31 `sym_heliport` = 16388; R3 p.35 | B2O, GB |  |
| 109 | Private Field | OP p.17, KBM, GB | C p.31 `sym_private` = 16389; R3 p.35 | B2O, GB |  |
| 110 | Soft Field | OP p.17, KBM, GB | C p.31 `sym_soft_fld` = 16390; R3 p.35 | B2O, GB |  |
| 111 | Tall Tower | OP p.17, KBM, GB | C p.31 `sym_tall_tower` = 16391; R3 p.35 | B2O, FGT, GB |  |
| 112 | Short Tower | OP p.17, KBM, GB | C p.31 `sym_short_tower` = 16392; R3 p.35 | B2O, FGT, GB |  |
| 113 | Glider Area | OP p.17, KBM, GB | C p.31 `sym_glider` = 16393; R3 p.35 | FGT, GB |  |
| 114 | Ultralight Area | OP p.17, KBM, GB | C p.31 `sym_ultralight` = 16394; R3 p.35 | FGT, GB |  |
| 115 | Parachute Area | OP p.17, KBM, GB | C p.31 `sym_parachute` = 16395; R3 p.35 | GB only |  |
| 116 | Seaplane Base | OP p.17, KBM, GB | C p.31 `sym_seaplane` = 16402; R3 p.35 | GB only |  |
| 117 | Geocache | OP p.17, KBM, GB | C p.29 `sym_geocache` = 8255 | B2O, FGT, GB |  |
| 118 | Geocache Found | OP p.17, KBM, GB | C p.29 `sym_geocache_fnd` = 8256 | FGT, GB |  |
| 119 | Contact, Afro | OP p.17, KBM, GB | C p.29 `sym_cntct_afro` = 8262 | GB only |  |
| 120 | Contact, Alien | OP p.17, KBM, GB | C p.29 `sym_cntct_alien` = 8272 | GB only |  |
| 121 | Contact, Ball Cap | OP p.17, KBM, GB | C p.29 `sym_cntct_ball_cap` = 8258 | GB only |  |
| 122 | Contact, Big Ears | OP p.17, KBM, GB | C p.29 `sym_cntct_big_ears` = 8259 | GB only |  |
| 123 | Contact, Biker | OP p.17, KBM, GB | C p.29 `sym_cntct_biker` = 8271 | GB only |  |
| 124 | Contact, Bug | OP p.17, KBM, GB | C p.29 `sym_cntct_bug` = 8273 | GB only |  |
| 125 | Contact, Cat | OP p.17, KBM, GB | C p.29 `sym_cntct_cat` = 8274 | GB only |  |
| 126 | Contact, Dog | OP p.17, KBM, GB | C p.29 `sym_cntct_dog` = 8275 | GB only |  |
| 127 | Contact, Dreadlocks | OP p.17, KBM, GB | C p.29 `sym_cntct_dreads` = 8263 | GB only |  |
| 128 | Contact, Female1 | OP p.17, KBM, GB | C p.29 `sym_cntct_female1` = 8264 | GB only |  |
| 129 | Contact, Female2 | OP p.17, KBM, GB | C p.29 `sym_cntct_female2` = 8265 | GB only |  |
| 130 | Contact, Female3 | OP p.17, KBM, GB | C p.29 `sym_cntct_female3` = 8266 | GB only |  |
| 131 | Contact, Goatee | OP p.17, KBM, GB | C p.29 `sym_cntct_goatee` = 8261 | GB only |  |
| 132 | Contact, Kung-Fu | OP p.18, KBM, GB | C p.29 `sym_cntct_kung_fu` = 8268 | GB only |  |
| 133 | Contact, Pig | OP p.18, KBM, GB | C p.29 `sym_cntct_pig` = 8276 | GB only |  |
| 134 | Contact, Pirate | OP p.18, KBM, GB | C p.29 `sym_cntct_pirate` = 8270 | GB only |  |
| 135 | Contact, Ranger | OP p.18, KBM, GB | C p.29 `sym_cntct_ranger` = 8267 | GB only |  |
| 136 | Contact, Smiley | OP p.18, KBM, GB | C p.29 `sym_cntct_smiley` = 8257 | GB only |  |
| 137 | Contact, Spike | OP p.18, KBM, GB | C p.29 `sym_cntct_spike` = 8260 | GB only |  |
| 138 | Contact, Sumo | OP p.18, KBM, GB | C p.29 `sym_cntct_sumo` = 8269 | GB only |  |
| 139 | Water Hydrant | OP p.18, KBM, GB | C p.29 `sym_hydrant` = 8282 | B2O, GB |  |
| 140 | Flag, Red | OP p.18, KBM, GB | C p.29 `sym_flag_red` = 8286 | B2O-fam, GB |  |
| 141 | Flag, Blue | OP p.18, KBM, GB | C p.29 `sym_flag_blue` = 8284 | B2O, GF, GB |  |
| 142 | Flag, Green | OP p.18, KBM, GB | C p.29 `sym_flag_green` = 8285 | B2O-fam, GB |  |
| 143 | Pin, Red | OP p.18, KBM, GB | C p.29 `sym_pin_red` = 8289 | B2O-fam, GB |  |
| 144 | Pin, Blue | OP p.18, KBM, GB | C p.29 `sym_pin_blue` = 8287 | B2O, GB |  |
| 145 | Pin, Green | OP p.18, KBM, GB | C p.29 `sym_pin_green` = 8288 | B2O-fam, GB |  |
| 146 | Block, Red | OP p.18, KBM, GB | C p.30 `sym_block_red` = 8292 | B2O-fam, GB |  |
| 147 | Block, Blue | OP p.18, KBM, GB | C p.29 `sym_block_blue` = 8290 | B2O-fam, GB |  |
| 148 | Block, Green | OP p.18, KBM, GB | C p.29 `sym_block_green` = 8291 | B2O-fam, GB |  |
| 149 | Bike Trail | OP p.18, KBM, GB | C p.30 `sym_bike_trail` = 8293 | B2O, FGT, GB |  |
| 150 | Fishing Hot Spot Facility | OP p.18, KBM, GB | C p.28 `sym_fhs_facility` = 181 | GB only |  |
| 151 | Police Station | OP p.18, KBM, GB | C p.29 `sym_badge` = 8249; R3 p.34 | B2O, FGT, GB |  |
| 152 | Ski Resort | OP p.18, KBM, GB | C p.29 `sym_snowski` = 8251; R3 p.35 | B2O, FGT, GB |  |
| 153 | Ice Skating | OP p.18, KBM, GB | C p.29 `sym_iceskate` = 8252; R3 p.35 | B2O, GB |  |
| 154 | Wrecker | OP p.18, KBM, GB | C p.29 `sym_wrecker` = 8253; R3 p.35 | B2O, GB |  |
| 155 | Anchor Prohibited | OP p.18, KBM, GB | C p.28 `sym_anchor_prohib` = 184 | GB only |  |
| 156 | Beacon | OP p.18, KBM, GB | C p.28 `sym_beacon` = 185 | B2O, GB |  |
| 157 | Coast Guard | OP p.18, KBM, GB | C p.28 `sym_coast_guard` = 186 | B2O, GB |  |
| 158 | Reef | OP p.18, KBM, GB | C p.28 `sym_reef` = 187 | GB only |  |
| 159 | Weed Bed | OP p.18, KBM, GB | C p.28 `sym_weedbed` = 188 | B2O, GB |  |
| 160 | Dropoff | OP p.18, KBM, GB | C p.28 `sym_dropoff` = 189 | B2O, GB |  |
| 161 | Dock | OP p.18, KBM, GB | C p.28 `sym_dock` = 190 | B2O, GB |  |
| 162 | Marina | OP p.18, KBM, GB | C p.28 `sym_marina` = 191 | B2O, GB | Distinct from GDB 0 (Anchor): Garmin lists both a white anchor (device 0) and a marina symbol (device 191). |
| 163 | Bait and Tackle | OP p.18, KBM, GB | C p.28 `sym_bait_tackle` = 192 | GB only |  |
| 164 | Stump | OP p.18, KBM, GB | C p.28 `sym_stump` = 193 | B2O, GB |  |
| 165 | Circle, Red | OP p.18, KBM, GB | C p.30 `sym_circle_red` = 8294 | B2O-fam, GB |  |
| 166 | Circle, Green | OP p.18, KBM, GB | C p.30 `sym_circle_green` = 8295 | B2O-fam, GB |  |
| 167 | Circle, Blue | OP p.18, KBM, GB | C p.30 `sym_circle_blue` = 8296 | B2O-fam, GB |  |
| 168 | Diamond, Blue | OP p.18, KBM, GB | C p.30 `sym_diamond_blue` = 8299 | GB only | Word order is a GUESS, as for 2. |
| 169 | Oval, Red | OP p.18, KBM, GB | C p.30 `sym_oval_red` = 8300 | GB only |  |
| 170 | Oval, Green | OP p.18, KBM, GB | C p.30 `sym_oval_green` = 8301 | GB only |  |
| 171 | Oval, Blue | OP p.18, KBM, GB | C p.30 `sym_oval_blue` = 8302 | B2O, GB |  |
| 172 | Rectangle, Red | OP p.18, KBM, GB | C p.30 `sym_rect_red` = 8303 | GB only |  |
| 173 | Rectangle, Green | OP p.18, KBM, GB | C p.30 `sym_rect_green` = 8304 | GB only |  |
| 174 | Rectangle, Blue | OP p.18, KBM, GB | C p.30 `sym_rect_blue` = 8305 | GB only |  |
| 175 | Square, Blue | OP p.18, KBM, GB | C p.30 `sym_square_blue` = 8308 | B2O-fam, GB |  |
| 176 | Letter A, Red | OP p.18, KBM, GB | C p.30 `sym_letter_a_red` = 8309 | B2O-fam, GB |  |
| 177 | Letter A, Green | OP p.18, KBM, GB | C p.30 `sym_letter_a_green` = 8313 | B2O-fam, GB |  |
| 178 | Letter A, Blue | OP p.19, KBM, GB | C p.30 `sym_letter_a_blue` = 8317 | B2O-fam, GB |  |
| 179 | Letter B, Red | OP p.19, KBM, GB | C p.30 `sym_letter_b_red` = 8310 | B2O-fam, GB |  |
| 180 | Letter B, Green | OP p.19, KBM, GB | C p.30 `sym_letter_b_green` = 8315 | B2O-fam, GB |  |
| 181 | Letter B, Blue | OP p.19, KBM, GB | C p.30 `sym_letter_b_blue` = 8318 | B2O-fam, GB |  |
| 182 | Letter C, Red | OP p.19, KBM, GB | C p.30 `sym_letter_c_red` = 8311 | B2O-fam, GB |  |
| 183 | Letter C, Green | OP p.19, KBM, GB | C p.30 `sym_letter_c_green` = 8314 | B2O-fam, GB |  |
| 184 | Letter C, Blue | OP p.19, KBM, GB | C p.30 `sym_letter_c_blue` = 8319 | B2O-fam, GB |  |
| 185 | Letter D, Red | OP p.19, KBM, GB | C p.30 `sym_letter_d_red` = 8312 | B2O-fam, GB |  |
| 186 | Letter D, Green | OP p.19, KBM, GB | C p.30 `sym_letter_d_green` = 8316 | B2O-fam, GB |  |
| 187 | Letter D, Blue | OP p.19, KBM, GB | C p.30 `sym_letter_d_blue` = 8320 | B2O-fam, GB |  |
| 188 | Number 0, Red | OP p.19, KBM, GB | C p.30 `sym_number_0_red` = 8321 | B2O-fam, GB |  |
| 189 | Number 0, Green | OP p.19, KBM, GB | C p.30 `sym_number_0_green` = 8331 | B2O-fam, GB |  |
| 190 | Number 0, Blue | OP p.19, KBM, GB | C p.30 `sym_number_0_blue` = 8341 | B2O-fam, GB |  |
| 191 | Number 1, Red | OP p.19, KBM, GB | C p.30 `sym_number_1_red` = 8322 | B2O-fam, GB |  |
| 192 | Number 1, Green | OP p.19, KBM, GB | C p.30 `sym_number_1_green` = 8332 | B2O-fam, GB |  |
| 193 | Number 1, Blue | OP p.19, KBM, GB | C p.30 `sym_number_1_blue` = 8342 | B2O-fam, GB |  |
| 194 | Number 2, Red | OP p.19, KBM, GB | C p.30 `sym_number_2_red` = 8323 | B2O-fam, GB |  |
| 195 | Number 2, Green | OP p.19, KBM, GB | C p.30 `sym_number_2_green` = 8333 | B2O-fam, GB |  |
| 196 | Number 2, Blue | OP p.19, KBM, GB | C p.30 `sym_number_2_blue` = 8343 | B2O-fam, GB |  |
| 197 | Number 3, Red | OP p.19, KBM, GB | C p.30 `sym_number_3_red` = 8324 | B2O-fam, GB |  |
| 198 | Number 3, Green | OP p.19, KBM, GB | C p.30 `sym_number_3_green` = 8334 | B2O-fam, GB |  |
| 199 | Number 3, Blue | OP p.19, KBM, GB | C p.30 `sym_number_3_blue` = 8344 | B2O-fam, GB |  |
| 200 | Number 4, Red | OP p.19, KBM, GB | C p.30 `sym_number_4_red` = 8325 | B2O-fam, GB |  |
| 201 | Number 4, Green | OP p.19, KBM, GB | C p.30 `sym_number_4_green` = 8335 | B2O-fam, GB |  |
| 202 | Number 4, Blue | OP p.19, KBM, GB | C p.30 `sym_number_4_blue` = 8345 | B2O-fam, GB |  |
| 203 | Number 5, Red | OP p.19, KBM, GB | C p.30 `sym_number_5_red` = 8326 | B2O-fam, GB |  |
| 204 | Number 5, Green | OP p.19, KBM, GB | C p.30 `sym_number_5_green` = 8336 | B2O-fam, GB |  |
| 205 | Number 5, Blue | OP p.19, KBM, GB | C p.30 `sym_number_5_blue` = 8346 | B2O-fam, GB |  |
| 206 | Number 6, Red | OP p.19, KBM, GB | C p.30 `sym_number_6_red` = 8327 | B2O-fam, GB |  |
| 207 | Number 6, Green | OP p.19, KBM, GB | C p.30 `sym_number_6_green` = 8337 | B2O-fam, GB |  |
| 208 | Number 6, Blue | OP p.19, KBM, GB | C p.30 `sym_number_6_blue` = 8347 | B2O-fam, GB |  |
| 209 | Number 7, Red | OP p.19, KBM, GB | C p.30 `sym_number_7_red` = 8328 | B2O-fam, GB |  |
| 210 | Number 7, Green | OP p.19, KBM, GB | C p.30 `sym_number_7_green` = 8338 | B2O-fam, GB |  |
| 211 | Number 7, Blue | OP p.19, KBM, GB | C p.30 `sym_number_7_blue` = 8348 | B2O-fam, GB |  |
| 212 | Number 8, Red | OP p.19, KBM, GB | C p.30 `sym_number_8_red` = 8329 | B2O-fam, GB |  |
| 213 | Number 8, Green | OP p.19, KBM, GB | C p.30 `sym_number_8_green` = 8339 | B2O-fam, GB |  |
| 214 | Number 8, Blue | OP p.19, KBM, GB | C p.30 `sym_number_8_blue` = 8349 | B2O-fam, GB |  |
| 215 | Number 9, Red | OP p.19, KBM, GB | C p.30 `sym_number_9_red` = 8330 | B2O-fam, GB |  |
| 216 | Number 9, Green | OP p.19, KBM, GB | C p.30 `sym_number_9_green` = 8340 | B2O-fam, GB |  |
| 217 | Number 9, Blue | OP p.19, KBM, GB | C p.30 `sym_number_9_blue` = 8350 | B2O-fam, GB |  |
| 218 | Triangle, Blue | OP p.19, KBM, GB | C p.30 `sym_triangle_blue` = 8351 | GB only |  |
| 219 | Triangle, Green | OP p.19, KBM, GB | C p.30 `sym_triangle_green` = 8352 | GB only |  |
| 220 | Triangle, Red | OP p.19, KBM, GB | C p.30 `sym_triangle_red` = 8353 | B2O, GB |  |
| 221 | Contact, Blonde | OP p.19, KBM, GB | — | GB only |  |
| 222 | Contact, Clown | OP p.19, KBM, GB | — | GB only |  |
| 223 | Contact, Glasses | OP p.19, KBM, GB | — | GB only |  |
| 224 | Contact, Panda | OP p.20, KBM, GB | — | GB only |  |
| 225 | Multi-Cache | OP p.20, KBM, GB | — | GB only |  |
| 226 | Letterbox Cache | OP p.20, KBM, GB | — | GB only |  |
| 227 | Puzzle Cache | OP p.20, KBM, GB | — | B2O, GB |  |
| 228 | Library | OP p.20, KBM, GB | — | B2O, GB |  |
| 229 | Ground Transportation | OP p.20, KBM, GB | — | B2O, FGT, GB | |
| 230 | City Hall | OP p.20, KBM, GB | — | B2O, GB |  |
| 231 | Winery | OP p.20, KBM, GB | — | B2O, GB |  |
| 232 | ATV | OP p.20, KBM, GB | — | GB only |  |
| 233 | Big Game | OP p.20, KBM, GB | — | GB only |  |
| 234 | Blind | OP p.20, KBM, GB | — | GB only |  |
| 235 | Blood Trail | OP p.20, KBM, GB | — | GB only |  |
| 236 | Cover | OP p.20, KBM, GB | — | GB only |  |
| 237 | Covey | OP p.20, KBM, GB | — | GB only |  |
| 238 | Food Source | OP p.20, KBM, GB | — | GB only |  |
| 239 | Furbearer | OP p.20, KBM, GB | — | GB only |  |
| 240 | Lodge | OP p.20, KBM, GB | — | B2O, GB |  |
| 241 | Small Game | OP p.20, KBM, GB | — | GB only |  |
| 242 | Animal Tracks | OP p.20, KBM, GB | — | GB only |  |
| 243 | Treed Quarry | OP p.20, KBM, GB | — | GB only |  |
| 244 | Tree Stand | OP p.20, KBM, GB | — | GB only |  |
| 245 | Truck | OP p.20, KBM, GB | — | GB only |  |
| 246 | Upland Game | OP p.20, KBM, GB | — | GB only |  |
| 247 | Waterfowl | OP p.20, KBM, GB | — | GB only |  |
| 248 | Water Source | OP p.20, KBM, GB | — | B2O, GB |  |
| 249 | Dog Running | GB only (PROVISIONAL) | — | GB only | In GB's "BaseCamp 4.8.13" block; number from GB alone. |
| 250 | Dog Pointing | GB only (PROVISIONAL) | — | GB only | In GB's "BaseCamp 4.8.13" block; number from GB alone. |
| 251 | Dog Treed | GB only (PROVISIONAL) | — | GB only | In GB's "BaseCamp 4.8.13" block; number from GB alone. |
| 252 | Dog Sitting | GB only (PROVISIONAL) | — | GB only | In GB's "BaseCamp 4.8.13" block; number from GB alone. |
| 253 | Dog Unknown | GB only (PROVISIONAL) | — | GB only | In GB's "BaseCamp 4.8.13" block; number from GB alone. |
| 254 | Bank, Euro | GB only (PROVISIONAL) | — | B2O, GB | In GB's "BaseCamp 4.8.13" block; number from GB alone. |
| 255 | Bank, Pound | GB only (PROVISIONAL) | — | B2O, GB | In GB's "BaseCamp 4.8.13" block; number from GB alone. |
| 256 | Bank, Yen | GB only (PROVISIONAL) | — | B2O, GB | In GB's "BaseCamp 4.8.13" block; number from GB alone. |
| 257 | Sad Face | GB only (PROVISIONAL) | — | GB only | In GB's "BaseCamp 4.8.13" block; number from GB alone. |
| 258 | Favorite | GB only (PROVISIONAL) | — | GB only | In GB's "BaseCamp 4.8.13" block; number from GB alone. |
| 259 | Ferry | GB only (PROVISIONAL) | — | B2O, GB | In GB's "BaseCamp 4.8.13" block; number from GB alone. |
| 260 | Funicular | GB only (PROVISIONAL) | — | B2O, GB | In GB's "BaseCamp 4.8.13" block; number from GB alone. |
| 261 | Railway | GB only (PROVISIONAL) | — | B2O, GB | In GB's "BaseCamp 4.8.13" block; number from GB alone. |
| 262 | Parking, Pay | GB only (PROVISIONAL) | — | B2O, GB | In GB's "BaseCamp 4.8.13" block; number from GB alone. |
| 263 | Parking, Euro | GB only (PROVISIONAL) | — | B2O, GB | In GB's "BaseCamp 4.8.13" block; number from GB alone. |
| 264 | Parking, Euro Pay | GB only (PROVISIONAL) | — | GB only | In GB's "BaseCamp 4.8.13" block; number from GB alone. |
| 265 | Hospital, Euro | GB only (PROVISIONAL) | — | GB only | In GB's "BaseCamp 4.8.13" block; number from GB alone. |
