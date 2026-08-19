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

## Block 5 — I recommend, you say one word, I do it.

Everything here is reversible and I have a clear call. Say **"go on block 5"** and I
execute all of it, or name the ones you want held back.

**21. Rotate the Resend API key (A-6).** The installed key is the one pasted into chat.
Blast radius is still nil — zero outbound drafts ever — which is exactly why now is the
cheap moment. Three steps, all clicks in your account; I will write them out.

**22. The stranded `tenant_owner` (A-5).** Three profiles carry `tenant_id` NULL, one of
them an owner — a real person's half-finished signup. `ON DELETE SET NULL` manufactures
another on every workspace deletion. Deactivate the profile; fix the FK behaviour so it
stops happening.

**23. The 12 orphaned migrations (B-10).** Production's ledger holds migrations whose
source is only on an unmerged branch, and `main` holds *different* files at the same
numbers. Live consequence: main's execute-perimeter is red. This needs the other
session's branch merged — coordination, not code — and I should not merge someone
else's in-flight work without your say-so.

**24. `docs/HIPAA-SECURITY-POLICY.md`.** It claims a programme that does not exist.
*Recommendation: delete it.* A policy nobody follows is worse than no policy, on the
day someone reads it in diligence.

**25. Fill the incident runbook's 14 placeholders (D-14).** Every role is `[name]`,
every contact `[____]` — Security Officer, Privacy Officer, Counsel, vendor support
routes. The honest fill is **your name in all five roles**, and writing that down is
itself the useful act.

**26. Decommission the legacy `outsourcetel` tenant and the probe tenants.** Eleven
idle employees generating alert noise and skewing every metric we read.

**27. Alert triage (C-1).** 136 open alerts; the banner shows 6; the weekly value
digest — your actual value read — is buried underneath. Route by severity so the digest
surfaces. ⚠ Not by resolving alerts: `resolve_cleared_ops_alerts` already runs every 15
minutes, so anything still open is a condition that has **not** cleared.

**28. Two builds that raise the decision rate, which is the real bottleneck:**

- **Batch decisions.** You answer at 50–67% within the hour when you engage; the loss
  is per-item friction. Approve-many in one pass.
- **Capture the reason.** Almost no decision so far recorded *why*. That rationale is
  exactly the evidence a trust promotion needs — without it, item 2 has nothing to
  promote on.

**14 workspaces on the starter checklist (G-3)** stays open deliberately: migrating a
customer's live template is their opt-in, not ours.

---

## If you only answer four

**2** (open the ladder), **1** (a price), **13** (buy PITR), **16+17** (withdraw the two
ghost approvals). Those four move the verdict further than the other twenty-four
combined — the first two are what a customer is actually buying, and the last two are
proof the queue can be emptied at all.
