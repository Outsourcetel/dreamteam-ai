# 27 — Knowledge Management: Phase 1 audit, architecture and pushback

**Status:** Phase 1 deliverable. Nothing built yet. Awaiting founder direction on §7.
**Verified against the live database and repo, 2026-07-26.** Numbers here are measured, not estimated.

---

## 1. What exists

| Thing | Reality |
|---|---|
| Documents | **2,000** across 12 tenants |
| `knowledge_collections` (`parent_id` hierarchy) | **0 rows.** Schema exists, entirely unused |
| `knowledge_doc_collections` | **0 rows.** Unused |
| `knowledge_doc_scopes` (`subject_kind`/`subject_id`) | 50 rows. Real, drives per-DE scoping |
| `knowledge_docs.visibility` | 1,950 `tenant`, 50 `scoped`, **0 `role`** |
| Human roles in `profiles` | `tenant_owner`, `tenant_admin`, `platform_super_admin`. That is the entire list |
| Group primitive | `workforce_teams` / `workforce_team_members` — these are **Digital Employee** teams. There is **no human group** |
| Versioning | Real: `previous_version_id`, `is_current`, version viewer shipped |
| Retrieval | `hybrid_match_knowledge` — lexical + semantic fused by RRF, one shared choke point |
| Platform shelf | 61 read-only articles in tenant-less tables (migs 334/336/337) |

### The finding that reframes the whole build

`knowledge_docs` has exactly **one** RLS policy:

```sql
knowledge_docs_tenant_isolation   FOR ALL   USING (tenant_id = auth_tenant_id())
```

`FOR ALL`. **Any authenticated member of a tenant can read, edit and delete every document in that workspace.** There is no human permission concept — not even a read/write split.

This is good news for compatibility. There is no existing human-permission behaviour to preserve, so the new layer can only ever *restrict*. Backfilling "the whole workspace may view" as the default grant reproduces today's behaviour exactly, and every later restriction is a deliberate act.

---

## 2. What is reusable — more than the spec assumes

- **Spaces should be top-level collections, not a new table.** `knowledge_collections.parent_id` already models the hierarchy and holds zero rows. Building Spaces on it means no data migration, and the "≤3 levels / no cycles" constraints land on a table nothing depends on yet. A `knowledge_spaces` table would duplicate a hierarchy that already exists.
- **`knowledge_doc_scopes` is already the AI-audience primitive.** `subject_kind`/`subject_id` generalises from `de` to `de_team` and `archetype` by widening a CHECK. No new table.
- **`hybrid_match_knowledge` has exactly the right shape.** Its `visible_docs` CTE is the single choke point both the lexical and semantic branches join. One predicate there filters before ranking — which is what the spec demands, and the platform-shelf work already proved this function can be reasoned about safely.
- Server-side pagination, faceted search, versioning, owners, review intervals, authority, gap detection and quality analytics all exist and should be left alone.

---

## 3. What is genuinely missing

Spaces as a *security* boundary · the six human permission levels · a **human** group primitive · `knowledge_access_grants` + inheritance resolution · explicit `lifecycle_status` · ingestion jobs/items with a queue and retryable errors · connector permission strategy.

---

## 4. Conflicts and security risks in what exists

1. **`FOR ALL` must be replaced, not joined.** Postgres OR's permissive policies. A new restrictive ACL policy sitting *beside* the existing one would be silently defeated by it. This is exactly the `skill_catalog` defect fixed in mig 330 today — a `USING(true)` policy killing its own tenant-scoped sibling. **Highest-severity trap in this build.**
2. **The retrieval functions bypass RLS.** `hybrid_match_knowledge`, `match_doc_chunks`, `search_knowledge` and `visible_knowledge_docs` are all `SECURITY DEFINER`. ACLs enforced only at the RLS layer would be **invisible to retrieval**. The predicate must go *inside* those functions — which is also the only way to filter before ranking.
3. **`visibility` must not be repurposed.** Agreed, and its `role` branch is dead in practice (0 rows), so extending AI audience via `doc_scopes` is safe.
4. **Two sources of truth on lifecycle.** Adding `lifecycle_status` beside `is_current` creates a drift risk. Today's session hit that bug class twice (tenant-scoped citations silently dropping shelf ids; the deflection and the shelf fan-in disagreeing). `is_current` must be *derived from* lifecycle, or constrained to agree by trigger — never maintained independently.
5. **N+1 at 100k.** Recursive inheritance resolved per document at query time is the classic failure. Effective access must be an indexed join or a materialised closure, not a function call per row.

---

## 5. Proposed model

```
knowledge_collections            reuse. add: space_root bool, depth check ≤3, cycle-prevention trigger
knowledge_access_grants          NEW  (tenant_id, resource_type, resource_id, principal_type,
                                       principal_id, permission, inherit, created_by, created_at)
knowledge_principal_groups       NEW  human groups (the workforce_* tables are for DEs)
knowledge_doc_scopes             reuse. widen subject_kind: de | de_team | archetype
knowledge_docs.lifecycle_status  NEW column, constrained against is_current
knowledge_ingestion_jobs/items   NEW
knowledge_permission_audit       NEW — or reuse audit_events with a new category
```

**Effective access** resolves as: walk the collection ancestry once (recursive CTE, capped at 3), union grants at space/collection/document, take the highest permission, then apply any restrictive child override. Exposed as one `SECURITY DEFINER` function returning a set of document ids for the caller — joined into retrieval, never called per row.

---

## 6. Migration and backfill

1. Every existing document gets a **"General" space** per tenant and a workspace-wide `view`+`edit` grant. Today's behaviour reproduced exactly; no tenant sees a change.
2. `lifecycle_status` backfills to `published` where `is_current`, `archived` otherwise.
3. The retrieval predicate ships **behind a flag, defaulting to the permissive backfill**, so flag-off is byte-identical — the same discipline as migs 328–337.
4. Tenant-isolation and ACL-inheritance tests must pass **before** the flag is flippable.

---

## 7. Pushback — where I think the spec is wrong or premature

You asked for this, so here it is plainly.

### 7a. Permission-aware retrieval will *degrade answer quality*, and the spec doesn't address it

This is my biggest concern and it goes straight at "no compromise on AI and intelligence."

Filter-before-rank is correct for security. But a Digital Employee retrieving from a deliberately narrowed corpus **does not know what it was not shown**. It will answer confidently from partial knowledge — which is precisely the failure the grounded-confidence and judgment-layer work exists to prevent. Security would quietly eat intelligence.

**Fix, and I'd call it non-negotiable:** the retrieval RPC must return a `withheld_count` alongside results. When material was excluded by permission that would otherwise have ranked, the employee is told, and says so — *"there may be material here I'm not permitted to see"* — instead of inventing or answering thinly. That is how you get both, rather than trading one for the other. It costs one integer in the return type and it is far cheaper to build now than to retrofit.

### 7b. The human-permissions layer is the least validated thing in the spec

Measured: **3 human roles exist, and a handful of users.** Several workspaces have one. The six-level model × four principal types × three resource levels is a genuine enterprise ACL matrix — and there is currently no evidence any workspace needs it.

I'm not saying don't build it. I'm saying **build the model, ship the UI as two presets first**: *Open to workspace* (today's behaviour) and *Restricted*, with the full grid as an escape hatch behind "Advanced". The schema supports everything on day one; the interface earns its complexity when a workspace actually has ten people. Shipping a full ACL grid to a one-person workspace is how good architecture becomes an abandoned screen.

### 7c. "Mirror source permissions" should be dropped from this scope

Mirroring SharePoint/Drive/Notion ACLs requires mapping external identities to DreamTeam users. **That mapping does not exist** — there is no SSO/SCIM, and it is a known open item. Without it, "mirror source permissions" can only be approximated, and an approximated ACL is worse than an honest one: it *looks* like it preserves the source's rules while silently differing.

Recommend: **platform-managed permissions only**, stated plainly in connector config, with mirroring deferred until identity federation exists. Anything else is a promise the system cannot keep.

### 7d. Sections as database records — agreed, don't

Your spec already says derive from headings. Strong agree. Chunking is heading-agnostic and an outline is cheap to derive client-side from markdown. A `knowledge_sections` table would be a second source of truth for something the document already contains.

### 7e. Sequencing

The spec's Phase 3 (three-panel UI) before Phase 4 (ingestion) is backwards for *your* situation. Collections currently hold **zero rows** — a three-panel library over an empty hierarchy shows an empty tree. Ingestion is what *creates* the structure. I'd build the guided ingestion flow first so there is something to navigate, then the library.

---

## 8. Files and migrations, in dependency order

```
340  spaces + collection constraints (depth, cycles) + backfill "General" space
341  knowledge_access_grants + human groups + RLS (REPLACING the FOR ALL policy)
342  effective-access resolution fn + indexes
343  permission predicate INSIDE hybrid_match_knowledge + visible_knowledge_docs,
     behind a flag, plus withheld_count  (§7a)
344  lifecycle_status + constraint against is_current
345  ingestion jobs/items + queue states
     src/lib/knowledgeApi.ts · LiveKnowledgeLibrary · KnowledgeIngestionPage ·
     new AccessDrawer + EffectiveAccessPreview components
```

Each increment is independently verifiable, and 340–342 change no behaviour at all.

---

## 9. What I need from you

1. **§7a** — confirm `withheld_count` is in scope. I think it is the difference between a secure product and a secure *and intelligent* one.
2. **§7b** — presets-first UI, or the full grid immediately?
3. **§7c** — drop connector ACL mirroring, or keep it and accept it will be approximate?
4. **§7e** — ingestion before library, or your original order?
