// ============================================================================
// edge-deployed-parity.mjs — what is RUNNING, compared against what `main` says.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// On 2026-08-18 register item D-12 ("71 floating remote imports across the edge
// functions") was recorded CLOSED on the strength of a grep of the local
// working tree. The grep was correct: the repo held zero unpinned imports. The
// CLAIM, however, was about the code an attacker or a broken upstream would
// actually reach — the DEPLOYED bundles — and 60 of the 64 deployed functions
// were still running the unpinned version, and went on doing so for two days
// with nothing detecting it. The register asked the repository a question whose
// subject was production.
//
// Two facts make this class of drift invisible without a probe like this one:
//
//  1. Deploying is a MANUAL step (`node scripts/deploy.mjs --fn <slug>`). Unlike
//     the frontend — which Vercel rebuilds from `main` with no human in the
//     loop — an edge function only changes when somebody runs a command. A
//     merged fix is therefore not a live fix, and nothing in the repo says so.
//  2. Five deploys in that window printed "Deployed Functions." and changed
//     nothing. A command that reports success is the worst possible signal:
//     it converts "I did not check" into "I checked and it was fine".
//
// ── ⚠ TIMESTAMPS ARE NOT EVIDENCE, PROVEN HERE ─────────────────────────────
//
// The obvious probe compares the deployed `updated_at` against the file's git
// mtime or last-commit date. It was tried during the audit that found D-12 and
// it is USELESS: 61 of 65 functions were flagged by mtime, of which almost all
// were byte-identical to `main`. A checkout, a rebase, a merge, a parallel
// session touching `_shared/*`, or simply cloning the repo rewrites mtimes; and
// a deploy re-stamps `updated_at` even when the bundle it uploaded is the same
// bytes. A signal with a ~94% false-positive rate is not a ratchet, it is noise
// that trains people to ignore the section. So this probe compares CONTENT.
//
// ── HOW THE CONTENT IS OBTAINED ─────────────────────────────────────────────
//
// `GET /v1/projects/{ref}/functions/{slug}/body` returns the deployed ESZIP v2.3
// bundle — the exact artefact the edge runtime executes. Module sources are
// stored UNCOMPRESSED inside it, so every file that went into the deploy
// (`functions/<slug>/index.ts` plus the per-deploy snapshot of each
// `functions/_shared/*.ts` it imported) can be read back byte for byte and
// diffed against `git show origin/main:supabase/<path>`.
//
// This is the same method docs/32-pre-start-reports/01-deploy-parity.md used on
// 2026-07-27 (it drove `supabase functions download`, which unpacks the same
// bundle); reading the eszip directly removes the CLI, the network round trip
// per file, and the temp directory, and it also yields the module GRAPH — every
// remote import specifier the deploy actually resolved — which is what D-12 has
// to be asked about.
//
// ── ⚠ THE PARSER MUST THROW, NEVER RETURN "NO DRIFT" ────────────────────────
//
// Every failure mode below raises: an unknown magic, an unknown header entry
// kind, a sources section whose anchor cannot be located, a file missing on
// `origin/main`. A bundle this cannot read is UNVERIFIABLE and is reported as
// such with its slug; it is never counted as in-sync. Silently returning zero
// drift from a parser that gave up is the same defect one layer down.
// ============================================================================
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

export const PROD_REF = 'rfsvmhcqeiyrxivbmpel';

// Deliberate, argued exclusions. Anything not listed here is compared.
// ⚠ An exclusion is a hole; each one has to say why it is not a bug.
export const EXCLUDED = {
  // Another session is mid-flight on de-answer: its fix is on a branch that has
  // not merged, so the deployed bundle is legitimately not `main` right now.
  // Left out by the audit that found D-12 for the same reason. REMOVE THIS
  // ENTRY once that branch lands — the exclusion, not the drift, is the debt.
  'de-answer': 'unmerged fix in flight in a parallel session (2026-08-20)',
  // Exists in the repo, has never been deployed. Absent from the deployed list
  // entirely, so it can only ever show up as "in repo, not deployed".
  'mcp-demo-server': 'never deployed — repo-only function',
};

// Pseudo-modules the Supabase bundler injects. They are not repo files.
const SYNTHETIC = new Set(['---SUPABASE-ESZIP-VERSION-ESZIP---', '---EDGE-RUNTIME-METADATA---']);

export function readToken() {
  const fromEnv = process.env.SUPABASE_ACCESS_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const env = readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
  const line = env.split(/\r?\n/).find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='));
  if (!line) throw new Error('SUPABASE_ACCESS_TOKEN not found in .env.local');
  return line.slice('SUPABASE_ACCESS_TOKEN='.length).replace(/^["']|["']$/g, '').trim();
}

// Transport-only retry, same policy as certify.mjs: a 4xx is a real answer and
// retrying it would turn a reportable error into a timeout.
async function api(token, path, { raw = false, attempt = 0 } = {}) {
  const res = await fetch(`https://api.supabase.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch((e) => ({ ok: false, status: 0, text: async () => String(e), arrayBuffer: async () => new ArrayBuffer(0) }));
  if (!res.ok) {
    if ((res.status === 429 || res.status >= 500 || res.status === 0) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      return api(token, path, { raw, attempt: attempt + 1 });
    }
    throw new Error(`Management API ${res.status} on ${path}: ${String(await res.text()).slice(0, 160)}`);
  }
  return raw ? Buffer.from(await res.arrayBuffer()) : JSON.parse(await res.text());
}

export const listDeployed = (token, ref = PROD_REF) => api(token, `/projects/${ref}/functions`);
export const fetchBundle = (token, slug, ref = PROD_REF) => api(token, `/projects/${ref}/functions/${slug}/body`, { raw: true });

// ── The ESZIP v2 reader ────────────────────────────────────────────────────
//
//   magic "ESZIP2.x" (8) | u32 options_len | options | u32 header_len | header
//   | u32 npm_snapshot_len | npm_snapshot | u32 sources_len | sources | ...
//
// The npm snapshot is empty (length 0) for every function that imports only
// URLs, and non-empty for the ones that import a bare npm specifier — push-send
// carries `web-push@3.6.7` and 740 bytes of snapshot. An earlier version of
// this parser assumed the snapshot was never there, which put every source
// offset 744 bytes out on exactly one function.
//
// ⚠ THE OFFSET IS THEN CHECKED, NOT TRUSTED. The header independently says
// where the last module ends; if the u32 at the computed sources position does
// not equal that total, the layout is not the one this parser understands and
// it THROWS. Mis-slicing every source would otherwise report all 64 functions
// as drifted — a red that is indistinguishable from a real one.
export function parseEszip(buf) {
  const magic = buf.slice(0, 8).toString('latin1');
  if (!magic.startsWith('ESZIP')) throw new Error(`not an eszip bundle (magic ${JSON.stringify(magic)})`);
  let p = 8;
  const optLen = buf.readUInt32BE(p); p += 4 + optLen;
  const hdrLen = buf.readUInt32BE(p); p += 4;
  const hdr = buf.slice(p, p + hdrLen);
  if (hdr.length !== hdrLen) throw new Error(`truncated bundle: header wants ${hdrLen} bytes, ${hdr.length} available`);
  const hdrEnd = p + hdrLen;

  const entries = [];
  let q = 0, sourcesEnd = 0;
  while (q < hdr.length) {
    const sl = hdr.readUInt32BE(q); q += 4;
    const spec = hdr.slice(q, q + sl).toString('utf8'); q += sl;
    const kind = hdr.readUInt8(q); q += 1;
    if (kind === 0) {
      const so = hdr.readUInt32BE(q), sn = hdr.readUInt32BE(q + 4); q += 17;
      entries.push({ spec, so, sn });
      sourcesEnd = Math.max(sourcesEnd, so + sn);
    } else if (kind === 1) {
      const rl = hdr.readUInt32BE(q); q += 4;
      entries.push({ spec, redirect: hdr.slice(q, q + rl).toString('utf8') }); q += rl;
    } else if (kind === 2) {
      // NpmSpecifier — a u32 index into the bundle's npm snapshot. Carries no
      // source of its own; recorded as a remote so the import census sees it.
      q += 4;
      entries.push({ spec, npm: true });
    } else {
      // Anything newer. An unknown entry kind makes every offset after this
      // point meaningless, so the whole bundle is unverifiable — and says so.
      throw new Error(`unknown eszip header entry kind ${kind} at header offset ${q - 1} (specifier ${JSON.stringify(spec)})`);
    }
  }

  const npmLen = buf.readUInt32BE(hdrEnd);
  const sourcesLenAt = hdrEnd + 4 + npmLen;
  if (sourcesLenAt + 4 > buf.length) throw new Error(`npm snapshot length ${npmLen} runs past the end of the bundle`);
  const declared = buf.readUInt32BE(sourcesLenAt);
  if (declared !== sourcesEnd) throw new Error(`sources section not where the layout says: the header's modules end at ${sourcesEnd} but the u32 after the npm snapshot (len ${npmLen}) reads ${declared}`);
  const base = sourcesLenAt + 4;
  if (base + sourcesEnd > buf.length) throw new Error(`sources section runs past the end of the bundle (${base}+${sourcesEnd} > ${buf.length})`);

  const modules = new Map();
  const remotes = [];
  for (const e of entries) {
    if (e.npm || e.redirect !== undefined) { remotes.push(e.spec); continue; }
    // ANY scheme is remote, not just http(s): a bundle carrying an npm
    // dependency also carries that package's files as `vfs://<n>` modules, and
    // those are no more repo files than a deno.land URL is.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(e.spec)) { remotes.push(e.spec); continue; }
    if (SYNTHETIC.has(e.spec)) continue;
    modules.set(e.spec, buf.slice(base + e.so, base + e.so + e.sn).toString('utf8'));
  }
  return { modules, remotes, entryCount: entries.length };
}

// ── ⚠ WHAT IS DEPLOYED IS NOT THE FILE, IT IS THE FILE'S EMIT ───────────────
//
// The eszip stores the TRANSPILED module, not the .ts that produced it. Deno's
// emitter strips type annotations, collapses blank lines, reflows the source
// and drops trailing commas, so `deployed bytes === repo bytes` is false for
// every function including the ones that are perfectly in sync. (The 2026-07-27
// parity pass got away with a byte diff because `supabase functions download`
// then returned the original sources; the /body endpoint returns the emit.)
//
// So both sides are put through ONE normalizer and compared there:
//   1. tsc transpile — strips types from the repo side, no-ops on the deployed
//      side (already JS), and reprints BOTH through the same printer;
//   2. comments removed — the two emitters attach comments differently
//      (`*/\nexport` vs `*/ export`) and a comment is not running code;
//   3. REDUNDANT PARENTHESES REMOVED AT THE AST LEVEL — deno's emitter drops
//      `const d = (data ?? null)` to `const d = data ?? null`, tsc's printer
//      keeps whatever its input had. Both sides are re-parsed and every
//      ParenthesizedExpression node is unwrapped before printing, so the two
//      converge on ONE spelling. Done on the tree, not with a regex over text:
//      deleting bracket characters from a string would also flatten
//      `(a || b) && c` into `a || b && c` and hide a real change.
//   4. ARROW PARAMETER LISTS RE-SYNTHESIZED — deno emits `.map((o) => …)`, the
//      repo writes `.map(o => …)`. Identical trees; the printer only kept the
//      spelling its input happened to have. Each parameter is rebuilt as a
//      fresh factory node so ONE printer rule decides both sides.
//      CANONICAL DIRECTION: bare, `o => …` (that is the printer's default for
//      a synthesized single-identifier parameter).
//   5. SINGLE-STATEMENT BODIES WRAPPED IN A BLOCK — deno emits
//      `if (x) { for (…) …; }` where the repo writes `if (x) for (…) …;`, for
//      if/else, for, for-of, for-in, while and do.
//      CANONICAL DIRECTION: always braced. Chosen deliberately in the ADDING
//      direction because the reverse is not always legal or equivalent — a
//      lone `let`/`const`/`class` cannot be a bare body at all, and
//      `if (a) { function f(){} }` is not `if (a) function f(){}`. Wrapping
//      can never change meaning; unwrapping can.
//   6. `||`, `&&` and `??` CHAINS RE-ASSOCIATED TO LEFT-NESTED — see below.
//   7. whitespace collapsed, whitespace around punctuators removed, trailing
//      commas before ) ] } dropped — the remaining places the emitters
//      disagree (`{ a }` vs `{a}`, `x, }` vs `x }`, `asUser\n.from(` vs
//      `asUser.from(`). None can change what the code does.
//
// ⚠ WHY (3) IS NOT ENOUGH ON ITS OWN, MEASURED 2026-08-20. Unwrapping the node
// does not remove the parenthesis, because ts.visitEachChild RE-APPLIES the
// parenthesizer rules when it updates a BinaryExpression: hand it a right
// operand that needs parens to keep the tree's shape and it puts them back. So
// `a ?? (b ?? c)` survived step 3 intact. That is not a cosmetic accident —
// `a ?? (b ?? c)` and `(a ?? b) ?? c` are genuinely DIFFERENT TREES, and the
// printer is right to distinguish them. They are, however, the same PROGRAM:
// `||`, `&&` and `??` are associative in value AND in evaluation order AND in
// what they short-circuit. So the trees are re-associated to left-nested,
// which is the shape that needs no parentheses at all, and both sides converge.
//
// ⚠ THE LIST IS EXACTLY THOSE THREE OPERATORS AND MUST STAY THAT WAY. `-` and
// `/` are not associative, `+` is not associative once a string is involved
// (`1 + (2 + '3')` is '123', `(1 + 2) + '3'` is '33'), and floating-point `*`
// is not associative either. Re-associating any of those would erase a real
// change. Nothing is re-associated ACROSS operators: `(a || b) && c` and
// `a || (b && c)` stay distinct, which is the case that actually matters.
//
// ⚠ RESIDUAL, STATED NOT HIDDEN: this comparison is blind to changes that
// survive none of the above — a comment-only edit, or a whitespace-only one,
// deployed or not, reads as IN SYNC. That is a deliberate trade: those cannot
// change behaviour, and a comparison that flagged them would flag every
// function on every run, which is the timestamp failure again in another skin.
//
// ⚠ SECOND RESIDUAL, found while fixing the first and left alone deliberately:
// `ts.transpileModule` ELIDES AN IMPORT WHOSE BINDING IS NEVER USED, so
// `import x from 'A'` and `import x from 'B'` both normalize to nothing when
// `x` is dead — and a module's side effects would change unseen. It is narrow:
// side-effect imports (`import 'https://…'`, which is what D-12 is about) carry
// no binding to elide and ARE compared, as the mutation tests pin. Widening it
// means preserving type-only imports too, which would manufacture a fresh crop
// of false positives against deno's emit — the defect this pass exists to
// remove. Named here rather than silently carried.
const ASSOC_OPS = new Set([
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);
const unparen = (e) => { while (ts.isParenthesizedExpression(e)) e = e.expression; return e; };

// ── The mutation seam ───────────────────────────────────────────────────────
// Inert unless `--mutate=` is passed on this file's own CLI. It exists so the
// self-test at the bottom can be scored the only way a checker's self-test can
// mean anything: by BREAKING the normalizer in one named way and requiring the
// suite to catch it. Nothing in the measurement path ever sets it.
let MUTATION = null;
export const setMutation = (m) => { MUTATION = m; };
const mutating = (m) => MUTATION === m;

const canonicalise = (ctx) => (root) => {
  const ops = new Set(ASSOC_OPS);
  if (mutating('reassociate-minus')) ops.add(ts.SyntaxKind.MinusToken);
  if (mutating('reassociate-plus')) ops.add(ts.SyntaxKind.PlusToken);
  const visit = (n) => {
    let v = ts.visitEachChild(n, visit, ctx);
    if (ts.isParenthesizedExpression(v)) v = v.expression;

    // (4) one printer rule for every arrow parameter list, whatever the input
    // spelled. Types and question tokens are already gone at this point (the
    // tree is post-transpile JS); modifiers and rest tokens are carried over.
    if (ts.isArrowFunction(v) && !mutating('drop-arrow-canonicalisation')) {
      const params = v.parameters.map((p) => ts.factory.createParameterDeclaration(
        undefined, p.dotDotDotToken, p.name, undefined, undefined, p.initializer));
      v = ts.factory.createArrowFunction(v.modifiers, undefined, params, undefined, v.equalsGreaterThanToken, v.body);
    }

    // (5) always braced. Wrapping is the safe direction; see the note above.
    const braced = (s) => (s && !ts.isBlock(s) && !mutating('drop-brace-canonicalisation') ? ts.factory.createBlock([s], true) : s);
    if (ts.isIfStatement(v)) {
      v = ts.factory.updateIfStatement(v, v.expression, braced(v.thenStatement), v.elseStatement ? braced(v.elseStatement) : undefined);
    } else if (ts.isForStatement(v)) {
      v = ts.factory.updateForStatement(v, v.initializer, v.condition, v.incrementor, braced(v.statement));
    } else if (ts.isForOfStatement(v)) {
      v = ts.factory.updateForOfStatement(v, v.awaitModifier, v.initializer, v.expression, braced(v.statement));
    } else if (ts.isForInStatement(v)) {
      v = ts.factory.updateForInStatement(v, v.initializer, v.expression, braced(v.statement));
    } else if (ts.isWhileStatement(v)) {
      v = ts.factory.updateWhileStatement(v, v.expression, braced(v.statement));
    } else if (ts.isDoStatement(v)) {
      v = ts.factory.updateDoStatement(v, braced(v.statement), v.expression);
    }

    // (6) `a op (b op c)` -> `(a op b) op c`, SAME operator only, for the three
    // operators where that is provably meaning-preserving. Looks THROUGH any
    // parenthesis the parenthesizer re-added, which is the whole reason this
    // step exists rather than relying on step 3.
    if (ts.isBinaryExpression(v) && ops.has(v.operatorToken.kind) && !mutating('drop-assoc-canonicalisation')) {
      const op = v.operatorToken.kind;
      // ⚠ The operator-EQUALITY test is what keeps `(a || b) && c` distinct from
      // `a || (b && c)`. --mutate=reassociate-across-operators removes it.
      const sameOp = (r) => (mutating('reassociate-across-operators') ? ops.has(r.operatorToken.kind) : r.operatorToken.kind === op);
      // ⚠ COLLECT THE WHOLE CHAIN, THEN REBUILD IT LEFT-NESTED. A single
      // rotation is NOT enough and quietly leaves a paren behind: rotating
      // `a ?? ((b ?? c) ?? d)` once yields `(a ?? (b ?? c)) ?? d`, whose left
      // operand is still right-nested, so the printer parenthesises it and the
      // two sides never converge. Measured on de-work/index.ts and
      // playbook-draft/index.ts, which is why the self-test runs over real
      // modules at full size and not only over the minimal pairs.
      const operands = [];
      const flatten = (e) => {
        const u = unparen(e);
        if (ts.isBinaryExpression(u) && sameOp(u)) { flatten(u.left); flatten(u.right); }
        else operands.push(u);
      };
      flatten(v.left); flatten(v.right);
      let acc = operands[0];
      for (let i = 1; i < operands.length; i++) acc = ts.factory.createBinaryExpression(acc, v.operatorToken, operands[i]);
      v = acc;
    }
    return v;
  };
  return ts.visitNode(root, visit);
};

export function normalizeModule(src, spec) {
  // --mutate=erase-everything: the catastrophic shape this self-test exists for
  // — a normalizer that agrees with itself about everything and reports a fleet
  // in perfect parity while production runs whatever it likes.
  if (mutating('erase-everything')) return '';
  const clean = String(src).replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const js = ts.transpileModule(clean, {
    fileName: spec,
    reportDiagnostics: false,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      removeComments: true,
      newLine: ts.NewLineKind.LineFeed,
      isolatedModules: true,
    },
  }).outputText;
  const sf = ts.createSourceFile('m.js', js, ts.ScriptTarget.ESNext, false, ts.ScriptKind.JS);
  const transformed = ts.transform(sf, [canonicalise]).transformed[0];
  return ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed })
    .printFile(transformed)
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}()[\];,:.])\s*/g, '$1')
    .replace(/,(?=[)\]}])/g, '')
    .trim();
}

function gitShow(ref, path) {
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
}

// Deploys made by different CLI versions record the entry module either as
// `functions/<slug>/index.ts` or as `<slug>/index.ts`. Both mean the same repo
// file; guessing wrong would report every such function as "absent from main",
// which is a manufactured finding.
function repoPathsFor(spec) {
  return spec.startsWith('functions/') ? [`supabase/${spec}`] : [`supabase/functions/${spec}`, `supabase/${spec}`];
}

// ── The comparison ─────────────────────────────────────────────────────────
// Returns one verdict per deployed function. `drifted` is the number the
// register pins on; `unverifiable` is printed separately and is NEVER folded
// into "in sync".
// ⚠ ONE PASS PER RUN, NOT ONE PER VERIFICATION.
// The register asks this module three separate questions (deployed-vs-main,
// D-12's unpinned imports, and a content question about one function's
// behaviour). Answering each with its own download meant 63 bundles fetched
// three times, and the Management API answered 429 — which this module
// correctly reports as UNVERIFIABLE, i.e. a red run caused by throttling. That
// is the same failure the register's own header records for its SQL probes ("a
// red caused by rate-limiting is exactly the noise that teaches people to
// re-run a gate until it is green"), so the same fix applies: one pass, shared.
const PASSES = new Map();
export function resetParityCache() { PASSES.clear(); }
export function measureParity(opts = {}) {
  const key = `${opts.ref ?? PROD_REF}|${opts.tree ?? 'origin/main'}`;
  if (!PASSES.has(key)) PASSES.set(key, measureParityUncached(opts));
  return PASSES.get(key);
}

async function measureParityUncached({ token, ref = PROD_REF, tree = 'origin/main', concurrency = 4 } = {}) {
  const deployed = await listDeployed(token, ref);
  const targets = deployed.filter((f) => !EXCLUDED[f.slug]);
  const excluded = deployed.filter((f) => EXCLUDED[f.slug]).map((f) => ({ slug: f.slug, why: EXCLUDED[f.slug] }));

  const verdicts = [];
  const queue = [...targets];
  const worker = async () => {
    for (;;) {
      const fn = queue.shift();
      if (!fn) return;
      try {
        const { modules, remotes } = parseEszip(await fetchBundle(token, fn.slug, ref));
        if (modules.size === 0) throw new Error('bundle contains no local module sources');
        const diffs = [];
        for (const [spec, deployedText] of modules) {
          let onMain = null;
          for (const p of repoPathsFor(spec)) { onMain = gitShow(tree, p); if (onMain !== null) break; }
          if (onMain === null) { diffs.push(`${spec} (deployed, absent from ${tree})`); continue; }
          // A file that will not transpile is UNVERIFIABLE, not in-sync: it
          // propagates out of the worker as this function's error.
          if (normalizeModule(onMain, spec) !== normalizeModule(deployedText, spec)) diffs.push(spec);
        }
        verdicts.push({ slug: fn.slug, files: modules.size, diffs, remotes, modules, status: fn.status, version: fn.version });
      } catch (e) {
        verdicts.push({ slug: fn.slug, error: String(e.message ?? e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  verdicts.sort((a, b) => a.slug.localeCompare(b.slug));

  return {
    tree,
    deployed: deployed.length,
    compared: targets.length,
    excluded,
    inSync: verdicts.filter((v) => !v.error && v.diffs.length === 0),
    drifted: verdicts.filter((v) => !v.error && v.diffs.length > 0),
    unverifiable: verdicts.filter((v) => v.error),
    verdicts,
  };
}

// ── The two scalars the register asks for ──────────────────────────────────
// Each returns an integer and throws on anything it could not measure, so a
// broken run lands in the register as F3 VERIFICATION ERROR rather than as a
// confident zero.
export async function countDriftedFromMain(opts = {}) {
  const r = await measureParity(opts);
  if (r.unverifiable.length) throw new Error(`${r.unverifiable.length} of ${r.compared} deployed bundle(s) could not be read: ${r.unverifiable.map((v) => `${v.slug} — ${v.error}`).join(' · ').slice(0, 300)}`);
  if (r.compared === 0) throw new Error('zero deployed functions compared — a parity check with no comparisons is not a clean result');
  return { n: r.drifted.length, report: r };
}

// ── D-12's real question ───────────────────────────────────────────────────
// Does the code that is RUNNING import remote modules at an unpinned
// specifier? Asked of the deployed module SOURCES with D-12's own pattern, so
// it is the same question the repo grep asked, put to the right subject.
//
// ⚠ NOT asked of the bundle's module GRAPH, deliberately. The graph also
// contains everything esm.sh pulled in transitively — `iceberg-js@^0.8.1`,
// `whatwg-url@^5.0.0`, and so on — which no edit to this repository can pin.
// Counting those would make D-12 permanently open for reasons nobody here can
// act on, which is the "red nobody owns" the register's header rules out. The
// transitive graph is worth knowing and is printed by the CLI; it is not the
// pin.
export const ANY_REMOTE_IMPORT = /from\s+['"]https:\/\/[^'"]+['"]/g;
export const FLOATING_IMPORT = /from\s+['"]https:\/\/(?![^'"]*@\d+\.\d+\.\d+)[^'"]+['"]/g;
export async function countFloatingDeployedImports(opts = {}) {
  const r = await measureParity(opts);
  if (r.unverifiable.length) throw new Error(`${r.unverifiable.length} of ${r.compared} deployed bundle(s) could not be read: ${r.unverifiable.map((v) => `${v.slug} — ${v.error}`).join(' · ').slice(0, 300)}`);
  if (r.compared === 0) throw new Error('zero deployed functions compared — a floating-import count over no bundles is not a clean result');
  let n = 0, modulesScanned = 0, remoteImports = 0;
  const offenders = new Map();
  for (const v of r.verdicts) {
    for (const [spec, text] of v.modules ?? []) {
      modulesScanned++;
      remoteImports += (text.match(ANY_REMOTE_IMPORT) ?? []).length;
      FLOATING_IMPORT.lastIndex = 0;
      for (const m of text.match(FLOATING_IMPORT) ?? []) {
        n++;
        const key = `${v.slug} › ${spec}: ${m.slice(0, 120)}`;
        offenders.set(key, (offenders.get(key) ?? 0) + 1);
      }
    }
  }
  // ⚠ COUNT THE COMPARISONS, NOT JUST THE FINDINGS. "0 unpinned" is only news
  // if remote imports were actually seen; 0 out of 0 is what a broken scan
  // looks like, and it looks exactly like a clean result.
  if (modulesScanned === 0) throw new Error('zero deployed modules scanned — an import count over no modules is not a clean result');
  if (remoteImports === 0) throw new Error(`scanned ${modulesScanned} deployed module(s) and found NO remote imports at all — these functions certainly have some, so the scan is broken and its zero is not a clean result`);
  return { n, offenders, modulesScanned, remoteImports, report: r };
}

// A single deployed bundle, asked a content question. This is what a claim
// about one function's RUNTIME BEHAVIOUR has to be pinned on — the local file
// answers a different question.
export async function countInDeployedBundle({ token, slug, pattern, flags = 'g', files = null, ref = PROD_REF, tree = 'origin/main' }) {
  const r = await measureParity({ token, ref, tree });
  const v = r.verdicts.find((x) => x.slug === slug);
  // ⚠ A function that is not deployed, or whose bundle would not parse, must
  // NOT read as "pattern absent". Both throw, so the register records F3
  // VERIFICATION ERROR — the item named, the reason printed — rather than a
  // confident zero from a probe that never saw its subject.
  if (!v) throw new Error(`${slug} is not among the ${r.deployed} deployed function(s)${EXCLUDED[slug] ? ` (it is excluded: ${EXCLUDED[slug]})` : ''} — a content question about a function that is not running cannot be answered, and must not be answered as zero`);
  if (v.error) throw new Error(`the deployed ${slug} bundle could not be read: ${v.error}`);
  const modules = v.modules;
  if (!modules || modules.size === 0) throw new Error(`deployed bundle for ${slug} contains no local module sources`);
  const re = new RegExp(pattern, flags.includes('g') ? flags : `${flags}g`);
  // Deploys made by different CLI versions spell the entry module either
  // `functions/<slug>/index.ts` or `<slug>/index.ts` (push-send is the second
  // form today). A `files` list written in one spelling must not silently match
  // nothing against the other — that would be a zero from zero comparisons.
  const bare = (s) => s.replace(/^functions\//, '');
  const want = files ? new Set(files.map(bare)) : null;
  let n = 0, looked = 0;
  for (const [spec, text] of modules) {
    if (want && !want.has(bare(spec))) continue;
    looked++;
    re.lastIndex = 0;
    n += (text.match(re) ?? []).length;
  }
  if (looked === 0) throw new Error(`no module in the deployed ${slug} bundle matched ${JSON.stringify(files)} — the file list is wrong, and zero matches over zero files is not a clean result (bundle holds: ${[...modules.keys()].join(', ').slice(0, 300)})`);
  return n;
}

// ============================================================================
// ── ⚠ THE SELF-TEST: A NORMALIZER THAT ERASES EVERYTHING LOOKS PERFECT ──────
//
// The canonicalisation above removed 27 false DRIFTED verdicts. The failure it
// could have introduced instead is far worse than the 27: a normalizer that
// flattens a REAL change into agreement would report perfect parity while
// production ran stale code — which is the exact defect (D-12) this whole
// module exists to catch, reintroduced one layer down and wearing a green tick.
// "0 drifted" from a broken normalizer is indistinguishable from "0 drifted"
// from a healthy fleet.
//
// So the canonicalisation is pinned in BOTH directions, offline, with no
// network and no token:
//
//   POSITIVE — a pair that differs BEHAVIOURALLY must still report DRIFTED,
//   *even when it also carries every cosmetic difference we now erase*. The
//   fixture is REAL HISTORY, not a toy: de-work/index.ts and eval-run/index.ts
//   at a54d5b54^ — the `bearer === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')`
//   string-equality check that broke on 2026-08-18 when Supabase rotated the
//   key — against those same files on `main`, which call serviceCaller(). That
//   is precisely a stale deploy of the shape B-16 is about, and it is run
//   through cosmeticVariant() first so the real change has to survive the noise.
//
//   NEGATIVE — a pair differing ONLY in the cosmetic forms must report IN SYNC.
//
//   ⚠ COUNT THE COMPARISONS. cosmeticVariant() is an AST transform, so if it
//   ever silently stopped perturbing anything, every NEGATIVE case would pass
//   by comparing a file with itself and every POSITIVE case would still pass on
//   its behavioural change alone. The suite therefore asserts that each variant
//   ACTUALLY CHANGED THE TEXT, and fails as NO-COMPARISONS if it did not.
// ============================================================================

// The inverse of the canonicalisation: re-introduces, at the AST level, the
// spellings deno's emitter produces. Two of the three forms are reachable this
// way (blocks and associativity); the arrow-parameter form is not expressible
// through the printer, so it is pinned by the hand-written MINIMAL_PAIRS below,
// which are small enough to audit by eye.
const denoish = (ctx) => (root) => {
  const visit = (n) => {
    let v = ts.visitEachChild(n, visit, ctx);
    // Blocks holding exactly one statement lose their braces — but ONLY when
    // that is legal: a lone declaration is not a valid unbraced body.
    const bare = (s) => {
      if (!s || !ts.isBlock(s) || s.statements.length !== 1) return s;
      const only = s.statements[0];
      if (ts.isVariableStatement(only) || ts.isFunctionDeclaration(only) || ts.isClassDeclaration(only)) return s;
      return only;
    };
    if (ts.isIfStatement(v)) v = ts.factory.updateIfStatement(v, v.expression, bare(v.thenStatement), v.elseStatement ? bare(v.elseStatement) : undefined);
    else if (ts.isForStatement(v)) v = ts.factory.updateForStatement(v, v.initializer, v.condition, v.incrementor, bare(v.statement));
    else if (ts.isForOfStatement(v)) v = ts.factory.updateForOfStatement(v, v.awaitModifier, v.initializer, v.expression, bare(v.statement));
    else if (ts.isForInStatement(v)) v = ts.factory.updateForInStatement(v, v.initializer, v.expression, bare(v.statement));
    else if (ts.isWhileStatement(v)) v = ts.factory.updateWhileStatement(v, v.expression, bare(v.statement));
    // `(a op b) op c` -> `a op (b op c)`: the RIGHT-nested shape, which is the
    // one the printer has to parenthesise and which defeated the old dropParens.
    if (ts.isBinaryExpression(v) && ASSOC_OPS.has(v.operatorToken.kind)) {
      const op = v.operatorToken.kind;
      const l = unparen(v.left);
      if (ts.isBinaryExpression(l) && l.operatorToken.kind === op) {
        v = ts.factory.createBinaryExpression(l.left, v.operatorToken,
          ts.factory.createBinaryExpression(l.right, v.operatorToken, v.right));
      }
    }
    return v;
  };
  return ts.visitNode(root, visit);
};

// Plain transpile + reprint, NO cosmetic transform. This is the control the
// variant is measured against, so "did the variant actually change anything"
// is a real question with a real answer.
function plainPrint(src) {
  const clean = String(src).replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const js = ts.transpileModule(clean, {
    fileName: 'v.ts',
    reportDiagnostics: false,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
      removeComments: true, newLine: ts.NewLineKind.LineFeed, isolatedModules: true,
    },
  }).outputText;
  const sf = ts.createSourceFile('v.js', js, ts.ScriptTarget.ESNext, false, ts.ScriptKind.JS);
  return { sf, text: ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed }).printFile(sf) };
}

export function cosmeticVariant(src) {
  // --mutate=no-perturbation: makes the noise generator a no-op, so every
  // negative arm would compare a file with itself and pass having proven
  // nothing. The suite must notice that it compared nothing.
  if (mutating('no-perturbation')) return plainPrint(src).text;
  const { sf } = plainPrint(src);
  return ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed })
    .printFile(ts.transform(sf, [denoish]).transformed[0]);
}

// Hand-written, deliberately tiny, and each one measured in a real bundle on
// 2026-08-20. `same: true` means the two spellings are the SAME program and
// must normalize equal; `same: false` means they are DIFFERENT programs and
// must NOT, no matter how similar they look.
export const MINIMAL_PAIRS = [
  // ── the three cosmetic forms: MUST be erased ────────────────────────────
  { same: true, name: 'arrow single parameter — tool-learn differed at 3 chars of 5758',
    a: 'export const f = (xs) => xs.map((o) => o.id);', b: 'export const f = xs => xs.map(o => o.id);' },
  { same: true, name: 'braces around a single-statement body — serviceCaller.ts, 23 bundles',
    a: 'export function f(t, x) { for (const k of t) { if (eq(x, k)) return { service: true }; } return null; }',
    b: 'export function f(t, x) { for (const k of t) if (eq(x, k)) return { service: true }; return null; }' },
  { same: true, name: 'nullish chain re-associated — playbook-draft/index.ts:459',
    a: 'export const f = (d, t) => d ?? t.de_id ?? null;', b: 'export const f = (d, t) => d ?? ((t.de_id) ?? null);' },
  { same: true, name: 'all three forms at once',
    a: 'export function f(xs, d, t) { if (xs) { return xs.map((o) => o.id ?? d ?? null); } return t; }',
    b: 'export function f(xs, d, t) { if (xs) return xs.map(o => o.id ?? (d ?? null)); return t; }' },
  // ── real programs that differ: MUST survive ─────────────────────────────
  { same: false, name: 'THE STALE-DEPLOY SHAPE — string-equality auth vs serviceCaller (2026-08-18)',
    a: 'export const ok = (b) => b === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");',
    b: 'export const ok = (b) => serviceCaller(b).service;' },
  { same: false, name: 'D-12 SHAPE — a side-effect import losing its version pin',
    a: 'import "https://esm.sh/p@1.2.3";', b: 'import "https://esm.sh/p";' },
  { same: false, name: 'D-12 SHAPE — a bound import losing its version pin',
    a: 'import x from "https://esm.sh/p@1.2.3"; export const y = x;',
    b: 'import x from "https://esm.sh/p"; export const y = x;' },
  { same: false, name: 'a negation dropped from a guard',
    a: 'export function f(x) { if (!x) return 401; return 200; }',
    b: 'export function f(x) { if (x) return 401; return 200; }' },
  { same: false, name: 'a statement deleted from a block',
    a: 'export function f() { audit(); run(); }', b: 'export function f() { run(); }' },
  { same: false, name: 'a statement moved OUT of a guard',
    a: 'export function f(a) { if (a) { audit(); run(); } }', b: 'export function f(a) { if (a) { audit(); } run(); }' },
  { same: false, name: 'an await dropped',
    a: 'export async function f() { await audit(); }', b: 'export async function f() { audit(); }' },
  { same: false, name: 'an argument added',
    a: 'export const f = () => rpc("go", { tenant });', b: 'export const f = () => rpc("go", { tenant, force: true });' },
  { same: false, name: 'operands reordered in a nullish chain',
    a: 'export const f = (a, b, c) => a ?? b ?? c;', b: 'export const f = (a, b, c) => a ?? c ?? b;' },
  { same: false, name: 'the operator itself swapped',
    a: 'export const f = (a, b) => a || b;', b: 'export const f = (a, b) => a && b;' },
  // ⚠ THE TWO ARMS THAT BOUND THE RE-ASSOCIATION. Without these, widening
  // ASSOC_OPS to every binary operator would score exactly the same.
  { same: false, name: 'BOUND: a different outer operator is a different program',
    a: 'export const f = (a, b, c) => (a || b) && c;', b: 'export const f = (a, b, c) => a || (b && c);' },
  // ⚠ THIS PAIR, NOT THE ONE ABOVE, IS WHAT BOUNDS THE OPERATOR-EQUALITY TEST.
  // The pair above shares no outer operator, so re-associating across operators
  // still leaves the two rebuilt spines different (`a && b && c` vs
  // `a || b || c`) and it passes even with the check removed — it scored
  // exactly like a real catch. These two share an outer `&&`, so dropping the
  // equality test collapses both to `a && b && c` and the difference is gone.
  { same: false, name: 'BOUND: regrouping ACROSS operators — `a && (b || c)` is not `a && (b && c)`',
    a: 'export const f = (a, b, c) => a && (b || c);', b: 'export const f = (a, b, c) => a && (b && c);' },
  { same: false, name: 'BOUND: `-` is not associative and must NOT be re-associated',
    a: 'export const f = (a, b, c) => a - (b - c);', b: 'export const f = (a, b, c) => (a - b) - c;' },
  { same: false, name: 'BOUND: `+` is not associative once a string is involved',
    a: 'export const f = (a, b, c) => a + (b + c);', b: 'export const f = (a, b, c) => (a + b) + c;' },
  { same: false, name: 'a string literal that merely LOOKS like the arrow form',
    a: 'export const s = "(o) => x";', b: 'export const s = "o => x";' },
];

// The known-stale fixture: real files, real history, a real behavioural change.
export const KNOWN_STALE = {
  ref: 'a54d5b54^',
  why: 'the pre-2026-08-18 `bearer === Deno.env.get(\'SUPABASE_SERVICE_ROLE_KEY\')` identity check, before a54d5b54 replaced it with serviceCaller()',
  paths: ['supabase/functions/de-work/index.ts', 'supabase/functions/eval-run/index.ts'],
};

// Real modules used for the full-size NEGATIVE arm — cosmetic noise applied to
// production source at its real size, not to a toy string.
const SELFTEST_MODULES = [
  'supabase/functions/_shared/serviceCaller.ts',
  'supabase/functions/_shared/contentHash.ts',
  'supabase/functions/de-work/index.ts',
  'supabase/functions/tool-learn/index.ts',
  'supabase/functions/playbook-draft/index.ts',
  'supabase/functions/conflict-probe-drain/index.ts',
];

// ── The mutation cases, BOTH DIRECTIONS ────────────────────────────────────
// A normalizer has two ways to be wrong and they fail in opposite directions:
// TOO LOOSE erases a real change (production stale, checker green — the D-12
// defect), TOO TIGHT manufactures false positives (the 27 this pass removed,
// which is how a section gets ignored). Proving only one leaves the other free
// to rot, and the first is the dangerous one. Mirrored in
// scripts/certify-mutation-test.mjs so they sit in that suite's denominator.
export const MUTATIONS = {
  // ── TOO LOOSE: the normalizer stops seeing real differences ─────────────
  'erase-everything': {
    dir: 'too loose',
    what: 'normalizeModule() returns a constant, so every module equals every other.',
    expect: ['ERASED A REAL DIFFERENCE', 'KNOWN-STALE'],
  },
  'reassociate-across-operators': {
    dir: 'too loose',
    what: 'drops the operator-EQUALITY test in step (6), so `(a || b) && c` is re-associated into `a || (b && c)` — a genuine change in meaning.',
    expect: ['ERASED A REAL DIFFERENCE', 'regrouping ACROSS operators'],
  },
  'reassociate-minus': {
    dir: 'too loose',
    what: 'adds `-` to ASSOC_OPS. Subtraction is not associative, so `a - (b - c)` would be flattened into `(a - b) - c`.',
    expect: ['ERASED A REAL DIFFERENCE', 'not associative'],
  },
  'reassociate-plus': {
    dir: 'too loose',
    what: 'adds `+` to ASSOC_OPS. String concatenation makes `+` non-associative: `1 + (2 + "3")` is "123", `(1 + 2) + "3"` is "33".',
    expect: ['ERASED A REAL DIFFERENCE', 'not associative'],
  },
  // ── TOO TIGHT: the false positives come back ────────────────────────────
  'drop-arrow-canonicalisation': {
    dir: 'too tight',
    what: 'reverts step (4). `.map((o) => …)` vs `.map(o => …)` reads as drift again — 4 of the 27.',
    expect: ['FALSE POSITIVE', 'arrow single parameter'],
  },
  'drop-brace-canonicalisation': {
    dir: 'too tight',
    what: 'reverts step (5). `if (x) { f(); }` vs `if (x) f();` reads as drift again — 24 of the 27, serviceCaller.ts among them.',
    expect: ['FALSE POSITIVE', 'braces around a single-statement body'],
  },
  'drop-assoc-canonicalisation': {
    dir: 'too tight',
    what: 'reverts step (6). playbook-draft/index.ts:459 reads as drift again.',
    expect: ['FALSE POSITIVE', 'nullish chain re-associated'],
  },
  // ── The arm that stops the whole suite being theatre ────────────────────
  'no-perturbation': {
    dir: 'no-comparisons',
    what: 'makes cosmeticVariant() a no-op. Every negative arm then compares a file with itself and passes having proven nothing.',
    expect: ['NO-COMPARISONS', 'perturbed NONE'],
  },
};

export function runSelfTest({ log = console.log } = {}) {
  const fail = [];
  let checks = 0, perturbed = 0;

  // 1. minimal pairs, both directions
  for (const p of MINIMAL_PAIRS) {
    checks++;
    const same = normalizeModule(p.a, 'x.ts') === normalizeModule(p.b, 'x.ts');
    if (same !== p.same) {
      fail.push(`${p.same ? 'FALSE POSITIVE' : '⚠ ERASED A REAL DIFFERENCE'} — ${p.name}: normalizer says ${same ? 'IN SYNC' : 'DRIFTED'}, expected ${p.same ? 'IN SYNC' : 'DRIFTED'}`);
    }
  }

  // 2. NEGATIVE at full size — cosmetic noise over real modules must vanish.
  for (const path of SELFTEST_MODULES) {
    const src = gitShow('HEAD', path) ?? (() => { try { return readFileSync(path, 'utf8'); } catch { return null; } })();
    if (src === null) { fail.push(`NO-COMPARISONS — self-test module ${path} could not be read; a suite that skips its fixtures proves nothing`); continue; }
    const variant = cosmeticVariant(src);
    checks++;
    // ⚠ the comparison only counts if the variant is genuinely different TEXT.
    if (variant !== plainPrint(src).text) perturbed++;
    if (normalizeModule(variant, path) !== normalizeModule(src, path)) {
      fail.push(`FALSE POSITIVE — cosmetic-only variant of ${path} reported DRIFTED`);
    }
  }
  if (perturbed === 0) {
    fail.push('NO-COMPARISONS — cosmeticVariant() perturbed NONE of the self-test modules, so every negative arm above compared a file with itself. Zero findings from zero comparisons is not a clean result.');
  }

  // 3. POSITIVE at full size — a real stale deploy, carrying cosmetic noise too.
  for (const path of KNOWN_STALE.paths) {
    const stale = gitShow(KNOWN_STALE.ref, path);
    const current = gitShow('origin/main', path) ?? gitShow('HEAD', path);
    if (stale === null || current === null) {
      fail.push(`NO-COMPARISONS — the known-stale fixture ${KNOWN_STALE.ref}:${path} could not be read; without it nothing proves this checker still fires`);
      continue;
    }
    checks++;
    if (normalizeModule(cosmeticVariant(stale), path) === normalizeModule(current, path)) {
      fail.push(`⚠ ERASED A REAL DIFFERENCE — the KNOWN-STALE ${path} (${KNOWN_STALE.ref}) normalized EQUAL to \`main\`. ${KNOWN_STALE.why}. This is the D-12 defect one layer down: production stale, checker green.`);
    }
  }

  log(`normalizer self-test: ${checks - fail.length}/${checks} check(s) passed · ${MINIMAL_PAIRS.filter((p) => p.same).length} cosmetic-only pair(s) must be IN SYNC · ${MINIMAL_PAIRS.filter((p) => !p.same).length} behaviourally-different pair(s) must be DRIFTED · ${KNOWN_STALE.paths.length} known-stale real-history fixture(s) · ${perturbed}/${SELFTEST_MODULES.length} real module(s) actually perturbed by cosmeticVariant()`);
  for (const f of fail) log(`  ✗ ${f}`);
  return { checks, failures: fail, perturbed };
}

// ── CLI ────────────────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith('edge-deployed-parity.mjs')) {
  // ⚠ Offline modes FIRST: the self-test must run with no token and no network,
  // so CI can prove the normalizer still fires without reaching production.
  if (process.argv.includes('--self-test') || process.argv.some((a) => a.startsWith('--mutate='))) {
    const mut = (process.argv.find((a) => a.startsWith('--mutate=')) ?? '').split('=')[1] || null;
    if (!mut) {
      const r = runSelfTest();
      console.log(r.failures.length ? `SELF-TEST FAILED: ${r.failures.length} failure(s)` : 'SELF-TEST PASSED');
      process.exit(r.failures.length ? 1 : 0);
    }
    // Each --mutate case BREAKS the normalizer in one named way. The run exits
    // 0 ONLY if the suite CAUGHT it and the failure text carries EVERY expected
    // substring. A silent run, or one whose failure is about something else, is
    // INCONCLUSIVE and exits non-zero — it is never scored as a pass.
    const M = MUTATIONS[mut];
    if (!M) { console.error(`unknown --mutate case ${JSON.stringify(mut)}; known: ${Object.keys(MUTATIONS).join(', ')}`); process.exit(2); }
    setMutation(mut);
    const r = runSelfTest();
    setMutation(null);
    const hit = r.failures.filter((f) => M.expect.every((s) => f.includes(s)));
    if (!hit.length) {
      console.log(`✗ --mutate=${mut} NOT CAUGHT — ${r.failures.length} failure(s), none carrying all of ${JSON.stringify(M.expect)}. INCONCLUSIVE, not a pass.`);
      process.exit(1);
    }
    console.log(`✓ --mutate=${mut} CAUGHT AND NAMED (${hit.length} matching failure line(s)):`);
    for (const h of hit.slice(0, 3)) console.log(`    ${h}`);
    process.exit(0);
  }
  const token = readToken();
  const tree = (process.argv.find((a) => a.startsWith('--tree=')) ?? '').split('=')[1] || 'origin/main';
  const r = await measureParity({ token, tree });
  console.log(`deployed edge functions: ${r.deployed} · compared against ${tree}: ${r.compared} · excluded: ${r.excluded.length}`);
  for (const e of r.excluded) console.log(`  — EXCLUDED ${e.slug}: ${e.why}`);
  console.log(`IN SYNC ${r.inSync.length}/${r.compared} · DRIFTED ${r.drifted.length}/${r.compared} · UNVERIFIABLE ${r.unverifiable.length}/${r.compared}`);
  for (const v of r.drifted) console.log(`  ✗ DRIFTED ${v.slug} — ${v.diffs.length}/${v.files} file(s) differ: ${v.diffs.join(', ')}`);
  for (const v of r.unverifiable) console.log(`  ⏸ UNVERIFIABLE ${v.slug} — ${v.error}`);
  const repoFns = readdirSync('supabase/functions', { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== '_shared').map((e) => e.name);
  const notDeployed = repoFns.filter((n) => !r.verdicts.some((v) => v.slug === n) && !r.excluded.some((e) => e.slug === n));
  console.log(`in repo, never deployed: ${notDeployed.length}/${repoFns.length}${notDeployed.length ? ` — ${notDeployed.join(', ')}` : ''}`);
  if (process.argv.includes('--floating')) {
    const f = await countFloatingDeployedImports({ token, tree });
    console.log(`\nunpinned remote imports written in DEPLOYED module sources: ${f.n} of ${f.remoteImports} remote import(s) across ${f.modulesScanned} module(s)`);
    for (const [k, c] of f.offenders) console.log(`  ${k}${c > 1 ? ` ×${c}` : ''}`);
    const graph = new Map();
    for (const v of r.verdicts) for (const s of v.remotes ?? []) if (/^https?:\/\/(?![^\s]*@\d+\.\d+\.\d+)/.test(s)) graph.set(s, (graph.get(s) ?? 0) + 1);
    console.log(`\nFYI (not pinned on, not actionable here) — unpinned specifiers reached TRANSITIVELY by esm.sh: ${graph.size} distinct`);
    for (const [s, c] of [...graph].slice(0, 6)) console.log(`  ${s} — in ${c} bundle(s)`);
  }
  process.exit(0);
}
