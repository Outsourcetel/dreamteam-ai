-- 582 — remove the two leftover MCP specialist sources.
--
-- Both date from the original MCP build (2026-07-05) and belong to "Technical
-- Specialist", the Digital Employee migration 550 stopped seeding into new
-- workspaces. That employee is DISABLED, so neither source has been reachable
-- from any live path for a month:
--
--   "Broken MCP server"   → nonexistent-mcp.dreamteam-invalid.example
--                           deliberately invalid, used to prove the client
--                           fails honestly rather than pretending. Its last
--                           handshake is a recorded DNS failure.
--   "DeepWiki public MCP" → mcp.deepwiki.com, handshaked once and never used.
--
-- They also now sit on the wrong side of a control: the allowlist went strict
-- today with mcp.stripe.com as the only permitted host, so both are refused on
-- every call. Leaving them is leaving two dead rows that a future reader would
-- have to re-investigate to discover mean nothing.
--
-- CHECKED BEFORE DELETING, because tidying must never cost evidence:
--   · the only FK to specialist_sources is specialist_source_secrets
--     (ON DELETE CASCADE) — 0 secrets attached to either;
--   · 0 rows reference them in de_incidents, de_learning_edits or
--     spec_consultations;
--   · 4 audit_events DO mention them. Those STAY. An audit log records what
--     happened, not what currently exists — the handshakes really did occur,
--     including the one that failed. The entries will point at removed rows,
--     which is correct, and is exactly how migration 578 left the voice
--     cleanup.
--
-- The Technical Specialist DE itself is deliberately NOT touched: it is
-- disabled rather than stale, and removing an employee is a different decision
-- from removing two test fixtures hanging off it.

do $$
declare
  n_sources int;
  n_secrets int;
begin
  select count(*) into n_secrets
    from specialist_source_secrets
   where source_id in (select id from specialist_sources where source_type = 'mcp_server');

  delete from specialist_sources
   where source_type = 'mcp_server'
     and config->>'endpoint' in (
       'https://nonexistent-mcp.dreamteam-invalid.example/mcp',
       'https://mcp.deepwiki.com/mcp'
     );
  get diagnostics n_sources = row_count;

  perform public.append_audit_event_internal(
    '5bb802e1-8e92-4eef-9a7a-ac348785d43f',
    'Platform maintenance', 'system',
    format('Removed %s stale MCP specialist source(s) left from the July build — both belonged to a disabled employee and both were refused by the allowlist. Audit history kept.', n_sources),
    'config_change',
    jsonb_build_object('kind', 'stale_mcp_sources_removed', 'sources', n_sources,
                       'secrets_cascaded', n_secrets)
  );
end $$;
