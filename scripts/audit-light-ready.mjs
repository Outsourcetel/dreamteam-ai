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
// `dt-accent` (bare, not just -strong/-hover) added 2026-08-21 (Task 5, group
// 8): it is opaque in every theme block including dt-force-dark (tokens.css),
// so it belongs beside dt-accent-strong/-hover for the same reason they're
// here — WorkforceEconomicsPanel.tsx's "Save baseline" button was the one
// real case this closed.
const COLORED_BG = 'bg-((?:indigo|rose|emerald|sky|amber|violet|purple|blue|green|red|teal|cyan|orange|fuchsia|pink)-\\d+(?![\\d/])|dt-accent(?:-strong|-hover)?(?!-)|gradient)';

// ── Sanctioned survivors (doc §7) — excluded by NAME, not by softening the
// baseline. Both lists are grep-blind spots: COLORED_BG only recognizes a
// literal `bg-<color>-NNN` class in the SAME line, so it cannot see a runtime
// `style={{backgroundColor: ...}}` (often on an adjacent line) or a
// template-literal class like `${de.color}` — both are genuine, always-opaque
// solid fills, just invisible to a className-string regex. Each entry below
// is one doc §7 row; if a matched line's surrounding code changes, re-verify
// it's still a solid-fill/control-shade line before leaving it excluded.
const SOLID_FILL_SURVIVORS = [
  // EndUserChatPage.tsx — accentColor/brandColor (or literal #64748b for
  // role==='system') inline-style fills: header/avatar/composer/send button
  // and the customer's own outgoing bubble.
  { file: 'EndUserChatPage.tsx', contains: 'text-xl font-bold text-white mb-3' },
  { file: 'EndUserChatPage.tsx', contains: 'text-sm font-semibold text-white rounded-xl transition-all hover:opacity-90' },
  { file: 'EndUserChatPage.tsx', contains: 'text-sm font-bold text-white"' },
  { file: 'EndUserChatPage.tsx', contains: 'text-xs font-bold text-white mr-2.5 mt-0.5' },
  { file: 'EndUserChatPage.tsx', contains: "'text-white rounded-br-sm'" },
  { file: 'EndUserChatPage.tsx', contains: 'text-xs font-bold text-white mr-2.5"' },
  { file: 'EndUserChatPage.tsx', contains: 'rounded-xl text-white text-sm font-medium disabled:opacity-40' },
  // DEChatDock.tsx — `${de.color}`/`${msgDe.color}` template-literal avatar
  // fills; de.color is always one of the file's own fixed bg-*-600 literals.
  { file: 'DEChatDock.tsx', contains: '${de.color} flex items-center justify-center text-white text-xs font-bold flex-shrink-0' },
  { file: 'DEChatDock.tsx', contains: '${de.color} mx-auto flex items-center justify-center text-white text-lg font-bold' },
  { file: 'DEChatDock.tsx', contains: '${msgDe.color} flex items-center justify-center text-white text-xs flex-shrink-0 mt-0.5' },
  { file: 'DEChatDock.tsx', contains: '${de.color} flex items-center justify-center text-white text-xs flex-shrink-0 mt-0.5' },
  { file: 'DEChatDock.tsx', contains: '${de.color} flex items-center justify-center text-white text-[10px] font-bold' },
  { file: 'DEChatDock.tsx', contains: '${de.color} hover:brightness-110 text-white text-base font-bold' },
  // SettingsPage.tsx — accentColor inline-style fills: active nav tab plus
  // every primary Save/Copy/Generate button on the page.
  { file: 'SettingsPage.tsx', contains: "activeTab === t ? 'text-white'" },
  { file: 'SettingsPage.tsx', contains: 'px-6 py-2.5 text-white text-sm font-medium rounded-xl disabled:opacity-50 transition-all' },
  { file: 'SettingsPage.tsx', contains: 'px-6 py-2.5 text-white text-sm font-medium rounded-xl disabled:opacity-40 transition-all' },
  { file: 'SettingsPage.tsx', contains: 'px-3 py-1.5 text-xs text-white rounded-lg disabled:opacity-40 transition-all' },
  { file: 'SettingsPage.tsx', contains: 'px-3 py-2 text-xs text-white rounded-lg flex-shrink-0' },
  { file: 'SettingsPage.tsx', contains: 'px-5 py-2.5 text-white text-sm font-medium rounded-xl disabled:opacity-50 flex-shrink-0' },
  // UserManagementPage.tsx — accentColor inline-style fills: invite-modal
  // submit, "+ Invite Member", active status-filter pill, "Open Organisation".
  { file: 'UserManagementPage.tsx', contains: 'py-2.5 rounded-xl text-sm font-medium text-white transition-all disabled:opacity-50' },
  { file: 'UserManagementPage.tsx', contains: 'px-4 py-2 rounded-xl text-white text-sm font-medium"' },
  { file: 'UserManagementPage.tsx', contains: "statusFilter === s ? 'text-white'" },
  { file: 'UserManagementPage.tsx', contains: 'text-xs px-3 py-1.5 rounded-lg text-white transition-all shrink-0' },
  // CommsSettingsCard.tsx — accentColor inline-style Save button.
  { file: 'CommsSettingsCard.tsx', contains: 'text-white text-sm font-medium rounded-xl disabled:opacity-50 transition-all' },
  // PageTabs.tsx — shared portal tab-bar; active branch is accentColor via
  // style prop (the inactive branch's hover was a real hazard and IS
  // converted, so only the active-state literal survives here).
  { file: 'PageTabs.tsx', contains: "page === t.id ? 'text-white'" },
  // Sidebar.tsx — collapsed-sidebar company badge, activeCompany.badgeColor.
  { file: 'Sidebar.tsx', contains: 'text-xs font-bold text-white cursor-pointer' },
  // LoginPage.tsx leftPanel — fixed dark-navy gradient marketing hero
  // (hidden lg:flex), not theme-reactive at all.
  { file: 'LoginPage.tsx', contains: 'bg-white/20 flex items-center justify-center text-white font-bold' },
  { file: 'LoginPage.tsx', contains: '"text-white font-bold text-lg"' },
  { file: 'LoginPage.tsx', contains: 'text-4xl font-bold text-white mb-4 leading-tight' },
  { file: 'LoginPage.tsx', contains: '"text-white text-sm font-medium"' },
];

// Control-shade focus rings (doc §7): `focus:border-slate-500/600`, always
// paired with `placeholder-slate-500/600` on the same input. Kept literal
// because `dt-border-strong`'s light value is ~1.4:1 against white — an
// invisible focus ring — while slate-500 holds ~4.2:1 in both themes by not
// riding the theme remap. Exactly five lines; see doc §7 for the contrast math.
const CONTROL_SHADE_FOCUS_RING = [
  { file: 'AISessionPanel.tsx', contains: 'focus:outline-none focus:border-slate-500' },
  { file: 'GovernanceAIPanel.tsx', contains: 'focus:outline-none focus:border-slate-500' },
  { file: 'SecurityAccessPage.tsx', contains: 'placeholder-slate-600 focus:outline-none focus:border-slate-500' },
  { file: 'LivePlaybookBuilder.tsx', contains: 'focus:outline-none focus:border-slate-500' },
];

const excluded = (l, list) => list.some((e) => l.includes(e.file) && l.includes(e.contains));

const lines = (pat) => sh(`grep -rn "${pat}" ${G} ${NO_COMMENTS}`).split('\n').filter(Boolean);
const bareWhite = lines('text-white')
  .filter(l => !new RegExp(COLORED_BG).test(l))
  .filter(l => !excluded(l, SOLID_FILL_SURVIVORS));
const slateBg = lines('bg-slate-');
// Widened 2026-08-21 (review fix round): plain `border-slate-` missed the
// DIRECTIONAL variants (`border-l-slate-500` etc.) — ActivityPage.tsx's
// `borderColor()` had exactly one, a left-border accent stripe sibling to its
// own already-converted `dotColor()` dot, verified as the only directional
// escape estate-wide. `border\(-[lrtbxy]\)\?-slate-` is BRE (GNU grep's `\?`/
// `\(...\)` extensions, not ERE) because `lines()` calls plain `grep`, not
// `grep -E`; keeps matching bare `border-slate-` too since the group is optional.
const slateBorder = lines('border\\(-[lrtbxy]\\)\\?-slate-').filter(l => !excluded(l, CONTROL_SHADE_FOCUS_RING));
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
//
// RATCHETED 2026-08-21 (Task 5, Workforce group). LiveWorkforceDEs.tsx (the
// DE roster + Workforce Teams board — "workforce boards" turned out to be
// this file's own Teams panel, not a separate file), EmployeeFilePage.tsx +
// EmployeeFileSections.tsx (the Employee File's sections, split out of
// LiveWorkforceDEs.tsx per that file's own header comment), DeWorkbench.tsx,
// HireEmployeeWizard.tsx (sole reachable entry: LiveWorkforceDEs.tsx's "Hire
// with AI" button, confirmed by grep — the one setPage('workforce_hire')
// call site in the app) and OnboardingArchitectPage.tsx (reachable from
// CompanySetupPage's "Quick Start" button and GettingStartedGuide's "Hire
// with Ada instead" — taken here as a DE-hiring flow per this group's brief,
// rather than left for a Setup/Dashboard pass) moved onto dt-* tokens.
// ScopedGuardrails.tsx and GovernanceAIPanel.tsx — named by the governance
// group's ratchet note above as shared with EmployeeFileSections.tsx rather
// than governance-only — were confirmed by grep to be consumed exactly that
// way (ScopedGuardrails: EmployeeFileSections.tsx only; GovernanceAIPanel:
// ScopedGuardrails.tsx and CompliancePage.tsx) and converted here as this
// group's sole-consumer components. WorkforceHubPage.tsx (LiveWorkforceDEs'
// container) was audited and found already clean — zero hits in all four
// metrics. Converted: 68 bare text-white (24 identical `text-base
// font-semibold text-white` section h3s across EmployeeFileSections.tsx in
// one scripted pass -> dt-title; row/card primary names — skill names, team
// names, archetype-card titles -> dt-title, matching the row-primary-name
// precedent; stat-tile values in the Economics panel -> dt-title; form
// input/select/textarea typed-value text across the Edit-DE modal, retire
// modal, colleague-grant selects and the two AI-panel composer textareas ->
// dt-body, matching the governance-group precedent; 3 `hover:text-white` on
// ghost-style links/icon-buttons -> hover:text-dt-body) and 5 bg-slate (2
// DeWorkbench.tsx statusPill entries, `queued`/`assigned` — not toggle
// tracks, so not the doc §7 control-shade exception, but not rare states
// either, so kept OPAQUE as bg-dt-border-strong rather than softened, same
// high-traffic reasoning as the Setup group's tenant_user precedent; 1
// EmployeeFileSections.tsx severity dot and 1 promotion-history fallback dot
// -> bg-dt-border-strong, and 1 trust-evidence progress-bar track ->
// bg-dt-border-strong, all three matching the Setup group's "a soft tint on
// a small dot or bar track reads as invisible, not softened" precedent).
// GovernanceAIPanel.tsx's `border-slate-500 focus:border-slate-500` (line
// 157, identical to its own sibling AISessionPanel.tsx and to
// SecurityAccessPage/LivePlaybookBuilder) is the doc §7 sanctioned control-
// shade/focus-ring exception and was deliberately left untouched — this is
// why border-slate does not move in this ratchet. One more sole-consumer
// component surfaced by re-checking every import in EmployeeFileSections.tsx
// (not just the two the brief named): src/components/de/ResponsiblePeoplePanel.tsx,
// imported only there — its one section-heading `text-white` on an opaque
// `bg-dt-card` card -> dt-title, already folded into the 68-count above.
// Its sibling import DEActionDials.tsx was audited and found
// already clean. EmployeeFilePage.tsx's other local imports were checked the
// same way: CaseTimelinePanel.tsx, DeliverablesPanel.tsx and
// OperatingModelPanel.tsx are each sole-consumer and already clean (zero
// hits in all four metrics); WorkforceBoard.tsx (imported for `fmtWhen`) and
// MissionPanel.tsx are shared — WorkforceBoard.tsx also renders on
// DEActivityPage.tsx, and MissionPanel.tsx's other exports (PlanDrawer,
// MissionRowView) are consumed by TeamMissionPanel.tsx, which itself renders
// on DashboardPage.tsx and WorkforceBoard.tsx — so both stay excluded as
// out-of-group shared components, same reasoning as AISessionPanel.tsx.
//
// The real hazard this group was assigned to fix: HireEmployeeWizard.tsx:634
// had `setupAnswers[q.key] === opt ? 'border-indigo-500 bg-indigo-500/10
// text-white' : …` — a selected-option pill whose ONLY background in the
// selected branch was a 10%-opacity indigo tint (COLORED_BG requires an
// OPAQUE fill, so this never qualified even before the audit's own bare-
// text-white regression test tightened that rule), with bare white text on
// top. In light theme that tint reads as a near-white wash, so the label
// vanished exactly when a user clicked to select it. Fixed with the
// codebase's existing accent-selection pattern — `border-dt-accent
// bg-dt-accent-soft text-dt-accent-text` — already used for this identical
// selected-pill shape at EmployeeFilePage.tsx:686, DiscoveryInterviewPage.tsx
// :519 and MobileShell.tsx:480, so no new vocabulary was introduced. A
// second instance of the same button-with-conditional-indigo-tint shape
// exists at HireEmployeeWizard.tsx:374-378 (the role-archetype picker), but
// there the `text-white` on the card's name was UNCONDITIONAL — rendered in
// both the selected AND unselected state, not gated by the ternary — so the
// accent-selection pattern would have been wrong (accent-colored text on an
// unselected card). That one got the ordinary dt-title heading treatment
// instead, which reads correctly against both bg-dt-card (unselected) and
// bg-indigo-500/10 (selected).
//
// RATCHETED 2026-08-21 (Task 5, Support/Customers/Dashboard group).
// SupportCommandCenterPage.tsx, CustomerSuccessLive.tsx, ImportCustomersModal.tsx
// (sole consumer: CustomerSuccessLive.tsx's "+ Import CSV" button, confirmed
// by grep), DashboardPage.tsx, and MissionPanel.tsx moved onto dt-* tokens.
// SupportInboxPage.tsx, SupportHubPage.tsx, SupportHistoryReport.tsx,
// CustomersHubPage.tsx, CustomerJourneyStubs.tsx, TeamMissionPanel.tsx and
// WorkforceBoard.tsx were audited and found already clean — zero hits in all
// four metrics — so they were left untouched (WorkforceBoard.tsx in
// particular: its own file has zero hits even though its actual JSX
// render-consumer is DEActivityPage.tsx, an out-of-group ops page — no
// cross-group risk from leaving that page for a later pass).
// SupportInboxPage.tsx's two `text-white` sit on `bg-dt-accent-strong`
// (COLORED_BG-exempt) — the sent-reply chat bubble's solid accent fill,
// exactly the "sent replies=solid accent" bubble rule this group's brief
// named as load-bearing — and were confirmed untouched by design, not by
// omission. Converted: 23 bare text-white (13 in CustomerSuccessLive.tsx —
// section/card headings, a stat-tile default value, a slider readout and a
// table row-primary-name -> dt-title, matching the stat-value and
// row-primary-name precedents; the shared `inputCls` module constant's typed-
// value text -> dt-body, matching the governance-group input precedent; 3
// `hover:text-white` ghost-button/pill hovers -> hover:text-dt-body, matching
// the Playbooks/Connected-systems ghost-button precedent — across
// CustomerSuccessLive.tsx, ImportCustomersModal.tsx and MissionPanel.tsx one
// each; 4 in SupportCommandCenterPage.tsx — a StatCard default value color
// and 3 headings -> dt-title; 2 in ImportCustomersModal.tsx's textarea/select
// typed-value text -> dt-body) and 3 bg-slate (CustomerSuccessLive.tsx's
// already-translucent `bg-slate-600/50` churned StatusChip -> bg-dt-neutral-
// soft, translucent-source bg-slate being soft-exempt by tier, matching its
// already-soft `bg-red-500/15`/`bg-emerald-500/15` siblings; DashboardPage.tsx's
// `healthDot` fallback dot -> bg-dt-border-strong, matching the Workforce
// group's "small dot stays opaque" precedent — this function is dead code,
// never called anywhere in the file, confirmed by grep, so converting it
// carries zero visual risk either way but still closes the metric).
// CORRECTED on review (Important finding): DashboardPage.tsx's
// `taskBadgeStyle` fallback badge was first mapped to bg-dt-neutral-soft on
// a "matches its translucent /20 siblings" consistency argument, but that
// overrode the high-traffic rule the wrong way — TaskType has 11 members and
// only 7 get explicit branches, so this fallback is the LIVE render path for
// `training_feedback`, `trust_promotion`, `trust_demotion_notice` and
// `checklist`, not a rare state. A softened chip diluting a
// `trust_demotion_notice` badge's urgency is exactly the risk the
// high-traffic rule exists to prevent. Corrected to the canonical opaque
// `bg-dt-border-strong text-dt-title` (precedent: SecurityAccessPage.tsx:33
// `tenant_user`, UserManagementPage.tsx:1018 Cancel button) — the same
// "defaults keep opaque" pairing used throughout this file's own ratchet
// notes above. The 7 explicit translucent `/20` branches are unchanged.
// One additional real hazard fixed on judgment, not caught by the audit's
// own count: ImportCustomersModal.tsx:157's tab-active ternary
// (`tab === t ? 'bg-indigo-600 text-white' : 'text-dt-support hover:text-white'`)
// put an opaque `bg-indigo-600` literal and a bare `hover:text-white` on the
// SAME line — the audit's COLORED_BG check is line-based, so it auto-exempted
// the whole line even though the inactive-tab branch has no background of
// its own and the hover state would have gone invisible against a light
// page. Converted `hover:text-white` -> `hover:text-dt-body` there, matching
// the identical tab-bar shape already fixed the same way in the Playbooks
// and Connected-systems groups.
// Left out of this group on purpose, by name (per the brief's explicit
// scope): ui.tsx (PageHeader/InHubContext/th/td), design/primitives.tsx,
// GettingStartedGuide.tsx, OpsAlertsBanner.tsx, AISessionPanel.tsx (checked —
// not actually imported by any file in this group) and LiveDataStates.tsx —
// all generic/shared, reserved for the final group. Also excluded, because
// the brief named specific files and these were not among them:
// DEChatDock.tsx (14 hits; a global floating dock rendered once in App.tsx
// for every authed non-DT user, not sole-consumer of any Support page);
// SupportCallsPage.tsx and SupportTriageRulesPage.tsx (3 hits; Support hub
// tab siblings); CustomerOnboardingLive.tsx (12), CustomerRenewalPage.tsx
// (9), CommercialContinuityPage.tsx (11) and PipelineLive.tsx (13) — all
// reachable from CustomersHubPage's other tabs (the last two via
// CustomerJourneyStubs.tsx, itself a zero-styling routing stub with no hits
// of its own), but not named in this group's brief; and DEActivityPage.tsx
// (1 hit) — WorkforceBoard.tsx's actual JSX render-consumer, but an ops page
// not named here. All left for a later pass. No `divide-slate-` hits in any
// file in this group (checked by grep across the whole set).
//
// RATCHETED 2026-08-21 (Task 5, group 8 — CLOSING THE SWEEP). Everything
// `--files` still listed, plus the two deferred items named by this group's
// brief. Converted 185 bare text-white (PlatformConsolePage.tsx 35,
// EndUserChatPage.tsx 9 real + 7 identified as sanctioned inline-fill
// survivors, DEChatDock.tsx 9 real + 6 survivors, PipelineLive.tsx,
// CustomerOnboardingLive.tsx, IntelligencePages.tsx, CommercialContinuity
// Page.tsx, CustomerRenewalPage.tsx, GettingStartedGuide.tsx,
// MfaEnrollmentPanel.tsx, LiveProvingGround.tsx, SelfLearningPage.tsx,
// LiveOutcomesPage.tsx, ChangePasswordModal.tsx, PlatformEmailKeyPanel.tsx,
// OrgSetupScreen.tsx, PlatformInvitesPanel.tsx, PlatformTeamPage.tsx,
// HumanTasksPage.tsx, ChatCore.tsx, SetPasswordScreen.tsx,
// SupportTriageRulesPage.tsx, MyAccountBadge.tsx, App.tsx (also both
// text-slate hits), PlatformAIEnginePanel.tsx, PageErrorBoundary.tsx,
// LiveDataStates.tsx, PageTabs.tsx (the real hazard half — see below),
// HostedChatPage.tsx, DEActivityPage.tsx) and AISessionPanel.tsx's 5 (header,
// close button, composer text, Undo link, and — the group's first named
// deferred item — the `bg-dt-panel text-white` chat bubble, all converted to
// match GovernanceAIPanel.tsx, its already-shipped sibling, line for line:
// `text-dt-title`/`text-dt-body`/`hover:text-dt-body` and the bubble itself
// to `bg-dt-panel text-dt-body`; the Undo link's `hover:text-white` became
// `hover:text-teal-100` — a tone-family brighten, not a jump to neutral,
// matching the CustomerOnboardingLive.tsx `text-teal-400 hover:text-teal-300`
// precedent). Converted all 28 remaining bg-slate (Badge.tsx's default/fallback `slate`
// variant — a live, default-frequency chip, not rare, confirmed by its one
// consumer PlatformConsolePage.tsx passing color="slate" for every
// non-enterprise/non-growth tenant plan — to the doc §7 neutral-chip pair
// `bg-dt-neutral-soft text-dt-neutral border-dt-neutral-border`; toggle
// tracks and small dots to `bg-dt-border-strong` per the mapping table and
// the established "a soft tint on a small dot/track reads as invisible"
// precedent; already-translucent chips to `bg-dt-neutral-soft`;
// DraftApprovalCard.tsx's Reject button to the LiveConnectorsPage
// `bg-dt-border-strong hover:bg-dt-panel text-dt-title` precedent). Converted
// all 7 `divide-slate-700` (5 in PlatformConsolePage.tsx, 1 each in
// PlatformInvitesPanel.tsx and PlatformTeamPage.tsx — uncounted by the four
// metrics, per the brief's separate grep instruction) to `divide-dt-border`.
// The other deferred item —
// OnboardingArchitectPage.tsx's `border-white/10 bg-white/[0.03]` /
// `bg-black/20|30` overlay vocabulary — was converted by meaning (panel/
// inset/border), also uncounted by these four metrics; see the group report
// for the mapping. One real hazard found on judgment, not by the count:
// PlatformConsolePage.tsx:306's tenant-initial avatar used a TRANSLUCENT
// `style={{backgroundColor: t.primaryColor + '30'}}` (~19% alpha) under bare
// text-white — a per-tenant brand-color wash that goes near-white on a light
// page, the same shape of bug as the Workforce group's HireEmployeeWizard
// finding — fixed to `text-dt-title`, which the COLORED_BG regex would not
// have exempted anyway (translucent fills never qualify) but which the raw
// count also would not have flagged as urgent by itself.
//
// The regex itself changed once: `dt-accent` (bare, not just -strong/-hover)
// joined COLORED_BG — it is opaque in every theme block, so text-white on it
// (WorkforceEconomicsPanel.tsx's "Save baseline" button) is a real exemption,
// not a survivor to document.
//
// EVERYTHING ELSE remaining after conversion is a named, script-excluded
// survivor — doc §7 has the full tables: SOLID_FILL_SURVIVORS (30 lines, 8
// files — accentColor/brandColor/badgeColor inline-style fills the COLORED_BG
// regex cannot see because the style attribute isn't on the matched line, the
// DEChatDock `${de.color}` template-literal avatar fills, and LoginPage's
// fixed dark-gradient marketing hero) and CONTROL_SHADE_FOCUS_RING (5 lines,
// 4 files — `focus:border-slate-500` composer/input focus rings, kept literal
// because dt-border-strong's light value is ~1.4:1 against white, an
// all-but-invisible focus ring, versus slate-500's ~4.2:1 in both themes).
// Both lists are enumerated above this baseline, one entry per doc §7 row, so
// a new bare hit anywhere else is a real regression the moment it lands.
//
// Baselines below are the TRUE floor: 0/0/0/0. `--strict` now fails on the
// first unaccounted-for hit, not on drift past a padded number.
const BASELINE = { 'bare text-white': 0, 'bg-slate': 0, 'border-slate': 0, 'text-slate': 0 };
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
