# Where is my BaseCamp library?

Everything you made in BaseCamp — your waypoints, tracks, routes, and the folders and lists you sorted them
into — lives in a set of files on your computer. Garmin calls that set your **library**. Foldertrail reads
those files. BaseCamp does not need to open for that; the files are still there even when it won't.

You can give Foldertrail either the library folder itself, or a BaseCamp backup file (one file that holds the
whole library). If BaseCamp still opens, the backup is the easiest route: see [Make a BaseCamp backup
first](02-make-a-backup-first.md). This article is about finding the folder.

## On a Mac

BaseCamp for Mac keeps the library inside a folder called Library that Finder normally hides. Hidden only
means Finder doesn't show it; it is still there. Here are two ways in.

### Way 1: Go to Folder

1. Click the Finder icon in the Dock (the blue and white smiling face), so Finder is in front.
2. In the menu bar at the top of the screen, choose **Go › Go to Folder**. (Or hold down ⌘ and ⇧ and press G.)
   A small box opens.
3. Copy this line and paste it into the box, then press Return:

   `~/Library/Application Support/Garmin/BaseCamp/Database`

   The `~` at the start means "my home folder", so the line works whatever your user name is. The converter
   page shows the same path with a Copy button next to it.
4. A Finder window opens on the **Database** folder. Inside it are one or more folders named with a version
   number, such as **4.8**. If there are several, the one with the highest number is your current library;
   the lower ones are left over from older versions of BaseCamp.
5. Drag the folder with the highest number (for example **4.8**) onto the Foldertrail page. Dragging the whole
   **BaseCamp** folder works too: Foldertrail finds the Database folder inside it.

### Way 2: the Option key

1. In Finder, click the **Go** menu in the menu bar and hold down the **Option** (⌥) key. An extra item,
   **Library**, appears in the menu. Choose it.
2. Open **Application Support**, then **Garmin**, then **BaseCamp**, then **Database**.
3. Carry on from step 4 above.

### How to tell you have the right folder

The version folder (such as 4.8) holds a file called **AllData.gdb** (your items), a file called
**FolderData.gfi** (your folders and lists) and a folder called **TrackSegments** (the elevation and time of
your tracks). You don't need to open any of them, and please don't move or rename them: BaseCamp needs them
where they are.

### If you keep your library somewhere else

If you made your own library in BaseCamp (rather than using the one it starts with), it is a *package*: it
ends in **.bclibrary** and looks like a single file in Finder, though it is really a folder. While BaseCamp
still opens, **BaseCamp › Preferences › Advanced › Library** shows where it is.

Drag the package onto the Foldertrail page as it is. If the page says your browser handed the package over as
a single file it cannot open, do this: in Finder, right-click (or hold Control and click) the package, choose
**Show Package Contents**, and drag the folder inside onto the page.

## On Windows

Foldertrail is made for libraries from BaseCamp for Mac. **Libraries from BaseCamp for Windows may work, but
they have not been checked yet.** If the page notices signs of a Windows library it says so, and the report
tells you if anything could not be read. The converter itself has only been tried in browsers on a Mac.

BaseCamp for Windows (the last version is 4.7.5) keeps its library here:

`C:\Users\<your name>\AppData\Roaming\Garmin\BaseCamp\Database\<version>`

with a version folder such as **4.7**. That location comes from a published description of the file format
and from posts on Garmin's forums, not from a Garmin help page.

The **AppData** folder is hidden, like the Mac's Library folder. The quickest way in:

1. Open **File Explorer**.
2. Click in the address bar at the top (where the folder's name is shown), type
   `%APPDATA%\Garmin\BaseCamp\Database` and press Enter. `%APPDATA%` is Windows's own shortcut to the Roaming
   folder; that is general Windows behavior, not something from Garmin's pages.
3. Inside is the version folder, such as **4.7**. It holds the same three things as on a Mac: AllData.gdb,
   FolderData.gfi and TrackSegments.

If BaseCamp for Windows still opens, **File › Backup** is simpler: it makes one `.Backup` file. We have not
checked that a Windows backup reads correctly in Foldertrail either; the free preview will tell you.

## Sources

- Apple Support, "Go directly to a specific folder on Mac": Go › Go to Folder; type or paste a pathname, then
  press Return; `~` means your home folder; hold Option and choose Library to reach the Library folder.
  https://support.apple.com/guide/mac-help/go-directly-to-a-specific-folder-on-mac-mchlp1236/mac
  — *checked by the writer on 6 October 2026.*
- Garmin, BaseCamp for Mac manual: Preferences › Advanced › Library shows where a custom library is (p. 15).
  https://www8.garmin.com/manuals/webhelp/basecampmac/EN-US/BaseCamp_Help_-_Mac_EN-US.pdf
  — *recorded in docs/research, not re-read today.*
- Garmin forum posts (2013–2025) giving the Mac path `~/Library/Application Support/Garmin/BaseCamp/Database/4.8/`,
  and a 2020 post saying that BaseCamp 4.8 copies the highest-numbered version folder when it first starts, so
  older folders can sit beside it — *recorded in docs/research, not re-read today.*
- Herbert Oppmann, "Garmin MapSource (MPS), GPS Database (GDB) and Folder and Item (GFI) File Format" (2024),
  p. 3: the Windows path with AppData\Roaming — *recorded in docs/research, not re-read today* (the PDF's text
  did not extract). Garmin forum posts from 2024 give the same path.
- Garmin, download page for BaseCamp (Windows) 4.7.5 — *recorded in docs/research, not re-read today.*

---

Foldertrail is an independent tool, not affiliated with, endorsed by, or sponsored by Garmin Ltd. or its
subsidiaries. Garmin and BaseCamp are trademarks of Garmin Ltd. or its subsidiaries.
