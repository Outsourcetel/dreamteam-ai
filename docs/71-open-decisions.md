# 71 — The decisions we kept walking past

Ten rounds of "take the next 10" fixed what code could fix. Every round also left
something behind that code **cannot** fix, because the missing input is a person's
answer, a payment, or an act of authority only the founder holds.

This is that residue, collected in one place. **28 items.** None of them is new work
discovered today; every one was named in a round and parked.

Live as of 2026-08-20:

| Signal | Now |
|---|---|
| Tenants with a price configured | **0** |
| Employees whose replies can reach a customer unsent by a human | **0 of 129** (see item 2 — `trust_level` is a derived badge, not the gate) |
| Decisions waiting on a human | **412** pending, 27 expired |
| Objectives blocked | **46** |
| Unresolved ops alerts | **136** |
| ERPNext consecutive failures | **8,184** |

The shape of the list is the finding: **the product's remaining problem is almost
entirely a decision backlog, not a build backlog.**

---

## Block 1 — Only you can answer these. No default exists.

These change what gets built. I have a recommendation on each but no authority to pick.

**1. A price, and billing switched on.** `tenant_billing_config` holds zero rows.
Nothing can charge anyone, so no revenue path has ever been exercised end to end.
*Decision:* a number and a unit (per employee / per resolved conversation / flat), or
an explicit "pilots are free until N customers".
*My recommendation:* per-employee-per-month, because that is what the product actually
meters and what the customer already thinks they are buying.

**2. Open the trust ladder — DECIDED 2026-08-20: outbound replies, no money.**
Reading the machinery to execute this found that "supervised" is **three separate
dials**, and my earlier "129 of 129 supervised" was a derived badge, not the gate.
What actually runs:

| Dial | What it controls | State today |
|---|---|---|
| `de_autonomy` (enabled, `min_confidence`) | the right to **produce** an answer instead of escalating | open at 70% on 22 rows — but 20 are the internal Workspace Assistant (mig 339). Every other employee has **no row**, and no row means floor 101, which is unreachable: everything escalates. |
| `digital_employees.external_reply_mode` | the right to **send** it to the customer | `draft` on **129 of 129**. No reply has ever reached a customer unsent by a human. |
| `trust_policies.current_level` | the governed, audited ladder that *should* set dial 1 | **0 on all 90 rows** — and level 0 means `enabled=false`, which contradicts the live 70% rows. The ladder and the dial were seeded by different paths and never reconciled. A floor of 70 is not a value the ladder can even produce; its levels are 90 / 75 / 60. |

The founder’s chosen class maps to `external_reply_mode = 'auto'`: the reply reaches the
customer, `max_amount_cents` stays null by construction, so no money can move.

**Turning it on is safe by construction.** `run_reply_mode_gate_internal` sweeps every
`auto` employee and pulls it back to `draft` — raising a `trust_demotion_notice` that
says why — on a failed records gate, an open critical incident, or 8-week metrics
showing >50% escalation or >15% errors. Restoring it is deliberately a human act.

**But on our operating tenant it would currently be inert, and that is the finding.**
Running `de_records_gate` across outsourcetel-hq’s twelve live employees:

- **9 pass the gate** — Accounting, Billing & Invoicing, Business Development, Finance,
  Marketing, Onboarding, Renewal, Account Success, Workspace Assistant — and **8 of the
  9 have no autonomy row at all**, so their confidence floor is 101 and every answer
  escalates no matter what the reply mode says.
- **Technical Support** is the only customer-facing employee with a working answer dial
  (70%), and it is **blocked by the gate for `stale_certification`**.
- **Front Desk and IT Helpdesk** are blocked `never_certified` — that is item 12.

So today there is **no employee where flipping reply-mode to auto would produce a single
auto-answer.** Executing the decision takes two steps per employee, in order:

1. **Grant the answer dial** — trust ladder level 1 (90% floor) on `answer_dock` /
   `answer_widget`. This is the governed path and I can prepare it.
2. **Flip the reply mode** — `set_de_external_reply_mode` demands `auth.uid()` and
   owner/admin (mig 433), because "switching to auto does not approve one reply, it
   removes the approval step for every future one." **I cannot call it and will not
   route around it.** It is a click per employee, in that employee’s Channels settings.

Technical Support additionally needs re-certification before the gate will let it stay.

**3. The email channel.** `RESEND_INBOUND_SECRET` is unset; the inbound function is
deployed and honestly returns 503. Email is the default support channel for the
mid-market buyer we are targeting, and it has never carried a message. (D-9)
*Decision:* which domain receives customer mail, and the go-ahead to wire it.
*Effort once decided:* under a day.

**4. Counsel.** Four questions I should not answer: governing jurisdiction, a liability
cap, a content retention window (today conversations are kept forever with no policy),
and a DPA plus subprocessor commitment. That last one has a live edge — see item 5.
*My recommendation:* one hour of a startup lawyer's time before the first *paid*
customer, not before the first pilot.

**5. Subprocessor policy (A-8).** The failover chain is Anthropic → Bedrock → OpenAI →
Google. A provider **joins the chain the moment its key is set in Settings** — no
policy change, no customer notice. Today only Anthropic sees customer content and the
privacy policy names only Anthropic, so we are currently truthful by accident.
*Decision:* name all four in the policy now, or gate key-setting behind an
acknowledgement that says what it means. Adding a key one busy afternoon is otherwise
a silent disclosure breach.

**6. Voice: park or invest (G-4).** Zero voice messages, ever. The plan of record
picked Vapi custom-LLM. Nobody has said whether we are doing it.
*My recommendation:* park it in writing and stop carrying it in every review.

**7. Support auto-close (G-5).** Deliberately unbuilt since baseline. Still undecided.
*My recommendation:* build it — it is small, and "why is this still open" is the most
common complaint about support tooling that lacks it.

**8. Configurable onboarding step types (G-2).** Documents, spreadsheets, PDFs, links.
Scoped 2026-08-10, spec'd 2026-08-11, nothing built; the storage foundation exists
with 0 objects.
*Decision:* build now, or after the first paying customer.

---

## Block 2 — Authority. Founder-locked by our own rules; I must not act.

**9. `propose_connector` needs a role nobody holds (B-4 / F-3).** Onboarding binds
`locations_configured` → `propose_connector`, which requires the `workforce_assistant`
role. The employee this workspace gives onboarding work to does not have it, and the
only holder is the Workspace Assistant, which has never been activated.
*Decision:* drop the role requirement from the binding, or activate the Workspace
Assistant. Permissions are founder-locked (docs/29), so this is yours either way.

**10. One support-shaped exam gates every role (C-5, founder decision D6).**
`outsourcetel` has been publish-gated since 2026-07-04 off a two-question failed run.
Every certification ever recorded is `support_agent`.
*Decision:* per-archetype exams, or a per-archetype gate that only blocks its own role.

**11. The approved-action driver is inert (D-10).** Cron `approved-action-driver-5min`
is `active=false`, awaiting your go. **The register marks this one as never to be
closed by an agent**, so I will not touch it.
*Decision:* turn it on, or say what must be true first.

**12. Exam content for Front Desk and IT Helpdesk (E-1).** Neither can be activated:
`gate_de_certification()` refuses `active` without a passed certification, and there
are no questions for these archetypes. I deliberately did not route around the gate.
*Decision:* you author or approve the questions. Writing the exam **is** setting the
bar that authorises an employee — which is why it is not mine to do.

---

## Block 3 — Money. Small, and each closes a real hole.

**13. Point-in-time recovery — roughly $100/month.** Backups exist and are verified;
without PITR the loss window is up to 24 hours. *Recommendation: buy it.*

**14. Prove a restore into a throwaway project.** The drill compares *structure* today.
It has never restored *rows* anywhere. The dev rebuild proved why that gap matters — a
structurally perfect database could not hire anyone.
*Recommendation: do it once, now, before a customer's data is in there.*

**15. Frappe Cloud billing.** ERPNext — the only real external integration — returned
`http_402` and has now failed 8,184 times. The circuit breaker (mig 774) stopped the
retries; restoring service is provider-side.
*Decision:* pay the bill and revive it, or drop ERPNext from the demo story.

---

## Block 4 — Taps in the UI. Two minutes, and only you can make them.

Migration 704 is explicit: **an agent never decides, rejects or cancels a human task.**
So these sit until you touch them.

**16. F-1 / B-2 — the $15,600 Meridian approval.** Pending, with no executor row on
either linkage column. Approving it sends nothing; it is a ghost. *Withdraw it.*

**17. F-2 / B-3 — kinetic's `create_specialist` approval.** Its action definition is
disabled, so the resolver answers `action_definition_not_found`. *Withdraw it.*

**18. F-a — who is the human at these accounts?** `customer_account_contacts` is empty
for every account. Eight escalations collapse to that one question.

**19. F-b — the $85,000 commercial decision.** Escalate to formal dunning, or stop
chasing. 22 tasks collapse to it. The machinery was fixed (migs 701/703); the decision
was not.

**20. D-11 — onboarding has never run end to end.** Zero `action_executions` with an
`onboarding:%` dedupe key. Blocked on two browser steps only a workspace owner can take.

---

## Block 5 — worked 2026-08-20. Four premises did not survive contact.

**21. Rotate the Resend API key (A-6) — YOURS, three clicks.** Still right, still
unstarted, and still nil blast radius (zero outbound drafts ever), which is why now is
the cheap moment. In order: create a new key in the Resend dashboard; set it with
`npx supabase secrets set RESEND_API_KEY=<new>` (or Supabase dashboard › Edge
Functions › Secrets); then revoke the old key in Resend. Revoking first would take
email down between the steps. I cannot do any of it — that is credential entry.

**22. The stranded `tenant_owner` (A-5) — MY RECOMMENDATION WAS WRONG. Not done.**
Two of the three NULL-tenant profiles are `platform_super_admin`, where NULL is
correct by design; only one is stranded. That one is **Bashir Khan, and it is their
ONLY profile** — deactivating it, as I proposed, would lock a real person out of the
product entirely, for no live gain, since a profile with no tenant already fails
`auth_tenant_id()` everywhere.

Checking whether it was dangerous found something that looked worse and turned out
better, registered and then closed the same day as **A-10** (it was filed as A-9 and
renumbered — a parallel session had claimed that id in the same hour).

`auth_has_tenant_role()` filters on user and role but **not on tenant**, so read alone
it answers "does this user hold this role anywhere". A caller that separately proves
membership of workspace B still takes the ROLE from workspace A — sharpest in
`set_tenant_llm_key`, where an LLM key adds a subprocessor that receives customer
conversations (item 5).

**It is not reachable, and I was wrong about why it might be.** `profiles_user_id_key`
is UNIQUE on `user_id` **alone** — a constraint, not a bare index, with 12 foreign keys
depending on it. One user, at most one profile. So the role held "anywhere" and the role
held "here" cannot differ, and `auth_tenant_id()`'s unordered `limit 1` is deterministic
rather than arbitrary, because it selects from at most one row. I proposed shipping that
invariant as a new guardrail without checking whether it already existed. It did.

What was genuinely missing: **neither object mentioned the other.** Someone widening
`profiles` so one person can join two workspaces would be reviewing a membership change,
not an authorisation model, and nothing would tell them they had just converted 89
callers from "your role here" to "your role anywhere". Migration 793 puts that warning on
both objects and asserts the index shape, so the widening fails loudly. A-10 stays closed
only while that shape holds — the register re-checks it every certify run.

**23. The orphaned migrations (B-10) — DONE, and it was 16, not 12.** The register
named 715 and 717 on branch `goofy-swanson`; that was stale. The real set was 756–789,
all on `origin/claude/docs54-stage-c`, and it had been growing — 7, then 12, then 16 —
as parallel sessions applied from worktrees without merging. Recovered the migration
FILES only, not that branch's other in-flight work. Proof rather than assumption: all
16 hash, under the ledger's own `migrationChecksum()`, to exactly what production
recorded when it applied them; 0 ledger rows remain orphaned and 0 of all 811
mismatch. **main can rebuild production again.**

**24. `docs/HIPAA-SECURITY-POLICY.md` — MY RECOMMENDATION WAS WRONG. Left in place.**
I called it a programme that does not exist. Reading it, it is honestly self-labelled:
*"starter template, not legal advice… must be reviewed and completed by qualified
HIPAA counsel"*, and it flags its own organizational gaps. That is not a diligence
liability, it is a useful artefact for item 4. The product's only other HIPAA mentions
describe compliance **packs**, a real feature, not certification. Deleting it would
have destroyed work worth having.

**25. The incident runbook's placeholders (D-14) — BLOCKED ON ONE FACT.** Four
`[name]`, four `[____]`, plus Security Officer, Privacy Officer and Counsel. The honest
fill is one person in all five roles, but the only `tenant_owner` on outsourcetel-hq is
a generic "Outsourcetel Owner", and I will not put a guessed human name into a security
document. **Tell me the name and I will fill all fourteen.**

**26. Decommission the legacy tenant and the probes — NOT DONE, needs your call.**
`outsourcetel` is **status=active** with 11 employees; `review-lab-disposable` is trial
with 4; `b5-probe-…` is already suspended with 2. ⚠ Deleting a workspace is precisely
what manufactures the stranded profiles in item 22 — so the safe verb is **suspend**,
not delete. Name which of the three and I will suspend them.

**27. Alert triage (C-1) — DONE.** Not by severity: `ops_alerts` has no severity
column, only (kind, message, detail, created_at, resolved_at). The actual bug was that
the banner rendered `alerts.slice(0, 6)` — the first six — so with 52
`de_objective_wake_spin` and 23 `edge_function_error` rows, the three weekly
`value_digest` alerts were never once on screen. It now ranks by kind before slicing:
service-affecting first, then the digest, then everything else newest-first.

**28. The two decision-rate builds — NOT STARTED, and one number was overstated.** I
wrote "almost no decision recorded why"; it is **12 of 43** — low, but not almost none.
Batch *approve* is deliberately not built alongside batch withdraw: withdrawing owes
nothing, approving owes an invoice send or a real external charge, and those two must
not share a code path or a habit. Both are features rather than hygiene — say the word
and they get planned properly.

**14 workspaces on the starter checklist (G-3)** stays open deliberately: migrating a
customer's live template is their opt-in, not ours.

---

## If you only answer four

**2** (open the ladder), **1** (a price), **13** (buy PITR), **16+17** (withdraw the two
ghost approvals). Those four move the verdict further than the other twenty-four
combined — the first two are what a customer is actually buying, and the last two are
proof the queue can be emptied at all.
