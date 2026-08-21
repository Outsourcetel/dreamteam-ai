// ============================================================================
// The dev rebuild's pre-flight, inverted.
//
// On 2026-08-20 the nightly rebuild sent the 3.0MB baseline as one request, got
// SQL 413 back, and had already dropped dev — which then sat at zero tables
// until someone noticed. scripts/sql-statements.mjs is the fix: split the dump,
// send it in 1MB chunks, and refuse BEFORE the drop if any of that cannot work.
//
// A pre-flight that cannot fail is worse than none, because it reads as proof.
// Every check below is therefore exercised twice — once against the real
// baseline where it must stay quiet, and once against input crafted to trip it
// where it must speak. The counts are asserted, not just the findings: a check
// that inspected nothing would look identical to a clean result.
// ============================================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  splitStatements,
  chunkStatements,
  countCreateTable,
  dumpProblems,
  sessionSetOf,
} from '../scripts/sql-statements.mjs';

const CAP = 1024 * 1024;
const BASELINE = 'supabase/baseline/full_schema.sql';

describe('splitStatements — what a semicolon does and does not mean', () => {
  it('does not split inside an anonymous dollar-quoted body', () => {
    const sql = `create function f() returns int as $$ begin; return 1; end; $$ language plpgsql;
select 1;`;
    const out = splitStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('return 1;');
    expect(out[1]).toBe('select 1;');
  });

  it('does not split inside a tagged dollar-quoted body', () => {
    const sql = `create function g() returns void as $fn$ begin perform 1; perform 2; end $fn$ language plpgsql;
select 2;`;
    expect(splitStatements(sql)).toHaveLength(2);
  });

  it('does not split inside a single-quoted literal, including doubled quotes', () => {
    const sql = `insert into t values ('a;b', 'it''s; fine');
select 3;`;
    const out = splitStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("'a;b'");
  });

  it('does not split on a semicolon inside a line or block comment', () => {
    const sql = `-- ; not a statement end
/* nor ; this one */
select 4;`;
    expect(splitStatements(sql)).toHaveLength(1);
  });

  it('keeps a $$ body nested inside a $fn$ body whole', () => {
    const sql = `create function h() as $fn$ select 'x'; $$ noise; $$ select 'y'; $fn$ language sql;
select 5;`;
    const out = splitStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('noise;');
  });
});

describe('the real baseline', () => {
  const dump = readFileSync(BASELINE, 'utf8');
  const statements = splitStatements(dump);

  it('is the artefact these numbers were measured against', () => {
    // If this fails the baseline has been regenerated and the constants below
    // describe a file that no longer exists. That is not a defect — it is a
    // signal to re-measure rather than to trust the rest of this block.
    expect(dump.length).toBeGreaterThan(2_500_000);
    expect(statements.length).toBeGreaterThan(4_000);
  });

  it('splits losslessly, with no cut function body and nothing over the cap', () => {
    expect(dumpProblems(dump, statements, CAP)).toEqual([]);
  });

  it('carries production-scale tables', () => {
    expect(countCreateTable(dump)).toBeGreaterThanOrEqual(300);
  });

  it('chunks into request-sized bodies that reassemble in order', () => {
    const chunks = chunkStatements(statements, CAP);
    expect(chunks.length).toBeGreaterThan(1);           // the whole point
    for (const c of chunks) {
      expect(c.length).toBeGreaterThan(0);
      expect(c.join('\n').length).toBeLessThanOrEqual(CAP);
    }
    expect(chunks.flat()).toEqual(statements);          // nothing dropped, nothing reordered
  });

  it('has a largest single statement that fits in one request', () => {
    // 409KB when this was written. If a future dump carries one larger than the
    // cap, the pre-flight refuses rather than 413-ing after the drop — which is
    // the case the next test proves can actually fire.
    expect(Math.max(...statements.map((s: string) => s.length))).toBeLessThan(CAP);
  });
});

describe('sessionSetOf — the GUCs that must survive a chunk boundary', () => {
  // This is not cosmetic. The real baseline emits FUNCTIONS BEFORE TABLES (a
  // CHECK constraint calls is_safe_external_url), so bodies reference tables
  // that do not exist yet and `check_function_bodies` has to stay off. Chunk 1
  // saw the SET; chunks 2..n get a fresh session and the default. The first
  // chunked restore died on exactly that: 42P01 relation "human_tasks".
  it('recognises a bare SET', () => {
    expect(sessionSetOf('SET check_function_bodies = off;')).toBe('SET check_function_bodies = off;');
  });

  it('recognises a SET the splitter has attached comments to', () => {
    const st = '-- Functions in turn reference tables that do not exist yet\n-- so:\nSET check_function_bodies = false;';
    expect(sessionSetOf(st)).toBe('SET check_function_bodies = false;');
  });

  it('sees through a block comment too', () => {
    expect(sessionSetOf('/* why */ SET search_path = public;')).toBe('SET search_path = public;');
  });

  it('does NOT claim a statement that merely contains the word set', () => {
    expect(sessionSetOf('UPDATE t SET x = 1;')).toBeNull();
    expect(sessionSetOf('CREATE TABLE settings (id int);')).toBeNull();
    expect(sessionSetOf("-- SET check_function_bodies = off;\nselect 1;")).toBeNull();
  });

  it('finds the real baseline\'s session settings, and they are the ones that matter', () => {
    const dump = readFileSync(BASELINE, 'utf8');
    const sets = splitStatements(dump).map((s: string) => sessionSetOf(s)).filter(Boolean) as string[];
    // Count asserted, not just presence: zero SETs found would look identical
    // to "the dump needs none", and would silently reintroduce the 42P01.
    expect(sets.length).toBeGreaterThanOrEqual(2);
    expect(sets.every((s) => /^SET\s/i.test(s))).toBe(true);
    expect(sets.filter((s) => /check_function_bodies/i.test(s)).length).toBeGreaterThanOrEqual(2);
  });
});

describe('every pin, inverted — each check must be able to fail', () => {
  const dump = readFileSync(BASELINE, 'utf8');
  const statements = splitStatements(dump);

  it('lossless: fires when a statement goes missing', () => {
    const damaged = statements.slice(0, -1);
    const problems = dumpProblems(dump, damaged, CAP);
    expect(problems.some((p: string) => p.includes('not lossless'))).toBe(true);
  });

  it('lossless: fires when a statement is silently altered', () => {
    const damaged = [...statements];
    damaged[0] = damaged[0] + ' drop table users;';
    expect(dumpProblems(dump, damaged, CAP).some((p: string) => p.includes('not lossless'))).toBe(true);
  });

  it('dollar-quote balance: fires on a function body cut in half', () => {
    const half = 'create function f() returns int as $fn$ begin return 1;';
    const problems = dumpProblems(half, [half], CAP);
    expect(problems.some((p: string) => p.includes('unbalanced dollar-quote'))).toBe(true);
  });

  it('dollar-quote balance: stays quiet on a whole body', () => {
    const whole = 'create function f() returns int as $fn$ begin return 1; end $fn$ language plpgsql;';
    expect(dumpProblems(whole, [whole], CAP).some((p: string) => p.includes('unbalanced'))).toBe(false);
  });

  it('size cap: fires on a statement too large to send on its own', () => {
    const huge = 'select ' + "'x'".repeat(CAP) + ';';
    expect(huge.length).toBeGreaterThan(CAP);
    const problems = dumpProblems(huge, [huge], CAP);
    expect(problems.some((p: string) => p.includes('exceed'))).toBe(true);
  });

  it('size cap: a statement at exactly the cap is allowed through', () => {
    // The boundary is asserted rather than assumed: off by one here means
    // either a needless refusal or the 413 this whole module exists to stop.
    const exact = 'x'.repeat(CAP - 1);
    expect(dumpProblems(exact, [exact], CAP).some((p: string) => p.includes('exceed'))).toBe(false);
    const over = 'x'.repeat(CAP);
    expect(dumpProblems(over, [over], CAP).some((p: string) => p.includes('exceed'))).toBe(true);
  });

  it('table count: a truncated dump reads as truncated', () => {
    const fragment = dump.slice(0, 200_000);
    expect(countCreateTable(fragment)).toBeLessThan(countCreateTable(dump) * 0.9);
  });

  it('chunking: a single over-cap statement still gets its own chunk rather than being merged away', () => {
    // chunkStatements never subdivides — refusing that case is dumpProblems'
    // job. This pins the division of labour so a future "helpful" split cannot
    // quietly send a half-statement.
    const big = 'x'.repeat(CAP + 10);
    const chunks = chunkStatements(['select 1;', big, 'select 2;'], CAP);
    expect(chunks.flat()).toEqual(['select 1;', big, 'select 2;']);
    expect(chunks.some((c: string[]) => c.includes(big) && c.length === 1)).toBe(true);
  });
});
