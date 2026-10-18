# What Foldertrail converts, and what it doesn't

Foldertrail turns your BaseCamp library into **GPX files**, laid out in the same folders and lists you built in
BaseCamp. GPX is a plain, widely read file format for waypoints, tracks and routes; most map apps and Garmin's
own tools open it. This page says exactly what comes across, what changes on the way, and what is left behind.
The report in your download says the same things about *your* library, item by item.

## What you get

One ZIP file, named like `Foldertrail export 2026-10-06.zip`. Double-click it in Finder to open it. Inside:

- **GPX/My Collection/…/\<list\>.gpx**: one GPX file for each of your BaseCamp lists, inside folders named like
  your folders. (GPX files can't hold folders, so your folders become folders of files on your Mac.)
- **GPX/All items.gpx**: everything that converted, in one file.
- **GPX/Not in any list.gpx**: items that were in no list, if there are any.
- **GPX/_Duplicate names/**: items whose list could not be decided (explained below), if there are any.
- **KML/My Collection.kml**: your whole folder tree in one file, for Google Earth and other apps that read
  KML. Optional; tick the KML box before downloading.
- **report.html** and **report.txt**: what converted, what didn't, and why, by name.
- **READ-ME-FIRST.txt**: a short note on what each file is.

If you tick **One GPX file per item** before downloading, each list becomes a folder holding one GPX file per
waypoint, track or route instead.

## What converts

**Waypoints.** Name, position, your notes (BaseCamp's comment) and the symbol. Elevation and time come across
when they read cleanly. Waypoint icons are carried over where Foldertrail knows the icon; an icon it doesn't
know is left off, and the waypoint is still converted. **Not exported:** addresses, phone numbers and
categories.

**Tracks.** The positions of every point, plus elevation and time when the track's elevation-and-time file
(in BaseCamp's TrackSegments folder) reads cleanly. **Heart rate and air temperature** recorded with a track are
kept too: they go into the GPX files in Garmin's published extension for them (TrackPointExtension), next to
each point's elevation and time. The KML file holds positions, elevations and times only. **Not exported:** other
sensor readings, such as cadence; a track that holds one keeps its positions, and the report says why. A track
whose record doesn't match a known layout is not converted, so its points can't be read safely; the report
names it.

**Routes.** Routes are converted as straight lines through their via points. A GPS device can work out the
roads again when you navigate the route. **Three kinds of route are not converted** and are listed by name
instead, with the lists they were in:

- a route that follows roads (BaseCamp calculated it); road-following routes are not converted in this version;
- a route where one or more of its via points could not be found in the library;
- a route whose record could not be decoded.

Route settings such as avoidances and activity profiles are not carried over.

**Folders and lists.** Each list becomes one GPX file; each folder becomes a folder on disk; the KML file keeps
the whole tree inside one file.

## What is not converted at all

BirdsEye imagery, custom maps, Adventures, geocache logs and photos. When Foldertrail finds some of these in
your library it counts them and says so in the preview and the report, but it does not convert them.

## Special cases you may meet

**An item in several lists.** It is written into each of those lists' files, and the report counts how many
items that was. So if you import several lists into an app, you get several copies. To avoid that, import one
list at a time, or import `All items.gpx` once.

**Items in no list.** They go into `Not in any list.gpx`.

**Smart lists.** BaseCamp's smart lists, such as "Last Week" and "Last Month", are filled by BaseCamp itself from
your other items, so they are not saved as lists of their own. Their items are still saved, in your own lists (or
in `Not in any list.gpx`), and the report says that smart lists were left out.

**Duplicate names.** BaseCamp's lists point to items by name. When your library holds two or more items of the
same kind with the same name (two tracks both called "Ridge walk", say), Foldertrail can't tell which copy a
list meant. It does not guess: every copy goes into the `_Duplicate names` folder, and the report names the
lists that referred to them. You can put them back in their lists by hand in the app you import into.

**No folder file.** Your folders and lists are kept in a file called FolderData.gfi next to AllData.gdb. If it
is missing (for example because only AllData.gdb was given), Foldertrail cannot rebuild your tree and says so
loudly. The items are then grouped by type: `Waypoints.gpx`, `Tracks.gpx` and `Routes.gpx`. Foldertrail never
invents a tree.

**Odd text.** A folder or list name longer than 255 characters is shortened and ends in "…". Names or notes
that weren't stored as standard text are read as Western (Windows-1252) text, and the report asks you to check
accented letters. Elevations, times, heart rates or temperatures with impossible values are left out; the points
themselves are kept.

## Which libraries it is built for

Foldertrail was written for BaseCamp's library file format version 1.88, which a public description of the
format says BaseCamp 4.4.1 to 4.7.5 write. BaseCamp for Mac 4.8.13 writes the same format with a few
Mac-specific additions, and Foldertrail reads them: this was checked against real libraries made in BaseCamp 4.8.13
for Mac (filled with made-up places and names). Libraries from Windows BaseCamp are expected to work the same way, but
have not yet been checked against a real one. A library in another format version is read as "experimental",
and the preview and report say so. A few very old formats are refused.

That is why the preview is free: it shows your whole tree, the counts, and everything that won't convert, so
you can compare it with BaseCamp (if it still opens) or with what you remember before you decide to pay. The
download is not on sale yet.

How Foldertrail reads BaseCamp's files was worked out from public notes, not from Garmin. Check important items
against BaseCamp.

## Sources

- Foldertrail's own code and report text: `src/export/report.js` (the reasons and the "Limits of this version"
  list), `src/app/pipeline.js` (the files in the download), `src/format/library.js` (the notes from reading).
- Herbert Oppmann, "Garmin MapSource (MPS), GPS Database (GDB) and Folder and Item (GFI) File Format" (2024):
  version table, BaseCamp 4.4.1–4.7.5 write file-format version 1.88 — *recorded in docs/research, not re-read
  today.*

---

Foldertrail is an independent tool, not affiliated with, endorsed by, or sponsored by Garmin Ltd. or its
subsidiaries. Garmin and BaseCamp are trademarks of Garmin Ltd. or its subsidiaries.
