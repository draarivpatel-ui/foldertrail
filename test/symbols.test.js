// Tests for src/format/symbols.js: the GDB waypoint icon number to GPX <sym> table (decision B31).
// Synthetic inputs only. The research note's per-entry table is parsed so the code and its sources cannot drift apart.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SYMBOLS, lookup } from '../src/format/symbols.js';

const NOTE_URL = new URL('../docs/research/symbols-sources.md', import.meta.url);

// GDB 0-248 are backed by several sources; 249-265 (BaseCamp 4.8 additions) are provisional (see the research note).
const AGREED_LAST = 248;
const PROVISIONAL_FIRST = 249;
const PROVISIONAL_LAST = 265;

// Distinct icon numbers that may share a name because a source says so. None are needed today; an entry here must
// cite its source in the research note.
/** @type {ReadonlyArray<string>} */
const SOURCED_DUPLICATE_NAMES = [];

/**
 * The per-entry table at the end of the research note, as rows of cells.
 * @returns {{ icon: number, sym: string, numberSources: string, spec: string, nameEvidence: string }[]}
 */
function noteRows() {
  const text = readFileSync(NOTE_URL, 'utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    const m = /^\| (\d+) \| ([^|]+?) \| ([^|]+?) \| ([^|]+?) \| ([^|]+?) \|/.exec(line);
    if (m) {
      rows.push({ icon: Number(m[1]), sym: m[2], numberSources: m[3], spec: m[4], nameEvidence: m[5] });
    }
  }
  return rows;
}

describe('the table', () => {
  test('is frozen, and so is every row', () => {
    assert.equal(Object.isFrozen(SYMBOLS), true);
    for (const entry of SYMBOLS) assert.equal(Object.isFrozen(entry), true, `row for icon ${entry.icon}`);
  });

  test('cannot be changed (module code is strict, so writes throw)', () => {
    assert.throws(() => /** @type {any} */ (SYMBOLS).push({ icon: 999, sym: 'Fake' }), TypeError);
    assert.throws(() => {
      /** @type {any} */ (SYMBOLS)[0] = { icon: 0, sym: 'Fake' };
    }, TypeError);
    assert.throws(() => {
      /** @type {any} */ (SYMBOLS[0]).sym = 'Fake';
    }, TypeError);
    assert.throws(() => {
      /** @type {any} */ (SYMBOLS).length = 0;
    }, TypeError);
    assert.equal(lookup(0), 'Anchor', 'a failed write leaves the lookup unchanged');
    assert.equal(SYMBOLS.length, PROVISIONAL_LAST + 1);
  });

  test('rows have exactly the two documented fields', () => {
    for (const entry of SYMBOLS) assert.deepEqual(Object.keys(entry), ['icon', 'sym']);
  });

  test('covers 0-248 and the provisional 249-265 block, each icon once, in ascending order', () => {
    const icons = SYMBOLS.map((entry) => entry.icon);
    const expected = Array.from({ length: PROVISIONAL_LAST + 1 }, (_, i) => i);
    assert.deepEqual(icons, expected);
    assert.equal(AGREED_LAST + 1, PROVISIONAL_FIRST);
  });

  test('icon numbers are non-negative safe integers within u32', () => {
    for (const { icon } of SYMBOLS) {
      assert.equal(Number.isSafeInteger(icon), true);
      assert.ok(icon >= 0 && icon <= 0xffffffff, `icon ${icon}`);
    }
  });

  test('names are non-empty, trimmed, single-spaced and plain ASCII without XML-special characters', () => {
    for (const { icon, sym } of SYMBOLS) {
      assert.equal(typeof sym, 'string');
      assert.notEqual(sym, '', `icon ${icon}`);
      assert.equal(sym, sym.trim(), `icon ${icon}`);
      assert.doesNotMatch(sym, / {2}/, `icon ${icon}`);
      assert.match(sym, /^[A-Za-z0-9 ,()/-]+$/, `icon ${icon}: ${sym}`);
    }
  });

  test('no two icon numbers share a name unless a source says so', () => {
    /** @type {Map<string, number[]>} */
    const byName = new Map();
    for (const { icon, sym } of SYMBOLS) {
      const key = sym.toLowerCase();
      byName.set(key, [...(byName.get(key) ?? []), icon]);
    }
    const duplicates = [...byName].filter(([, icons]) => icons.length > 1).map(([name]) => name);
    assert.deepEqual(duplicates.filter((name) => !SOURCED_DUPLICATE_NAMES.includes(name)), []);
  });
});

describe('lookup', () => {
  test('returns the documented names for well-known icons', () => {
    /** @type {[number, string][]} */
    const cases = [
      [0, 'Anchor'],
      [18, 'Waypoint'],
      [20, 'Man Overboard'],
      [38, 'Campground'],
      [64, 'Flag'],
      [106, 'Summit'],
      [117, 'Geocache'],
      [140, 'Flag, Red'],
      [141, 'Flag, Blue'],
      [142, 'Flag, Green'],
      [162, 'Marina'],
      [248, 'Water Source'],
    ];
    for (const [icon, sym] of cases) assert.equal(lookup(icon), sym, `icon ${icon}`);
  });

  test('agrees with the table for every row', () => {
    for (const { icon, sym } of SYMBOLS) assert.equal(lookup(icon), sym);
  });

  test('returns "" for icon numbers that are not in the table', () => {
    const unknown = [
      PROVISIONAL_LAST + 1,
      300,
      499,
      500, // GPSBabel calls 500-563 custom symbols; deliberately not mapped
      531,
      563,
      564,
      1000,
      8284, // a device protocol number, not a GDB icon number
      0x7fffffff,
      0x80000000,
      0xffffffff,
      2 ** 40,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_VALUE,
    ];
    for (const icon of unknown) assert.equal(lookup(icon), '', `icon ${icon}`);
  });

  test('treats -0 as 0 (a u32 field never holds -0; Map keys compare -0 and 0 as equal)', () => {
    assert.equal(lookup(-0), lookup(0));
  });

  test('returns "" for negative numbers, fractions and non-finite numbers', () => {
    for (const icon of [-1, -141, -(2 ** 31), 0.5, 141.5, 1e-9, NaN, Infinity, -Infinity, Number.EPSILON]) {
      assert.equal(lookup(icon), '', `icon ${icon}`);
    }
  });

  test('returns "" for anything that is not a number, and never throws', () => {
    const throwing = {
      valueOf() {
        throw new Error('must not be coerced');
      },
      toString() {
        throw new Error('must not be coerced');
      },
    };
    const odd = [
      '141',
      '0',
      '',
      141n,
      0n,
      null,
      undefined,
      true,
      false,
      {},
      [],
      [141],
      Object(141),
      Symbol('141'),
      () => 141,
      throwing,
      Object.create(null),
    ];
    for (const value of odd) assert.equal(lookup(value), '', `value of type ${typeof value}`);
  });

  test('looking up does not depend on inherited properties', () => {
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      assert.equal(lookup(/** @type {any} */ (key)), '');
    }
  });
});

describe('the research note (docs/research/symbols-sources.md)', () => {
  const rows = noteRows();

  test('lists exactly the entries in the table, in order', () => {
    assert.deepEqual(
      rows.map(({ icon, sym }) => ({ icon, sym })),
      SYMBOLS.map(({ icon, sym }) => ({ icon, sym })),
    );
  });

  test('records sources for every entry', () => {
    for (const row of rows) {
      assert.notEqual(row.numberSources.trim(), '', `icon ${row.icon}`);
      assert.notEqual(row.spec.trim(), '', `icon ${row.icon}`);
      assert.notEqual(row.nameEvidence.trim(), '', `icon ${row.icon}`);
    }
  });

  test('backs 0-248 with OP, KBM and GPSBabel, and marks 249-265 as provisional', () => {
    for (const row of rows) {
      if (row.icon <= AGREED_LAST) {
        assert.match(row.numberSources, /^OP p\.(1[5-9]|20), KBM, GB$/, `icon ${row.icon}`);
      } else {
        assert.ok(row.icon >= PROVISIONAL_FIRST && row.icon <= PROVISIONAL_LAST, `icon ${row.icon}`);
        assert.match(row.numberSources, /PROVISIONAL/, `icon ${row.icon}`);
      }
    }
  });

  test('cites Garmin\'s specification for every icon from 0 to 220', () => {
    for (const row of rows) {
      if (row.icon <= 220) assert.match(row.spec, /^C p\.\d+ `sym_[a-z0-9_]+` = \d+/, `icon ${row.icon}`);
      else assert.equal(row.spec, '—', `icon ${row.icon}`);
    }
  });
});
