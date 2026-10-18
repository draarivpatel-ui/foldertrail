# Gate 1: check BCR against a real BaseCamp (about 25 minutes)

**What this is for.** BCR reads BaseCamp's files. We found nothing published about what a Mac BaseCamp 4.8 file looks
like inside, so parts of our reader rest on guesses. This check settles them. You make a small BaseCamp library from our
made-up test files, then a page on your Mac reads it and prints a report. You paste the report into the chat.

**Everything in it is made up.** The places are in the middle of the ocean and the desert. The names all start with
"Gate1". The report holds no names, places or times anyway: only numbers and yes/no.

**Three decisions are yours, not ours.** Each one is a download onto this Mac or a legal agreement, so read and decide:
- **Installing BaseCamp** on this Mac. It comes from Garmin's own website.
- **Accepting Garmin's licence agreement** when the installer shows it. That is a legal agreement, so read it and decide.
- **Installing Rosetta**, Apple's tool that lets this Mac run apps made for older Intel Macs. BaseCamp is one of those
  apps. Rosetta is **not** on this Mac yet (I checked on 6 October 2026), so macOS will offer to install it when you
  open the installer or BaseCamp. It is Apple's own software and comes with Apple's licence terms; clicking Install
  accepts them.

If you would rather not do any of these, stop here and say so in the chat. Nothing else needs them.

**While you do this:**
- Put nothing real into BaseCamp. Only the made-up files below.
- Keep any Garmin GPS unplugged, so nothing real ends up in the library.
- If BaseCamp or macOS asks a question this page does not mention, choose the answer that changes the least (such as
  No, Not Now or Cancel), write down what it said, and tell me in the chat.

The **Undo** section at the end removes everything again.

---

## Before you start: check that this Mac has no BaseCamp data (1 minute)

This makes sure the undo at the end can only ever delete made-up data.

1. Click the Finder icon in the Dock (the blue and white face) so Finder is in front.
2. Press **Command-Shift-G** (hold Command and Shift, then press G). A "Go to Folder" box opens.
3. Paste this and press Return: `~/Library/Application Support/Garmin`
4. If Finder says the folder can't be found, or nothing opens, that is what we want. Close the box and go on.
   - If a folder opens instead, stop here and tell me in the chat. Do not install anything yet.

## Step 0. Check the page works (1 minute)

1. In Finder, click **Documents** in the sidebar, then double-click **bcr**, then **tools**, then **gate1**.
2. Right-click (or hold Control and click) **check.html**. Choose **Open With > Safari**.
3. Near the top it should say **"Self-test passed"**.
   - If it says "Self-test FAILED", or still says "running" after a minute, stop and tell me in the chat.
4. Leave this Safari tab open. You will come back to it.

## Step 1. Install BaseCamp 4.8.13 (about 5-10 minutes)

1. In Safari, open a new tab (Command-T) and go to Garmin's page:
   **https://www8.garmin.com/support/download_details.jsp?id=4450**
   It should say "BaseCamp for Mac software version 4.8.13" and "Intel based Mac". The file is
   **BaseCampforMac_4813.dmg** (about 87 MB).
2. Click the download link on that page. If Safari asks whether to allow downloads from this site, click Allow. The
   file goes to your **Downloads** folder.

**About Rosetta (decision 3):** at some point in the next steps (when the installer starts, or when BaseCamp first
opens) macOS offers to install Rosetta. Click **Install** if you agree, and wait until it finishes.

3. In Finder, click **Downloads** in the sidebar and double-click **BaseCampforMac_4813.dmg**. A new window opens. (A
   .dmg file is a "disk image": it opens like a USB stick.) I have not looked inside this file, so it may be one of two
   kinds:
   - **An installer** (an icon like an open box, its name ending in .pkg): double-click it and follow its steps. It
     shows Garmin's licence agreement (decision 2). It may ask for your Mac password; that is the installer asking
     permission to install an app.
   - **The BaseCamp icon next to an Applications folder**: drag the BaseCamp icon onto the Applications folder.
4. When it has finished, close that window and eject the disk image: in the Finder sidebar, click the eject arrow (⏏)
   next to its name.
5. Open BaseCamp: in Finder, click **Applications** in the sidebar and double-click **BaseCamp** (it may be called
   Garmin BaseCamp).
   - If macOS says BaseCamp was downloaded from the internet and asks whether you are sure, click **Open**.
   - If BaseCamp does not open by itself after Rosetta is installed, double-click it again.
6. If BaseCamp shows welcome screens, or offers maps, updates or an account, close them or choose "Not now" or "Skip".
   Do not sign in to anything.

## Step 2. Make a results folder (30 seconds)

Click an empty part of your Desktop. In the menu bar at the top of the screen, choose **File > New Folder**. Type
**Gate1 results** and press Return. You will save three kinds of files here.

## Step 3. Build the folders and lists (3 minutes)

The left side of BaseCamp shows **My Collection**. You will build this:

```
My Collection
  Gate1 Trips        (a list folder)
    Gate1 Ocean      (a list)
    Gate1 Desert     (a list)
    Gate1 Inner      (a list folder)
      Gate1 Deep     (a list)
```

Type every name exactly, including capitals and the space after "Gate1". After each **New** command a new, empty item
appears on the left: type its name and press Return.

1. Choose **File > New List Folder**. Name it **Gate1 Trips**.
2. Choose **File > New List Folder** again. Name it **Gate1 Inner**. Drag it onto **Gate1 Trips**.
3. Choose **File > New List**. Name it **Gate1 Ocean**. Drag it onto **Gate1 Trips**.
4. Choose **File > New List**. Name it **Gate1 Desert**. Drag it onto **Gate1 Trips**.
5. Choose **File > New List**. Name it **Gate1 Deep**. Drag it onto **Gate1 Inner**.
6. Check it looks like the picture above. (Click the small arrows to open the folders.) If a new item already sat
   inside the right folder, that is fine. If something is in the wrong place, drag it to the right one. If it will not
   go, tell me in the chat.

## Step 4. Import the three test files (2 minutes)

The files are in **Documents > bcr > tools > gate1 > gpx**.

1. Click the list **Gate1 Ocean**. Choose **File > Import into 'Gate1 Ocean'**. Pick **gate1-ocean.gpx**. Click **Import**.
2. Click the list **Gate1 Desert**. Choose **File > Import into 'Gate1 Desert'**. Pick **gate1-desert.gpx**. Click **Import**.
3. Click the list **Gate1 Deep**. Choose **File > Import into 'Gate1 Deep'**. Pick **gate1-deep.gpx**. Click **Import**.

Two tracks are called **Gate1 Twin Track** on purpose (one in Gate1 Desert, one in Gate1 Deep). If BaseCamp says an
item with that name already exists, choose to keep both (the button may say Keep Both, or similar; I have not seen this
message, so its wording is a guess).

If BaseCamp asks any other question during an import (for example about recalculating a route), choose the answer that
leaves things as they are, such as **No**. Write down what it asked, and tell me in the chat.

## Step 5. Put two items in a second list (1 minute)

1. Click **Gate1 Ocean**. In the item list below it, drag **Gate1 Waypoint Alpha** onto the list **Gate1 Desert**.
2. Click **Gate1 Desert**. Drag **Gate1 Track Timed** onto the list **Gate1 Ocean**.
3. To check: double-click **Gate1 Waypoint Alpha** and click **References**. It should show both lists. Close that
   window. Do the same for **Gate1 Track Timed**.
   If either shows only one list, write down which list it shows and tell me in the chat; do not try to fix it.

## Step 6. Type an address and phone number by hand (1 minute)

1. Click **Gate1 Desert**. Double-click **Gate1 Waypoint Delta**.
2. Click **Contact Info**.
3. Type these made-up values into the boxes with the same meaning. Type them exactly. Leave any other box empty.

   | Box | Type this |
   |---|---|
   | Street / Address | 12 Gate1 Typed Lane |
   | City | Gate1 Typed Town |
   | State | Gate1 Typed State |
   | Postal code / ZIP | G1-0002 |
   | Country | Gate1 Typed Land |
   | Phone | 555-0102 |

   If a box from this table does not exist, skip it and tell me which one.
4. Close the window. BaseCamp saves changes by itself.

## Step 7. Save a backup and some exports into "Gate1 results" (3 minutes)

How to save into **Gate1 results** each time: in the box that asks where to save, click **Desktop** in its sidebar
(if there is no sidebar, click the small arrow next to the name box first), then double-click **Gate1 results**.

1. **Backup.** Choose **File > Backup**. Choose **Gate1 results** as the place to save it, name it **Gate1**, and click
   **Backup**.
2. **GPX exports, one per list.** Do this three times, for **Gate1 Ocean**, **Gate1 Desert** and **Gate1 Deep**:
   click the list, choose **File > Export Selected User Data**, name it after the list (for example
   "Gate1 Ocean export"), save it in **Gate1 results**, choose the **GPX** format, and click **Export**.
   If GPX is not offered, tell me which formats are.
3. **KML export.** Click the folder **Gate1 Trips**. Choose **File > Export Selected User Data**. Choose the **KML**
   format (it may be called Google Earth). Save it in **Gate1 results** as "Gate1 Trips export".
   If BaseCamp will not export a folder, choose **File > Export 'My Collection'** instead (it exports everything, which
   here is only the made-up content), choose KML, and save it in **Gate1 results** as "Gate1 everything export".
   Tell me which one worked.

## Step 8. Quit BaseCamp

In the menu bar, choose **BaseCamp > Quit BaseCamp**. This makes sure everything is written to disk.

## Step 9. Run the check and paste the report (2 minutes)

1. Go back to the Safari tab with **check.html**.
2. Click the Finder icon in the Dock. Make the Finder window smaller (drag its bottom-right corner) and move it so you
   can see part of the check page behind it.
3. In Finder, press **Command-Shift-G**. Paste this and press Return:
   `~/Library/Application Support/Garmin/BaseCamp/Database`
   (The Library folder is normally hidden. This box still reaches it.)
4. You should see a folder named **4.8**. If there are several numbered folders, use the highest number.
5. Drag the **4.8** folder onto the check page (onto the dashed box, or anywhere on the page). The page only reads it;
   nothing is copied, moved or sent anywhere.
6. When it says "Done", click **Copy report**. Paste it into the chat.
7. Then open **Gate1 results** on your Desktop. Drag the backup file **Gate1.Backup** (it may show as just **Gate1**)
   onto the same box: the file itself, not the whole folder. Finder can hide the end of a file name. Copy that report
   and paste it too.
8. In the chat, also say:
   - whether dragging the 4.8 folder worked (yes or no);
   - any question BaseCamp asked during the imports;
   - which KML export worked (the folder, or My Collection).

**If dragging the 4.8 folder does nothing, or the report says the browser would not let the page open it:** that is
useful to know, so say so (paste that report too). Then try the button
**Choose a folder…** on the check page: in the box that opens, press Command-Shift-G, paste the Database path from
step 3, press Return, click the **4.8** folder once, and click the button that confirms (Safari may call it Upload;
nothing leaves this Mac). Another way: hold Option while you drag the 4.8 folder to your Desktop (a green plus sign
shows that it copies; without Option it would move the library), drag that copy onto the page, and drag the copy to the
Trash afterwards. The backup file (step 7) works on its own too.

Keep the **Gate1 results** folder. Do not send it anywhere. I may ask for those files in the chat; they hold only the
made-up content.

---

## Undo: remove BaseCamp and the test data (3 minutes)

Do this only when I say the check is finished.

1. Quit BaseCamp if it is open.
2. In Finder, open **Applications** and drag **BaseCamp** to the Trash.
   I have not checked whether the installer adds any other app. If Applications now holds another Garmin app that was
   not there before, tell me before you remove it.
3. Press **Command-Shift-G**, paste `~/Library/Application Support/Garmin`, press Return, and drag the folder
   **BaseCamp** to the Trash. This removes the made-up library. You checked before installing that this folder did not
   exist, so everything in it is from this test. If the Garmin folder is then empty, drag it to the Trash as well.
4. In **Downloads**, drag **BaseCampforMac_4813.dmg** to the Trash.
5. Drag the **Gate1 results** folder on your Desktop to the Trash.
6. Empty the Trash when you are ready. (Emptying the Trash cannot be undone.)

**Rosetta stays.** As far as I know, Apple gives no simple way to remove it. It does nothing on its own; it only runs
when you open an app made for Intel Macs.

BaseCamp may leave a few small settings files elsewhere in your Library folder. That is a guess; I have not checked
which files. They would hold BaseCamp's settings, not the library.
