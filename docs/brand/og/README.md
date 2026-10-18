# Social preview images (Open Graph)

| File | Size | Use |
|---|---|---|
| `og-1200x630.png` | 1200 × 630 | `og:image` / `twitter:image` for the landing page (link previews in Slack, iMessage, Facebook, LinkedIn, X, Mastodon) |
| `og-1080x1080.png` | 1080 × 1080 | Square posts and places that crop to a square |
| `og-1200x630.svg`, `og-1080x1080.svg` | | Sources, written by `build.mjs` |
| `build.mjs` | | Writes the SVGs; with `--png`, renders them in headless Chrome |

What they show: the wordmark (the site's own mark: folder in ink, trail in trail brown), the landing-page headline
"Keep the folders you built in BaseCamp", and the landing page's before/after tree, row for row with the same made-up
names. Light theme, base.css colours only, no Garmin marks. A short non-affiliation line sits top right. The square adds
one line of what it does ("GPX files in the same folders and lists. It runs in your browser; nothing is uploaded."),
which repeats the landing page's own claims and adds none.

## Regenerate

```sh
node docs/brand/og/build.mjs                                                          # SVGs only
node docs/brand/og/build.mjs --png  # SVGs + PNGs
```

Edit `build.mjs`, not the SVGs: the tree rows, colours, icons and sizes all live there. If the landing page's
headline or its example tree changes, change `BEFORE`/`AFTER` and the headline lines to match.

The SVGs set text in the system font (`-apple-system`, so SF Pro on a Mac) and are rendered on a Mac; opened on another
system they fall back to Segoe UI, Helvetica or Arial and the headline's line breaks may sit differently. Publish the
PNGs, not the SVGs.

## Wiring it up (not done: site/ belongs to another workstream)

Copy `og-1200x630.png` into the site (for example `site/assets/og.png`) and add to the landing page's `<head>`, with
the real domain once there is one (crawlers need an absolute URL):

```html
<meta property="og:image" content="https://DOMAIN/assets/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Foldertrail. Keep the folders you built in BaseCamp. An example tree of folders and lists in BaseCamp, and the same folders in the download as GPX files.">
<meta name="twitter:card" content="summary_large_image">
```

The image is fetched by the sharing site's crawler, not by the page, so the Content-Security-Policy is unaffected.

## Legibility at small sizes

Checked on 2026-10-06 by downscaling the Chrome-rendered PNGs with `sips -Z` and looking at them:

| Image, shown at | Headline and wordmark | Tree | Non-affiliation line |
|---|---|---|---|
| wide, 600 px (a desktop link card) | readable | names readable | readable, small |
| wide, 300 px (a narrow phone card) | readable | reads as a folder tree (icons, trail guides); names too small to read | not readable |
| square, 270 px | readable; the line under it just readable | reads as a folder tree; names too small to read | not readable |

The non-affiliation line is a courtesy at full size; the landing page's footer carries the full statement.
