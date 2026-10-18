# Foldertrail brand kit

Written 2026-10-06 from what `site/` ships on that date. Where this file and `site/assets/` disagree, the site is right
and this file is out of date. Labels: **observed** (read in the repository), **computed** (worked out by a script or
a render on 2026-10-06), **recommendation** (a house rule proposed here, not yet applied anywhere).

Files in this folder:

| File | What it is |
| --- | --- |
| `BRAND.md` | this guide |
| `icon-512.svg` | master app icon (512 × 512) |
| `icon-32.svg` | 32 px icon, folder edges on whole pixels |
| `icon-16.svg` | 16 px icon, folder and trail dot only |
| `preview.html` | a local review sheet: open it from the repository and it shows the lockup, the icons, the live colour tokens and the type, all read from `site/assets/` |

## 1. Name

**Foldertrail.** One word, capital F, lower-case t. Not "FolderTrail", "Folder Trail" or "FOLDERTRAIL". Lower case
only in a domain or a file name.

- **It is a working name.** B29 (docs/DECISIONS.md) says the final name waits on a trademark search and the
  founder's approval. The Gate 0 synthesis recommended "GPXodus" with Foldertrail as the runner-up, and Foldertrail
  was taken as the placeholder. Neither name has had a real trademark search.
- **What the name says:** the folders you built in BaseCamp survive the trip. "Trail" is the GPS track, and the
  dashed line that draws the folder tree on the site.
- **Where it lives (observed):** `CONFIG.brand` in `src/config.js`, and also typed out by hand 107 times across 18
  files in `site/` and `src/`. A rename has to touch all of them, plus the `og:` tags.
- **Codenames stay internal.** "BCR" and "BaseCamp Rescue" never appear in anything a user sees. 37signals also
  claims "Basecamp".

## 2. One-line description

| Use | Text (observed) |
| --- | --- |
| Tagline (`CONFIG.tagline`) | Your Garmin BaseCamp library as GPX files, in the folders you made. |
| Next to the name in the masthead | for Garmin BaseCamp libraries |
| Meta description, store listing | Turn your Garmin BaseCamp library into GPX files in the same folders and lists, plus a KML for Google Earth and a report. It runs in your browser; nothing is uploaded. |

"Garmin BaseCamp" appears only as a plain description of what the tool reads ("for", "your"), never as part of the
name, the logo or a domain (B29).

## 3. Voice and tone: calm, precise, honest

The reader is a Mac owner with years of trips in BaseCamp, often not technical, sometimes worried. The copy lowers
the worry by being exact, not by reassuring.

**Calm.** State what is known, with its source and its limits. Never push.

- Do: "Once an Apple-silicon Mac moves to macOS 28, BaseCamp won't open on it. On an Intel Mac, or a Mac that stays
  on macOS 27 or earlier, it keeps running."
- Do (the site's own words): "You don't have to rush."
- Don't: "BaseCamp is dying. Save your maps before it's too late!"
- Don't: "macOS 28 will kill BaseCamp on every Mac."

**Precise.** Name the thing, the number and the scope.

- Do: "Routes come out as straight lines between their via points."
- Do: "3 routes weren't converted because BaseCamp calculated them along roads. The report lists them by name."
- Don't: "Converts your whole library perfectly."
- Don't: "Conversion complete!" when anything was skipped.

**Honest about testing.** Gate 1, the check against a real Mac library, has not been done.

- Do: "So far Foldertrail has been tested with made-up libraries, not yet with a real one. Check the free preview
  against your library before you buy."
- Don't: "Tested on real BaseCamp libraries." / "Works with every library." / "Windows libraries supported."

**Honest about privacy.** Claim only what the design does, and name the one exception.

- Do: "Your library is never uploaded. The only request the page makes to another site is the license check, which
  sends your key and Foldertrail's product ID to the payment provider."
- Don't: "100% secure." / "Military-grade privacy." / "Our security policy guarantees nothing ever leaves your Mac."
  (The Content-Security-Policy is defense in depth, and the copy never calls it a guarantee: docs/ARCHITECTURE.md §1.)

**Plain words.** Use BaseCamp's own words for the user's things (folder, list, waypoint, track, route, library) and
everyday words for ours.

- Do: "It all happens in your browser."
- Don't: "Client-side parsing of the proprietary GDB container."

### Mechanics (observed across `site/`)

- Headings in sentence case: "What will not convert", "How it works".
- Curly apostrophes and quotes (’ “ ”): the site's HTML has 95 curly apostrophes and no straight ones.
- US spelling in what users read ("license", "color"). The code's ids say `licence`; users never see them.
- Contractions are fine ("won't", "don't"). No exclamation marks: the visible text of the site has none.
- The subject is "Foldertrail" or "the page", the reader is "you". "We" appears only where a person's judgment is
  admitted ("We couldn't find Garmin's own instructions…").
- Dates as "21 September 2026". "Apple silicon" as a noun, "Apple-silicon Mac" as an adjective. "macOS 28".
- Every claim about Garmin or Apple carries a source line, as the landing page's "Why now" section does.

## 4. Words and claims we never use

| Never | Why | Say instead |
| --- | --- | --- |
| "official", "authorized", "certified", "approved", "Garmin-approved", "partner", "endorsed" (except in the non-affiliation sentence) | Implies a tie to Garmin. Nominative fair use allows plain references and never these words (not legal advice) | "an independent tool", "for Garmin BaseCamp libraries" |
| "Garmin", "BaseCamp" or "Basecamp" in the name, domain, logo, icon or app title | B29 | the brand alone, with the descriptor beside it |
| Garmin's logo, its triangle, or anything styled to look like Garmin's products | Same; must not imitate Garmin's look | Foldertrail's own mark and colours (§6, §8) |
| Deadline fear: "BaseCamp is dead/dying", "before it's too late", "last chance", "act now", "your maps will be lost", countdown timers, "every Mac" | False for Intel Macs and Macs on macOS 27 or earlier, and against the house voice | the scoped facts in §9, with their source |
| "lossless", "perfect", "100%", "every library", "all your data", "guaranteed" | Road-following routes, BirdsEye imagery, custom maps, Adventures and more are not converted; Gate 1 not done | what converts, what doesn't, and that the report lists it |
| "tested with real libraries", "proven", "trusted by thousands", testimonials, user counts | None of these exist yet | "tested with made-up libraries" |
| "free converter", "free download" | Only the preview is free; the download needs a license key (price shown as planned, not on sale yet) | "the free preview" |
| "upload" for anything Foldertrail does | Nothing is uploaded | "reads", "opens", "in your browser". Exception: explaining Chrome's own "Upload N files to this site?" dialog |
| "secure", "encrypted", "military-grade" | Not checkable by the user; not what the design is | "never uploaded", "one request, for the license" |
| "BaseCamp Rescue", "BCR", "rescue your data" | Internal codename; Basecamp is also a 37signals mark; "rescue" sells fear | "keep the folders you built" |

## 5. The non-affiliation sentence

On every page, the converter and the 404 page included, in the footer (observed, identical on all six pages):

> Foldertrail is an independent tool, not affiliated with, endorsed by, or sponsored by Garmin Ltd. or its
> subsidiaries. Garmin and BaseCamp are trademarks of Garmin Ltd. or its subsidiaries.

Short form, for a FAQ answer (observed in `site/faq/`): "No. It's an independent tool, not affiliated with,
endorsed by, or sponsored by Garmin."

Use the full sentence in the README, any store or directory listing and any social profile. Recommendation: add it
to the download's READ-ME-FIRST.txt and report too; today nothing under `src/export/` contains it (observed). If the
brand is renamed, only the first word changes.

## 6. Colour

All colours are tokens on `:root` in `site/assets/base.css`. Light is the default and dark follows the system setting
(`prefers-color-scheme`). `site.css` and `app.css` contain no colour values of their own: no hex, no `rgb()`
(observed). The palette comes from paper maps: ink, a spruce green for actions, contour brown for the trail lines.

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--ground` | `#f2f3ef` | `#111412` | page background |
| `--panel` | `#ffffff` | `#191d1a` | cards, masthead |
| `--panel-2` | `#f7f8f5` | `#1e2320` | quiet panels, button hover |
| `--panel-sunk` | `#eceee9` | `#151816` | pressed, inset |
| `--ink` | `#17201b` | `#e7ebe7` | text, the folder in the mark |
| `--ink-2` | `#48524c` | `#b3bcb6` | secondary text |
| `--ink-3` | `#5f6a64` | `#939d97` | captions, footer |
| `--line` | `#dde1da` | `#2b312d` | dividers |
| `--line-strong` | `#c2c8c0` | `#414944` | button borders, the rule after the brand name |
| `--field-line` | `#8b938d` | `#6c746e` | form field borders |
| `--accent` | `#1d6a4f` | `#5ebf94` | links, primary buttons, the app icon tile |
| `--accent-hover` | `#175a42` | `#77cca6` | hover |
| `--accent-ink` | `#ffffff` | `#0a1d14` | text on accent |
| `--accent-wash` | `#e2eee7` | `#16301f` | selection, quiet-button hover |
| `--accent-line` | `#a8ccb8` | `#2c5a45` | accent borders |
| `--trail` | `#a8692b` | `#c8945c` | the trail in the mark, dashed trail lines, the rings around step numbers |
| `--trail-line` | `#cfa57a` | `#7d6246` | the dashed connectors between steps and tree rows |
| `--warn` / `--warn-wash` / `--warn-line` | `#7a4e00` / `#fbf3dd` / `#e8d29a` | `#eec46c` / `#2b2412` / `#5a4a22` | warning notices only |
| `--bad` / `--bad-wash` / `--bad-line` | `#a1291e` / `#fcebe8` / `#efc1b9` | `#f29b8f` / `#341c19` / `#6a3029` | error notices only |
| `--focus` | `#1d6a4f` | `#5ebf94` | focus ring |

Shadows: `--shadow-1` and `--shadow-2` (base.css). Radii: `--r-sm` 6px, `--r-md` 8px, `--r-lg` 12px, `--r-xl` 14px.

**One colour outside the tokens:** `#f3dcb4`, a pale sand, used only for the trail in `site/assets/favicon.svg`. The
app icons reuse it. It is not a CSS token and should not be used on pages.

**Contrast (computed, WCAG 2 formula):**

| Pair | Ratio |
| --- | --- |
| light `--ink` on `--ground` | 14.97:1 |
| light `--ink-3` on `--ground` | 5.05:1 |
| light `--accent` on `--panel` | 6.51:1 |
| light `--accent-ink` on `--accent` | 6.51:1 |
| light `--trail` on `--panel` | **4.45:1** |
| light `--trail` on `--ground` | **3.99:1** |
| dark `--ink-3` on `--panel` | 6.10:1 |
| dark `--accent` on `--panel` | 7.59:1 |
| dark `--trail` on `--panel` | 6.37:1 |
| icon: white on `#1d6a4f` | 6.51:1 |
| icon: `#f3dcb4` on `#1d6a4f` | 4.87:1 |

Rules:

- Green means "you can act here": links, the primary button, focus. Don't use it for decoration.
- Brown is for trail lines, dots and outlines. In light mode `--trail` is below the 4.5:1 that body text needs, so
  never set running text in it. It passes the 3:1 that lines and large shapes need.
- Amber and red appear only inside notices (`.notice-warn`, `.notice-bad`), never as a thick coloured side stripe
  (base.css: "Never a thick coloured side stripe").
- A new colour is a new token in `base.css`, with a dark value, or it doesn't ship.

## 7. Type

The system font stack, so nothing loads from another origin and nothing extra ships:

```
--font:      -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, "Helvetica Neue", Arial, sans-serif
--font-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace
```

On a Mac this is San Francisco; elsewhere the nearest system face. The scale in use (observed):

| Role | Size | Weight | Line height | Tracking |
| --- | --- | --- | --- | --- |
| Landing hero title | 2.875rem (2.125rem at 560px and under) | 700 | 1.07 | −0.03em |
| h1 | 1.75rem | 650 | 1.2 | −0.018em |
| h2 | 1.1875rem | 650 | 1.3 | −0.01em |
| h3 | 1rem | 650 | 1.35 | 0 |
| Brand name | 1.1875rem | 680 | 1.5 | −0.022em |
| Body | 16px | 400 | 1.5 | 0 |
| Small, captions, footer | 0.875rem / 0.8125rem | 400–550 | 1.5 | 0 |
| Paths, keys, diagnostics | `--font-mono` at 0.9em | 400 | inherit | 0 |

In-between weights such as 550, 620 and 680 need a font with many weights; where the system font lacks one, the
browser uses the nearest weight it has (CSS font matching). Headings use `text-wrap: balance`.

## 8. Logo and icon

### The lockup

There is no single wordmark file. The lockup in the masthead is built by `base.css` from three parts (observed):

1. **The mark**, 28 × 28 px: `site/assets/mark-folder.svg` (a folder outline, stroke 2) painted in `--ink`, with
   `site/assets/mark-trail.svg` (a dashed trail ending in a dot) on top, painted in `--trail`. Both files are black
   shapes used as CSS masks, so the colours follow light and dark mode. Opened on their own as images they look black;
   that is expected.
2. **The name** "Foldertrail" in live text: system font, 1.1875rem, weight 680, tracking −0.022em, `--ink`, 9px after
   the mark.
3. **The descriptor** (optional): "for Garmin BaseCamp libraries" in `--ink-3` at 0.875rem, after a 1px
   `--line-strong` rule with 14px on each side. It is smaller and lighter than the name, so it reads as a description,
   not part of the name.

Rules (recommendation, matching what the site does):

- Keep the folder in ink and the trail in brown. Don't recolour the folder green, don't fill it, don't put the
  trail outside it.
- On a coloured or photographic background, use the app icon instead of the lockup.
- If the mark would be drawn smaller than 20 px, use the app icon at that size instead (§8, the table below); the
  dashed trail turns to noise.
- Keep clear space of at least half the mark's height (14 px at the masthead size) on every side.
- Never set the name in capitals, outline it, stretch it, or put "Garmin" or "BaseCamp" inside the lockup.

### The app icon

A spruce tile (`--accent`, light), a white folder outline, and the trail in pale sand (`#f3dcb4`) ending in a dot.
It is the site's favicon drawn at three sizes:

| File | Drawing | Use |
| --- | --- | --- |
| `icon-512.svg` | `favicon.svg`'s paths unchanged (checked with `diff`), scaled 14.4× about the centre; corner radius 112 (the favicon's 7/32). Only the trail's dashes are opened up (stroke 1.6, dashes 1.2/3, against 1.8 and 1.7/2.1), because the favicon's nearly closed dashes read as lumps when drawn large | app and touch icons, social cards, anything 48 px and up |
| `icon-32.svg` | the favicon redrawn with the folder's straight edges on whole pixels, stroke 2 | 24 to 47 px |
| `icon-16.svg` | folder (stroke 2, on whole pixels) and the trail's end dot only; no dashes | 16 to 23 px, browser tabs |

Checked (computed, 2026-10-06):

- **Safe zone.** In `icon-512.svg` the folder reaches 201.6 px from the centre, inside the 204.8 px (80%) circle that
  platforms keep when they crop an icon to a shape. A maskable PWA icon also has to fill its square edge to edge, so
  for that use set the tile's `rx` to 0; the drawing itself needs no change.
- **Small sizes.** Rendered at 1x in headless Chrome and enlarged pixel by pixel: the shipped `favicon.svg` has soft,
  half-pixel left and right folder edges at 32 px, and `icon-32.svg` does not. At 16 px a 1.5-unit stroke went soft
  on both sides and a tiny solid trail read as a smudge, which is why `icon-16.svg` uses stroke 2 and the dot only.
- **Dark backgrounds.** The tile's edge is faint on dark surfaces: 2.85:1 against the dark `--ground`, 2.62:1 against
  the dark `--panel`, 2.19:1 against the dark `--accent-wash`. The white folder still carries the shape; prefer the
  dark `--ground` behind it.

Not done here: PNG exports (`apple-touch-icon` and most app stores want PNG). They can be made from these SVGs with
headless Chrome when the site needs them. Swapping `site/assets/favicon.svg` for `icon-32.svg` is a
suggestion for whoever owns `site/`; this kit changes nothing there.

### UI icons

`site/assets/icons/` holds 17 line icons (folder, list, waypoint, track, route, file, lock, key, check, alert, info,
copy, download, external, stop, drop, chevron), used as masks so they take the colour of the text around them. Add new
ones in the same style: round caps and joins, one stroke weight, no fills except small dots.

## 9. Facts the copy may state, and how

These are the claims the brand leans on. Each is scoped the way the evidence allows.

| Claim | How to say it | Source |
| --- | --- | --- |
| Testing so far | "tested with made-up libraries", "not yet with a real one". Gate 1 (a real Mac library with made-up content) has been run; Windows is still unchecked | tools/gate1/STEPS.md |
| macOS 28 | BaseCamp stops opening only on Apple-silicon Macs that upgrade to macOS 28. Intel Macs, and Macs that stay on macOS 27 or earlier, keep it | Apple support article 102527; docs/ARCHITECTURE.md §5 |
| Garmin's plans | quote the forum post as the landing page does, with its date and link; don't paraphrase it into "discontinued" | site/index.html "Why now" |
| Windows libraries | "may work, but they haven't been checked yet" | site/faq/ |
| Price | "$19, planned price", "not on sale yet" until `isConfigured()` is true | src/config.js, site/index.html |
| Privacy | "never uploaded"; the license check is the one outside request and sends only the key and a public product ID | docs/ARCHITECTURE.md §1 |

One wording to fix on the site (not changed here): the landing page's "Still being tested" item says "tested with
made-up libraries, not yet with many real ones". "Many" suggests that a few real libraries were tested. None have
been, so it should read "not yet with a real one".
