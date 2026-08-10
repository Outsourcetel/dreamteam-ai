# Conversation Checks (tool-call retention) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline — chosen by the founder for this work stream). Steps use checkbox syntax.

**Goal:** Handoff 06 §A's "What Sophie already checked" — retain, per conversation, what the DE verified before escalating, so the owner stops re-doing the work before trusting the draft.

**Architecture:** One new table (`conversation_checks`, mig 667) written best-effort by the widget runtime at its three escalation exits, read by a small panel in the support inbox's detail pane. The evidence that EXISTS at escalation today: knowledge sources consulted, caller identity verification, the guardrail rule that blocked, the escalation rule that fired, and confidence. **No conversation-time connector calls exist in this runtime (verified — zero tool references in widget-ask/de-answer), so none are invented**; `kind='connector'` is in the CHECK constraint for the day they arrive.

**Tech stack facts (verified 2026-08-10):** `exec_sql` is GONE — apply migrations via `scripts/db-query.mjs`; ledger = `public.schema_migrations` keyed on filename; migration tail is 666 → this is **667**. `tsc` excludes `supabase/functions` — syntax-check edge code with esbuild from node_modules. widget-ask is deployed public (`verify_jwt=false` — confirm via Management API before deploy, deploy with `--no-verify-jwt`).

## Global Constraints

- **No mixing with the parallel session:** fetch + rebase before the deploy; deploy ONLY `widget-ask`; `de-answer` (dock escalations) is a shared function they edit — named follow-up, not touched.
- **A check row is evidence, not decoration:** rows are written ONLY for checks that actually ran. Empty state says "No checks were recorded before this came to you" — never a fabricated ✓.
- **Best-effort writes, never blocking:** a failed insert logs and the reply still goes out (the .rpc-sweep rule: telemetry is not load-bearing; but it must never be SILENT — log the error).
- Table security per the standing rules: RLS on, tenant-scoped SELECT for authenticated, **no INSERT/UPDATE/DELETE policy for clients** — the service-role runtime is the only writer.
- Live proof by simulation (the voice-spike pattern): drive a real escalation through the deployed function with a real widget key, SELECT the rows, then DELETE the test conversation + checks.

---

### Task 1: Migration 667 — the table, applied and negatively probed
- [ ] Write `supabase/migrations/667_what_the_de_already_checked.sql`: table (tenant_id, conversation_id, de_id, kind CHECK in ('knowledge','identity','guardrail','escalation_rule','connector'), ok boolean, label text, detail text null, created_at), indexes (conversation_id), RLS enable + one SELECT policy (tenant members via existing tenant-scope idiom copied from a recent migration), asserts BEFORE (to_regclass null) and AFTER (exists + rowsecurity + policy count = 1).
- [ ] Apply via `node scripts/db-query.mjs` (file mode per its README/usage); verify `to_regclass('public.conversation_checks')` NOT NULL and ledger row present.
- [ ] Negative control: as `authenticated` (set_config request.jwt.claims simulation is NOT valid per memory — instead verify via policy catalogue: `pg_policies` shows exactly one SELECT policy and zero write policies; plus `has_table_privilege('authenticated','conversation_checks','INSERT')` — if the default grant machinery leaves INSERT privilege, RLS with no INSERT policy still denies; record BOTH facts).
- [ ] Commit.

### Task 2: widget-ask writes the checks at its three escalation exits
- [ ] Add `recordChecks(admin, tenantId, convId, deId, checks: Array<{kind, ok, label, detail?}>)` — one insert, try/catch, `console.error('conversation_checks:', …)` on failure.
- [ ] Exit ~343 (escalation-rule handoff): knowledge sources (if any yet), identity (if verdict exists), escalation_rule row (`ok:false`, label "Stopped by the rule: <rule>").
- [ ] Exit ~453 (guardrail block): guardrail row (`ok:false`, label "Blocked by the guardrail: <rule>") + identity + sources.
- [ ] Exit ~491 (low-confidence draft): sources rows (`ok:true`, "Read: <title>" each), identity row (verified → `ok:true` "Caller identity verified" / not → `ok:false` "Caller identity not verified"), confidence row (`ok:false`, label "Confidence <n>% — below the send threshold").
- [ ] Syntax-check with esbuild; commit.

### Task 3: lib + panel
- [ ] `supportInboxApi.ts`: `ConversationCheck` type + `listConversationChecks(conversationId)` (plain select, order created_at).
- [ ] Detail pane (SupportInboxPage): when `sel` is needs_human/human_owned, load checks; render "What <deName> already checked" — ✓ (ok) / ✕ (not ok) rows, dt tokens, 12px floor; empty → the honest line. Loads lazily per selected conversation; failure → panel absent, never fake.
- [ ] tsc + commit.

### Task 4: deploy + live simulation + cleanup
- [ ] `git fetch` + confirm 0 behind (rebase if not); Management API: confirm widget-ask `verify_jwt` current value; `npx supabase functions deploy widget-ask --no-verify-jwt --project-ref rfsvmhcqeiyrxivbmpel`.
- [ ] Pull a real widget key for outsourcetel-hq (or a demo tenant) from the DB; POST a question engineered to escalate (e.g. explicit refund-promise ask that trips rules, or nonsense that yields low confidence); assert HTTP result `needs_escalation: true`.
- [ ] SELECT conversation_checks for the new conversation — expect ≥2 rows (identity + confidence at minimum). THIS is the feature proof.
- [ ] Cleanup: DELETE the test conversation (cascade covers messages; delete checks rows explicitly if no FK cascade), verify zero residue.
- [ ] Full check suite; commit; update memory.

## Out of scope (named)
- `de-answer` (dock escalations) — shared with the parallel session; same `recordChecks` pattern applies verbatim when picked up.
- Connector-fact checks ("couldn't reach Stripe") — no conversation-time tool calls exist anywhere in the runtime yet; the `kind` constraint already admits them.
- email channel — served by a different inbound path; follow-up with de-answer.
