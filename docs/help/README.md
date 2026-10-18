# Help articles (drafts for the site)

Five short help articles for Foldertrail, written in Markdown so they can be turned into site pages later
(same tone as `site/guide/` and `site/faq/`: plain words, short steps, for a hiker who is not a computer
person). Written 6 October 2026 from the code in `src/` and the research in `docs/research/`.

| File | Article |
|---|---|
| [01-where-is-my-library.md](01-where-is-my-library.md) | Where is my BaseCamp library? (Mac, with Go to Folder; Windows) |
| [02-make-a-backup-first.md](02-make-a-backup-first.md) | Make a BaseCamp backup first |
| [03-what-converts-and-what-doesnt.md](03-what-converts-and-what-doesnt.md) | What Foldertrail converts, and what it doesn't |
| [04-using-your-gpx-files.md](04-using-your-gpx-files.md) | Putting your GPX files into Garmin Explore, a device, Gaia GPS, CalTopo and Google Earth |
| [05-troubleshooting-and-the-diagnostic-report.md](05-troubleshooting-and-the-diagnostic-report.md) | Troubleshooting, and the diagnostic report |

## Facts the articles must keep straight

- **Not on sale yet.** The free preview works; the download is switched off until the maintainer launches.
- **Checked with synthetic (made-up) content only.** Gate 1, the check against a real BaseCamp 4.8.13 for Mac library
  holding made-up content, has been run (`tools/gate1/STEPS.md`). No article may say a real person's library has been tested, and Windows libraries are unchecked.
- **macOS 28 stops BaseCamp only on Apple-silicon Macs that upgrade.** Intel Macs, and Apple-silicon Macs that
  stay on macOS 27 or earlier, keep running it.
- **Windows libraries may work but have not been checked** (decision B32; `src/app/intake.js` says so on the page).
- **Non-affiliation line on every page**. Each article ends with it.

## How sources are labeled

Every outside fact in these articles carries one of three labels in its Sources section:

- **Checked by the writer on 6 October 2026**: the writer opened the page that day and the article quotes it.
- **Recorded in docs/research, not re-read today**: the fact comes from `docs/research/gate0-mac-library.md`,
  where a researcher marked it VERIFIED or REPORTED; the writer could not re-open the source today (two of them
  are PDFs whose text did not extract).
- **Not checked**: the source refused automated reading today (Gaia GPS's help site returned 403). The steps
  are kept, as the site guide gives them, and labeled.

Behavior of the tool itself (what converts, the messages on the page, what the diagnostic report holds) is taken
from the code: `src/export/report.js` (`REASONS`, `LIMITS`), `src/app/intake.js` (`TEXT`, `ZIP_TEXT`),
`src/format/library.js` (`PROBLEMS`), `src/format/dump.js`, `src/app/ui.js`, `src/app/pipeline.js`, and the
converter page `site/app/index.html`.
