# Security: Multi-Tenant Isolation Audit

_Last updated: 2026-07-06 — pre-onboarding adversarial audit, first full pass._

This document records a concrete, adversarial security audit of DreamTeam AI's
multi-tenant isolation and permission model, performed live against the
production database ahead of onboarding the first real paying customers. It
is a point-in-time engineering record — for the permanent security
philosophy and principles, see `07_Security_and_Governance.md`.

**Founder's requirement, verbatim:** "no company data should leak to another
or no guardrails or permissions are broken even within a single company
account." This audit tested that requirement directly against the live
database, not just by reading the code.

---

## Plain-language summary (for a prospect or auditor)

**Why your data is safe from other customers:**

Every table that holds customer data has a database-enforced rule (Row Level
Security) that says "you may only see rows that belong to your own company."
That rule is checked by the database itself, every single time, for every
query — it does not depend on the application code getting it right, and it
cannot be bypassed by a bug in a web page or a malicious request. Critically,
the rule doesn't trust anything the user's browser says about which company
it belongs to — it looks up the real answer from a server-side record tied
to your login, every time.

Two real, serious gaps were found in that model during this audit (detailed
below) — both were in newer, less-tested corners of the system, both were
exploited live to confirm they were real (not just theoretical), and both
were fixed and re-verified live the same day, before any real customer
other than the two existing tenants had data at risk.

**Why one department's Digital Employee can't see another department's
systems:** every connection to an outside system (your CRM, your helpdesk,
etc.) has its own explicit permission list — which Digital Employee or
Specialist may read from it, and which may also write to it. A Digital
Employee with no permission on a system gets a plain "access denied,"
whether it asks directly, asks through the automation layer, or asks as
part of a scheduled playbook — all three paths were tested live and all
three deny consistently.

**Why a destructive action can never happen by accident:** any action
marked destructive (e.g., closing a ticket, changing a status) always stops
for a human's explicit approval, no matter how much the system has come to
trust that department's automation. This was tested at maximum trust with
full write permission granted, and the system still stopped and asked a
human — confirmed live, not just in the code.

**Why the audit log itself can't be tampered with:** every recorded action
is chained together with cryptographic hashes, so if any row were ever
altered or deleted, the chain would visibly break. This was verified after
the audit's own adversarial testing (nearly 2,000 events checked for Acme
Telecom) — the chain came back fully intact.

---

## What was checked (method)

1. **Every table** created since migration 011 — confirmed Row Level
   Security (RLS) is enabled and a tenant-scoped policy exists, or the table
   is an intentional platform-global exception (noted below).
2. **Every `SECURITY DEFINER` function** in the `public` schema (70 total,
   including helpers added since the initial 68-function count) — these run
   as the database owner and bypass RLS entirely, so each one was read in
   full and checked for an explicit tenant-ownership check in its own SQL,
   not just a reliance on RLS (which does not apply to them).
3. **Every edge function** (`connector-hub`, `connector-zendesk`, `de-answer`,
   `eval-run`, `ingest-chunks`, `mcp-client`, `playbook-execute`,
   `specialist-consult`, `widget-ask`, plus the removed `workforce-chat`) —
   these use the service-role key, which also bypasses RLS, so every
   database query in each one was checked for an explicit tenant filter.
4. **The tenant-switching logic** in `AuthContext.tsx` — confirmed the tenant
   used for any real data read/write is always resolved server-side from
   the authenticated user's own `profiles` row, never from client-settable
   state. (Demo-mode "which demo company am I browsing" state is a
   deliberately separate, client-side-only concern — it never touches real
   tenant-scoped data operations.)
5. **Live adversarial tests against the real production database** — signed
   in as a real Acme Telecom user and attempted to read/write another
   tenant's data across the newest tables (migrations 025–036), attempted
   to forge tenant/subject identifiers into edge functions and RPCs,
   attempted to have one Digital Employee use a connector it was not
   granted, and attempted to force a destructive action to auto-execute at
   maximum trust.

---

## Findings and fixes

### 1. `platform_config` — CRITICAL — fixed

The table storing platform-wide secrets (the email-provider API key, and
per-tenant alert email addresses) had Row Level Security **disabled
entirely**, with default database permissions still in place for both
anonymous and logged-in roles. Confirmed live: an unauthenticated request
using only the public "anon" key (the key that ships inside every web
browser bundle) could read every secret in the table, and could also
write or delete arbitrary rows, with no login at all.

**Fix:** revoked all anonymous/authenticated access to this table; it is
now reachable only by the backend's own service-role connection. The one
legitimate use — an internal settings page for platform administrators to
rotate AI provider keys — now goes through two new database functions that
independently re-check the caller is a platform administrator before
touching anything.

### 2. Signup tenant-takeover — CRITICAL — fixed

The trigger that provisions a new user's record at signup read the new
user's "which company do I belong to" claim directly from data the user's
own browser supplies at signup time, with no verification. Confirmed live:
a brand-new signup, using only the public anon key, could claim to belong
to Acme Telecom's real, existing company — and the resulting account
received full owner-level access to 100% of Acme Telecom's real data,
because every other part of the system correctly (and reasonably) trusts
that a user's own account record says which company they belong to. The
one broken link was that this record could be forged at the exact moment
of signup.

**Fix:** the signup trigger no longer reads a company assignment from
anything the browser supplies. A new signup always starts with no company
assigned; real company assignment only happens through the app's own
controlled signup flow (which creates a brand-new company for a brand-new
account) or through an existing admin explicitly inviting a teammate into
their own company (which is safe, because it is gated by the inviting
admin's own verified company membership, not by anything the new user
claims). Re-tested live after the fix: the identical forged-signup attempt
now results in an account with no company access at all.

### 3. The demo company's name and a structural signup guard — fixed

The seeded demo company was named identically to the founder's real
company, which is exactly the kind of mix-up that had previously caused the
founder's own real account to be attached to the demo company by mistake.
Renamed the demo company to "Demo Workspace" — an unmistakable name — and
added a second, independent safety check (on top of fix #2 above) that
makes it structurally impossible for any brand-new signup to ever be
assigned to the demo company's ID, even if some future code change
reintroduced a way to specify a company at signup time.

### 4. Twelve database functions with a missing ownership check — fixed

A large group of internal database functions (used for things like
resolving system-access permissions, deciding whether an automated action
should run, and recording the result) accept a "which company" value as a
plain parameter, and several had no check that the value matched the
caller's own company. Because these functions run with elevated database
privileges, the normal per-table protection does not apply to them — each
one had to be checked on its own.

Two of them turned out to be reachable directly by regular logged-in users
and were missing a check that a real customer could exploit today
(confirmed live): looking up another company's knowledge-base articles by
guessing their company ID, and reading another company's automated-action
result by guessing a task ID. Both were fixed with an explicit
ownership check.

The other functions in this group had no real external calling path (they
are only ever used internally, by the backend's own automated
connectors and schedulers) — for those, the safer fix was to remove the
ability for any regular user to call them directly at all, rather than
try to guess the "right" check for a function that was never meant to be
called by a person in the first place.

One more function (recording AI usage totals) was found, during
re-verification, to still be callable with **no login at all** even after
an initial attempted fix — the first fix removed access from named user
roles but missed that the function's access was actually coming from a
separate, broader default grant. This was caught by re-testing live rather
than trusting the first fix, and corrected properly. The lesson generalizes:
after any permission fix, re-test live — don't just re-read the code.

### 5. A dead, dangerous, never-deployed file — removed

An old, pre-rebuild edge function (`workforce-chat`) existed in the
codebase with no login check at all and a "how to deploy this" comment
still attached to it. It was never actually deployed to the live backend,
so it was not a live risk — but it was a landmine: if anyone ever followed
its own deployment instructions, it would have reopened a serious hole
instantly. Removed entirely; its functionality is fully covered by the
newer, properly-secured `de-answer` function.

### 6. Everything else checked came back clean

- Every RLS policy on every customer-data table correctly derives the
  caller's company from a server-side lookup tied to their login — never
  from anything the browser supplies.
- The tenant-switching logic in the app's login/session code was confirmed
  to only affect which *demo* story a user is browsing; it never changes
  which company's real data any read or write actually touches.
- The three entry points for one Digital Employee reaching a system it
  wasn't granted access to (direct backend call, the connector automation
  layer, and a scheduled playbook step) were each tested live and each
  denies consistently.
- The rule that destructive actions always require a human's approval —
  even at maximum automation trust and full write permission — was tested
  live and held.
- The tamper-evident audit log was checked for both tenants after all of
  this adversarial testing and came back fully intact (no broken links in
  the hash chain).

### Intentional platform-global exceptions (not bugs)

A small number of tables are deliberately shared across all tenants and are
not tenant-isolated by design — these are not findings:
- `adapter_templates` and `action_definitions` rows with `scope = 'platform'`
  (shared starter templates any tenant can read, alongside their own
  tenant-scoped ones).
- `trust_policies` platform-level seed rows.
- `platform_config` (see finding #1 — locked to service-role only, not
  tenant-scoped because it isn't tenant data at all).

---

## Residual risk / honest notes

- The "AI Engine" settings tab in the tenant settings page still visually
  presents platform-wide AI provider keys as if they were a per-tenant
  setting. The underlying security hole (finding #1) is fully closed — a
  regular tenant user's save attempt will now correctly fail — but the tab
  should be hidden or moved to the platform console for clarity. Flagged
  as a follow-up task, not a security hole.
- This audit prioritized migrations 025–036 (the newest, least-tested
  surface) and the full function/edge-function/table inventory as
  instructed. It did not attempt to fuzz every possible parameter
  combination of every RPC — it verified the specific bug classes named in
  the audit brief (forged tenant claims, cron/SECURITY DEFINER bypass,
  service-role edge-function leaks, join-table policy independence, and
  tenant-switching bypass) exhaustively, and spot-checked beyond that where
  time allowed.
