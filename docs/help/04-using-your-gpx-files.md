# Putting your GPX files into other apps

Your download holds GPX files (one per BaseCamp list, in your folders) and, if you chose it, one KML file with
the whole tree. GPX files hold waypoints, tracks and routes but no folders, so each app below arranges your data
its own way. The steps here come from each maker's own help pages. Where we could open the page on 6 October
2026 it says so; where we could not, the steps are labeled **not checked**. Apps change, so if a step doesn't
match what you see, look at the maker's current help, linked under Sources.

## Before you start

- Double-click the ZIP file in Finder to open it. The GPX folder inside holds your files.
- An item that was in several BaseCamp lists is in each of those lists' files. Importing several lists gives
  you several copies. To avoid that, import one list at a time, or import `All items.gpx` once.
- Routes come out as straight lines between their via points; a device recalculates the roads when you
  navigate.

## Garmin Explore (the website)

*Checked by the writer on 6 October 2026.*

Garmin's own manuals describe this path for BaseCamp data: export it from BaseCamp, import it on the Garmin
Explore website, then synchronize your Garmin Explore data with your device. Foldertrail replaces the first
step; the GPX files are what you import.

Garmin's Explore web help says you can import GPX, KML or KMZ files from another device or application. From
the map, click the Import button, then follow the on-screen instructions to import the files and add them to a
collection. Then sync your device as its own manual describes.

Our suggestion, not Garmin's: import one list's GPX file at a time, into a collection with the same name as the
list. Garmin's help describes collections but not collections inside collections, so your deeper folder levels
won't carry over as they are.

## A Garmin device, over a USB cable

*Checked by the writer on 6 October 2026.* The steps differ by model, so look up "Transferring files" in your
own device's manual. Two examples from Garmin's manuals:

**Tread.** Connect the device to your computer; it appears as a portable device. Open the file browser, select
a GPX file, choose Edit › Copy, browse to the **GPX** folder on the device, and choose Edit › Paste. The manual
adds that Apple computers may require additional third-party software, such as Android File Transfer, to read
and write files on this device.

**GPSMAP 67.** The manual says Mac operating systems do not detect the device by default, and that you must use
Garmin Express software to interact with files on your device. Its steps: connect the device, open the file
browser, select a file, Edit › Copy, open the portable device, drive or volume for the device or memory card,
browse to a folder, Edit › Paste. It says most file types have a named folder within the Garmin folder; that
page does not name the folder for GPX files.

## Garmin Connect

We found no official Garmin instructions for importing a GPX file into Garmin Connect, so this article gives no
steps for it.

## Gaia GPS

***Not checked:*** Gaia's help site refused automated reading on 6 October 2026, so these steps are repeated
from the site guide, whose author read Gaia's page that day. Check Gaia's help page (under Sources) before you
rely on them.

On gaiagps.com/map, click Import Data on the right-hand toolbar, or drag files onto the map, then click Save
Item. Gaia puts each imported file in its own folder, named after the file, so importing list by list gives you
one folder per list. Gaia accepts up to 1,000 features (waypoints, tracks and so on) per file.

## CalTopo

*Checked by the writer on 6 October 2026.*

CalTopo's training page says: click the Import button at the top of the Map Objects side bar, find the file on
your device, and select it. CalTopo accepts GPX, KML or GeoJSON files. For GPX and KML, markers import to the
marker folder and shapes go to the Lines and Polygons folder: your own folders are not kept. CalTopo keeps
folders only from GeoJSON files, which Foldertrail does not write.

## Google Earth

*Checked by the writer on 6 October 2026.* (Google's old help address for this now redirects to a page on
developers.google.com; that is the page we read.)

Use the **KML** file: it holds your whole folder tree. In Google Earth on the web:

- **Without signing in:** at the bottom left of the home screen, click Open local KML editor, then Open KML from
  device, and select the KML file.
- **Into a project:** at the top left, click New › Import file to project, then Upload from device. To add it to
  a project you already have, open that project and choose File › Import file to *project name*.

Google says projects are kept in your Google Drive, that importing as project features suits KML or KMZ files
with up to 10,000 features, and that larger files are loaded as data layers instead.

## Other apps

Most map apps import GPX files. Look for Import or Open in the app.

## Sources

- Garmin, Tread SXS Edition manual, "Adding BaseCamp Data to Garmin Explore": export from BaseCamp, import on
  the Garmin Explore website, synchronize with the device.
  https://www8.garmin.com/manuals/webhelp/GUID-F0AC3576-CD83-465E-983D-7AD585ADB59E/EN-US/GUID-BF0DCAAD-2DC1-4B7E-A116-E22E2BBB4E18.html
  — *checked by the writer on 6 October 2026.*
- Garmin Explore Web Help, "Importing Map Data": GPX, KML or KMZ; from the map, click Import; follow the
  on-screen instructions to add the files to a collection.
  https://www8.garmin.com/manuals/webhelp/explorewebsitepro/EN-US/GUID-5F906255-6086-4CD6-9D8F-A038C01C2FB9.html
  — *checked by the writer on 6 October 2026.*
- Garmin, Tread Owner's Manual, "Transferring GPX Files From Your Computer".
  https://www8.garmin.com/manuals/webhelp/GUID-700B8BF2-F8BB-42A2-A617-3CC00CB4CCA0/EN-US/GUID-CACE2D6E-A614-4AB9-9924-35BAFDE21913.html
  — *checked by the writer on 6 October 2026.*
- Garmin, GPSMAP 67 Owner's Manual, "Transferring Files to Your Device".
  https://www8.garmin.com/manuals/webhelp/GUID-5724F4C0-7557-4C51-BF07-54A567FA4600/EN-US/GUID-7E9B2540-FC7A-4233-97E3-8703987AD8E5.html
  — *checked by the writer on 6 October 2026.*
- Gaia GPS Help, "Import GPX, KML, KMZ, GeoJSON, or FIT Files on gaiagps.com".
  https://help.gaiagps.com/hc/en-us/articles/360052763513 — ***not checked*** (HTTP 403 to automated reading
  on 6 October 2026); steps repeated from `site/guide/`.
- CalTopo Training, "Importing Objects". https://training.caltopo.com/all_users/import-export/import
  — *checked by the writer on 6 October 2026.*
- Google, "Import data into Google Earth". https://developers.google.com/maps/documentation/earth/import-kml
  (reached by redirect from https://support.google.com/earth/answer/7365595) — *checked by the writer on
  6 October 2026.*

---

Foldertrail is an independent tool, not affiliated with, endorsed by, or sponsored by Garmin Ltd. or its
subsidiaries. Garmin and BaseCamp are trademarks of Garmin Ltd. or its subsidiaries. Gaia GPS, CalTopo and
Google Earth are the trademarks of their respective owners.
