# Troubleshooting, and the diagnostic report

Most problems come down to one of three things: the page was given the wrong thing, the browser is too old, or
the preview doesn't match what you remember from BaseCamp. This page takes them in turn, then explains the
diagnostic report: what it holds, what it never holds, and how to share it.

A note before anything else: Foldertrail has been checked against real libraries made in BaseCamp 4.8.13 for Mac, but yours may hold something we haven't seen yet. If the preview looks wrong, that is worth knowing about, and the diagnostic report is how you can tell us
without sharing anything private.

## The page won't take my library

The messages below are the ones the page shows, with what to do about each.

**"No BaseCamp library was found in what you chose."** The page needs the library itself: on a Mac, the folder
named with a version number (such as 4.8) inside `~/Library/Application Support/Garmin/BaseCamp/Database`, or a
`.Backup` file made with File › Backup in BaseCamp. [Where is my BaseCamp library?](01-where-is-my-library.md)
shows how to find it.

**"A .gdb file that is not a library's AllData.gdb was given"** or **"GPX files were given."** Files exported
from BaseCamp (File › Export) hold your items but not your folders and lists, so there is no tree to rebuild.
Give the library folder or a backup instead.

**"FolderData.gfi was not found next to AllData.gdb."** Your items will be exported without folders, grouped by
type. Usually this means only AllData.gdb was dragged. Drag the whole version folder (for example 4.8).

**"The folder that holds track elevation and time (TrackSegments) wasn't found next to AllData.gdb."** Tracks
keep their shape but lose elevation and time. Again, drag the whole version folder.

**"Your browser handed over the .bclibrary package as a single file it cannot open."** In Finder, right-click
the package, choose Show Package Contents, and drag the folder inside onto the page.

**"Your browser could not open something you dropped."** If it was a folder, use the Choose folder button
instead, or give a `.Backup` file.

**"The folder holds a backup file (.Backup or .zip) but no library."** Drop the backup file on its own.

**"The file is not a BaseCamp backup"**, **"The backup file is damaged"**, or **"The backup file is
incomplete: it ends early."** Make the backup again in BaseCamp, or copy it again if it was copied from
another disk.

**"This browser cannot unzip backups."** Double-click the backup in Finder (if Finder won't open it, rename it
so it ends in `.zip` first), then drag the folder that appears onto the page.

**"A file inside the backup is too large to read in this browser."** Unzip the backup in Finder the same way
and drop the folder that appears.

**"A file could not be read. It may have been moved or changed while this page was open."** Give the library
again, and don't open BaseCamp while the page is reading.

**"AllData.gdb is larger than 1 GB."** That is more than Foldertrail can read in a browser tab, and nothing is
converted. There is no workaround in this version.

**"AllData.gdb is in a library format version this tool cannot read."** A very old or unusual library. If
instead the page says the library is read as *experimental*, it is a format version Foldertrail wasn't built
for; the preview still shows what it found, but check it carefully.

**"Some signs suggest this library was copied from a Windows PC."** Windows libraries should work the same way,
but that has not been checked yet; the report says if anything could not be read.

## The browser

**"This browser can't run Foldertrail."** Use a current version of Safari, Chrome or Firefox on your Mac. On
macOS 10.13 or 10.14, Safari can't be updated far enough: use a current Chrome or Firefox there.

**Chrome asks "Upload N files to this site?"** when you choose a folder. That is Chrome's wording for letting
the page read the files. They stay on your Mac; nothing is uploaded.

**It is slow.** Reading happens inside the browser tab, on your computer. A large library can take a minute
or two. Leave the tab open and in front.

**On a phone or tablet** the page can't help, because your library is on your computer.

## The preview doesn't match BaseCamp

**Fewer items than BaseCamp shows.** The summary sentence says how many items can't be converted, and the
section "What will not convert" names them with the reason. [What Foldertrail converts, and what it
doesn't](03-what-converts-and-what-doesnt.md) explains each reason.

**An item isn't in the list I put it in.** Two things can cause this. If another item of the same kind has the
same name, both copies are in the `_Duplicate names` folder, and the report names the lists that referred to
them. If the item was in no list, it is in `Not in any list.gpx`.

**No folders at all.** The folder file (FolderData.gfi) was not found or could not be read. See above.

**A track has no elevation or time.** Under "Notes from reading", the page says why: its elevation-and-time
file was missing, didn't match, held sensor data this version can't read, or couldn't be read. The track's
positions are kept.

**Routes are straight lines.** That is by design in this version. Routes that BaseCamp calculated along roads
aren't converted; they are named in "What will not convert".

**Accented letters look wrong.** Some names weren't stored as standard text and were read as Western
(Windows-1252) text. The report says so; check those items.

## Two different reports

Don't mix these up:

- **The conversion report** (`report.html` and `report.txt` in your download, also shown on the page after a
  download). It names your items and lists, because it is yours: it is made on your computer, stays in your
  download, and is never sent anywhere. Share it only if you want to.
- **The diagnostic report** (on the converter page, under the preview, the result or an error message). It
  describes only the *structure* of your library files. It is the one to share if you need help.

## The diagnostic report

If something looks wrong, the converter page offers a diagnostic report. It is made from an allow-list: only
numbers Foldertrail computed, yes/no answers, and words from fixed tables in the code. Foldertrail's own tests
plant made-up names, places, times and identifiers in test libraries and check that none of them reach the
report.

**What it holds**

- Foldertrail's version, and your browser's engine family and major version (not the full browser string).
- What you gave: a folder, a ZIP (backup) or a package, and which library files were found, with their sizes.
- For each file: its signature (the few bytes that identify a BaseCamp file), its format version numbers,
  whether its header could be read and whether it was read to the end.
- Record counts and lengths; which known layout each kind of record matched; and problems in fixed words, such
  as "the record ended too soon".
- The shape of your folder tree as numbers: how many folders and lists, the deepest level, how many items per
  list, references that point nowhere.
- TrackSegments: how many files, their sizes, and their point counts.

**What it never holds**

Names of anything, notes, places or coordinates, times, identifiers, file names or paths, or the maker and date
strings inside the files. Nothing from it could tell someone where you have been.

**How to use it**

1. On the converter page, scroll to **Diagnostic report**. Click **Show it** to read it first, if you like.
2. Click **Copy diagnostic report**. If your browser blocks copying, the page selects the text for you; press
   ⌘C (or Ctrl+C) to copy it.
3. Paste it into a message. Foldertrail never sends it: you decide whether and to whom.

A support address will be listed on the page and in the FAQ when Foldertrail goes on sale. Until then, keep the
report; it will still be useful.

## Sources

- The messages and behavior above are taken from Foldertrail's code: `src/app/intake.js` (the messages when
  the page is given something), `src/format/library.js` (the notes from reading), `src/app/ui.js` (the preview
  wording), `site/app/index.html` (the page), `src/format/dump.js` and `docs/ARCHITECTURE.md` §11 (the
  diagnostic report), `test/dump.test.js` (the planted-name test).

---

Foldertrail is an independent tool, not affiliated with, endorsed by, or sponsored by Garmin Ltd. or its
subsidiaries. Garmin and BaseCamp are trademarks of Garmin Ltd. or its subsidiaries.
