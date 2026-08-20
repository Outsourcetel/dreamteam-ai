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
//   4. whitespace collapsed, whitespace around punctuators removed, trailing
//      commas before ) ] } dropped — the remaining places the emitters
//      disagree (`{ a }` vs `{a}`, `x, }` vs `x }`, `asUser\n.from(` vs
//      `asUser.from(`). None can change what the code does.
//
// ⚠ RESIDUAL, STATED NOT HIDDEN: this comparison is blind to changes that
// survive none of the above — a comment-only edit, or a whitespace-only one,
// deployed or not, reads as IN SYNC. That is a deliberate trade: those cannot
// change behaviour, and a comparison that flagged them would flag every
// function on every run, which is the timestamp failure again in another skin.
const dropParens = (ctx) => (root) => {
  const visit = (n) => {
    const v = ts.visitEachChild(n, visit, ctx);
    return ts.isParenthesizedExpression(v) ? v.expression : v;
  };
  return ts.visitNode(root, visit);
};

export function normalizeModule(src, spec) {
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
  const transformed = ts.transform(sf, [dropParens]).transformed[0];
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

// ── CLI ────────────────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith('edge-deployed-parity.mjs')) {
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
