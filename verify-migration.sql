-- Verify migration 20260720 was applied
SELECT 
  'draft_responses' as table_name,
  COUNT(*) as exists_check
FROM information_schema.tables 
WHERE table_name = 'draft_responses'
UNION ALL
SELECT 
  'embed_tokens',
  COUNT(*)
FROM information_schema.tables 
WHERE table_name = 'embed_tokens'
UNION ALL
SELECT 
  'config_schema_templates',
  COUNT(*)
FROM information_schema.tables 
WHERE table_name = 'config_schema_templates'
UNION ALL
SELECT 
  'RPC Functions Count',
  COUNT(*)
FROM pg_proc
WHERE proname IN ('submit_draft_for_review', 'get_pending_draft', 'get_pending_drafts_for_de', 'approve_draft', 'reject_draft', 'generate_embed_token', 'get_or_create_embed_token', 'verify_embed_token');
