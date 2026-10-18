#!/usr/bin/env node
// Social preview images for the landing page: writes the SVG sources, and with --png renders them to PNG in the
// installed Google Chrome (headless). Zero dependencies: Node built-ins only. Development only; nothing here ships.
//
//   node docs/brand/og/build.mjs                 # write og-1200x630.svg and og-1080x1080.svg
//   node docs/brand/og/build.mjs --png
//                                                # also render the PNGs (one headless Chrome)
//
// Colours are base.css tokens (light theme); icons and the wordmark are the site's own SVGs (site/assets). The
// before/after tree copies the landing page's example (made-up names) row for row. No Garmin marks.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// base.css :root (light)
const C = {
  ground: '#f2f3ef',
  panel: '#ffffff',
  panel2: '#f7f8f5',
  ink: '#17201b',
  ink2: '#48524c',
  ink3: '#5f6a64',
  line: '#dde1da',
  accent: '#1d6a4f',
  trail: '#a8692b',
  trailLine: '#cfa57a',
};

const FONT = `-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', system-ui, 'Helvetica Neue', Arial, sans-serif`;

// site/assets/icons/*.svg and mark-*.svg, path data only (16x16 and 28x28 viewBoxes).
const ICON = {
  folder: '<path d="M1.75 4.1c0-.64.52-1.15 1.15-1.15h3.05l1.55 1.6h5.6c.63 0 1.15.51 1.15 1.15v6.35c0 .64-.52 1.15-1.15 1.15H2.9c-.63 0-1.15-.51-1.15-1.15z"/><path d="M1.75 6.6h12.5"/>',
  list: '<path d="M6 4.25h7.75M6 8h7.75M6 11.75h7.75"/><path d="M2.6 4.25h.3M2.6 8h.3M2.6 11.75h.3" stroke-width="2.1"/>',
  file: '<path d="M9.25 1.75H4.4c-.63 0-1.15.52-1.15 1.15v10.2c0 .63.52 1.15 1.15 1.15h7.2c.63 0 1.15-.52 1.15-1.15V5.25z"/><path d="M9.25 1.75v3.5h3.5"/>',
};
const MARK_FOLDER = 'M3.25 8.4c0-1.1.9-2 2-2h5.05l2.4 2.45H22.75c1.1 0 2 .9 2 2V21c0 1.1-.9 2-2 2H5.25c-1.1 0-2-.9-2-2z';
const MARK_TRAIL = 'M7.4 19.6c2.2-.1 2.75-3.9 5.6-3.95 2.95-.05 3.1 2.75 5.35 1.55 1.2-.65 1.55-2.15 2.15-3.05';

// The landing page's compare figure (site/index.html), row for row. g = trail guides, as in .guides there.
const BEFORE = {
  title: 'In BaseCamp',
  aside: 'Your library',
  rows: [
    { kind: 'folder', name: 'My Collection', g: [] },
    { kind: 'folder', name: 'Hiking', g: ['tee'] },
    { kind: 'list', name: 'Lakes loop', sub: '24 waypoints, 3 tracks', g: ['pipe', 'tee'] },
    { kind: 'list', name: 'Ridge walks', sub: '9 waypoints, 5 tracks', g: ['pipe', 'elbow'] },
    { kind: 'folder', name: 'Cycling', g: ['tee'] },
    { kind: 'list', name: 'Gravel rides', sub: '12 tracks, 2 routes', g: ['pipe', 'elbow'] },
    { kind: 'list', name: 'Favorite places', sub: '41 waypoints', g: ['elbow'] },
  ],
};
const AFTER = {
  title: 'In your download',
  aside: 'One ZIP file',
  rows: [
    { kind: 'folder', name: 'GPX', g: [] },
    { kind: 'folder', name: 'My Collection', g: ['elbow'] },
    { kind: 'folder', name: 'Hiking', g: ['', 'tee'] },
    { kind: 'gpx', name: 'Lakes loop.gpx', g: ['', 'pipe', 'tee'] },
    { kind: 'gpx', name: 'Ridge walks.gpx', g: ['', 'pipe', 'elbow'] },
    { kind: 'folder', name: 'Cycling', g: ['', 'tee'] },
    { kind: 'gpx', name: 'Gravel rides.gpx', g: ['', 'pipe', 'elbow'] },
    { kind: 'gpx', name: 'Favorite places.gpx', g: ['', 'elbow'] },
    { kind: 'folder', name: 'KML', g: [] },
    { kind: 'file', name: 'My Collection.kml', g: ['elbow'] },
    { kind: 'file', name: 'report.html', g: [] },
  ],
};

/** @param {string} s */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** @param {number} n */
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * One tree card, drawn at scale k of the site's 1x card (32 px rows, 15 px names, 16 px icons, 20 px guides).
 * The card runs `height` tall from y; rows past its bottom are not drawn (the canvas crops the card).
 * @param {{x: number, y: number, w: number, height: number, k: number, id: string, card: typeof BEFORE}} o
 */
function card({ x, y, w, height, k, id, card: data }) {
  const rowH = 32 * k;
  const headH = 40 * k;
  const padX = 16 * k;
  const listTop = y + headH + 8 * k;
  const gw = 20 * k;
  const icon = 16 * k;
  const nameSize = 15 * k;
  const subSize = 13 * k;
  const dash = `${r2(4 * k)} ${r2(2 * k)}`;
  const sw = r2(1.5 * k);
  const out = [];
  out.push(`<g clip-path="url(#clip-${id})">`);
  out.push(`<rect x="${x}" y="${y}" width="${w}" height="${height}" fill="${C.panel}"/>`);
  out.push(`<rect x="${x}" y="${y}" width="${w}" height="${r2(headH)}" fill="${C.panel2}"/>`);
  out.push(`<path d="M${x} ${r2(y + headH - 0.5)}h${w}" stroke="${C.line}" stroke-width="1"/>`);
  const headBase = r2(y + headH / 2 + 4.6 * k);
  out.push(`<text x="${r2(x + padX)}" y="${headBase}" font-size="${r2(13 * k)}" font-weight="620" fill="${C.ink}">${esc(data.title)}</text>`);
  out.push(`<text x="${r2(x + w - padX)}" y="${headBase}" font-size="${r2(13 * k)}" fill="${C.ink3}" text-anchor="end">${esc(data.aside)}</text>`);
  data.rows.forEach((row, i) => {
    const top = listTop + i * rowH;
    if (top > y + height) return;
    const mid = top + rowH / 2;
    let cx = x + padX - 2 * k;
    for (const g of row.g) {
      const lx = r2(cx + 9 * k + 0.75 * k);
      if (g === 'pipe' || g === 'tee') out.push(`<path d="M${lx} ${r2(top)}V${r2(top + rowH)}" stroke="${C.trailLine}" stroke-width="${sw}" stroke-dasharray="${dash}"/>`);
      if (g === 'elbow') out.push(`<path d="M${lx} ${r2(top)}V${r2(mid)}" stroke="${C.trailLine}" stroke-width="${sw}" stroke-dasharray="${dash}"/>`);
      if (g === 'tee' || g === 'elbow') out.push(`<path d="M${lx} ${r2(mid)}H${r2(cx + gw - 1 * k)}" stroke="${C.trailLine}" stroke-width="${sw}" stroke-dasharray="${dash}"/>`);
      cx += gw;
    }
    const ix = cx + 1 * k;
    const iconKind = row.kind === 'folder' ? 'folder' : row.kind === 'list' ? 'list' : 'file';
    const iconColor = row.kind === 'list' || row.kind === 'gpx' ? C.accent : C.ink2;
    out.push(`<use href="#i-${iconKind}" x="${r2(ix)}" y="${r2(mid - icon / 2)}" width="${r2(icon)}" height="${r2(icon)}" stroke="${iconColor}"/>`);
    const tx = r2(ix + icon + 8 * k);
    const base = r2(mid + nameSize * 0.36);
    const weight = row.kind === 'folder' ? 600 : 400;
    let t = `<text x="${tx}" y="${base}" font-size="${r2(nameSize)}" font-weight="${weight}" fill="${C.ink}">${esc(row.name)}`;
    if (row.sub) t += `<tspan dx="${r2(8 * k)}" font-size="${r2(subSize)}" font-weight="400" fill="${C.ink3}">${esc(row.sub)}</tspan>`;
    out.push(`${t}</text>`);
  });
  out.push('</g>');
  out.push(`<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${height - 1}" rx="${r2(12 * k)}" fill="none" stroke="${C.line}"/>`);
  return {
    defs: `<clipPath id="clip-${id}"><rect x="${x}" y="${y}" width="${w}" height="${height}" rx="${r2(12 * k)}"/></clipPath>`,
    shadow: `<rect x="${x}" y="${y}" width="${w}" height="${height}" rx="${r2(12 * k)}" fill="${C.panel}" filter="url(#shadow)"/>`,
    body: out.join('\n    '),
  };
}

/** The wordmark: the site's mark (folder in ink, trail in trail brown) and the name. */
function wordmark(x, y, size, nameSize) {
  const s = size / 28;
  return [
    `<g transform="translate(${x} ${y}) scale(${r2(s)})" fill="none" stroke-linecap="round" stroke-linejoin="round">`,
    `  <path d="${MARK_FOLDER}" stroke="${C.ink}" stroke-width="2"/>`,
    `  <path d="${MARK_TRAIL}" stroke="${C.trail}" stroke-width="1.7" stroke-dasharray="1.7 2.1"/>`,
    `  <circle cx="21.1" cy="12.85" r="1.75" fill="${C.trail}"/>`,
    '</g>',
    `<text x="${r2(x + size + size * 0.32)}" y="${r2(y + size / 2 + nameSize * 0.355)}" font-size="${nameSize}" font-weight="680" letter-spacing="-0.022em" fill="${C.ink}">Foldertrail</text>`,
  ].join('\n  ');
}

/** The landing page's trail between the two cards (.trail-svg, viewBox 0 0 92 34), centred on (cx, cy). */
function trail(cx, cy, scale) {
  return [
    `<g transform="translate(${r2(cx - 46 * scale)} ${r2(cy - 17 * scale)}) scale(${scale})">`,
    `  <path d="M4 25C16 25.5 18 10 32 10s16 15.5 30 14c8-.8 13-6.5 19-11" fill="none" stroke="${C.trail}" stroke-width="1.75" stroke-linecap="round" stroke-dasharray="1.75 3.6"/>`,
    `  <circle cx="85.5" cy="10.5" r="3.4" fill="${C.trail}"/>`,
    '</g>',
  ].join('\n  ');
}

function defs(extra) {
  const icons = Object.entries(ICON)
    .map(([name, d]) => `<symbol id="i-${name}" viewBox="0 0 16 16" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${d}</symbol>`)
    .join('\n    ');
  return `<defs>
    ${icons}
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="130%">
      <feDropShadow dx="0" dy="1" stdDeviation="1" flood-color="#17201b" flood-opacity="0.06"/>
      <feDropShadow dx="0" dy="6" stdDeviation="10" flood-color="#17201b" flood-opacity="0.07"/>
    </filter>
    ${extra.join('\n    ')}
  </defs>`;
}

/**
 * @param {{w: number, h: number, title: string, body: string[], cards: ReturnType<typeof card>[]}} o
 */
function svg({ w, h, title, body, cards }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="${FONT}">
  <title>${esc(title)}</title>
  ${defs(cards.map((c) => c.defs))}
  <rect width="${w}" height="${h}" fill="${C.ground}"/>
  ${cards.map((c) => c.shadow).join('\n  ')}
  ${cards.map((c) => c.body).join('\n  ')}
  ${body.join('\n  ')}
</svg>
`;
}

const ALT = 'Foldertrail. Keep the folders you built in BaseCamp. An example tree of folders and lists in BaseCamp, and the same folders in the download as GPX files.';

// ---------------------------------------------------------------------------------------------
// 1200 x 630: wordmark, headline on two lines, the two trees below, cropped by the bottom edge.

function wide() {
  const W = 1200;
  const H = 630;
  const M = 64;
  const k = 1.3;
  const gap = 104;
  const cw = (W - 2 * M - gap) / 2;
  const cy = 352;
  const ch = H - cy + 40;
  const a = card({ x: M, y: cy, w: cw, height: ch, k, id: 'a', card: BEFORE });
  const b = card({ x: M + cw + gap, y: cy, w: cw, height: ch, k, id: 'b', card: AFTER });
  const body = [
    wordmark(M, 52, 44, 32),
    `<text x="${W - M}" y="${52 + 22 + 6}" font-size="17" fill="${C.ink3}" text-anchor="end">Independent tool, not affiliated with Garmin</text>`,
    `<text font-size="80" font-weight="700" letter-spacing="-0.032em" fill="${C.ink}"><tspan x="${M - 4}" y="192">Keep the folders</tspan><tspan x="${M - 4}" y="278">you built in BaseCamp</tspan></text>`,
    trail(W / 2, cy + 40 * k + 8 * k + 2.5 * 32 * k, 1.05),
  ];
  return svg({ w: W, h: H, title: ALT, body, cards: [a, b] });
}

// ---------------------------------------------------------------------------------------------
// 1080 x 1080: the same, with the headline on three lines and a line of what it does.

function square() {
  const W = 1080;
  const H = 1080;
  const M = 72;
  const k = 1.2;
  const gap = 88;
  const cw = (W - 2 * M - gap) / 2;
  const cy = 594;
  const ch = H - cy + 40;
  const a = card({ x: M, y: cy, w: cw, height: ch, k, id: 'a', card: BEFORE });
  const b = card({ x: M + cw + gap, y: cy, w: cw, height: ch, k, id: 'b', card: AFTER });
  const body = [
    wordmark(M, 64, 48, 35),
    `<text font-size="88" font-weight="700" letter-spacing="-0.032em" fill="${C.ink}"><tspan x="${M - 4}" y="236">Keep the folders</tspan><tspan x="${M - 4}" y="330">you built in</tspan><tspan x="${M - 4}" y="424">BaseCamp</tspan></text>`,
    `<text font-size="29" fill="${C.ink2}"><tspan x="${M}" y="490">GPX files in the same folders and lists.</tspan><tspan x="${M}" y="530">It runs in your browser; nothing is uploaded.</tspan></text>`,
    `<text x="${W - M}" y="${64 + 24 + 6}" font-size="18" fill="${C.ink3}" text-anchor="end">Not affiliated with Garmin</text>`,
    trail(W / 2, cy + 40 * k + 8 * k + 3.5 * 32 * k, 0.9),
  ];
  return svg({ w: W, h: H, title: ALT, body, cards: [a, b] });
}

// ---------------------------------------------------------------------------------------------

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Render one SVG to PNG with headless Chrome's own --screenshot (the window is the image size, scale 1). Chrome
 * sometimes stays alive after writing the file, so wait for the PNG to appear and settle, then close Chrome.
 * @param {string} svgPath @param {string} pngPath @param {number} w @param {number} h
 */
async function render(svgPath, pngPath, w, h) {
  const profile = await mkdtemp(join(tmpdir(), 'ft-og-'));
  await rm(pngPath, { force: true });
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--window-size=${w},${h}`,
      `--screenshot=${pngPath}`,
      pathToFileURL(svgPath).href,
    ],
    { stdio: 'ignore' },
  );
  let exited = false;
  child.on('exit', () => (exited = true));
  try {
    let last = -1;
    for (let waited = 0; ; waited += 250) {
      if (waited > 120_000) throw new Error(`Chrome did not write ${pngPath} within 120 s`);
      await sleep(250);
      const size = existsSync(pngPath) ? (await stat(pngPath)).size : -1;
      if (size > 0 && size === last) break;
      last = size;
      if (exited && size <= 0) throw new Error('Chrome exited without writing the screenshot');
    }
  } finally {
    if (!exited) child.kill();
    for (let i = 0; i < 40 && !exited; i++) await sleep(100);
    await rm(profile, { recursive: true, force: true });
  }
}

const jobs = [
  { name: 'og-1200x630', w: 1200, h: 630, make: wide },
  { name: 'og-1080x1080', w: 1080, h: 1080, make: square },
];
for (const job of jobs) {
  const svgPath = join(HERE, `${job.name}.svg`);
  await writeFile(svgPath, job.make());
  console.log(`wrote ${job.name}.svg`);
  if (process.argv.includes('--png')) {
    await render(svgPath, join(HERE, `${job.name}.png`), job.w, job.h);
    console.log(`rendered ${job.name}.png`);
  }
}
