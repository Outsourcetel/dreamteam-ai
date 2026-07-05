# Migrations

- **011+ — production track.** Applied to the live project (`rfsvmhcqeiyrxivbmpel`) via the Supabase Management API (`POST /v1/projects/.../database/query`), not `supabase db push`. New migrations continue this numbering.
- **001–010 — legacy / pre-production-track.** Kept for history only; superseded by the entity/outcome rebuild. Do not re-apply and do not delete the files. Notably, `006_knowledge_chunks_and_search.sql` created the legacy `knowledge_chunks` table (1536-dim), superseded by `knowledge_doc_chunks` (012).
