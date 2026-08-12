// ============================================================================
// deferred-register.mjs — the machine-checked register of deferred work.
//
// ── WHY THIS IS NOT A DOCUMENT ──────────────────────────────────────────────
//
// docs/53 counted 47 still-open deferred items over seven days and found that
// **eleven of the fourteen genuinely walked past were named in a DOCUMENT
// rather than a commit**. Items written into migration headers and commit
// bodies got acted on. Items written into docs got admired and forgotten.
//
// The same census found the registers themselves had drifted — measured, not
// asserted: docs/51 listed a fix migration 692 had already landed; docs/45
// named 28 fail-open guards where the live catalogue holds 1 of 928; docs/50
// carried two r5 findings already closed or refuted. A backlog nobody
// re-measures stops being evidence, and then it is just prose that scores
// itself.
//
// So the answer to "documents go stale" cannot be another document. This is
// the same move migs 706-709 made on the measurement organs: put the claim and
// the thing that checks the claim in ONE place, and re-run the check on every
// certify run. `review/deferred-register.json` records what is deferred; this
// module re-derives, from live production and from the repo on disk, whether
// the register is still telling the truth about itself.
//
// ── ⚠⚠ THE FAILURE CONDITION IS THE WHOLE DESIGN ────────────────────────────
//
// The obvious probe — "fail while any item is open" — is worse than nothing.
// 47 items cannot be closed this week, so it would be red on day one, red
// every day after, and switched off or ignored inside a fortnight. docs/53 §4
// wrote the epitaph for that shape already: *"a red nobody owns is a red
// nobody fixes."* An item being OPEN is therefore DATA, printed with its
// denominators, and never a failure.
//
// What fails is the register being **WRONG ABOUT ITSELF**. Seven conditions,
// each argued:
//
//  F1  register says OPEN, verification proves CLOSED.
//      This is exactly docs/45's "28 fail-open guards" — a finding that was
//      real, got fixed, and went on being carried as live backlog for four
//      days. Stale-open entries are not harmless: they inflate the backlog,
//      they get re-triaged, and they teach readers that the register is
//      approximate. CANNOT ERODE INTO PERMANENT RED: the fix is to flip one
//      field to "closed" and paste the evidence the probe just printed —
//      always available, always correct, never blocked on anyone.
//
//  F2  register says CLOSED, verification proves OPEN.
//      The worse direction, and the one this repo has paid for repeatedly: a
//      governed refusal reported as success; a gate marked done that had never
//      fired. Recording "closed" is a claim that a defect is gone; if the
//      defect answers back, that claim is a lie in the one artefact people
//      will trust. CANNOT ERODE: flip it back to open (one field) or fix it.
//
//  F3  a verification ERRORED. A broken checker is a failure, never a skip —
//      certify's house rule since the first vacuous invariants query. A probe
//      that quietly drops an unrunnable check is a probe with a hole exactly
//      where someone last touched it. CANNOT ERODE: fix the query.
//
//  F4  schema/vocabulary violation — duplicate id, missing field, unknown
//      severity or why-skipped, a closed item with no closing evidence. The
//      register is a data structure other tools read; a register that will not
//      parse cleanly is a register whose counts mean nothing. CANNOT ERODE:
//      `npm run defer` writes conforming entries and refuses to write others.
//
//  F5  NO-COMPARISONS. If zero verifications ran, every arm above is vacuously
//      quiet and the section prints PASS having checked nothing. Zero findings
//      from zero comparisons looks exactly like a clean result. CANNOT ERODE:
//      only reachable by emptying the register or deleting every verification.
//
//  F6  an UNVERIFIABLE item whose citation no longer exists. An item carried
//      on a claim must at least cite a document that still says what it is
//      claimed to say — file present, anchor text present. Without this,
//      "unverifiable" degrades into "unfalsifiable", which is how docs/50's
//      carried-forward r5 list came to name two findings that were already
//      closed and refuted. CANNOT ERODE: restore the anchor, re-point the
//      citation, or give the item a real verification.
//
//  F7  the UNVERIFIABLE CEILING. The count of items carrying no mechanical
//      verification may not exceed the pinned ceiling. This is the ratchet
//      shape this repo already trusts (edge-typecheck ceilings, KNOWN_DUPLICATES,
//      the EXECUTE allowlist): new work must come with a way to check it, and
//      an exception has to be typed by a person into a diff a reviewer sees.
//
// ⚠ WHY THERE IS NO AGE-BASED FAILURE, deliberately. The brief asked me to
// consider failing when an unverifiable item has no owner after a stated age.
// I argued myself out of it and the argument is the point: a deadline red
// fires because a DATE PASSED, not because anything about the system changed,
// and the only actions that clear it are (a) doing unrelated work under time
// pressure or (b) bumping the date. (b) is a rubber stamp, and a stored marker
// re-read as truth is the exact trap listed three times in this repo's memory.
// It would also be the one condition here that a correct, honest, fully
// up-to-date register cannot avoid — i.e. the one that erodes. The ceiling
// (F7) achieves the intent — pressure toward verifiable items — while only
// ever firing on an ACTION someone took.
//
// ⚠ UNVERIFIABLE IS NEVER RENDERED AS FINE. docs/53 marked 18 items ⏸.
// Every run prints the carried-on-claim population as its own denominator line
// and names each item, because an item nobody can check is a WEAKER position
// than an item checked and found open, and the two must not look alike.
//
// ── WHY THIS IS A SECTION AND NOT A `PROBES` ENTRY ──────────────────────────
// certify's PROBES array is one SQL string per probe, run against production.
// These verifications span three sources — production SQL, the repo on disk,
// and a second Supabase project (dev) — so it cannot be expressed as one
// query. It sits in the same band: read-only, runs in --fast, violations-only.
// ============================================================================
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

export const REGISTER_FILE = 'review/deferred-register.json';

export const SEVERITIES = ['security', 'correctness', 'measurement', 'hygiene'];
export const WHY_SKIPPED = ['walked-past', 'founder-decision', 'out-of-scope', 'blocked', 'deliberate'];
export const STATES = ['open', 'closed'];
export const KINDS = ['sql', 'sql-lag', 'grep', 'none'];
const OPS = {
  '>=': (a, b) => a >= b, '>': (a, b) => a > b, '==': (a, b) => a === b,
  '<=': (a, b) => a <= b, '<': (a, b) => a < b,
};

export function loadRegister(file = REGISTER_FILE) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

// ── F4: schema and vocabulary ──────────────────────────────────────────────
// Written as a pure function over the parsed register so `npm run defer` can
// run the SAME validator before writing. One definition of "conforming".
export function validateRegister(reg) {
  const out = [];
  if (!reg || !Array.isArray(reg.items)) return ['schema — register has no `items` array'];
  if (typeof reg.unverifiable_ceiling !== 'number') out.push('schema — register has no numeric `unverifiable_ceiling` (F7 cannot be evaluated without it, and a ratchet with no ceiling is not a ratchet)');
  const seen = new Set();
  for (const it of reg.items) {
    const id = it?.id ?? '(no id)';
    if (!it.id) out.push('schema — an item has no `id`');
    else if (seen.has(it.id)) out.push(`schema — duplicate id ${it.id}: two items sharing an id means one of them can never be addressed, closed or cited`);
    else seen.add(it.id);
    for (const f of ['what', 'where', 'severity', 'why_skipped', 'state', 'first_named', 'verification']) {
      if (it[f] === undefined) out.push(`schema — ${id} is missing required field \`${f}\``);
    }
    if (it.severity && !SEVERITIES.includes(it.severity)) out.push(`schema — ${id} has severity "${it.severity}", not one of ${SEVERITIES.join('/')}`);
    if (it.why_skipped && !WHY_SKIPPED.includes(it.why_skipped)) out.push(`schema — ${id} has why_skipped "${it.why_skipped}", not one of ${WHY_SKIPPED.join('/')}`);
    if (it.state && !STATES.includes(it.state)) out.push(`schema — ${id} has state "${it.state}", not one of ${STATES.join('/')}`);
    if (it.first_named && (!it.first_named.date || !it.first_named.source)) out.push(`schema — ${id}.first_named needs both a date and a source (the census's whole finding was WHERE an item was named)`);
    // A closed item with no evidence is a claim, and this register exists
    // because claims go stale. Closing must cite something re-readable.
    if (it.state === 'closed' && !it.closed_by) out.push(`schema — ${id} is recorded closed with no \`closed_by\` — closing an item is a claim, and a claim with no citation is what this register replaces`);
    const v = it.verification;
    if (v) {
      if (!KINDS.includes(v.kind)) out.push(`schema — ${id}.verification.kind "${v.kind}" is not one of ${KINDS.join('/')}`);
      if (v.kind !== 'none') {
        if (!v.open_if || !OPS[v.open_if.op] || typeof v.open_if.n !== 'number') out.push(`schema — ${id}.verification.open_if must be {op,n} with op in ${Object.keys(OPS).join('/')}`);
      } else {
        if (!v.why_unverifiable) out.push(`schema — ${id} carries no verification and does not say why (F6 requires the reason to be readable, not implied)`);
        if (!v.claim || !v.claim.file || !v.claim.anchor) out.push(`schema — ${id} carries no verification and no {file,anchor} citation — an item nobody can check must at least cite a document that still says it`);
      }
      if (v.kind === 'sql' && !v.sql) out.push(`schema — ${id}.verification.kind=sql with no \`sql\``);
      if (v.kind === 'sql-lag' && (!v.production_sql || !v.dev_sql)) out.push(`schema — ${id}.verification.kind=sql-lag needs both production_sql and dev_sql`);
      if (v.kind === 'grep' && (!Array.isArray(v.paths) || !v.pattern)) out.push(`schema — ${id}.verification.kind=grep needs \`paths\` and \`pattern\``);
    }
  }
  return out;
}

// ── The grep verification ──────────────────────────────────────────────────
// Implemented in JS rather than shelling out to ripgrep/findstr: certify runs
// on Windows and in CI containers, and a verification that silently returns 0
// because the tool was missing is a false CLOSED — the exact direction F2
// exists to catch. A missing path THROWS (F3), it does not count as zero.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

function walk(p, acc) {
  let st;
  try { st = statSync(p); } catch { throw new Error(`path does not exist: ${p}`); }
  if (st.isFile()) { acc.push(p); return acc; }
  for (const e of readdirSync(p, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(join(p, e.name), acc); }
    else if (e.isFile()) acc.push(join(p, e.name));
  }
  return acc;
}

export function runGrep(v, root = '.') {
  const files = [];
  for (const p of v.paths) walk(join(root, p), files);
  const inc = v.include ? new RegExp(v.include) : null;
  const exc = v.exclude ? new RegExp(v.exclude) : null;
  const re = new RegExp(v.pattern, v.flags ?? 'g');
  let matches = 0, hitFiles = 0;
  for (const f of files) {
    const rel = f.slice(root === '.' ? 0 : root.length).split(sep).join('/').replace(/^\//, '');
    if (inc && !inc.test(rel)) continue;
    if (exc && exc.test(rel)) continue;
    let text;
    try { text = readFileSync(f, 'utf8'); } catch { continue; }   // binary/unreadable
    re.lastIndex = 0;
    const n = (text.match(re) ?? []).length;
    if (n > 0) { matches += n; hitFiles++; }
  }
  return v.count === 'files' ? hitFiles : matches;
}

// ── Evaluation ─────────────────────────────────────────────────────────────
// `runSql` / `runSqlDev` are injected so certify passes its own credentialed
// query function and the mutation self-test can pass a stub. Every SQL
// verification must return exactly one row with one integer column `n`; a
// query that returns anything else is an ERROR (F3), not a zero.
function scalar(rows, id) {
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error(`expected exactly 1 row, got ${Array.isArray(rows) ? rows.length : typeof rows}`);
  const keys = Object.keys(rows[0]);
  if (keys.length !== 1) throw new Error(`expected exactly 1 column named n, got [${keys.join(', ')}]`);
  const n = Number(rows[0][keys[0]]);
  if (!Number.isFinite(n)) throw new Error(`column ${keys[0]} is not a number for ${id}`);
  return n;
}

// ── Measuring the verifications ────────────────────────────────────────────
// ⚠ THE SQL VERIFICATIONS GO OVER IN ONE QUERY, not one round trip each.
// The first version fired ~25 concurrent Management-API calls and the API
// throttled them: several items came back `429 Too Many Requests`, which this
// probe correctly classified as F3 VERIFICATION ERROR — and a red run caused by
// rate-limiting is exactly the noise that teaches people to re-run a gate until
// it is green. It also made a mutation case pass for the WRONG REASON (the
// injected broken query was "caught" by a throttle error carrying the same item
// id), which is an INCONCLUSIVE result, not a proof.
//
// So: every `sql` verification is wrapped as a scalar subquery and UNIONed into
// a single statement — 1 call instead of 25. `(select * from (<sql>) x)` rather
// than `(<sql>)` so the wrapper does not depend on the item's column alias, and
// a sub-select returning more than one row still errors loudly rather than
// silently taking the first.
//
// If the batch fails, EVERY item in it is unattributed — so the fallback re-runs
// them one at a time to name the one that broke. F3 must say WHICH item, or the
// cheapest way to hide an inconvenient verification is to break it.
async function measureAll(items, { runSql, runSqlDev, root, measured }) {
  const sqlItems = items.filter((it) => it.verification?.kind === 'sql');
  const lagItems = items.filter((it) => it.verification?.kind === 'sql-lag');

  for (const it of items.filter((i) => i.verification?.kind === 'grep')) {
    try { measured.set(it.id, { n: runGrep(it.verification, root) }); }
    catch (e) { measured.set(it.id, { err: e }); }
  }

  if (sqlItems.length) {
    const batch = sqlItems
      .map((it) => `select ${JSON.stringify(it.id).replace(/"/g, "'")}::text as id, (select * from (${it.verification.sql}) x)::numeric as n`)
      .join('\nunion all\n');
    let rows = null;
    try { rows = await runSql(batch); } catch { rows = null; }
    if (Array.isArray(rows) && rows.length === sqlItems.length) {
      const byId = new Map(rows.map((r) => [r.id, r.n]));
      for (const it of sqlItems) {
        const v = byId.get(it.id);
        // A scalar subquery over an empty result yields NULL. Number(null) is 0,
        // which would read as a confident "closed" from a query that measured
        // nothing — the exact false-CLOSED direction F2 exists to catch, one
        // layer down. It is an error, not a zero.
        if (v === undefined || v === null) measured.set(it.id, { err: new Error('the verification returned no row (a scalar subquery over an empty result is NULL, and NULL is not zero)') });
        else measured.set(it.id, { n: Number(v) });
      }
    } else {
      // Attribute, serially. Slow, but it only happens on a broken run.
      for (const it of sqlItems) {
        try { measured.set(it.id, { n: scalar(await runSql(it.verification.sql), it.id) }); }
        catch (e) { measured.set(it.id, { err: e }); }
      }
    }
  }

  for (const it of lagItems) {
    const v = it.verification;
    try {
      const p = scalar(await runSql(v.production_sql), it.id);
      const d = scalar(await runSqlDev(v.dev_sql), it.id);
      measured.set(it.id, { n: p - d });
    } catch (e) { measured.set(it.id, { err: e }); }
  }
}

export async function evaluateRegister({ reg, runSql, runSqlDev, root = '.' }) {
  const failures = [];
  const notes = [];
  for (const v of validateRegister(reg)) failures.push(`F4 ${v}`);

  const items = Array.isArray(reg?.items) ? reg.items : [];
  let verified = 0, verifiedOpen = 0, verifiedClosed = 0, unverifiable = 0, errored = 0;
  const claimCarried = [];
  // Per-item verdicts, so the --mutate self-test can pick a REAL currently-open
  // and a REAL currently-closed item off one pass instead of choosing the item
  // that makes the test pass. Also the only honest way to answer "which ones".
  const verdicts = [];

  const measured = new Map();
  await measureAll(items, { runSql, runSqlDev, root, measured });

  for (const it of items) {
    const v = it.verification ?? { kind: 'none' };
    if (v.kind === 'none') {
      unverifiable++;
      claimCarried.push(it);
      // F6 — the citation must still exist and still say it.
      if (v.claim?.file && v.claim?.anchor) {
        let text = null;
        try { text = readFileSync(join(root, v.claim.file), 'utf8'); } catch { /* missing */ }
        if (text === null) {
          failures.push(`F6 UNSUPPORTED CLAIM — ${it.id} is carried on ${v.claim.file}, which does not exist. An item nobody can check, citing a document nobody can read, is not backlog — it is folklore. Re-point the citation, or give ${it.id} a verification.`);
        } else if (!text.includes(v.claim.anchor)) {
          failures.push(`F6 UNSUPPORTED CLAIM — ${it.id} is carried on ${v.claim.file}, but the anchor text ${JSON.stringify(v.claim.anchor)} is no longer in that file. Either the finding was rewritten (re-anchor it) or it was resolved there (close ${it.id} with the evidence).`);
        }
      }
      continue;
    }

    const { n = null, err = null } = measured.get(it.id) ?? { err: new Error('verification was never run') };

    if (err) {
      errored++;
      verdicts.push({ id: it.id, kind: v.kind, error: String(err.message ?? err) });
      // F3 — a broken verification is a failure, never a skip. Without this,
      // the cheapest way to silence an inconvenient item is to break its query.
      failures.push(`F3 VERIFICATION ERROR — ${it.id} (${v.kind}) could not be evaluated: ${String(err.message ?? err).slice(0, 200)}. A verification that cannot run is a hole in this register exactly where someone last touched it; it is NOT a pass and NOT a skip.`);
      continue;
    }

    verified++;
    const isOpen = OPS[v.open_if.op](n, v.open_if.n);
    if (isOpen) verifiedOpen++; else verifiedClosed++;
    verdicts.push({ id: it.id, kind: v.kind, n, isOpen });

    // ── F1 / F2: the register being wrong about itself ────────────────────
    if (it.state === 'open' && !isOpen) {
      failures.push(
        `F1 REGISTER SAYS OPEN, REALITY SAYS CLOSED — ${it.id} "${short(it.what)}". `
        + `Its ${v.kind} verification returned n=${n}, and the item is open only when n ${v.open_if.op} ${v.open_if.n}. `
        + `This is docs/45's 28-fail-open-guards shape: a real finding that got fixed and went on being carried as live backlog. `
        + `FIX: set "state":"closed" on ${it.id} and record closed_by (the commit or migration that did it) — the evidence is this line.`);
    }
    if (it.state === 'closed' && isOpen) {
      failures.push(
        `F2 REGISTER SAYS CLOSED, REALITY SAYS OPEN — ${it.id} "${short(it.what)}". `
        + `Its ${v.kind} verification returned n=${n}, which satisfies open_if ${v.open_if.op} ${v.open_if.n}. `
        + `Something recorded as fixed is answering back. Either the fix regressed or it was never there; `
        + `${it.closed_by ? `the register credits ${it.closed_by}` : 'no closing evidence is recorded'}. `
        + `This is the worse direction: a defect marked done in the one artefact people trust. FIX IT or re-open ${it.id}.`);
    }
  }

  // ── F7: the unverifiable ratchet ────────────────────────────────────────
  const ceiling = reg?.unverifiable_ceiling;
  if (typeof ceiling === 'number' && unverifiable > ceiling) {
    failures.push(
      `F7 UNVERIFIABLE CEILING EXCEEDED — ${unverifiable} item(s) carry no mechanical verification, ceiling is ${ceiling}. `
      + `New deferred work must ship with a way to check it. If this one genuinely cannot be checked, raise the ceiling in ${REGISTER_FILE} `
      + `in the same commit and say in the item's why_unverifiable what a future agent would have to do by hand — so the exception is typed by a person into a diff a reviewer sees.`);
  }

  // ── F5: no-comparisons ──────────────────────────────────────────────────
  if (verified === 0) {
    failures.push(
      `F5 NO-COMPARISONS — ${items.length} item(s) in the register and ZERO runnable verifications. `
      + `Every other arm of this probe is vacuously quiet, so it would print PASS having compared nothing. `
      + `Zero findings from zero comparisons looks exactly like a clean result and must never be one.`);
  }

  // ── The denominators, printed on every run, pass or fail ────────────────
  const bySev = {}, byWhy = {};
  for (const it of items) {
    if (it.state !== 'open') continue;
    bySev[it.severity] = (bySev[it.severity] ?? 0) + 1;
    byWhy[it.why_skipped] = (byWhy[it.why_skipped] ?? 0) + 1;
  }
  const openRecorded = items.filter((i) => i.state === 'open').length;
  notes.push(
    `deferred-register: ${items.length} item(s) total — ${openRecorded} recorded open, ${items.length - openRecorded} recorded closed. `
    + `Re-verified this run: ${verified} (${verifiedOpen} verified STILL OPEN, ${verifiedClosed} verified CLOSED), `
    + `${unverifiable} carried on claim (ceiling ${ceiling}), ${errored} errored.`);
  notes.push(`  open by severity: ${Object.entries(bySev).map(([k, n]) => `${k}=${n}`).join(' · ') || 'none'}`);
  notes.push(`  open by why-skipped: ${Object.entries(byWhy).map(([k, n]) => `${k}=${n}`).join(' · ') || 'none'}`);
  // ⚠ Named individually, never aggregated away. An item nobody can check is a
  // WEAKER position than an item checked and found open; the two must not look
  // alike, which is the whole reason docs/53 marked its 18 with ⏸.
  for (const it of claimCarried) {
    notes.push(`  ⏸ UNVERIFIABLE (carried on claim, NOT a clean result) — ${it.id} [${it.severity}/${it.why_skipped}]: ${short(it.what)} — ${it.verification.why_unverifiable}`);
  }
  return { failures, notes, verdicts, denominators: { total: items.length, openRecorded, verified, verifiedOpen, verifiedClosed, unverifiable, errored } };
}

function short(s, n = 110) { return String(s ?? '').length > n ? String(s).slice(0, n - 1) + '…' : String(s ?? ''); }

// ── The certify entry point ────────────────────────────────────────────────
export async function deferredRegisterSection({ runSql, runSqlDev, root = '.', file = REGISTER_FILE }) {
  let reg;
  try { reg = loadRegister(join(root, file)); }
  catch (e) {
    // A missing or unparseable register is a FAILURE, not a skip: this whole
    // mechanism exists because the previous register could be deleted by
    // inattention and nothing would notice.
    return { ok: false, detail: `F4 the register at ${file} could not be read or parsed: ${String(e.message ?? e).slice(0, 200)}` };
  }
  const { failures, notes } = await evaluateRegister({ reg, runSql, runSqlDev, root });
  for (const n of notes) console.log(`        ${n}`);
  return { ok: failures.length === 0, detail: failures.join('\n') };
}

// ── Self-test: --mutate=<case> ─────────────────────────────────────────────
// The five arms below cannot be expressed as a SELECT that synthesises a
// violating row (the harness certify-mutation-test.mjs uses for SQL probes),
// because the thing under test is a JS evaluation over a JSON file. So the
// mutations live here, behind --mutate, exactly as playbook-branch-parity.mjs
// does — and each run exits 0 ONLY if the injected break was CAUGHT and NAMED
// in the output. certify-mutation-test.mjs records them so they land in that
// suite's denominator rather than in a commit message nobody re-runs.
//
//   node scripts/deferred-register.mjs                  # report, no mutation
//   node scripts/deferred-register.mjs --mutate=<case>
const MUTATIONS = {
  // ⚠ BOTH DIRECTIONS ARE PROVEN, and they are different failures.
  'says-open-but-closed': {
    // Take an item whose verification says CLOSED and record it OPEN.
    apply: (reg, live) => {
      const it = live.closedByVerification[0];
      if (!it) throw new Error('no item currently verifies CLOSED — cannot inject F1');
      reg.items.find((x) => x.id === it.id).state = 'open';
      return { expect: `F1 REGISTER SAYS OPEN, REALITY SAYS CLOSED — ${it.id}` };
    },
  },
  'says-closed-but-open': {
    apply: (reg, live) => {
      const it = live.openByVerification[0];
      if (!it) throw new Error('no item currently verifies OPEN — cannot inject F2');
      const t = reg.items.find((x) => x.id === it.id);
      t.state = 'closed'; t.closed_by = 'MUTATION — no such commit';
      return { expect: `F2 REGISTER SAYS CLOSED, REALITY SAYS OPEN — ${it.id}` };
    },
  },
  'broken-verification': {
    apply: (reg) => {
      const t = reg.items.find((x) => x.verification.kind === 'sql');
      t.verification.sql = 'select this_column_does_not_exist from nowhere_at_all';
      // ⚠ TWO substrings, both required, and the second is the point. An earlier
      // form asserted only "F3 … — A-1" and PASSED off a 429 throttle error that
      // happened to carry the same item id — caught for the wrong reason, which
      // is an inconclusive run, not a proof. The failure must name the item AND
      // quote the injected break.
      return { expect: [`F3 VERIFICATION ERROR — ${t.id}`, 'nowhere_at_all'] };
    },
  },
  'duplicate-id': {
    apply: (reg) => {
      reg.items.push({ ...reg.items[0] });
      return { expect: `F4 schema — duplicate id ${reg.items[0].id}` };
    },
  },
  'closed-without-evidence': {
    apply: (reg, live) => {
      const it = live.closedByVerification[0];
      const t = reg.items.find((x) => x.id === it.id);
      t.state = 'closed'; delete t.closed_by;
      return { expect: `F4 schema — ${it.id} is recorded closed with no \`closed_by\`` };
    },
  },
  'no-comparisons': {
    apply: (reg) => {
      for (const it of reg.items) it.verification = { kind: 'none', why_unverifiable: 'mutation', claim: { file: REGISTER_FILE, anchor: '"items"' } };
      reg.unverifiable_ceiling = reg.items.length;
      return { expect: 'F5 NO-COMPARISONS' };
    },
  },
  'unsupported-claim': {
    apply: (reg) => {
      const t = reg.items.find((x) => x.verification.kind === 'none');
      t.verification.claim = { file: t.verification.claim.file, anchor: 'ZZ this sentence is in no document ZZ' };
      return { expect: `F6 UNSUPPORTED CLAIM — ${t.id}` };
    },
  },
  'unverifiable-over-ceiling': {
    apply: (reg) => {
      const t = reg.items.find((x) => x.verification.kind !== 'none');
      t.verification = { kind: 'none', why_unverifiable: 'mutation', claim: { file: REGISTER_FILE, anchor: '"items"' } };
      return { expect: 'F7 UNVERIFIABLE CEILING EXCEEDED' };
    },
  },
};

if (import.meta.url === `file://${process.argv[1].split(sep).join('/')}` || process.argv[1]?.endsWith('deferred-register.mjs')) {
  const MUTATE = (process.argv.find((a) => a.startsWith('--mutate=')) ?? '').split('=')[1] || null;
  const PROD_REF = 'rfsvmhcqeiyrxivbmpel';
  const DEV_REF = 'nmuntxrcdksyhsdywpan';
  const tok = (() => {
    const fromEnv = process.env.SUPABASE_ACCESS_TOKEN?.trim();
    if (fromEnv) return fromEnv;
    const env = readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
    const line = env.split(/\r?\n/).find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='));
    return line.slice('SUPABASE_ACCESS_TOKEN='.length).replace(/^["']|["']$/g, '').trim();
  })();
  // Retry policy copied from certify.mjs, and for the same reason: TRANSPORT
  // ONLY. A 4xx is where a genuine SQL error lands, and retrying one would be
  // retrying a broken verification into a timeout instead of reporting F3.
  const mk = (ref) => async function run(sql, attempt = 0) {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql }),
    }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
    const t = await res.text();
    if (!res.ok) {
      if ((res.status === 429 || res.status >= 500 || res.status === 0) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        return run(sql, attempt + 1);
      }
      throw new Error(`Management API ${res.status}: ${t.slice(0, 180)}`);
    }
    return JSON.parse(t);
  };
  const runSql = mk(PROD_REF), runSqlDev = mk(DEV_REF);

  const base = loadRegister();
  // ONE unmutated pass. It is both the plain report and the source of truth for
  // which items currently verify open / closed — so the two direction
  // mutations pick a REAL item off live evidence rather than one chosen to make
  // the test pass, and no mutation costs a second round of queries.
  const first = await evaluateRegister({ reg: base, runSql, runSqlDev });
  const live = {
    openByVerification: first.verdicts.filter((v) => v.isOpen === true).map((v) => ({ id: v.id })),
    closedByVerification: first.verdicts.filter((v) => v.isOpen === false).map((v) => ({ id: v.id })),
  };

  if (!MUTATE) {
    for (const n of first.notes) console.log(n);
    if (first.failures.length) { console.log('\nFAILURES:'); for (const f of first.failures) console.log(`  ${f}`); }
    console.log(`\n${first.failures.length ? `NOT CLEAN — ${first.failures.length} failure(s)` : 'register agrees with reality'}`);
    process.exit(first.failures.length ? 1 : 0);
  }

  const m = MUTATIONS[MUTATE];
  if (!m) { console.error(`unknown mutation "${MUTATE}". Known: ${Object.keys(MUTATIONS).join(', ')}`); process.exit(1); }
  const mutated = JSON.parse(JSON.stringify(base));
  const { expect } = m.apply(mutated, live);
  const want = Array.isArray(expect) ? expect : [expect];
  const r = await evaluateRegister({ reg: mutated, runSql, runSqlDev });
  // CAUGHT means ONE failure line carries every expected substring. Not "some
  // failure fired" — a probe that goes red for an unrelated reason has not
  // caught anything, and counting it would be the padded number this file's
  // sibling (certify-mutation-test.mjs) exists to stop.
  const caught = r.failures.some((f) => want.every((w) => f.includes(w)));
  for (const f of r.failures) console.log(`  ${f}`);
  console.log(`\n--mutate=${MUTATE}: ${caught ? 'CAUGHT' : 'NOT CAUGHT'} — expected ONE failure containing all of ${JSON.stringify(want)}`);
  process.exit(caught ? 0 : 1);
}
