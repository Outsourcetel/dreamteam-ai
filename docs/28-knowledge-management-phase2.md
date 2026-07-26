# 28 — Knowledge Management Phase 2: permissions, built and proven

**Status:** shipped and live across all 16 workspaces. Enforcement of the human ACL is **on**; permission-aware *retrieval* is behind a default-OFF flag.
**Every number here is measured against the live database, 2026-07-26.**

Phase 1 audit and the pushbacks are in [docs/27](27-knowledge-management-phase1.md). All four pushbacks were approved and are implemented as described there.

---

## What shipped

| Mig | What | Behaviour change |
|---|---|---|
| **341** | Knowledge **Spaces** on the existing `knowledge_collections` table; depth cap ≤3, cycle guard, cross-workspace parent guard; a "General" Space per workspace | None |
| **342** | **P0 security fix** — closed a cross-tenant write path into the global platform shelf | None (no call sites) |
| **343** | `knowledge_access_grants`, human groups, ancestry closure, six-level ladder, backfill reproducing today's access | None |
| **344** | **Replaced** the `FOR ALL` policy on `knowledge_docs` with four command-scoped ACL policies | Yes — see below |
| **345** | Permission-aware retrieval + `withheld_count`; `de-answer` wired | None until flag on |

## The P0 found along the way

Mig 334 revoked the shelf functions from `public, anon, authenticated`. Mig 338 added four more and revoked from `public, anon` — dropping one word.

`publish_platform_shelf_doc` was therefore executable by **any authenticated user in any workspace**, with **no caller check in its body**. The platform shelf is tenant-less by design: 61 articles every workspace's Workforce Assistant cites. One customer's logged-in user could have rewritten the product guide that *all* workspaces are answered from — content injection into every other customer's employee, under our name.

Closed at both layers: the grant revoked, **and** an `is_platform_admin()` check placed inside the body so a future `CREATE OR REPLACE` carries it along. Grants alone would have re-opened silently the next time someone edited the function — which is exactly how 338 happened, four migrations after 334 got it right.

Also fixed: `list_platform_kb_review_queue` was exposing our internal change feed (unreleased migration titles and bodies) to every customer's users.

## The one deliberate narrowing

DELETE on a knowledge document now requires `knowledge_manager` (rank 5). Today *any* workspace member can hard-delete any document. All 19 current users hold an admin role and keep full control; a future ordinary member will not inherit destructive power by default. Reverting is a grant change, not a code change.

Everything else is byte-identical: the backfill grants `everyone → editor` and the admin roles `workspace_admin` per workspace.

## Design decisions worth keeping

- **A Space IS a collection** (`is_space = true`), not a second table. `knowledge_collections.parent_id` already modelled the hierarchy and held zero rows. Two hierarchies would mean two parent chains and two RLS surfaces — the drift bug class that cost this session three separate defects.
- **The `FOR ALL` policy was dropped, not supplemented.** Postgres OR's permissive policies, so an ACL policy beside it would have been decoration. Asserted in-migration that no `FOR ALL` policy survives.
- **One resolver body, parameterised by user.** `knowledge_effective_level_for(user, doc)` is the only implementation; the `auth.uid()` version is a one-line wrapper. Proving the parameterised form over every real user *is* proving the shipped code — no twin to drift, and no auth identity forged to test it.
- **Ancestry is materialised** (`knowledge_doc_access_paths`, trigger-maintained, depth ≤3) and "is this in a locked room?" is denormalised onto `knowledge_docs.restricted_space_id`. Both so the policy is a flat indexed EXISTS rather than recursion per row.
- **A restricted Space is a locked room:** a workspace-wide grant does not open it; you need a grant on the Space or inside it.

## Measured

| Check | Result |
|---|---|
| Cross-tenant resolution | **0** — a user resolves to no access on another workspace's document |
| Own workspace | 6 (`workspace_admin`) for current admins |
| Restricted Space vs workspace-wide grant | **0** — locked out |
| Explicit Space grant | 4 (`publisher`) — gets back in |
| Colleague without that grant | **0** — no leak |
| List path (72 docs) | **1.221 ms**; grants side materialised once (`loops=1`), closure subplan never executed |
| Per-row function path | 33 ms — 27× slower, which is why the SELECT policy avoids it |
| Users losing access | **0** (asserted before the policy swap; migration aborts otherwise) |
| Legacy 7/8/9-arg retrieval calls | 10 / 10 / 10 rows — identical, no call site broken |

## §7a — the answer-quality guarantee

Filtering alone would have been a bad trade. An employee retrieving from a narrowed corpus **does not know what it was not shown**, so it answers thinly *and* sounds certain — the exact failure the grounded-confidence work exists to prevent.

`hybrid_match_knowledge` now returns `withheld_count`: documents that matched the question but were withheld by permission. `de-answer` reads it and instructs the employee to say there may be material it is not permitted to show. Proven: locking one retrieved document produced `withheld_count = 1` and the document's absence from results.

**Acting-user spoofing is closed.** If `auth.uid()` is non-null, `p_acting_user` is ignored and replaced with the caller's own id. Only a null-auth caller (edge function, cron) may name the human being served — otherwise "act as" would be a query parameter.

**Autonomous DE work is deliberately unfiltered.** Background missions have no human whose permissions should narrow them; proven in test (4).

---

## Increments 5–7 (migs 346–349)

| Mig | What | Behaviour change |
|---|---|---|
| **346** | `lifecycle_status` — draft / in_review / published / archived, with "needs verification" **derived** | None (defaults + backfill to `published`) |
| **347** | Ingestion jobs + items: queue, classified retries, backoff, reaper, Space filing | None (new tables) |
| **348** | Repair of damage 346 caused to `updated_at` on all 2,000 documents | Restores truth |
| **349** | Closes a self-publish hole 346 opened | Editors can no longer publish |

### Why "Needs verification" is derived, not stored

It is not a decision anyone makes — it is a fact about time, already expressed by `last_verified_at` / `review_interval_days` / `expires_at`. Storing it means a cron recomputing a column from three timestamps that already say it, and it reads stale between ticks. Derived, it is correct at the instant it is asked.

**Measured honesty:** those three columns are set on **0 of 2,000** documents, so the state currently matches nothing. Rather than ship a state that can never fire, `tenants.knowledge_review_interval_days` lets a workspace switch the whole idea on with one number. Dormant, and labelled dormant.

### Why `lifecycle_status` and `is_current` do not drift

They answer different questions — *which version is newest* vs *what editorial state this is in*. A draft is legitimately the head of its version chain **and** a draft. They agree on exactly one thing (a superseded version cannot stay published), enforced by derivation in a trigger rather than by two writers. Adversarial review confirmed the alternative — deriving `is_current` from lifecycle — would have broken the version chain and un-archived retired documents back into live retrieval.

### 347: the finding that shaped it

`content_hash` existed but was set on **0 of 2,000** documents, unindexed, referenced only by chunk-level conflict probes. Idempotency built on it would have been a guarantee that never fires. 347 makes it real — trigger-computed, backfilled, indexed — *before* deduping against it.

Failures are **classified** `retryable` vs `terminal`. A queue that retries a corrupt PDF forever burns the drain slot, buries real failures, and never tells the human the file was unreadable. Terminal errors skip remaining attempts; retryable ones back off exponentially, capped at an hour. A reaper returns items abandoned by a dead worker. Composes with the existing `connector_ingest_candidates` (discovery + approval) rather than duplicating it.

### Two mistakes I made, and what they cost

**348 — I stamped every document as edited.** 346's backfill updated all 2,000 rows with the `updated_at` trigger live (`distinct_update_seconds = 1`). I guarded exactly this in 347 and missed it one migration earlier. Measured cost: freshness weighting is default-on, but the term moved ~0.2% of one rank position near-uniformly, so ranking impact was real and negligible; the derived lifecycle state was unaffected (it keys off `created_at`); 25 cache rows regenerated. The genuine loss was informational. `updated_at` was reconstructed from `created_at` — stated as a reconstruction, not an undo, since the prior values were unrecoverable.

**349 — I left the publisher gate bypassable.** 346's `set_knowledge_lifecycle()` required publisher to publish. But `lifecycle_status` is an ordinary column, and the UPDATE policy admits **editor**, with a `WITH CHECK` that verifies only the workspace. So any editor could `PATCH /knowledge_docs {"lifecycle_status":"published"}` and skip the gate entirely — no publisher check, no audit event. Found by adversarial review of my own design, verified against the live policy, closed with a BEFORE UPDATE trigger that gates the **transition** (needs `OLD` vs `NEW`, which a `WITH CHECK` cannot see) on every path.

---

## Increments 8–12 (migs 354–360) — the UIs, and what attacking them found

| Mig | What |
|---|---|
| **354** | Ingestion drill-down + retry (retryable failures only; reports the terminal count) |
| **355** | **Regression fix** — `is_current` carries two meanings; a re-published playbook's knowledge was permanently invisible |
| **356** | ACL write API + `preview_space_access` (level **and reason** per person) |
| **357** | `knowledge_collections` FOR ALL → 4 policies; restricted spaces never answer an unidentified asker |
| **358** | Group management, with the group-level ceiling |
| **359** | **Restricting a space was a one-way door**; two unguarded filing RPCs |
| **360** | Closure/junction enumeration closed without policy recursion |

### The one that would have bricked a customer

`knowledge_space_level_for` correctly stops counting workspace grants once a space is restricted — that is what a locked room means, and the mig-356 test asserted it as a win. But 356 then used that same number to authorise **administration**, so locking the room destroyed the authority over it. Measured across the live database: all 16 spaces × every real admin in all 16 workspaces went **level 6 → level 0**, with zero collection-scoped grants anywhere to survive it.

The rule now, and it is load-bearing:

> **`knowledge_my_admin_level` ignores `is_restricted`. `knowledge_space_level_for` honours it.**
> Being locked out of a room's *contents* must not lock you out of its *controls*.

An admin still cannot **read** a restricted space without granting themselves access — which writes an audit event. Full access can always get in; it can never get in silently.

### Enumeration, and why the obvious fix was wrong

The ancestry closure and filing junction were readable tenant-wide, leaking the *shape* of a locked room — that it exists, how many documents are in it, which ids. The natural policy (`you may see a path row if you may see its document`) **recurses**: `knowledge_docs_acl_select` contains an `EXISTS` over the closure, so reading a document consults the closure and reading the closure would consult the document. Postgres raises 42P17.

360 asks the only question that is actually secret — *is this room locked, and am I allowed in it* — reading only `knowledge_collections` and `knowledge_access_grants`, neither of which references the closure. The cycle cannot form structurally, and the migration proves it by running real queries under the `authenticated` role.

**Measured cost:** ~0.33 ms per *distinct* collection; the planner materialises it rather than calling per output row. It only ever runs on bounded sets — the client reads one document's rows, and the docs policy probes a bound `doc_id`+`collection_id` pair. If the closure is ever scanned in bulk, this needs revisiting.

### Pattern worth naming

An RPC gate is worthless if the underlying **table** is client-writable. This appeared **four times**: `knowledge_docs` (344), `lifecycle_status` (349), `knowledge_collections` (357), and the filing RPCs (359). Check `pg_policy` *and* `has_table_privilege` for every table an RPC claims to guard.

And: when a security rule removes access, ask **who keeps the key**. A correct-looking `level = 0` in a test can be a lockout rather than a win.

## Open / next

1. **Enable `knowledge_acl_retrieval`** per workspace when you want employees to respect human permissions. Off everywhere today.
2. `visible_knowledge_docs` (de-answer:567) is **not** ACL-aware — it only decides whether a workspace has *any* documents. Harmless now; would give a slightly wrong deflection message to a user who can see none.
3. **346 lifecycle_status** and **347 ingestion jobs/items** remain. Per §7e, ingestion comes before the three-panel library.
4. **UI not built** — §7b: two presets (*Open to workspace* / *Restricted*) with the full grid behind "Advanced". The schema supports everything today.
5. **Data defect, pre-existing:** one active `tenant_owner` profile references a workspace that no longer exists (created 2026-07-09, likely collateral from the 11-tenant cleanup). They can reach nothing today. Not caused or fixed here.
6. **§7c stands:** connector ACL mirroring remains out of scope until identity federation exists.
