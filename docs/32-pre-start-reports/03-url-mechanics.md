# HEADLINE
Good news: the tab rename needs zero URL redirects, because the Employee File's active tab was never in the URL at all — the only deep-linkable thing is ?de=<employee-id>, which the reshuffle does not touch, so every existing bookmark and inbound link keeps working and simply lands on the renamed default tab. The real work is elsewhere: all six inbound links funnel through one hook and three of them semantically want a tab they cannot target (Performance ×2, Trust ×1) — fixable by adding an optional ?tab= param that is provably safe against the URLSync bounce because URLSync only reconciles pathnames; the new 9-tab structure needs a per-role visibility declaration (today all 11 tabs render for every role including read-only, and the Performance tab currently shows per-employee cost data to read-only users); and the one URL-level change in the cut list (deleting the legacy /specialist/* routes) is compile-checked by the exhaustive page map and degrades old bookmarks to a graceful dashboard landing, not a dead click. The historic URLSync bounce is confirmed fixed in current code by three separate guards; the residual hazards are the query-string-stripping branch (mitigated by the single-hook rule) and the silent-deny dead-click class, which the per-role tab filter must be built to avoid.

# STATS
6 inbound link call sites enumerated (1 construction path, 0 raw URLs); 3 of 6 land on the wrong tab today; 3 textual tab pointers found (1 factually wrong today); 0 edge functions and 0 database columns store employee-file links (live DB query); 11+1 current tabs and 8 Workbench subtabs mapped to the 9-tab target; 1 per-tab role-ACL precedent (Settings) + 1 tab-filter precedent (Governance hub) identified for reuse; 3 residual URLSync hazards; 4 founder decisions flagged; 10-item regression checklist produced; ~15 files read, all claims file:line-cited.

# Commitment #5 — Rename/URL Mechanics Plan for the Employee File reshuffle (docs/31 Q12, build step 4)

**Date:** 2026-07-27 · **Method:** read-only. Every claim below is traced to file:line read directly from `D:\Dream Team AI` this session, one live read-only DB query, and the SaaS-readiness memory cross-checked against current code. No browser click-through was run (read-only commitment) — claims marked *inferred* are from code structure, not observed runtime.

**Honesty classification used:** proven-in-code (read this session) / proven-live (DB query) / inferred / not verified.

---

## 1. Tab-routing mechanics as they exist (proven-in-code)

**The app has no React-Router routes at all.** `grep` for `<Route`/`createBrowserRouter` = 0 hits. Navigation is a state machine: `currentPage` lives in AuthContext; `handleSetPage` (`src/context/AuthContext.tsx:543-546`) gates every transition through `canAccessPage` and **silently no-ops on deny** — the "click did nothing" class of bug the Governance hub fixed by filtering its tabs (`src/pages/tenant/governance/GovernanceHubPage.tsx:29-38`).

**URLSync** (`src/App.tsx:151-211`) reconciles `currentPage` ↔ `location.pathname` bidirectionally:
- `PAGE_TO_URL` is `Record<Page, string>` — deliberately exhaustive so an unmapped Page is a **compile error**, not a runtime bounce (`src/App.tsx:62-66`). This is the fix for the historic bounce (see §4).
- First-mount deep-link branch (`App.tsx:176-183`): a cold URL wins over default page state.
- Page→URL branch (`App.tsx:185-189`): `navigate(target, { replace: true })` where `target` is the **bare pathname** — this call **strips any query string** if it fires.
- URL→page branch (`App.tsx:198-205`): only adopts the URL's page when the *pathname* changed (back/forward), guarded by a `lastSynced` ref.
- Effect deps are `[currentPage, location.pathname]` (`App.tsx:208`) — **URLSync never reacts to search-param-only changes.**

**Employee File specifics:**
- Page key `workforce_de_file` → `/workforce/employee` (`src/App.tsx:108`), rendered standalone at `src/App.tsx:467-468`, access tier `ALL_TENANT` (`src/lib/navAccess.ts:72`).
- **The only deep-linkable thing is the DE identity**: `?de=<id>`, written and read exclusively by `src/lib/employeeFileRoute.ts` (`useOpenEmployeeFile` at :13-19, `useEmployeeFileDeId` at :21-24).
- **The active tab is NOT in the URL in any form.** `const [tab, setTab] = useState<FileTab>('today')` (`src/pages/tenant/EmployeeFilePage.tsx:690`); `TabBar` onSelect is a plain local setter (`:779-781`). No sessionStorage, no localStorage, no query param. Refresh or any inbound link **always lands on Today**. There is no mechanism by which any surface can target a tab today.
- The Workbench's 8 subtabs are likewise local state: `useState<Section>('memory')` (`src/pages/tenant/DeWorkbench.tsx:90`), sections declared at `:33-42` (memory, work, reasoning, exceptions, replay, certification, training, compliance).
- The 11 tabs (+1 conditional Specialist Tools when `de.is_specialist`) are declared at `EmployeeFilePage.tsx:63-77` and `:780`; the profile-family tabs render through `DeProfileSections` keyed by `DeProfileSectionKey` (`src/pages/tenant/LiveWorkforceDEs.tsx:3703-3706`).
- **Why `?de=` survives URLSync** (the documented fragility, `employeeFileRoute.ts:5-9`): the hook calls `navigate(path?de=X)` and `setPage('workforce_de_file')` in the same handler tick, so by the time URLSync's effect runs, `location.pathname === target` and the stripping `navigate` at `App.tsx:188` never fires. Any arrival path that sets page state *without* navigating with the query in the same tick would get the query stripped. *(Mechanism proven-in-code; the tick-ordering behavior is inferred from the code comment and effect structure, not observed.)*

**Per-tab role gating today: none.** All 11 tabs render for every tenant role including `read_only`. Precedents that exist for the fix: `SETTINGS_TAB_ACCESS` + `canAccessSettingsTab` (`src/lib/navAccess.ts:191-233`) and the Governance hub's `TABS.filter(t => canAccessPage(...))` (`GovernanceHubPage.tsx:36-38`).

## 2. Complete inbound-link inventory (proven-in-code)

There is exactly **one** construction path — `useOpenEmployeeFile` — and **six call sites**. No raw `href`/`navigate` to `/workforce/employee` exists anywhere else; no `setPage('workforce_de_file')` exists outside the hook.

| # | Call site | Origin surface (page tier) | Click context | Tab it semantically expects | Tab it gets today |
|---|-----------|---------------------------|---------------|------------------------------|-------------------|
| 1 | `src/components/WorkforceBoard.tsx:102` | At Work cockpit, `ops_de_activity` (MANAGE), via `DEActivityPage.tsx:314` | board row: now / next / blocked | live queue → **Work** (new) | Today ✓ becomes Work ✓ |
| 2 | `src/pages/tenant/DashboardPage.tsx:434` | Command Centre (ALL_TENANT) | "Working now" tile — running/waiting items | live queue → **Work** | Today ✓ |
| 3 | `src/components/OutcomeStatement.tsx:137` | Workforce hub "Value" tab, `outcomes` (ALL_TENANT) | economics/ROI row | **Performance** | Today ✗ (mismatch, pre-existing) |
| 4 | `src/pages/tenant/intelligence/IntelligencePages.tsx:322` | `intelligence_performance` (MANAGE), LivePerformancePage roster row "Employee File →" | performance metrics context | **Performance** | Today ✗ (mismatch, pre-existing) |
| 5 | `src/pages/tenant/intelligence/IntelligencePages.tsx:702` | `intelligence_insights` (MANAGE), LiveInsightsPage | "raise {name}'s trust dial to clear the queue" | **Trust & Autonomy** | Today ✗ (mismatch, pre-existing) |
| 6 | `src/pages/tenant/LiveWorkforceDEs.tsx:3780` | Roster, `workforce_des` (ALL_TENANT) | open the file, generic | default | Today ✓ |

**Textual pointers to tab names** (copy, not links):
- `EmployeeFilePage.tsx:769` — records-gate banner says "(Record → Incidents)". **Wrong today** (incidents render under the Governance section, per docs/31); becomes correct only after the reshuffle rehomes incidents into Record as planned. Must be re-checked in the same PR.
- `LiveWorkforceDEs.tsx:940` — "gates autonomy" tooltip references certification gating; certification moves to Trust & Autonomy — copy is generic enough to survive, verify wording.
- `DashboardPage.tsx:422-423` empty-state copy ("link to that employee's file") — generic, safe.

**Outbound links FROM the file** (regression surface for the same dead-click class): `ops_human_tasks` (APPROVALS tier) at `EmployeeFilePage.tsx:137`, `ops_de_activity` (MANAGE) at `:206`, `support_inbox` (ALL_TENANT) at `:418`, `workforce_des` at `:720,733`. The first two **already dead-click for tenant_user/read_only** because `handleSetPage` silently swallows denied pages — a live instance of the bug class, pre-existing, worth fixing in step 4.

**External/stored links:** zero. `grep` of `supabase/` for `workforce/employee` and `workforce_de_file` = 0 hits (no edge function or email emits a file URL). **Proven-live:** an information_schema scan of production found the only URL-ish columns are `connectors.base_url`, `de_messages.audio_url`, `de_product_knowledge.source_url`, `knowledge_chunks.source_url`, `learned_tool_specs.base_url`, `tenants.logo_url` — **no table stores app deep links**, so no data migration is needed for any rename.

**`EmployeeFileStrip`** (slated for cutting): rendered only inside the profile section (`LiveWorkforceDEs.tsx:3711`); takes only `de`, navigates nowhere. Safe to delete with zero link fallout.

## 3. The concrete rename plan

### 3a. URL redirects/aliases needed: **none for the tab merge itself**
The feared URL problem largely does not exist at the URL layer: tabs were never in the URL. `/workforce/employee?de=<id>` is identity-stable, the Page key `workforce_de_file` is untouched, and every bookmark or shared link keeps working — it just lands on the (renamed) default tab. The genuinely URL-touching change in the docs/31 cut list is **deleting the legacy `/specialist/*` routes**: removing those four Page keys forces `PAGE_TO_URL`, `URL_TO_PAGE`, `navAccess`, and the `types/index.ts` union to be cleaned in one compile-checked sweep (the `Record<Page, string>` guard does the policing). Old `/specialist/*` bookmarks then hit no `URL_TO_PAGE` match and URLSync's first-mount branch falls through → the user lands on the default page URL (dashboard). That is a graceful bounce, not a dead click. Decision: accept it (recommended — the audit says the pages hold fabricated data) or keep the four pathnames as aliases into the Employee File of the tenant's specialist.

### 3b. Tab-key mapping (component-state only, no persistence to migrate)

| Old key | New key | Notes |
|---|---|---|
| `today` | `work` | rename + label "Work". **Key collision caution:** `work` previously meant the lifetime ledger; harmless at runtime (no persistence, no URL) but any `?tab=` param added later starts fresh, so no legacy meaning leaks. |
| `work` (ledger) | — deleted | ledger content moves to top of Record |
| `operating` | `operating` | gains watcher manager |
| `record` | `record` | gains ledger header + incidents |
| `performance` | `performance` | gains Goals/KPIs, Development card |
| `workbench` | `workbench` | loses `work` + `training` subtabs (`DeWorkbench.tsx:35,40`); `certification` → Trust tab, `compliance` → Governance tab; internal default `'memory'` unaffected |
| `profile` + `capabilities` | one merged key (`profile`) | `DeProfileSectionKey` (`LiveWorkforceDEs.tsx:3703`) must change in lockstep — same PR, both files |
| `trust` | `trust` | gains certification |
| `development` | — deleted | dissolves into Performance |
| `governance` | `governance` | gains compliance packs, Responsible people replaces Owner |
| `specialist` | `specialist` | conditional, unchanged |

### 3c. Recommended: make the tab deep-linkable (`?tab=`) as part of step 4
Three of six inbound sites (rows 3–5) semantically want a non-default tab and structurally cannot get one. Fix by extending the single hook: `useOpenEmployeeFile(setPage)` returns `(deId, tab?) => navigate(\`${EMPLOYEE_FILE_PATH}?de=${id}&tab=${tab}\`); setPage(...)`. This is **safe against URLSync by construction**: URLSync compares pathnames only and its effect never fires on search-only changes (`App.tsx:186,208`), and the hook keeps navigate+setPage in the same tick so the stripping branch (`App.tsx:188`) never runs. Page side: initialize `tab` from the search param, **whitelisted against the role-visible tab set** (never trust the URL to open a denied section), falling back to the first visible tab; tab clicks update the param with `replace: true` so tab-flipping doesn't pollute back-button history. Then retarget: OutcomeStatement → `performance`, LivePerformancePage → `performance`, LiveInsightsPage → `trust`. If the founder declines `?tab=`, ship the rename with all six sites landing on Work — no breakage, the three mismatches simply persist as today.

### 3d. Per-role tab matrix (docs/29 default-DENY; new declaration needed)
The file page is `ALL_TENANT` but its tabs span content whose page-level equivalents sit at different tiers — the exact shape that produced the Governance hub dead-click bug. Declare a `FILE_TAB_ACCESS` in `navAccess.ts` following the `SETTINGS_TAB_ACCESS` pattern, filter `FILE_TABS` like `GovernanceHubPage.tsx:36-38`:

| New tab | Proposed tier | Anchor |
|---|---|---|
| Work (default) | ALL_TENANT | everyday surface; **must** be in every role's set so the default is always renderable |
| How I operate | ALL_TENANT view; watcher-edit affordances MANAGE | writes enforced server-side regardless |
| Record | ALL_TENANT | but the four unscoped Record readers must be RPC-scoped first (docs/31 step 2) — nav is not a boundary (`navAccess.ts:25-28`) |
| Performance | **MANAGE** | mirrors `intelligence_performance` MANAGE (`navAccess.ts:135`); today per-DE cost/economics are visible to read_only through this file — a live tier inconsistency this closes. Founder sign-off needed (docs/29 amendment). |
| Profile & Capabilities | ALL_TENANT | write RPCs already gated |
| Trust & Autonomy | MANAGE | dial writes live here |
| Governance | MANAGE | mirrors `gov_*` (`navAccess.ts:141-144`) |
| Workbench | MANAGE | reasoning transcripts = most-sensitive content per docs/31; readers also need RPC scoping |
| Specialist Tools | ALL_TENANT (conditional on `is_specialist`) | founder may prefer MANAGE |

Rules: default tab = first visible tab; never render a denied tab; the DE-visibility **assignment axis** (docs/29 axis 2) is enforced by RPC (`can_access_de`), not by this matrix — and with 113/116 DEs unassigned, sub-manager roles will see denied/empty files until the assignment drive runs.

### 3e. Regression checklist for build step 4
1. **Cold deep link:** paste `/workforce/employee?de=<real id>` into a fresh session → file opens on Work, `?de=` still present after settle. Watch for a redirect to `/dashboard` — that is the historic bounce signature.
2. **Warm nav from all six call sites** (§2 table) → correct DE, expected tab, query intact.
3. **Back/forward:** back from the file returns to the origin page (URLSync `App.tsx:198-205`); with `?tab=`, tab flips use `replace:true` so back doesn't walk tab history.
4. **Refresh on the file** preserves DE (and tab, if `?tab=` shipped).
5. **Per-role sweep, all 7 invitable tenant roles:** tab bar filtered per matrix; zero dead-click tabs; outbound buttons to `ops_human_tasks`/`ops_de_activity` hidden or gated for junior roles (pre-existing dead-click at `EmployeeFilePage.tsx:137,206`).
6. **Specialist conditional:** 9th tab only for `is_specialist`; a forged `?tab=specialist` on a non-specialist falls back to Work.
7. **`tsc` clean:** if `/specialist/*` Page keys are deleted, the `Record<Page,string>` exhaustiveness plus `navAccess` and `types/index.ts:54` cleanup all compile in one pass. Note `tsc` excludes `supabase/functions` (known lesson) — irrelevant here, all frontend.
8. **Copy sweep:** gate-banner incident pointer (`EmployeeFilePage.tsx:769`) matches where incidents actually land; `LiveWorkforceDEs.tsx:940` tooltip still true after certification moves.
9. **TabBar at 9 tabs on mobile width** — design-system §5 (scroll/wrap not verified this session).
10. **Nothing to migrate:** no stored links (DB-proven), no persisted tab state, no edge-function URLs.

## 4. The URLSync bounce — what precisely made it bounce, and what remains

**Historic bug (fixed, per memory + current code):** any `Page` missing from `PAGE_TO_URL` → the page→URL branch found no `target`, fell through, and the URL→page branch instantly reverted `currentPage` to the URL's page — the click literally did nothing. Shipped twice (`platform_team`, `platform_security`; new-tenant "nothing works" escalation 2026-07-11). Fixed three ways, all visible in current code: exhaustive `Record<Page, string>` (compile error, `App.tsx:62-66`), the `pathnameChanged` guard (`App.tsx:194-205`), and the `lastSynced` anti-cascade ref (`App.tsx:156-165`).

**Live residual hazards for this reshuffle:**
1. **Query-stripping:** `navigate(target, {replace:true})` at `App.tsx:188` navigates to the bare pathname. Any future path that arrives at the file by setting page state without the same-tick navigate loses `?de=` (and `?tab=`). Mitigation: the single-hook rule — all arrivals go through `useOpenEmployeeFile`. Consider making URLSync preserve `location.search` when the pathname already belongs to the target page; that removes the fragility class outright. *(inferred severity — not reproduced live)*
2. **Silent-deny dead clicks:** `handleSetPage` no-ops on `canAccessPage` failure — every newly tier-restricted surface must filter what it renders, or juniors get dead controls.
3. **Deleted Page keys** downgrade old bookmarks to a dashboard bounce (graceful) — decide alias-or-accept for `/specialist/*` before the sweep.

## 5. Risks that remain
- **Founder decisions embedded here:** Performance-tab tier (ALL_TENANT→MANAGE is a visibility *reduction* for junior roles), `?tab=` adoption, `/specialist/*` alias-or-accept, Specialist Tools tier. None should be decided silently.
- **Shared-hot repo:** two other sessions are active (migrations; a worktree). `LiveWorkforceDEs.tsx` (3,785 lines) and `navAccess.ts` are both plausible collision points — coordinate before step 4 lands.
- **Assignment-drive dependency:** the per-role matrix is only half the story; without `de_assignments` rows (113/116 empty), sub-manager roles see an almost-empty workforce regardless of any tab plan (docs/31 commitment 6).
- **Not verified:** no runtime click-through of URLSync behavior was performed this session; tick-ordering claims are code-derived. The TabBar primitive's overflow behavior at 9 tabs was not read. Whether Vercel-deployed frontend matches repo `main` was not checked (frontend deploys from repo, so drift risk is low but unexamined).
