#!/usr/bin/env node
// Light-readiness audit — what still assumes a dark page under it.
// Same contract as design-drift.mjs: counts only go DOWN; --strict exits 1
// on any regression above the pinned baseline. Run with --files to see the
// per-file worklist.
import { execSync } from 'node:child_process';

const sh = (cmd) => { try { return execSync(cmd, { encoding: 'utf8', shell: 'bash' }).trim(); } catch { return ''; } };
const G = `src/ --include='*.tsx' --include='*.ts' --exclude-dir=design`;
const NO_COMMENTS = `| grep -v '^[[:space:]]*\\(//\\|\\*\\)'`;

// Only an OPAQUE colored fill legitimizes text-white. A translucent tint
// (bg-indigo-500/10) is effectively the surface underneath — white text on it
// is a real light-theme hazard, so the shade must NOT carry a /NN opacity
// suffix. (?![\d/]) also stops bg-indigo-500/10 half-matching as bg-indigo-50.
const COLORED_BG = 'bg-((?:indigo|rose|emerald|sky|amber|violet|purple|blue|green|red|teal|cyan|orange|fuchsia|pink)-\\d+(?![\\d/])|dt-accent-strong|dt-accent-hover|gradient)';

const lines = (pat) => sh(`grep -rn "${pat}" ${G} ${NO_COMMENTS}`).split('\n').filter(Boolean);
const bareWhite = lines('text-white').filter(l => !new RegExp(COLORED_BG).test(l));
const slateBg = lines('bg-slate-');
const slateBorder = lines('border-slate-');
const slateText = lines('text-slate-');

// Baselines pinned 2026-08-21 (first measurement). Tighten in the SAME
// commit that lowers a number — design-drift.mjs enforces its own version
// of this rule for exactly the reason recorded there.
//
// RATCHETED 2026-08-21 (Task 4, pilot screens verified light). CrashFallback,
// Sidebar's two indigo/light-broken states, and the whole pre-auth surface
// (LoginPage, Terms, Privacy, ProofPage, PlatformInviteRedeemPage,
// ResetPasswordScreen) moved off text-white/text-slate onto dt-* tokens —
// 54 bare text-white instances and 1 text-slate instance closed for real.
//
// RATCHETED 2026-08-21 (Task 5, Knowledge group). The seven
// src/pages/tenant/knowledge/* pages plus the three panels used only there
// (IngestionQueuePanel, KnowledgeGroupsPanel, KnowledgeTreePanel) and
// PlatformShelfPanel (the "what your assistant knows" shelf, itself
// knowledge-only) moved onto dt-* tokens — 29 bare text-white and 3 bg-slate
// (2 status-chip fills, 1 health dot) closed for real. LiveKnowledgeLibrary's
// bg-emerald-600/80 hover:bg-emerald-500 text-white pairing at line ~1031 is
// left as-is (opaque hover sibling; the regex already treats it as covered).
//
// RATCHETED 2026-08-21 (Task 5, Governance group). The seven
// src/pages/tenant/governance/* pages plus GuardrailAdjudicationPanel (its
// sole consumer is CompliancePage) moved onto dt-* tokens — 35 bare
// text-white (headings/stat-values -> dt-title, table/list/input primary
// text -> dt-body) and 11 bg-slate-600 (status/role/operation chip fills and
// two toggle tracks) closed for real. GovernanceAIPanel and ScopedGuardrails
// were left out on purpose: both are also reachable from
// EmployeeFileSections.tsx (a different route-group), so they are shared,
// not governance-only. Several bg-indigo-600/bg-emerald-600 solid-fill and
// opaque-hover-sibling text-white pairings are left as-is (paints a solid
// colored fill; the regex already treats them as covered) — CompliancePage,
// SecurityAccessPage and GuardrailAdjudicationPanel each keep some. The two
// border-slate-500 `focus:border-slate-500` hits in SecurityAccessPage are
// the doc §7 sanctioned control-shade/focus-ring exception (identical to the
// untouched instances in AISessionPanel, GovernanceAIPanel and
// LivePlaybookBuilder) and are deliberately not converted here.
//
// RATCHETED 2026-08-21 (Task 5, Playbooks group). The whole group is one
// file: src/pages/tenant/systems/LivePlaybookBuilder.tsx (route
// systems_playbooks, sole Sidebar entry "Playbook Builder"). No sole-consumer
// components — its local imports are either shared design primitives or
// shared components (AISessionPanel, LiveDataStates) reachable from many
// other pages. TemplateBuilder.tsx was checked and excluded: it is the sole
// consumer of LiveConnectorsPage.tsx (Connected systems group), not
// playbooks, despite living in the same src/pages/tenant/systems/ directory.
// Converted: 17 bare text-white (step/decision-row labels and card/section
// headings -> dt-title; 7 `hover:text-white` on ghost-style secondary
// buttons -> hover:text-dt-body, matching the primitives.tsx `ghost` variant
// and the governance-group precedent) and 3 bg-slate-600 status-chip fills
// (archived/skipped_dedup status-map entries, and the "Guide" tag in the
// Rail/Judgment/Guide step-tone family) -> bg-dt-neutral-soft, matching doc
// §7's "neutral status chip" vocabulary and the governance-group precedent
// for the same shape of chip. All three were rare/fallback states, not the
// page's default-frequency status, so softening them follows the
// high-traffic rule rather than violating it. The file's one
// `focus:border-slate-500` (line 97, shared input/select class) is the doc
// §7 sanctioned control-shade/focus-ring exception already named above and
// was deliberately left untouched — it is not part of this group's ratchet.
//
// RATCHETED 2026-08-21 (Task 5, Connected systems group).
// src/pages/tenant/systems/LiveConnectorsPage.tsx and its sole-consumer
// TemplateBuilder.tsx (imported ONLY by LiveConnectorsPage — confirmed by
// grep — despite living in the same systems/ directory as the already-done
// LivePlaybookBuilder.tsx) moved onto dt-* tokens. McpServersPage.tsx (the
// third page in this route group) was audited and found already fully
// converted — zero hits in any of the four metrics — so it was left
// untouched. AISessionPanel and LiveDataStates, imported by
// LiveConnectorsPage, are shared across 40 files and are not sole-consumer;
// left alone as out of scope. Converted: 20 bare text-white (card/section
// titles -> dt-title; a search-result-row item label -> dt-body, matching
// the "list item -> dt-body" precedent; 7 `hover:text-white` on
// ghost-style Cancel/back links -> hover:text-dt-body, matching the
// primitives.tsx `ghost` variant) and 4 bg-slate (3 `bg-slate-600
// hover:bg-dt-panel text-white` opaque action buttons — "Save app
// credentials", the per-row learned-tool Publish/Unpublish toggle, and the
// per-connector "Sync tickets" button — each a default/high-frequency
// control in its own context, not a rare fallback, so they keep the
// opaque `bg-dt-border-strong text-dt-title` pairing rather than a
// softened `-soft` token, per the SecurityAccessPage `tenant_user` chip
// precedent; and the "Excluded"/rejected ingest-candidate status chip's
// `bg-slate-500/10` -> `bg-dt-neutral-soft`, keeping its already-token'd
// `text-dt-support`, matching the LivePlaybookBuilder "Guide" chip
// precedent). The one `divide-slate-700/60` list divider (uncounted by
// this audit's metrics, per the brief's separate grep instruction) became
// `divide-dt-border`, matching the same file's own `divide-y
// divide-dt-border` used two sections above it.
//
// RATCHETED 2026-08-21 (Task 5, Setup group). The seven SETUP-nav pages
// (CompanySetupPage, DiscoveryInterviewPage, DiscoveryProposalsPage,
// UserManagementPage, MyProfilePage, OrganisationPage, SettingsPage) plus
// eleven sole-consumer components reachable ONLY from those pages
// (DataExportPanel, BooksImportCard, ReviewMinutesCard, DeleteWorkspacePanel,
// sso/DomainClaimPanel, sso/SsoPolicyPanel, sso/ScimTokensPanel,
// CommsSettingsCard, WorkforceTrustDefaults, WorkforceTrustPanel,
// EmployeeProfileDrawer — the last two consumed by both UserManagementPage
// and MyProfilePage, both in-group) moved onto dt-* tokens. Four pages
// (DiscoveryInterviewPage, DiscoveryProposalsPage, MyProfilePage,
// OrganisationPage) and seven components (DataExportPanel — its one
// text-white already sits on the COLORED_BG-exempt bg-dt-accent-strong,
// BooksImportCard, ReviewMinutesCard, DeleteWorkspacePanel, DomainClaimPanel,
// SsoPolicyPanel, ScimTokensPanel, EmployeeProfileDrawer, WorkforceTrustPanel)
// were audited and found already clean — zero hits in all four metrics — so
// they were left untouched. HireEmployeeWizard.tsx was checked and excluded:
// its sole reachable entry is LiveWorkforceDEs.tsx's "Hire with AI" button
// under the Workforce hub's 'workforce_hire' route (/workforce/hire), not
// any Setup page — it belongs to a Workforce-group pass, not this one, and
// its line-634 bg-indigo-500/10 text-white stays unconverted (not in scope).
// OnboardingArchitectPage.tsx was checked and excluded: it has no entry in
// the Sidebar's SETUP nav group (only discovery_interview, discovery_
// proposals, company_setup, users, my_profile, organisation and settings do)
// — it is reachable only via a button inside CompanySetupPage and via
// GettingStartedGuide (shared with DashboardPage, so not sole-consumer
// either), so it is left for a later/"remaining" pass. GettingStartedGuide
// and SecurityAccessPage were excluded as shared (GettingStartedGuide also
// renders on DashboardPage; SecurityAccessPage is also GovernanceHubPage's
// gov_security tab and was already converted there — Governance group).
// AISessionPanel and LiveDataStates stay excluded as shared across 40+ files
// (per the Connected-systems ratchet note above).
//
// Converted: 59 bare text-white (headings/section-labels/stat-values/inline-
// emphasis/row-primary-names -> dt-title; form input/select typed-value text
// -> dt-body, per the governance-group "table/list/input primary text ->
// dt-body" precedent for the fields where dt-body reads as the plain typed
// value rather than an emphasized identifier) and 10 bg-slate-600 (3
// already-translucent "Not set"/"set by your plan" info chips -> bg-dt-
// neutral-soft, since translucent-source bg-slate is soft-exempt by tier;
// 1 progress-bar track and 1 promotion-history fallback dot -> bg-dt-
// border-strong, matching the doc §7 "toggle tracks etc." control-shade row
// of the mapping table, kept opaque rather than soft because a soft tint on
// a 1.5px dot or a 2px bar track would read as invisible, not softened; 1
// modal permission-chip list -> bg-dt-neutral-soft, matching the Playbooks/
// Connected-systems "neutral status chip" precedent; 1 modal Cancel button
// and 1 default-role ROLE_COLOR badge (both UserManagementPage) kept OPAQUE
// as bg-dt-border-strong text-dt-title rather than softened — the Cancel
// button is a default control on every remove-confirm, not a rare state, and
// the tenant_user badge is the platform's fallback role (useUsers.ts) that
// renders on every non-privileged row and in the Role Permissions Reference,
// matching the identical tenant_user precedent already recorded in
// SecurityAccessPage above, ~10:1 contrast in light). The one `divide-slate-
// 700/50` list divider (UserManagementPage, uncounted by this audit's
// metrics) became `divide-y divide-dt-border`, dropping the alpha to match
// the Connected-systems divide-dt-border precedent.
//
// Left AS-IS on purpose (not drift): every `text-white` paired with a
// runtime `style={{ backgroundColor: accentColor }}` (or `accentColor +
// '30'`) — CompanySetupPage buttons/badges (colored-bg lines, already
// COLORED_BG-exempt), and 6 in UserManagementPage/SettingsPage/
// CommsSettingsCard nav-tab-active and action-button fills that the
// COLORED_BG regex cannot see (it only recognizes literal Tailwind bg-*-NNN
// classes, not inline styles) — these are genuine solid fills using the
// tenant's own brand color, matching the mapping table's "text-white on a
// solid colored fill stays" rule; converting them would be the wrong call,
// not a missed one, so they are not counted toward this ratchet even though
// the raw audit numbers still include them. Also left as-is:
// `placeholder-slate-500/600` and `focus:border-slate-500` on inputs across
// this group (the doc §7 sanctioned control-shade/placeholder/focus-ring
// exception, identical to the LoginPage/SecurityAccessPage/
// LiveKnowledgeLibrary precedent) and `hover:ring-slate-600` on
// UserManagementPage's role-badge button (not one of the four tracked
// metrics, out of this sweep's scope).
const BASELINE = { 'bare text-white': 307, 'bg-slate': 36, 'border-slate': 6, 'text-slate': 2 };
const NOW = {
  'bare text-white': bareWhite.length,
  'bg-slate': slateBg.length,
  'border-slate': slateBorder.length,
  'text-slate': slateText.length,
};

const strict = process.argv.includes('--strict');
const showFiles = process.argv.includes('--files');
let regressions = 0;
console.log('── Light readiness (must only go DOWN) ───────────────────────');
for (const k of Object.keys(BASELINE)) {
  const b = BASELINE[k], n = NOW[k];
  const mark = n > b ? '▲ REGRESSION' : n < b ? '▼ improved (pin it!)' : '· unchanged';
  if (n > b) regressions++;
  console.log(`${k.padEnd(20)} baseline ${String(b).padStart(4)} → now ${String(n).padStart(4)}  ${mark}`);
}
if (showFiles) {
  console.log('\n── bare text-white worklist ──');
  const perFile = {};
  for (const l of bareWhite) { const f = l.split(':')[0]; perFile[f] = (perFile[f] ?? 0) + 1; }
  Object.entries(perFile).sort((a, b) => b[1] - a[1]).forEach(([f, n]) => console.log(`${String(n).padStart(4)}  ${f}`));
}
if (strict && regressions) { console.log(`✗ ${regressions} metric(s) regressed`); process.exit(1); }
console.log(regressions ? '▲ regressions present (non-strict run)' : '✓ within baseline');
