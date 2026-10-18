#!/usr/bin/env node
// Writes fixture libraries to disk, for a manual look or a browser test. Nothing it writes belongs in git: point it at
// a scratch folder (scratch/ is gitignored).
//
//   node tools/fixtures/build.js --list
//   node tools/fixtures/build.js <out-dir> [scenario ...]      (no scenario names = all of them)
//
// For each scenario it writes <out-dir>/<name>/Database/<version>/… (the folder a user would drop),
// <out-dir>/<name>.Backup (stored ZIP) and <out-dir>/<name>.expected.json (what a correct reader must produce).

import fs from 'node:fs';
import path from 'node:path';
import { SCENARIOS, buildScenario, getScenario } from './scenarios.js';
import { buildBackup } from './backup.js';

const args = process.argv.slice(2);
if (args[0] === '--list') {
  for (const s of SCENARIOS) console.log(`${s.name.padEnd(28)} ${s.supportedPath ? ' ' : '*'} ${s.title}`);
  console.log('\n* not supported-path coverage (H-OP or broken records only)');
  process.exit(0);
}
if (args.length === 0 || args[0].startsWith('-')) {
  console.error('usage: node tools/fixtures/build.js --list | <out-dir> [scenario ...]');
  process.exit(2);
}
const out = path.resolve(args[0]);
const chosen = args.length > 1 ? args.slice(1).map((n) => getScenario(n)) : SCENARIOS;

for (const s of chosen) {
  const { built, expected, exercises } = buildScenario(s);
  const root = path.join(out, s.name);
  if (fs.existsSync(root)) {
    // Only ever replace a folder this tool wrote before; never delete anything else.
    if (!fs.existsSync(path.join(root, 'Database')) || fs.readdirSync(root).some((n) => n !== 'Database')) {
      console.error(`refusing to replace ${root}: it was not written by this tool`);
      process.exit(1);
    }
    fs.rmSync(path.join(root, 'Database'), { recursive: true, force: true });
  }
  const db = path.join(root, 'Database', built.databaseVersion);
  for (const [rel, bytes] of built.files) {
    const file = path.join(db, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  fs.writeFileSync(path.join(out, `${s.name}.Backup`), await buildBackup(built));
  const meta = { name: s.name, title: s.title, covers: s.covers, supportedPath: s.supportedPath, exercises, notes: s.notes ?? [] };
  fs.writeFileSync(path.join(out, `${s.name}.expected.json`), `${JSON.stringify({ scenario: meta, expected }, null, 2)}\n`);
  console.log(`${s.name}: ${built.files.size} files`);
}
