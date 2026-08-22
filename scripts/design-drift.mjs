#!/usr/bin/env node
// Design-drift detector — DreamTeam Design System v1 (docs/design-system.md §6).
// Prints the variant counts that must only go DOWN. Run before shipping UI.
import { execSync } from 'node:child_process';

const sh = (cmd) => { try { return execSync(cmd, { encoding: 'utf8', shell: 'bash' }).trim(); } catch { return '0'; } };
// src/design/ IS the system — its canonical definitions are exempt from drift.
const G = `src/ --include='*.tsx' --exclude-dir=design`;
// ── A SECOND GLOB, for one metric ──────────────────────────────────────────
// Every metric above this line is about markup and correctly scans .tsx only.
// `raw error text` is about what a CAUGHT ERROR becomes on screen, and half of
// those live in src/lib/*.ts — 77 modules this file has never looked at. Rather
// than widen G (which would move nine pinned numbers at once, in a commit that
// is not about them), the one metric that needs .ts gets its own glob.
const G_ALL = `src/ --include='*.tsx' --include='*.ts' --exclude-dir=design`;
const countAll = (pat) => Number(sh(`grep -rhE "${pat}" ${G_ALL} ${NO_COMMENTS} | wc -l`));
// Defined below NO_COMMENTS (hoisting would read as if the order mattered).
let uniq;
// ⚠ COMMENTS ARE NOT CODE. `hand-rolled dialogs` counts the string
// `fixed inset-0`, so the moment someone DOCUMENTS why they removed one — as
// happened writing the phone shell — the metric reports the documentation as
// the defect. A checker that fails on its own explanation teaches people to
// stop explaining. Drop lines that are pure comment (`// …` or a JSDoc ` * …`
// continuation); real markup always has the token inside a className string,
// never after a leading comment marker.
// ⚠ WAS: "this covers count() ONLY — uniq() uses `grep -o`, which discards the
// line, so `radius variants` and `raw hex colors` still see commented-out
// examples. That is a real remaining hole."
//
// HOLE CLOSED. It was not theoretical: it fired on 2026-08-19, when a comment
// explaining why an overlay had moved off a translucent token quoted the hex
// value it was moving away from, and `raw hex colors` reported the explanation
// as the defect — the exact failure mode the paragraph below already describes
// for count(). Writing the explanation down was punished, which is how repos
// teach people to stop writing them.
//
// The fix is to drop comment lines FIRST and only then extract matches, rather
// than extracting from every line and losing the context needed to judge it.
const NO_COMMENTS = `| grep -v '^[[:space:]]*\\(//\\|\\*\\)'`;
const count = (pat) => Number(sh(`grep -rh "${pat}" ${G} ${NO_COMMENTS} | wc -l`));
uniq = (pat) => Number(sh(`grep -rhE "${pat}" ${G} ${NO_COMMENTS} | grep -oE "${pat}" | sort -u | wc -l`));
const files = (pat) => Number(sh(`grep -rlE "${pat}" ${G} | wc -l`));
// ── A THIRD FILTER, for one metric ─────────────────────────────────────────
// NO_COMMENTS drops `// …` and ` * …` lines. It does NOT drop a JSX comment
// ({/* … */}), whose continuation lines are bare prose — and the one place in
// the estate that DOCUMENTS a colour decision in JSX prose (GettingStartedGuide,
// explaining a past audit false-exemption) names two hue classes in English.
// Counting those is the "metric counting English as CSS" failure this file
// already records for `radius variants`. A real class token is always inside a
// quoted string; the sentence describing one is not. Measured before adding
// this filter: exactly 2 matches on quote-free lines, both from that comment.
// The quote test runs in Node, not in the pipeline: a shell pattern matching
// all three of ' " and ` cannot be written in this file without an escaping
// puzzle that the next reader would have to re-solve to trust the number.
const countQuoted = (pat) => {
  const re = new RegExp(pat, 'g');
  return sh(`grep -rhE "${pat}" ${G} ${NO_COMMENTS}`)
    .split('\n')
    .filter((l) => /['"`]/.test(l))
    .reduce((n, l) => n + (l.match(re) || []).length, 0);
};
const HUE = 'bg-(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]{2,3}(/[0-9]{1,3})?';

// Baseline RATCHETED 2026-07-30. Counts only go DOWN — when a sweep lowers
// them, tighten these floors in the SAME commit, which is the step that had
// been skipped: inline styles had sat at 85 while the tree was at 65 and raw
// hex at 19 while the tree was at 18, so two real improvements were unprotected
// and could have silently drifted back.
//
// Remaining bg/border-slate variants are the SANCTIONED set (doc §7): control
// shades (slate-500/600 toggles, placeholders, focus rings) + EmbedWidget's
// light-theme branch (customer-site context).
//
// ⚠ 'local Modals (files)' WAS REPLACED, not renamed. It counted
// `function .*Modal` — component NAMES. A component may legitimately be called
// ChangePasswordModal and correctly use the shared primitive, and a page may
// hand-roll a dialog in a function called nothing of the sort. So the metric
// could neither detect the problem nor register the fix: ten dialogs were
// migrated onto the primitive on 2026-07-30 and the number did not move.
// A metric that cannot move when the thing it names is fixed is worse than no
// metric, because it reads as evidence that nothing is wrong.
//
// 'hand-rolled dialogs' counts the markup instead — `fixed inset-0` outside
// src/design. That is what a hand-rolled dialog IS, it falls as each one is
// migrated, and it cannot be satisfied by renaming anything.
// 'hand-rolled toasts' is the same shape of metric as dialogs and exists for
// the same reason: eight pages had hand-rolled one, five of them the same class
// string copied verbatim, so every copy inherited a translucent surface that
// let page content bleed through the confirmation — and two had drifted further
// to raw `bg-emerald-900/90`. Migrating them onto the Toast primitive fixes the
// eight; this line is what stops the ninth. Counting the MARKUP (the fixed
// bottom-right anchor a toast IS) rather than a component name, for exactly the
// reason recorded above about 'local Modals (files)'.
// RATCHETED AGAIN 2026-08-19. The floors had drifted out of date exactly as
// the note above warns: five metrics sat below their baseline, 24 units of
// slack in total and 20 of it in `inline style objects` (65 floor, 45 actual).
// Every one of those was a real improvement someone made that was not
// protected, so it could have silently drifted back to 65 and the checker
// would have called it green the whole way.
//
// RATCHETED 2026-08-21 (Task 5, Playbooks group). LivePlaybookBuilder's
// three-way step-tone badge (Rail/Judgment/Guide) carried the estate's only
// `bg-slate-600/20` — converting its "Guide" fill to bg-dt-neutral-soft
// removed that distinct variant string entirely (bg-slate-600 with no
// opacity suffix still exists elsewhere, untouched, so this is a real drop,
// not a fluke of the pattern).
//
// RATCHETED 2026-08-21 (Task 5, Connected systems group).
// LiveConnectorsPage's rejected-candidate chip carried the estate's only
// `bg-slate-500/10` — converting it to bg-dt-neutral-soft removed that
// distinct variant string entirely (bg-slate-500 and bg-slate-500/20 still
// exist elsewhere, untouched, so this is a real drop). The three converted
// `bg-slate-600` action buttons did NOT move this metric: bg-slate-600
// (bare) and its /40, /50 opacity siblings are still present elsewhere in
// the estate, unconverted.
//
// RATCHETED 2026-08-21 (Task 5, group 8 — closing the estate sweep).
// `bg-slate variants` hits zero: every remaining bg-slate-* class in the
// estate (toggle tracks, status chips, Badge.tsx's default variant,
// DraftApprovalCard's Reject button, ActivityPage's config_change dot — see
// audit-light-ready.mjs's own ratchet note for the full file list) converted
// to dt-* tokens. `border-slate variants` drops to exactly 1: the five
// `focus:border-slate-500` control-shade focus rings (doc §7,
// CONTROL_SHADE_FOCUS_RING in audit-light-ready.mjs) all share the identical
// literal `border-slate-500` — one distinct variant string, deliberately kept
// (converting to dt-border-strong would trade a visible focus ring for a
// ~1.4:1-contrast one in light theme; see doc §7 for the math). Badge.tsx's
// `border-slate-500/30` variant is gone along with its bg-slate sibling.
const BASELINE = {
  'bg-slate variants': 0, 'border-slate variants': 1, 'radius variants': 13,
  'card padding variants': 9, 'local StatCard-likes (files)': 6,
  'hand-rolled dialogs': 0, 'hand-rolled toasts': 0,
  'inline style objects': 39, 'raw hex colors': 12,
  // ── raw error text, pinned 2026-08-22 at its measured value ─────────────
  // `setSomething(e.message)` straight out of a catch. When the error came from
  // .rpc() or .from() it is a PostgrestError and `.message` is raw Postgres —
  // `column "de_id" of relation "human_tasks" does not exist` — reaching a
  // customer's screen verbatim, naming our tables and telling them nothing.
  //
  // 125 sites when first measured with a looser grep; 61 converted to
  // presentError() the same day. This metric's own (stricter, ERE) count of what
  // remains is 62 — and that number came from THIS GATE REFUSING an unpinned
  // improvement, which is the behaviour working rather than a nuisance.
  // Pinned rather than floored at 0 because the rest need reading
  // one at a time: some are already fine (a plain Error our own code threw),
  // and a few carry a GOVERNED REFUSAL that must reach the user verbatim —
  // rewriting one of those into "something went wrong" would be the exact
  // defect CLAUDE.md records this repo has already paid for. A blanket codemod
  // is how that gets done by accident, so the remainder is a worklist, not a
  // sweep.  `node scripts/design-drift.mjs --files` lists them.
  'raw error text': 62,
  // ── bare hue fills, ADDED 2026-08-22 ───────────────────────────────────
  // The gap this closes: audit-light-ready.mjs ratchets bare hues in TEXT and
  // BORDER classes, and nothing anywhere ratcheted them in BACKGROUNDS. 580
  // occurrences were sitting in 70 of 133 page files, and no checker in the
  // repo could see one.
  //
  // ⚠ 580, not the 405 this comment said in its first draft. 405 came from
  // `grep -coE`, and `-c` counts matching LINES even with `-o` — so every
  // className carrying two hue fills was counted once. The number that
  // survived was the one this metric computes itself.
  //
  // Why it is not cosmetic: tokens.css defines FOUR themes (:root dark,
  // :root.light, :root.light.editorial, and the fourth block), and each
  // redefines --dt-accent. A literal `bg-indigo-600` ignores all of it, so a
  // tenant on the editorial theme — accent #c14d21, a rust orange — got 136
  // indigo primary buttons.
  //
  // 262 occurrences converted in the same commit (580 → 318), every one an
  // EXACT token equivalence checked against tokens.css rather than eyeballed:
  //     bg-indigo-600      → bg-dt-accent-strong    (--dt-accent-strong #4f46e5)
  //     hover:bg-indigo-500→ hover:bg-dt-accent-hover
  //     bg-indigo-500/10   → bg-dt-accent-soft      (--dt-accent-soft #6366f11a)
  //     bg-indigo-500      → bg-dt-accent           (--dt-accent #6366f1)
  //     border-indigo-500/30 → border-dt-accent-border
  //     focus:border-indigo-500 → focus:border-dt-accent
  //     text-indigo-300    → text-dt-accent-text
  // The same pass converted the border/text/focus siblings of those classes,
  // which is what moved audit-light-ready's `tone border-400/500` from 268 to
  // 105 — 432 substitutions in total, of which the 262 above are the
  // backgrounds this metric counts.
  //
  // The remaining 318 are NOT one substitution: they are semantic status
  // colours (emerald=healthy, amber=needs-a-human, rose=failed) at opacities
  // the token set has no exact match for — /5, /15, /20, /40, /60. Each needs
  // a design decision about which dt-* recipe it becomes, so this is pinned as
  // a worklist, not swept.
  'bare hue fills': 318,
};
const NOW = {
  'bg-slate variants': uniq('bg-slate-[0-9/]*'),
  'border-slate variants': uniq('border-slate-[0-9/]*'),
  // ⚠ WAS `rounded-[a-z0-9]*`, which was wrong in three directions at once and
  // still reported a confident 13.
  //   · BLIND to arbitrary values. `[a-z0-9]` is a character class, so against
  //     `rounded-[2rem]` it matched `rounded-` and stopped. Every arbitrary
  //     radius in the estate collapsed into ONE token — the exact syntax most
  //     likely to be a one-off someone should have used a scale step for.
  //   · TRUNCATED directional variants: `rounded-tr-sm` counted as `rounded-tr`,
  //     so adding `rounded-tr-lg` beside it would have moved nothing.
  //   · MATCHED INSIDE WORDS. Four of the thirteen were the tail of the prose
  //     word "Grounded-only" on a governance page. A metric counting English
  //     as CSS is not measuring the estate.
  // Net effect on the number: minus one false positive, plus one from splitting
  // the collapsed arbitrary values — still 13, now thirteen things that exist.
  // The baseline is unchanged BECAUSE the true count is unchanged; if a fix
  // like this ever does move it, the honest move is to re-pin and say the
  // MEASUREMENT changed, not the estate.
  'radius variants': uniq('\\brounded-(\\[[^]]*\\]|[a-z0-9-]*)'),
  'card padding variants': uniq('p-[0-9]'),
  // Name-based, and defensible here: locally DEFINING a StatCard is itself the
  // duplication. Unlike a dialog, the component does not keep its name after
  // being migrated away.
  'local StatCard-likes (files)': files('function (StatCard|Tile|Stat|Metric)'),
  // The markup, not the name. src/design is already excluded by G, so the
  // primitive's own shell is not counted against the estate.
  'hand-rolled dialogs': count('fixed inset-0'),
  'hand-rolled toasts': count('fixed bottom-6 right-6'),
  'inline style objects': count('style={{'),
  'raw error text': countAll('\\bset[A-Za-z_]*\\(.*\\b(e|err|error|ex)\\b\\??\\.message'),
  'raw hex colors': uniq('#[0-9a-fA-F]{6}'),
  // Occurrences, not distinct variants: the conversion above moved the
  // variant count by two (77 → 75) and the occurrence count by 262. A uniq()
  // here would have called that a rounding error.
  'bare hue fills': countQuoted(HUE),
};

let regressions = 0;
const unratcheted = [];
console.log('── Design drift (must only go DOWN) ──────────────────────────');
for (const k of Object.keys(BASELINE)) {
  const b = BASELINE[k], n = NOW[k];
  const mark = n > b ? '▲ REGRESSION' : n < b ? '▼ improved' : '· unchanged';
  if (n > b) regressions++;
  if (n < b) unratcheted.push([k, n]);
  console.log(`${k.padEnd(32)} baseline ${String(b).padStart(3)} → now ${String(n).padStart(3)}  ${mark}`);
}
console.log('──────────────────────────────────────────────────────────────');
if (regressions) { console.log(`✗ ${regressions} metric(s) regressed — see docs/design-system.md`); process.exit(1); }

// ── AN IMPROVEMENT THAT IS NOT LOCKED IN IS NOT PROTECTED ────────────────
// This hunk is separable: delete it and the checker behaves as it did before.
//
// The file has told people to tighten floors in the same commit since
// 2026-07-30, and it was skipped anyway — twice, leaving 20 units of slack on
// one metric. Of course it was: '▼ improved' is congratulation, and nothing
// congratulatory has ever been a control. The only version of this rule that
// holds is the one that stops the build, so it now does, and prints the exact
// block to paste so obeying it takes one edit rather than a hunt.
//
// A branch that improves a metric as a side effect will hit this. That is the
// intent — that branch is precisely the one whose gain would otherwise be
// unprotected the moment it merges.
if (unratcheted.length) {
  console.log(`✗ ${unratcheted.length} metric(s) improved but the floor was NOT moved.`);
  console.log('  An improvement nobody pinned can drift back in silence — pin it here:\n');
  for (const [k, n] of unratcheted) console.log(`    '${k}': ${n},`);
  console.log('\n  Update BASELINE in scripts/design-drift.mjs, in THIS commit.');
  process.exit(1);
}
console.log('✓ no drift regressions, and every improvement is pinned');
