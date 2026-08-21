#!/usr/bin/env node
// Design-drift detector — DreamTeam Design System v1 (docs/design-system.md §6).
// Prints the variant counts that must only go DOWN. Run before shipping UI.
import { execSync } from 'node:child_process';

const sh = (cmd) => { try { return execSync(cmd, { encoding: 'utf8', shell: 'bash' }).trim(); } catch { return '0'; } };
// src/design/ IS the system — its canonical definitions are exempt from drift.
const G = `src/ --include='*.tsx' --exclude-dir=design`;
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
const BASELINE = {
  'bg-slate variants': 7, 'border-slate variants': 2, 'radius variants': 13,
  'card padding variants': 9, 'local StatCard-likes (files)': 6,
  'hand-rolled dialogs': 0, 'hand-rolled toasts': 0,
  'inline style objects': 42, 'raw hex colors': 18,
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
  'raw hex colors': uniq('#[0-9a-fA-F]{6}'),
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
