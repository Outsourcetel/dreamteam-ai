# 67 — Workstream R: reliability, incident readiness & continuity (2026-08-18)

Three earlier findings pointed the same way — a cron dead 13 days (B-11), the only live connector
dead 7 days (B-13), 133 alerts unread with one firing for 20 days (C-8). R tests the whole chain
that should have caught them: **detect → notify → respond**.

## 1. Detection — Sentry works, and I proved it by breaking something

Rather than infer from configuration, the chain was **tripped deliberately**:

```
thrown in the deployed app:  Error: Workstream R incident-path probe [REVIEW-R-PROBE-1787043449]
console confirms capture:    __sentry_captured__: true
arrived in Sentry as:        JAVASCRIPT-REACT-7, first seen 4 minutes later
```

**Capture → transport → ingestion → issue all work**, with roughly four minutes of latency (which
is why my first two checks came back empty — worth knowing before anyone debugs a "missing"
event). The test issue was then **resolved with an explanatory comment** so it does not pollute
the triage queue.

This also settles a question the data alone could not: the project's **4 pre-existing issues are
22–29 days old**, and that quiet is **real** — not a severed pipe. The application genuinely has
not thrown a new error in three weeks.

## 2. Notification — the same hole, in a third system

| Issue | Age | Status | Users |
|---|---|---|---|
| `useAuth must be used within AuthProvider` | 22 days | unresolved | 0 |
| `TypeError: reading 'id'` | 26 days | unresolved | 0 |
| `TypeError: reading 'parentElement'` | 28 days | unresolved | 0 |
| `TypeError: reading 'id'` (8 events) | 29 days | unresolved | 0 |

Four errors, none triaged, the oldest a month. This is **C-8 again in a third system**: ops alerts
reach only an in-app banner, connector failures reach only a derived UI badge, and Sentry issues
reach only the Sentry dashboard. **Every detection organ in this product works. None of them
reaches a person.**

That is now the single most repeated finding of the entire review, arrived at from four
independent directions.

## 3. The runbook is the wrong shape, and unfilled (register **D-14**)

`docs/INCIDENT-RESPONSE-RUNBOOK.md` — 102 lines, last touched 5 weeks ago.

**It is a breach runbook:** six phases, PHI breach determination, regulator notification clocks,
cyber-insurance hotline. That is a real document to have eventually. It is not the document this
system needs today, because **not one of the three incidents this review found was a breach**:

| Real incident found | Days undetected | Covered by the runbook? |
|---|---|---|
| B-11 — reconcile cron dead | 13 | ❌ |
| B-13 — only live connector dead (`http_402`) | 7 | ❌ |
| C-8 — alert channel unread | 20 | ❌ |

**And it is unfilled: 14 bracketed placeholders.** Every role is `[name]` — Incident Commander,
Security/Eng lead, Privacy/Legal, Comms, Scribe. Every contact is `[____]` — Security Officer,
Privacy Officer, Counsel, the Supabase/Anthropic/Vercel support routes, the breach hotline. Even
the clocks are placeholders (`[1 hour]`, `[5 business days]`). The document says so itself:
*"Engineering starter; complete the bracketed items and review with counsel."*

**One part is genuinely good and should be kept verbatim:** §4's containment actions are real,
current and specific — *disconnect connector → purges the Vault secret*, *suspend tenant*,
*verify audit integrity via `verify_audit_chain`*, *rotate the Anthropic key via Settings → AI
Engine*, *revoke sessions on Security & Access*. Those are commands that would actually work, and
Workstream Q proved the suspend path behaves as described.

## 4. Deploy safety — the recorded hazard is CLOSED

Project memory records a real hazard: deploying a shared edge function from a **stale tree**
silently reverts a parallel session's work. `scripts/deploy.mjs` now **aborts on a dirty or stale
tree**, with a deliberate `--stale-ok` escape hatch and a comment explaining the original
incident (an abort whose exit code was swallowed by a pipe).

**A remembered warning has become an enforced check.** That is exactly the transition this review
keeps recommending, already done here.

## 5. Continuity — bus factor is one

Commits in the last 90 days:

| Author | Commits | Share |
|---|---|---|
| **Claude (Team)** — AI sessions | 855 | **59%** |
| bkhan-saas | 484 | 34% |
| Bilal Khan | 84 | 6% |
| Outsourcetel | 16 | 1% |

1,439 commits, **one human**. Roughly three fifths of recent history was authored by AI sessions
under that person's direction.

Said plainly, because a diligence process will: **if the founder is unavailable, no one else can
currently operate or explain this system.** The mitigations that exist are unusually strong for a
company this size — an executable spec (`golden-path`), a 20-section gate suite, a self-verifying
findings register, and 60+ decision documents — which means the *knowledge* is externalised even
though the *operator* is not. That is a better position than most single-founder codebases, and it
is still a bus factor of one.

## 6. What to do

1. **Route detection to a person.** One job, three systems: ops alerts, connector health and
   Sentry issues into the push channel that already works and is already proven (docs/50). This
   closes C-8, and would have caught B-11 and B-13 on day one.
2. **Write the operational half of the runbook** — five failure modes that have actually occurred
   or plausibly will: a cron dies · a connector dies · the LLM provider fails over · the queue
   stalls · push stops delivering. Each needs a symptom, a check, and a fix. Half a page each.
3. **Fill the 14 placeholders** (D-14). Most are one word; the founder is currently every role.
4. **Rehearse one incident.** Pick B-13 — it is live right now — and run it end to end: notice,
   diagnose, restore, write it up. A runbook that has never been executed is a hypothesis.

## 7. Verdict

**Detection is genuinely healthy** — Sentry proven end to end, cron measured, connector health
derived correctly, backups verified. The instruments work.

**Notification is absent, everywhere.** That is not four problems; it is one problem with four
faces, and it is the reason three real incidents ran for a combined 40 days unnoticed.

Nothing here blocks a pilot on its own, but it compounds what docs/55 found: a customer whose
decisions expire unanswered *and* whose failures reach nobody is a customer who will discover both
at the same time.
