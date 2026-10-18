# Real BaseCamp output with made-up content

Libraries written by Garmin BaseCamp for Mac 4.8.13 (program version 408, format 1.88) on the maintainer's Mac, holding
ONLY made-up content from tools/gate1 (names start with "Gate1", places are in the ocean or desert). They are the
ground truth for the Mac layouts (Gate 1, decisions B3/B4). Do not add a library with real places or names here.

- run1-gate1/: the maintainer's first Gate 1 run (2026-10-07). The lists ended up as one import list "gate1-ocean"
  plus BaseCamp's own "Last Week", "Last Month" and "Unlisted Data"; BaseCamp renamed the second twin track
  "Gate1 Twin Track 001"; no address was typed by hand.
- run2-structured/ (2026-10-07, built in BaseCamp 4.8.13 via screen control, on top of run1):
  - Tree: My Collection > [Last Week, Last Month (smart lists), Gate1 Trips (list folder) > [gate1-ocean (import list,
    all 15 items), Gate1 Desert (user list), Gate1 Inner (list folder) > [Gate1 Deep (user list)]], Unlisted Data].
  - Items in TWO lists (dragging in BaseCamp adds a reference, it does not move): Gate1 Waypoint Alpha and Gate1 Track
    Timed are in gate1-ocean AND Gate1 Desert; Gate1 Route Four and Gate1 Track Two Segments are in gate1-ocean AND
    Gate1 Deep.
  - Gate1 Waypoint Delta has a hand-typed address: street "12 Gate1 Typed Lane", city "Gate1 Typed Town", state
    "Gate1 Typed State", country "Gate1 Typed Land", postal code "G1-0002", phone "555-0102".
  - BaseCamp also wrote AllData.gdb.bak and FolderData.gfi.bak next to the live files (the reader must ignore them).
- run2-exports/: BaseCamp's own exports of the "Gate1 Trips" folder after run2 (GPX v1.1, KML 2.2, GDB) and a
  File > Backup (BaseCamp_261007.Backup). FINDING: none of BaseCamp's exports contain any list or folder name — the KML
  groups only by Waypoints / Routes / Tracks — so BaseCamp itself cannot carry the user's tree out (kill-risk check).
