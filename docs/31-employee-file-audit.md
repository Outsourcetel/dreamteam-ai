# 31 — Employee File Deep Audit: 12 founder questions, verified against production

**Date:** 2026-07-27
**Method:** 14 agents, every claim traced to code (file:line) and checked against the live
production database with read-only queries. Every factual claim is classified:
**proven-live** (verified against real data), **built-but-dark** (machinery exists, nothing
uses it), **partial**, **broken**, or **absent**. A completeness critic then audited the
audit — its corrections are folded in below, and what could NOT be proven is listed at the
end rather than papered over.

**Status:** analysis and plan of record for the Employee File rebuild. Nothing in this
document has been built yet.

---

## The five findings that matter most

1. **A one-word bug has silenced your employees since July 22.** DEs raised 18 real
   exceptions — "I can't access the CRM," "the invoices system is down" — and the
   Approve/Reject buttons have never rendered because the UI checks for a status
   (`pending`) the database cannot hold (rows are `proposed`). The backend was fixed in
   migration 340 and has sat dark behind this ever since. Each of the 18 exceptions maps
   1:1 to a work item stuck in `waiting_human` (verified). One word to fix.

2. **Trust is two disconnected systems, and the visible one is frozen.** The badge
   (supervised/established/trusted/autonomous) has no promotion path — all 116 employees
   say "supervised" forever. The real dial underneath is well-built but barely alive, and
   **registered connector actions — most DEs' actual work — structurally cannot earn
   trust**: the gate looks up a per-action row that a database constraint makes impossible
   to create. All 14 non-destructive actions have been permanently human-gated since
   July 7. This is the root of your "the options don't fit most DEs" instinct, and it's
   fixable in place (design below).

3. **The custom-skills feature you asked for already exists.** It shipped in migrations
   205/206 — type any skill name, human-rated 1–5, honestly badged. Zero people have ever
   used it because the entry point is an 11px footnote link. Your question is the
   discoverability bug report.

4. **The moat is empty where customers would look.** The Experience ledger ("the record
   that makes an employee worth keeping") has trustworthy machinery — single server-only
   writer, zero fabricated rows — but **zero rows for every real-tenant DE.** Real work
   never flows through its two write doors. Meanwhile the Execution log beside it is
   excellent: 242 real traced runs, fresh today, failover visible per answer.

5. **The Governance "Owner" is a dead limb.** 0 of 116 DEs have one, zero transfers ever,
   no security rule reads it. The real accountability model (`de_assignments`:
   primary/manager/executive, humans only) is enforced by 8 RLS policies — but only 3
   assignment rows exist, all on one DE. Delete the Owner UI; run an assignment drive.

**Bonus platform bug found while verifying:** the suspended acme-telecom tenant executed
9 actions in the last 3 days. **Tenant suspension does not stop the cron machinery.**
Tracked as a separate task — bigger than the Employee File.

---

## The 12 questions

### Q1 — Record → Experience: is it real?

**Verdict: machinery trustworthy, data absent where it matters.**

The Record tab has four sections. Strongest first:

- **Execution log** — *proven-live and excellent.* Every answer with the model that served
  it (failover made visible) and confidence. 242 runs across 11 real-tenant DEs, fresh
  today. Nothing fabricated; missing fields honestly render "—".
- **Responsible people** — live and working, nearly unused (3 rows, one DE; the other 115
  show "Nobody assigned" — honest, but see Q11).
- **Autonomous runs** — real but thin (13 runs platform-wide), and the section *vanishes*
  for DEs with zero runs instead of showing an empty state, so nobody discovers the
  capability exists.
- **Experience** — the section you asked about. Write-path integrity is *proven*: one
  server-only writer that refuses entries without a real evidence run or action behind
  them; zero orphans; no seed script has ever touched it. But all 75 rows live in the
  suspended acme-telecom tenant (63 of them daily test-fixture noise against "Action
  Layer Verification Account"). **Every real-tenant DE shows the empty state.** Traced
  cause: experience only writes when (a) an inquiry decision carries a customer/ticket
  reference, or (b) an executed action carries an account reference — and in
  outsourcetel-hq neither door has ever fired (0 decision rows despite 242 answers; all
  7 executed actions carried no reference).

Also found: the four Record readers are the **least permission-scoped RPCs on the page**
(no `can_access_de`, unlike the Wave-2 scoped functions) while holding the most sensitive
content (reasoning transcripts) — and the autonomy-gate banner sends users to
"Record → Incidents" when incidents actually render under Governance.

**Do:** wire the two experience doors for real work (medium); scope the four readers
(small — belongs to the Wave-2 migration stream); honest empty state for Autonomous runs
(small); fix or move the incidents pointer (small); stop the daily verification-account
noise rows (small).

### Q2 + Q4 — Work tab, Today, and Workbench→Work: redundant?

**Verdict: your instinct is right, but the fix is a rename plus rehoming — not deletion.**

The three surfaces are two different things plus one true duplicate:

- **Today** = live queue (what's happening now). Real data, fresh today.
- **Work** = *lifetime output ledger by role* — shares **zero** tables with Today. The name
  is the whole problem: the tab called "Work" doesn't show the work queue.
- **Workbench→Work** = genuine duplicate of Today's queue **plus three things that exist
  nowhere else**: the watcher manager (the only place to create/pause watchers), the
  objectives editor (the only "Done" button — the only brake on objectives waking
  forever), and the deliverables reader.

The live data explains why the redundancy is confusing: your workforce is bimodal.
Queue-driven DEs (Bailey 29 items/0 actions) have a rich Today and empty Work;
answer-driven DEs (Technical Support 169 conversations/0 items) the reverse. Whichever
employee you open, one tab looks pointless — a different one each time.

**Do (recommended merge, "organize by tense"):** rename Today → **Work** and absorb the
unique Workbench pieces (objectives editor, deliverables, richer work-item rendering);
move the watcher manager to **How I operate** (it's job configuration, not activity);
move the lifetime ledger to the top of **Record** (it's past tense — and its
auto-executed vs human-approved split is a governance number shown nowhere else, so it
must not die with the tab); delete Workbench→Work. Information lost: none. Tabs 11 → 10.

### Q3 — How I operate: what's the value?

**Verdict: right concept, real data, zero controls — a brochure that should be a control
surface.**

One RPC composes seven real tables into the only page that tells one employee's whole job
as a story. Content is genuinely per-DE (each of the 6 wired DEs has role-distinct
watchers, zero copy-paste). But: ~90% of DEs render mostly empty states; the page has
zero buttons and zero links (it isn't even passed the navigation function) — it shows
"Waiting on you: 114" with no way to act; the "always listening" feature **can never
render for anyone** (it requires a watcher kind nothing in the product can create — so
your support DE, the one truly continuous employee, shows no continuous source); and
every watcher shows "found 0 last time" with no way to tell healthy-quiet from miswired.

**Do:** deep-link every fact (small — highest value-per-line on the page); derive
"always listening" from the DE's actual live channel binding (small); embed the existing
watcher controls inline (medium); an honest per-watcher effectiveness line (small); show
all in-progress objectives, not just one (small). Later: a founder-editable "operating
brief" compiled into watchers — the honest version of the tab's promise (large).

### Q5 — Workbench → Reasoning and Exceptions: complete?

**Verdict per subtab:** Memory **complete** (130 real memories). Work **complete** (moves
per Q2/Q4). Certification **complete** (17 real exam certifications). Compliance
**complete**. Replay Lab **wired end-to-end but never fired live** (the critic caught the
earlier "complete" overclaim — fire one paid replay before calling it done anywhere
customer-visible). Training **shell** — zero rows, and *no writer exists anywhere in the
codebase*; it is structurally empty forever until built. Cut or build.

**Reasoning — partial:** 780 live trace rows updating daily, but the "why" column is NULL
on all 780 — the writer never records it, while the tab's own copy promises "every step
it takes and why." Also chat answers write no traces (chat-only DEs show empty forever),
and the newest-60-rows cap silently clips busy DEs (one has 435).

**Exceptions — broken at the exact moment that matters:** see headline finding 1. And two
deeper gaps once the one-word fix lands: the "remember this" checkbox sets a flag nothing
reads (an approved ruling never becomes a memory — the employee will ask again), and
deciding an exception doesn't touch the paused work item that raised it (proven 1:1: 18
exceptions ↔ 18 stuck items). Ship all three fixes together — the button fix alone would
create 18 "decided" exceptions whose work stays stuck forever, a worse false signal than
today's visible stuckness.

### Q6 — Specialists: why does it exist?

**Verdict: the concept earns its place; the current UI does not — and the feature has
never been used by a real customer.**

A specialist is the phone-a-friend for other DEs: answers a colleague's hard question
only from sources you configure, with confidence and citations. The plumbing is genuinely
built and deployed. Your confusion is structural: there are **two rival setup surfaces
for one concept** — the visible Capabilities "Specialists" panel writes a table *no
runtime path reads* (it feeds only a playbook step that has executed zero times), while
the actually-enforced table (consultation grants, buried under Governance) has **zero
rows** — so no DE anywhere has ever been offered the consult tool. Plus: every tenant has
exactly one specialist, yet the UI offers a Primary/Secondary ranked chooser over a
one-item list. Your own tenant's specialist is disabled. Stale copy still names "Alex"
(the killed persona) and claims the LLM is "awaiting activation" when it's been live
since July 22. And ~130 lines of fabricated consultation histories sit one refactor away
from rendering again on the legacy /specialist/* routes.

**Do:** collapse to one "Colleagues & help" panel writing the enforced table; a single
on/off toggle while only one specialist exists; fix the stale copy; delete the fake data
and legacy routes. **Founder decision:** auto-grant every DE consultation access to the
seeded Technical Specialist at hire — the single change that takes the feature from dark
to live everywhere, but it changes runtime behavior and adds LLM cost per consult.

### Q7 — Trust Dial: how do we make it fully customizable?

**Verdict: your diagnosis is correct, and the fix is to generalize the existing engine in
place — not rebuild it.**

Current state (all proven live):

- **Two disconnected vocabularies.** The badge is frozen at "supervised" for 116/116 with
  no promotion path; the real dial+ladder underneath never moves it.
- **The dial recognizes exactly 4 hardcoded action types** enforced by database
  constraints; what each level unlocks ($1k/$5k/$10k caps, 90/75/60 confidence floors) is
  frozen inside an immutable SQL function.
- **The dial genuinely bites** where wired: dock answers, widget answers, triage, the
  renewal-invoice playbook, and the unified action gate — with guardrails, destructive
  gates and spend caps correctly *above* the dial in every path.
- **Broken twice:** (a) connector actions ask the dial for a per-action row the
  constraint makes unrepresentable → 14 actions permanently human-gated since July 7;
  (b) the Earned Trust panel renders zero cards for any tenant with starter DEs — the
  flagship governance story is invisible exactly where it's showcased.
- **Barely alive in practice:** 17–18 of 116 DEs have an enabling dial row; all 38 ladder
  policies sit at level 0; total lifetime promotion history is 6 events, all from
  July 5–11 testing.
- **New finding:** per-employee ladder policies argue their case with *workspace-wide*
  evidence — one employee could be promoted on another's track record. Must be fixed
  before per-DE trust is honest.

**The design (Architecture B — "generalize the dial in place," chosen over a
capability-matrix rebuild that would rewrite five live enforcement sites):**

1. **Unfreeze the key axis + make level rewards data** (medium, zero behavior change):
   drop the two 4-value constraints; trust keys become free text (`action:<category>` for
   a category, raw action key for one action). Add a per-policy `ladder` — each level
   gets a manager-chosen *name*, a *mode* (draft / act-with-approval / act-within-limits
   / act — your vocabulary, compiled to the proven dial fields), and settings. Null
   ladder = today's exact behavior, so all 116 DEs are unaffected on day one.
2. **Un-brick registered actions** (small): the action gate falls back through
   action-key → category → generic. Existing seeds are all disabled, so nothing opens by
   itself — it becomes *possible* to open trust per action, and that's all.
3. **Surface-derived trust cards** (large): generate each employee's Trust tab from what
   it actually does — its answer channels, its reachable actions, its playbooks — instead
   of the hardcoded 3-card list. Destructive actions listed read-only as "always requires
   approval." This is your exact ask: controls about work this employee does, with level
   names the manager chose. Fully generic — the surface derives from config, never a
   department name.
4. **Per-employee evidence** (medium): scope eval runs and guardrail blocks to the
   policy's employee.
5. **Reconnect the badge** (small): derive it from the earned ladder + records gate.
   Every existing reader becomes honest with zero code changes.
6. **Phase 2 — plain-language trust plans** (medium, deliberately last): the manager
   writes "Maya can send reminders on her own up to $500; after 50 clean sends over 30
   days, raise her to $2,000" → compiled to a draft ladder → human approves. Reuses the
   proven compile-and-approve pattern. Guardrails structurally cannot be overridden by
   any ladder — they sit above the dial in every enforcement path (verified).

Also required regardless: workspace-default trust settings currently live *only inside
one arbitrary employee's file* (Governance dropped its Trust tab in c10ef9b). They need a
Settings home.

### Q8 — Skills: custom vs pick list?

**Verdict: already built, live, well-designed, and undiscoverable — plus four real gaps.**

"+ Add a skill your business cares about" exists at the bottom of the Skills panel:
free-text name, human-rated 1–5, honestly badged "rated by a person," namespaced per
tenant, and the database refuses hand-set scores on the five evidence-measured built-ins.
Zero usage ever, across all tenants — the entry point is a footnote.

Real gaps behind your question: no org-level catalog (skills are workspace objects but
only definable from inside one employee's file); no delete/archive (a typo'd skill is
permanent, on every employee); no role-scoping (your telecom skill appears on the
accounting DE — the KPI catalog already solved this exact problem with role-aware
domains); custom categories are schema-supported but have no UI or RPC; and skills are
near-decorative (nothing in routing, exams, or autonomy reads them — the panel honestly
badges itself "record — not a gate yet").

**Do:** promote the add-flow to a real button (small — answers your question outright);
org-level Skill Catalog manager in Settings with archive + custom categories (medium);
role-scope via the proven KPI pattern (medium); make skills do something in three steps —
render the already-captured review snapshot, then skills as a signal in the escalation
engine, then skill-fit at assignment (graduated).

### Q9 — Goals & KPIs: beyond a % number

**Verdict: everything is numeric-only at every layer, and the "Goals" half of the name is
unshipped.**

The engine works end-to-end (catalog → targets → daily snapshot cron → status) but the
entire goal vocabulary is "this number ≥/≤ that number." Currency and durations are
unlabeled raw numbers; booleans, milestones, ranges, and qualitative goals don't exist at
any layer. Units are stored but *never rendered* — even the live % KPIs display as bare
numbers. Adoption: 6 targets in production, all on one DE; zero manual readings ever; the
daily snapshot feeder writes readings nothing consumes (zero metric-threshold watchers).
Targets sit on Development while all actuals sit on Performance — they never share a
screen.

**Do, in order:** render units (small — "92% / target ≥ 95%"); typed quantitative model
on the existing tables — percent/count/currency/duration/boolean + band targets (medium,
metadata not storage rebuild); milestone goals as a new small table — deliberately NOT
overloading the numeric KPI contract or the DE's autonomous objectives (medium);
rubric-scored qualitative goals using the jsonb that already exists (medium); SLA
attainment only when a real timing signal exists to compute from (honesty first);
give the snapshot feeder its consumer — KPI dropdown in the watcher form plus a one-click
"open a case when this crosses the line" (small). Move the whole panel to the top of
Performance so expectation and result finally read as one story.

### Q10 — Development: does it even work?

**Verdict: half-works. Honest machine-fed flagging; nothing acts on or closes the flags.**

The front of the loop is real and running: a daily cron scans 8-week evidence and opens
items on real thresholds (proven live, succeeded every day this week); skills feed a
consolidated gap item; the quarterly review opens a formal PIP with a deadline and
written consequence. An open item genuinely flips the employee to "Improving."

The back of the loop is missing: the four core item types are **never closed by the
machine** even when the metric recovers (and in 16 days no human has ever closed one —
the two demo DEs are stuck "Improving" indefinitely); **nothing executes a plan** — the
already-built improve drivers (migs 278/282) never read this table; a **failed PIP
vanishes from the panel** (the UI filters don't know the status exists); and the PIP's
consequence and due date are stored but displayed nowhere.

**Do:** auto-close recovered items by mirroring the skill-gap pattern that already exists
(small — the single defect that makes the feature feel broken); render PIP due date,
consequence, and a visible failed state (small); wire items to the existing improve
drivers so the loop closes — the defensible "self-developing employee" story (medium).
**Founder decision:** program or flags? If you decline the wiring, relabel the card
"Improvement flags" so the name stops overselling.

### Q11 — Governance Owner: who is it?

**Verdict: a human, never a DE — and it does nothing. Delete it.**

The Transfer dropdown only offers human team members and the RPC rejects anyone else. But
0 of 116 DEs have an owner, the transfer has been used zero times ever, and no security
rule reads the column. The provisioning path that created your fleet explicitly writes
NULL. Meanwhile the *real* model — `de_assignments`, primary/manager/executive, shown as
"Responsible people" on the Record tab — is enforced by 8 RLS policies and is what
permissions actually read (docs/29). Two panels in the same file claim the accountability
job; only one is real.

One thing worth saving from the dead path: it wrote a tamper-evident audit event on
transfer. The live assignment functions write **no audit events at all** — for a
governance product, an unrecorded change of who answers for an employee is a story a
prospect's auditor will find.

**Do:** delete the Owner row/modal and render the responsibility summary in its place
(small); redirect manual DE creation to write a "primary" assignment instead of the dead
column, then retire the column via the migration stream (medium); add audit events to
assignment changes (small); run the assignment drive — 113 of 116 DEs have nobody named,
and under default-DENY that means sub-manager users see an almost-empty workforce
(founder action, ~1 hour).

### Q12 — The reshuffle

**Verdict: 11 tabs (+1 conditional) → 9, organized by the question each answers.**

| # | Tab | Question it answers | Main changes |
|---|-----|--------------------|--------------|
| 1 | **Work** (default) | What's happening right now? | Today renamed; absorbs objectives editor, deliverables, richer queue rows; single "Next up" |
| 2 | **How I operate** | What is this employee's job? | Gains watcher manager; every fact becomes a link; effectiveness lines |
| 3 | **Record** | What has it done? | Gains lifetime output ledger (header) + incidents; readers get permission-scoped |
| 4 | **Performance** | Is it meeting expectations? | Gains Goals & KPIs (top), Economics, reviews, Skills, Development-plan card |
| 5 | **Profile & Capabilities** | How is it set up? | Profile + Capabilities merged; new "Colleagues & help" writing the enforced table |
| 6 | **Trust & Autonomy** | What may it do alone? | Surface-derived cards; certification moves in (it gates autonomy); records-gate banner |
| 7 | **Governance** | Who answers for it, under what rules? | Responsible people replaces dead Owner; compliance packs move in; audit views |
| 8 | **Workbench** | Open the hood | Memory, Reasoning (+pagination), Exceptions (fixed), Replay. Work subtab deleted; Training cut |
| 9 | **Specialist Tools** (conditional) | Specialist's own bench | Unchanged; stale copy fixed; legacy routes deleted |

Cuts (nothing real is lost — full mapping preserved in the audit data): Owner machinery,
Workbench→Work, Training (no writer exists), human-attestation certs (0 rows ever),
custom profile fields (0 definitions ever), the EmployeeFileStrip (all four tiles
duplicate other surfaces), the fabricated SpecialistsPage data and dead panels in
LiveWorkforceDEs.tsx.

**Build order** (11 steps, sequenced so honesty lands before layout):
1. The one-word Exceptions fix + the two loop-closers (memory write, work-item requeue) + the incidents pointer. *(small)*
2. Scope the four Record readers — coordinate with the Wave-2 migration session. *(small)*
3. Dead-weight sweep (Owner UI after audit events land, fake data, dead panels, Training, strip). *(small)*
4. The core merge: Today→Work, Workbench→Work dissolved. *(medium)*
5. Record rebuild (ledger header, incidents in). *(small)*
6. How I operate → control surface. *(medium)*
7. Profile+Capabilities merge + Colleagues & help. *(medium)*
8. Development dissolves into Performance; certification to Trust. *(medium)*
9. Governance rebuild + workforce-board unassigned-DE nudge. *(small)*
10. Data wiring so the tabs aren't hollow on the real tenant: evidence decisions from the
    live answer path, account refs into action parameters (Experience doors), exception
    decisions → memory + requeue. *(medium)*
11. The trust customization program (five migrations + Settings home). *(large, founder-gated)*

---

## Before we start: six commitments the founder did not ask about

Findings beyond the 12 questions that should be locked in before any rebuild step ships.

> **STATUS 2026-07-27 (end of day):** #1, #2, #5 and #6's worksheet are DONE — full
> reports in `docs/32-pre-start-reports/`. #3 is DONE (migration 429, with a category
> correction by the Wave-2 session — see the reports). #4 is unblocked by #1's verdict
> (de-answer deployed = repo) and is the next build. Corrections from the reports:
> the unassigned figure is **115 of 116** (91 of 92 active in non-suspended tenants),
> not 113/116; and #2 found the permission surface is materially worse than the four
> Record readers — 2 unguarded RPCs (one internet-reachable), 8 role-gate gaps on
> writers, 21 tenant-only readers. See `02-permission-matrix.md` for the ranked list.

1. **Deploy-parity pass.** Every runtime claim in this audit about edge functions
   (trust enforcement, trace writers, gate ordering) was verified against *repo* source,
   not the *deployed* functions — and this codebase has a history of deploy drift
   (verify_jwt gotchas exist for a reason). One diff pass of deployed vs repo closes the
   audit's largest evidentiary hole. Cheap; do it first.
2. **Full permission matrix for the Employee File's ~60 RPCs.** The four Record readers
   are proven-unscoped, but Workbench readers (memory, traces, exceptions, replay) and
   the rest were never checked against docs/29 default-DENY. This is new scoping surface
   beyond the docs/30 worklist and belongs to the Wave-2 migration stream — which makes
   it urgent now (see #6).
3. **Audit events on assignment changes BEFORE deleting Owner.** The dead ownership path
   audited its transfers; the live one records nothing. Deleting Owner first would leave
   accountability changes unrecorded in a governance product — sequence matters.
4. **The real-tenant evidence pipeline.** `evidence_run_decisions` is 0 for
   outsourcetel-hq despite 242 answers. This single gap is why the Performance tiles,
   the Experience ledger, AND the development detector are all empty or inert for every
   real DE — three "broken-looking" features share one un-wired pipe. Rebuilding the UI
   without it ships beautiful empty tabs.
5. **Rename/URL mechanics plan before the tab merge.** URLSync bounce is a known gotcha
   in this codebase; deep links from the Command Centre and gate banners point at tab
   names the merge changes; and the new tabs need a per-role visibility matrix under
   docs/29 nav-gating. A half-day of planning prevents a class of regression the
   design-system checklist won't catch.
6. **The assignment drive graduated from "nice" to "urgent" mid-audit.** Wave-2 scoping
   (migs 387–424) went live while this audit ran. The moment anyone below manager signs
   in, they see an almost-empty workforce — because 113 of 116 DEs have nobody named.
   The security machinery now outruns the org data feeding it.

Also standing, from the same day's session: rotate the Supabase access token (it sat in
plaintext in the permissions file for weeks before today's cleanup), and the stale-copy
sweep — two pages currently claim live machinery is dormant ("Designed until
activation", "Awaiting ANTHROPIC_API_KEY"), which understates the product in every demo.

## Your eight decisions

1. **Missions front door.** The docs/14 keystone has never been used — 0 missions ever,
   any tenant, despite full wiring and 5 templates. Keep it on the per-employee Work tab
   collapsed, or move mission creation to the Command Centre where orders are actually
   given? Placement, not plumbing, is the likely failure.
2. **Auto-grant consultation at hire?** Takes the specialist machinery from dark to live
   everywhere. Changes runtime behavior; adds LLM cost per consult (no volume estimate
   exists yet — ask for one before approving if cost matters).
3. **Development: program or flags?** Wire the improve drivers so the machine attempts
   the fix and closes the loop, or relabel to "Improvement flags."
4. **Delegated tasks** (DE→DE handoff): 0 rows ever. Keep and rehome, or cut until a real
   use case demands it?
5. **Trust program go/no-go** — and, urgently and separately: workspace trust defaults
   need a Settings home regardless (they're currently editable only from inside one
   arbitrary employee's file).
6. **Experience ledger priority.** Wire it with the reshuffle (step 10), or accept the
   redesigned Record tab shipping with its headline section empty on every real DE?
7. **Naming.** "Work" for the merged live tab (recommended)? "Profile & Capabilities" or
   plain "Setup"?
8. **The assignment drive.** ~1 hour of your time to name a primary on each active DE.
   Until then, "Nobody assigned" undercuts the governance story on nearly every file.

---

## What this audit could NOT prove (read before trusting any claim above)

The completeness critic audited every agent's evidence. These limits stand:

- **Deploy parity.** Every claim about edge-function *runtime* behavior (dial enforcement
  sites, trace writers, gate ordering) was verified by reading repo source, not the
  deployed functions. Database-side claims used live definitions and are solid. One
  diff pass of deployed vs repo functions would close the largest evidentiary gap.
- **"Wired" ≠ "exercised."** The custom-skills flow and the Certification exam button are
  completely wired in code, but neither has provably been executed through the UI even
  once. Replay Lab has never fired a live replay (spend avoided). Treat all three as
  built-and-wired, not proven-in-use.
- **Watcher lifetime-zero matches** is inferred from last-run counts only; lifetime
  history was not queried.
- **Row-count discrepancies** between agents (dial rows 41 vs 51; one internal 17-vs-18
  arithmetic slip) — the live-verified numbers (51; 18 enabling rows) are used above.
- **The daily writer** producing action executions in the suspended tenant was never
  identified — spun off as its own task, along with the suspension-doesn't-stop-crons
  finding it proves.
- **Rename/merge mechanics** (deep links from other surfaces, URLSync's known bounce
  gotcha, per-role tab visibility under docs/29 nav-gating) need a concrete plan before
  step 4 ships. No day-level estimates or staged-rollout plan exist yet for the
  reshuffle of a 796-line page plus a 3,785-line component file.

Closed post-critique by direct verification: the 18 exceptions ↔ 18 stuck work items
linkage is real (all 18 joined), and the suspended-tenant machinery leak is confirmed
(9 action executions in 3 days against a suspended tenant).
