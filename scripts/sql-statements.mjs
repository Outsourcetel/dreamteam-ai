// ============================================================================
// sql-statements.mjs — split a schema dump into statements that fit in one
// Supabase Management API request, and refuse the ones that cannot.
//
// WHY THIS EXISTS
// On 2026-08-20 the nightly dev rebuild sent the 3.0MB baseline as a single
// request and got back
//
//     SQL 413: {"message":"request entity too large"}
//
// AFTER dropping dev's public schema. The endpoint's ceiling is between 2MB and
// 3MB (measured: a 2048KB body returns 201, a 3072KB body returns 413), and the
// schema had simply grown past it. Dev was left with ZERO tables, and the one
// tool that could put them back was the tool that had just failed. Every
// dev-touching CI job went red for want of a database rather than for want of
// correct code — a tick that means "no environment" looks exactly like one that
// means "broken product".
//
// This module is separate from rebuild-dev-from-baseline.mjs for one reason:
// that script drops a database at import time and so cannot be imported by a
// test. The checks that decide whether it is safe to drop must be testable, and
// they must be THE checks that run — not a second transcription of them that
// only ever agrees with itself.
//
// Tested by tests/sql-statement-splitter.test.ts, which runs it against the real
// baseline AND inverts every pin.
// ============================================================================

// Split SQL into statements. Splitting on `;` is not safe on a pg dump: most of
// the interesting statements are function bodies full of semicolons inside
// $$ … $$ or $fn$ … $fn$. This walks the text and is dollar-quote, single-quote
// and comment aware.
export function splitStatements(sql) {
  const out = [];
  let buf = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];

    if (c === '-' && sql[i + 1] === '-') {                        // line comment
      const e = sql.indexOf('\n', i);
      const stop = e === -1 ? n : e + 1;
      buf += sql.slice(i, stop); i = stop; continue;
    }
    if (c === '/' && sql[i + 1] === '*') {                        // block comment
      const e = sql.indexOf('*/', i + 2);
      const stop = e === -1 ? n : e + 2;
      buf += sql.slice(i, stop); i = stop; continue;
    }
    if (c === "'") {                                              // '' escapes a quote
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") { j += 1; break; }
        j += 1;
      }
      buf += sql.slice(i, j); i = j; continue;
    }
    if (c === '$') {                                              // the one that matters
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const e = sql.indexOf(tag, i + tag.length);
        const stop = e === -1 ? n : e + tag.length;
        buf += sql.slice(i, stop); i = stop; continue;
      }
    }
    if (c === ';') { buf += ';'; out.push(buf.trim()); buf = ''; i += 1; continue; }

    buf += c; i += 1;
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter((x) => x.length > 0);
}

// Pack statements into request-sized groups, in order. Statements are never
// subdivided — one that exceeds the cap on its own is a refusal, not a split.
export function chunkStatements(stmts, cap) {
  const chunks = [];
  let cur = [];
  let size = 0;
  for (const st of stmts) {
    if (cur.length && size + st.length + 1 > cap) { chunks.push(cur); cur = []; size = 0; }
    cur.push(st); size += st.length + 1;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// ⚠ EACH CHUNK IS ITS OWN SESSION, AND THE DUMP RELIES ON SESSION STATE.
// full_schema.sql opens with `SET check_function_bodies = off` and restates it
// before the functions, because it emits FUNCTIONS BEFORE TABLES on purpose — a
// CHECK constraint on `connectors` calls is_safe_external_url(), so the function
// has to exist first, which in turn means function bodies reference tables that
// do not exist yet. Sent as one request that is fine: one session, one GUC. Sent
// as four, chunks 2..n get a fresh session with the default `on` and the restore
// dies on the first SQL-language body — observed exactly once, as
//
//     ERROR: 42P01: relation "human_tasks" does not exist
//
// So every `SET` the dump has executed so far is replayed at the head of each
// later chunk. Replaying the ones ALREADY SEEN rather than all of them keeps
// single-session semantics: a GUC changed halfway through the file still
// applies to the right half.
//
// Returns the bare `SET …;` text if this statement is a session setting (the
// splitter attaches preceding comments to a statement, so leading comment and
// whitespace are stripped before deciding), else null.
export function sessionSetOf(statement) {
  let s = statement;
  for (;;) {
    const t = s.replace(/^\s+/, '');
    if (t.startsWith('--')) { const e = t.indexOf('\n'); s = e === -1 ? '' : t.slice(e + 1); continue; }
    if (t.startsWith('/*')) { const e = t.indexOf('*/'); s = e === -1 ? '' : t.slice(e + 2); continue; }
    s = t; break;
  }
  return /^SET\s+/i.test(s) ? s : null;
}

// How many tables the dump claims to create. Used to tell a real dump from a
// truncated one BEFORE anything is dropped.
export function countCreateTable(dump) {
  return (dump.match(/^CREATE TABLE/gim) || []).length;
}

// Everything that can be known about a dump without a database. Returns a list
// of human-readable problems; empty means the restore is worth attempting.
//
// `statements` is passed in rather than derived so a test can hand it a
// deliberately damaged array and prove each check actually fires.
export function dumpProblems(dump, statements, cap) {
  const problems = [];

  // Reassembly must differ from the source only in whitespace. A splitter that
  // silently ate a fragment would bring dev back SUBTLY wrong, which is worse
  // than bringing it back empty — the census at the end would still say OK.
  const norm = (x) => x.replace(/\s+/g, ' ').trim();
  if (norm(statements.join('\n')) !== norm(dump)) {
    problems.push('the statement splitter is not lossless on this dump');
  }

  // An unbalanced dollar-quote means a function body was cut in half and one of
  // the halves is now pretending to be its own statement.
  const unbalanced = statements.filter((x) => {
    const seen = {};
    for (const t of x.match(/\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$/g) || []) seen[t] = (seen[t] || 0) + 1;
    return Object.values(seen).some((v) => v % 2 !== 0);
  });
  if (unbalanced.length) {
    problems.push(`${unbalanced.length} statement(s) carry an unbalanced dollar-quote — first: ${unbalanced[0].slice(0, 90).replace(/\s+/g, ' ')}…`);
  }

  // A statement bigger than the cap cannot be split any further, so it would
  // 413 on its own — which is precisely the failure this module exists for.
  const oversize = statements.filter((x) => x.length + 1 > cap);
  if (oversize.length) {
    problems.push(`${oversize.length} statement(s) exceed the ${Math.round(cap / 1024)}KB request cap on their own — largest ${Math.max(...oversize.map((x) => x.length))} bytes`);
  }

  return problems;
}
