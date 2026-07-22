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

// Baseline RATCHETED 2026-07-22 after the estate-wide token sweep (was the
// program-start capture: 34/16/13/10/8/8/85/19). Counts only go DOWN — when a
// sweep lowers them, tighten these floors in the same commit.
// Remaining bg/border-slate variants are the SANCTIONED set (doc §7): control
// shades (slate-500/600 toggles, placeholders, focus rings) + EmbedWidget's
// light-theme branch (customer-site context). StatCard/Modal file counts
// include the two legacy ADAPTERS in src/components (thin delegations to the
// primitives) — retire the counts when their call sites import directly.
const BASELINE = {
  'bg-slate variants': 8, 'border-slate variants': 3, 'radius variants': 13,
  'card padding variants': 10, 'local StatCard-likes (files)': 7, 'local Modals (files)': 8,
  'inline style objects': 85, 'raw hex colors': 19,
};
const NOW = {
  'bg-slate variants': uniq('bg-slate-[0-9/]*'),
  'border-slate variants': uniq('border-slate-[0-9/]*'),
  'radius variants': uniq('rounded-[a-z0-9]*'),
  'card padding variants': uniq('p-[0-9]'),
  'local StatCard-likes (files)': files('function (StatCard|Tile|Stat|Metric)'),
  'local Modals (files)': files('function .*Modal'),
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
