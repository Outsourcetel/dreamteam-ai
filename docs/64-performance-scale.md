# 64 — Workstream J: performance & scale (2026-08-18)

Where each subsystem breaks, measured rather than modelled. The short answer: **nothing is slow
today because nothing is big today** — so this workstream is about locating the cliffs before a
customer finds them.

## 1. Database — small, and correctly indexed

| Table | Rows | Size | Seq scans | Index scans |
|---|---|---|---|---|
| audit_events | 59,895 | 81 MB | 15,400 | 4,936,383 |
| knowledge_doc_chunks | 5,036 | 25 MB | 46,310 | 76,236 |
| knowledge_docs | 2,006 | 23 MB | 2,411 | 37,920 |
| dispatch_log | 4,812 | 7.6 MB | 8 | 45,754 |
| human_tasks | 466 | 1.2 MB | 13,663 | 2,865,507 |

The largest table is **81 MB**. There is no storage or query pressure of any kind, and the
index-scan ratios on the hot paths (audit, tasks, dispatch) are healthy.

**Vector search is properly indexed** — `knowledge_doc_chunks_embedding_idx` is an **HNSW** index
on `embedding vector_cosine_ops`, and there are 5 ANN indexes across the schema. This was the most
likely hidden cliff and it is not there.

## 2. The real cliff — a badge that goes silently wrong at 1,000 rows (register **B-14**)

`listChunkStatus()` (`src/lib/knowledgeApi.ts`) selects `doc_id, chunk_index, embedding` from
`knowledge_doc_chunks` filtered **only by tenant, with no limit**, then counts the rows.

Two problems, one serious:

1. **PostgREST caps the response at 1,000 rows — measured, not assumed.** Above that the counts
   are computed from a truncated set, with **no error and no warning**. `acme-telecom` already
   holds **4,223 chunks**: its badges would be wrong by **76%**.
2. It ships the **embedding vectors themselves** — 1,540 bytes per row — to the browser purely to
   test whether they are null. At 4,223 chunks that is ~6.5 MB of vectors transferred to render
   two numbers.

A customer with roughly 150–200 documents crosses 1,000 chunks. This is not a future problem; it
is a today problem hiding on a suspended demo tenant.

**Enumerated, not assumed** — the other large tables were checked for the same pattern:

| Table | Call sites in `src/lib` | With a bounding limit |
|---|---|---|
| audit_events | 6 | **6** ✅ |
| de_messages | 5 | 2 (rest bounded by conversation) |
| de_conversations | 4 | 2 |
| action_executions | 2 | 1 |
| **knowledge_doc_chunks** | **1** | **0** ❌ |

Only one call site is genuinely unbounded by nature. The `de_conversations` and
`action_executions` sites deserve a follow-up read, but are not confirmed defects.

## 3. Frontend — one monolithic bundle, growing unwatched

```
dist/assets/index-9ac7bf87.js   2,357 kB   (gzip 638 kB)
dist/assets/index.css              73 kB   (gzip  13 kB)
dist/assets/SchemaGallery.js        6 kB
```

The entire application ships as **one 2.36 MB JavaScript file**. Debt-map finding #39 recorded
2.1 MB; it has grown ~12% since, and it grew unnoticed because `vite.config.ts` sets
`chunkSizeWarningLimit: 5000` — the alarm is set above any size the app is likely to reach.

638 kB gzipped is tolerable for an authenticated dashboard on a desktop connection. It is poor for
the `/m` phone shell on mobile data, which is the surface the founder actually uses. There is
essentially **no route-level code splitting** (one 6 kB lazy chunk), so a user waits for the
playbook builder, the schema gallery and every governance page before seeing an approval queue.

The build also warns of a real defect worth fixing while there: `playbookApi.ts` is both
dynamically and statically imported, so the dynamic import cannot split — the code-splitting that
does exist is partly defeated.

## 4. Capacity ceilings — the honest table

| Subsystem | Today | Breaks at | Notes |
|---|---|---|---|
| Database size | 81 MB | far beyond any near-term volume | no action |
| Vector retrieval | 5,036 chunks | HNSW scales to millions | no action |
| **Knowledge badges** | 290 chunks (HQ) | **1,000 chunks/tenant** | already crossed on acme-telecom (B-14) |
| Frontend load | 638 kB gzip | degrades on mobile now | no route splitting |
| Edge invocations | 5,695 / 30 days | not near any limit | mostly heartbeat (docs/50) |
| Cron jobs | 5,082 runs / 24h, 53 active | healthy | all 48 failures are B-11 |
| **Human decisions** | ~5 answered/week | **already exceeded** | ~66 arrive/week (docs/55) |

**The binding constraint is not machine capacity anywhere.** Every technical subsystem has orders
of magnitude of headroom; the queue that is actually saturated is the human one, and it saturated
long ago.

## 5. The five cheapest fixes

1. **Bound `listChunkStatus`** — count server-side (`select count(*) ... group by doc_id`) instead
   of shipping vectors to the browser. Removes a wrong number *and* ~6 MB of transfer. **(B-14)**
2. **Lower `chunkSizeWarningLimit`** to something the bundle can actually trip (say 800 kB), so
   the next 12% of growth is noticed rather than absorbed.
3. **Split the route bundle** — lazy-load the heavy builders (playbook, schema, governance) so the
   phone shell and approvals queue load first.
4. **Fix the `playbookApi` static/dynamic double import** so the existing splitting works.
5. **Add a circuit breaker to connector retries** — 6,714 attempts at a dead endpoint (docs/61) is
   not a load problem today, but it is the shape of one.

## 6. Verdict

**Performance is not a risk to the pilot, and scale is not a risk this year.** The database is
small and correctly indexed, the vector path has the right index, and cron is healthy.

Two things are worth fixing on principle rather than pressure: a badge that silently lies above
1,000 rows, and a bundle that grows because its alarm was disabled. Both are the same failure this
review keeps finding — **a limit nobody watches** — rather than anything structural.
