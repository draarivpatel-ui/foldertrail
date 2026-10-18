# Make a BaseCamp backup first

Foldertrail only **reads** your library. It never changes it, and it never uploads it. So a backup is not
something Foldertrail needs from you; it is plain good sense. Years of waypoints and tracks deserve a second
copy before you do anything with them, in case a disk fails, a file gets deleted by mistake, or a macOS update
goes wrong.

There are two ways to make the copy. If you can, do both.

## If BaseCamp still opens: File › Backup

1. Open BaseCamp.
2. In the menu bar, choose **File › Backup**.
3. Choose where to save the file and click Save. The file's name ends in **.Backup**. Save it somewhere you
   will find again, such as your Desktop, and then copy it onto an external drive as well.

BaseCamp's manual has a section on backing up and one on restoring a backup; the manual says a backup holds all
your data, lists and folders. A `.Backup` file is one single file, so it is easy to keep safe. Inside, it is a
compressed copy of the library folder (a ZIP file, in computer terms). It can be big: for a library with many
tracks, hundreds of megabytes or several gigabytes, so give it a minute and don't save it to a nearly full
disk.

You can drop that `.Backup` file straight onto the Foldertrail page. Nothing needs renaming or unzipping.

**One thing to know about restoring.** Garmin forum users have reported that when BaseCamp for Mac restores a
backup, it does not put back the TrackSegments files, which hold the elevation and time of your tracks. We have
not tested this ourselves. It does not affect Foldertrail, which reads the backup file directly and never
restores anything. But it is a reason to also keep a plain copy of the folder, below.

## If BaseCamp no longer opens, or as a second copy: copy the folder

1. Quit BaseCamp if it is running (BaseCamp › Quit BaseCamp).
2. Find your library folder: [Where is my BaseCamp library?](01-where-is-my-library.md) shows how to open
   `~/Library/Application Support/Garmin/BaseCamp/Database` in Finder.
3. Go up one level, so you can see the **Database** folder itself (in Finder, choose **Go › Enclosing
   Folder**, or press ⌘ and the up arrow).
4. Right-click (or hold Control and click) the **Database** folder and choose **Copy "Database"**.
5. Open your external drive, or a folder somewhere else, and choose **Edit › Paste Item**. Finder copies the
   whole folder. A large library takes a while.
6. Check the copy: inside **Database** there should be a version folder such as **4.8**, and inside that,
   **AllData.gdb**, **FolderData.gfi** and a **TrackSegments** folder.

Copying the whole **BaseCamp** folder (one level up again) is fine too, and a bit more complete.

## Then leave the original alone

- Don't delete your library, even if BaseCamp has stopped opening. It is what Foldertrail reads.
- If your Mac has Apple silicon (M1 or later) and you upgrade to macOS 28, BaseCamp will no longer open there,
  because Apple is ending the Rosetta feature that ran it. Your library is still on the Mac. On an Intel Mac,
  or on macOS 27 or earlier, BaseCamp keeps running and you don't have to hurry.
- Keep the backup or the copy somewhere other than the Mac itself: an external drive, or a second computer.

## Sources

- Garmin, BaseCamp for Mac manual: sections "Backing Up Data" and "Restoring Backup Data" (p. 14). The
  writer confirmed those section titles in the manual's table of contents on 6 October 2026; the wording that a
  backup includes "all data, lists, and folders" is *recorded in docs/research, not re-read today.*
  https://www8.garmin.com/manuals/webhelp/basecampmac/EN-US/BaseCamp_Help_-_Mac_EN-US.pdf
- Garmin forum posts (2025, Mac and Windows) saying a `.Backup` file is a ZIP of the library folder, that
  backups can be several gigabytes, and that Mac Restore does not put TrackSegments back — *recorded in
  docs/research, not re-read today.* These are user reports, not Garmin statements.
- Apple Support, "Using Intel-based apps on a Mac with Apple silicon" (article 102527): from macOS 28, Rosetta
  is available only for certain older games. https://support.apple.com/en-us/102527 — *cited on the site's
  landing page; not re-read today.*

---

Foldertrail is an independent tool, not affiliated with, endorsed by, or sponsored by Garmin Ltd. or its
subsidiaries. Garmin and BaseCamp are trademarks of Garmin Ltd. or its subsidiaries.
