#!/usr/bin/env node
// Design-drift detector — DreamTeam Design System v1 (docs/design-system.md §6).
// Prints the variant counts that must only go DOWN. Run before shipping UI.
import { execSync } from 'node:child_process';

const sh = (cmd) => { try { return execSync(cmd, { encoding: 'utf8', shell: 'bash' }).trim(); } catch { return '0'; } };
// src/design/ IS the system — its canonical definitions are exempt from drift.
const G = `src/ --include='*.tsx' --exclude-dir=design`;
const uniq = (pat) => Number(sh(`grep -rhoE "${pat}" ${G} | sort -u | wc -l`));
const count = (pat) => Number(sh(`grep -rh "${pat}" ${G} | wc -l`));
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
const BASELINE = {
  'bg-slate variants': 8, 'border-slate variants': 3, 'radius variants': 13,
  'card padding variants': 10, 'local StatCard-likes (files)': 7,
  'hand-rolled dialogs': 26,
  'inline style objects': 65, 'raw hex colors': 18,
};
const NOW = {
  'bg-slate variants': uniq('bg-slate-[0-9/]*'),
  'border-slate variants': uniq('border-slate-[0-9/]*'),
  'radius variants': uniq('rounded-[a-z0-9]*'),
  'card padding variants': uniq('p-[0-9]'),
  // Name-based, and defensible here: locally DEFINING a StatCard is itself the
  // duplication. Unlike a dialog, the component does not keep its name after
  // being migrated away.
  'local StatCard-likes (files)': files('function (StatCard|Tile|Stat|Metric)'),
  // The markup, not the name. src/design is already excluded by G, so the
  // primitive's own shell is not counted against the estate.
  'hand-rolled dialogs': count('fixed inset-0'),
  'inline style objects': count('style={{'),
  'raw hex colors': uniq('#[0-9a-fA-F]{6}'),
};

let regressions = 0;
console.log('── Design drift (must only go DOWN) ──────────────────────────');
for (const k of Object.keys(BASELINE)) {
  const b = BASELINE[k], n = NOW[k];
  const mark = n > b ? '▲ REGRESSION' : n < b ? '▼ improved' : '· unchanged';
  if (n > b) regressions++;
  console.log(`${k.padEnd(32)} baseline ${String(b).padStart(3)} → now ${String(n).padStart(3)}  ${mark}`);
}
console.log('──────────────────────────────────────────────────────────────');
if (regressions) { console.log(`✗ ${regressions} metric(s) regressed — see docs/design-system.md`); process.exit(1); }
console.log('✓ no drift regressions');
