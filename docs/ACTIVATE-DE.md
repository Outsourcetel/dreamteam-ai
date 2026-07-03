# Activate the DE brain (5-minute runbook)

The `de-answer` edge function is deployed but dormant until the Anthropic API key is set.

1. **Get a key:** https://console.anthropic.com → API Keys → Create Key (starts `sk-ant-`).
2. **Set the secret** (either path):
   - Dashboard: Supabase → project `rfsvmhcqeiyrxivbmpel` → Edge Functions → Secrets → add `ANTHROPIC_API_KEY`.
   - API (token in `.supabase-token`):
     ```
     curl -X POST "https://api.supabase.com/v1/projects/rfsvmhcqeiyrxivbmpel/secrets" \
       -H "Authorization: Bearer <management-token>" -H "Content-Type: application/json" \
       -d '[{"name":"ANTHROPIC_API_KEY","value":"sk-ant-..."}]'
     ```
3. **Verify:** log in as a live tenant, add a knowledge document in Knowledge → Library, then ask Alex (chat dock) a question about it. A grounded answer with a confidence chip and a "From: <doc title>" line means it's live. Low-confidence answers create a real Human Tasks escalation.
