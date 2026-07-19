# Outsourcetel Go-Live: Blockers & Wiring Guide

## Status: Phase 5 Complete ✅ — Wiring Phase (IN PROGRESS)

All frontend components built. Needs backend RPC wiring + configuration.

---

## Blocker 1: Reply-Mode (Draft Approval)

**What it does**: DE drafts a response → human reviews → approves/edits/rejects → sends or escalates.

### Frontend ✅
- `src/lib/replyModeApi.ts` — API layer (submitDraft, getPendingDraft, approveDraft, rejectDraft)
- `src/components/ReplyModeReviewCard.tsx` — Modal UI for reviewing drafts

### Backend (NEEDS MIGRATION)
Create migration `20260719_create_reply_mode_rpcs.sql`:

```sql
-- Draft response storage
CREATE TABLE IF NOT EXISTS draft_responses (
  draft_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  de_id UUID NOT NULL REFERENCES digital_employees(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL,
  user_question TEXT NOT NULL,
  draft_content TEXT NOT NULL,
  confidence NUMERIC DEFAULT NULL,
  sources JSONB DEFAULT '[]',
  status TEXT CHECK (status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT now(),
  expires_at TIMESTAMP DEFAULT (now() + INTERVAL '30 minutes'),
  approved_at TIMESTAMP DEFAULT NULL,
  approved_by UUID DEFAULT NULL,
  rejected_at TIMESTAMP DEFAULT NULL,
  rejected_by UUID DEFAULT NULL
);

CREATE INDEX idx_draft_responses_de_id ON draft_responses(de_id, status);
CREATE INDEX idx_draft_responses_expires_at ON draft_responses(expires_at);

-- RLS policies
ALTER TABLE draft_responses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see drafts in their tenant" ON draft_responses
  FOR SELECT USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY "Users can submit drafts in their tenant" ON draft_responses
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY "Users can approve/reject drafts in their tenant" ON draft_responses
  FOR UPDATE USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- RPC functions
CREATE OR REPLACE FUNCTION submit_draft_for_review(
  p_de_id UUID,
  p_conversation_id UUID,
  p_user_question TEXT,
  p_draft_content TEXT,
  p_confidence NUMERIC DEFAULT NULL,
  p_sources JSONB DEFAULT '[]',
  p_review_timeout_minutes INTEGER DEFAULT 30
)
RETURNS json AS $$
DECLARE
  v_draft_id UUID;
  v_tenant_id UUID;
BEGIN
  v_tenant_id := current_setting('app.current_tenant_id')::uuid;
  
  INSERT INTO draft_responses (
    tenant_id, de_id, conversation_id, user_question, 
    draft_content, confidence, sources, expires_at
  ) VALUES (
    v_tenant_id, p_de_id, p_conversation_id, p_user_question,
    p_draft_content, p_confidence, p_sources,
    now() + (p_review_timeout_minutes || ' minutes')::interval
  )
  RETURNING draft_id INTO v_draft_id;
  
  RETURN json_build_object(
    'draft_id', v_draft_id,
    'de_id', p_de_id,
    'conversation_id', p_conversation_id,
    'user_question', p_user_question,
    'draft_content', p_draft_content,
    'confidence', p_confidence,
    'sources', p_sources,
    'created_at', now()::text,
    'expires_at', (now() + (p_review_timeout_minutes || ' minutes')::interval)::text
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_pending_draft(p_draft_id UUID)
RETURNS json AS $$
BEGIN
  RETURN (
    SELECT json_build_object(
      'draft_id', draft_id,
      'de_id', de_id,
      'conversation_id', conversation_id,
      'user_question', user_question,
      'draft_content', draft_content,
      'confidence', confidence,
      'sources', sources,
      'created_at', created_at::text,
      'expires_at', expires_at::text
    )
    FROM draft_responses
    WHERE draft_id = p_draft_id
      AND status = 'pending'
      AND expires_at > now()
      AND tenant_id = current_setting('app.current_tenant_id')::uuid
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_pending_drafts_for_de(p_de_id UUID)
RETURNS json AS $$
BEGIN
  RETURN json_agg(
    json_build_object(
      'draft_id', draft_id,
      'de_id', de_id,
      'conversation_id', conversation_id,
      'user_question', user_question,
      'draft_content', draft_content,
      'confidence', confidence,
      'sources', sources,
      'created_at', created_at::text,
      'expires_at', expires_at::text
    )
  ) FILTER (WHERE draft_id IS NOT NULL)
  FROM draft_responses
  WHERE de_id = p_de_id
    AND status = 'pending'
    AND expires_at > now()
    AND tenant_id = current_setting('app.current_tenant_id')::uuid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION approve_draft(
  p_draft_id UUID,
  p_edited_content TEXT DEFAULT NULL,
  p_notes TEXT DEFAULT NULL
)
RETURNS json AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();
  
  UPDATE draft_responses
  SET 
    status = 'approved',
    draft_content = COALESCE(p_edited_content, draft_content),
    approved_at = now(),
    approved_by = v_user_id
  WHERE draft_id = p_draft_id
    AND tenant_id = current_setting('app.current_tenant_id')::uuid;
  
  RETURN json_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION reject_draft(
  p_draft_id UUID,
  p_reason TEXT
)
RETURNS json AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();
  
  UPDATE draft_responses
  SET 
    status = 'rejected',
    rejected_at = now(),
    rejected_by = v_user_id
  WHERE draft_id = p_draft_id
    AND tenant_id = current_setting('app.current_tenant_id')::uuid;
  
  RETURN json_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION submit_draft_for_review TO authenticated;
GRANT EXECUTE ON FUNCTION get_pending_draft TO authenticated;
GRANT EXECUTE ON FUNCTION get_pending_drafts_for_de TO authenticated;
GRANT EXECUTE ON FUNCTION approve_draft TO authenticated;
GRANT EXECUTE ON FUNCTION reject_draft TO authenticated;
```

### Wiring (Next Steps)
1. Apply migration to Supabase
2. Wire into `de-answer` edge function: after generating draft, call `submitDraft()` if `reply_mode_enabled`
3. Add modal to chat component showing `ReplyModeReviewCard` when draft is pending
4. Show approve/reject buttons; on approval, send response via `sendResponse()` RPC

---

## Blocker 2: Embed Widget

**What it does**: Customers embed `<div id="dreamteam-widget"></div>` in their website. Support DE runs in iframe.

### Frontend ✅
- `src/components/EmbedWidget.tsx` — React component (chat UI, message loop)

### Hosting & Script (NEEDS)
Create `src/lib/embed-widget.js` (standalone script):

```javascript
/**
 * DreamTeam Support Widget
 * Usage: <script src="https://embed.dreamteam.ai/widget.js"></script>
 * Config: window.DreamTeam({ tenant_id: "...", de_id: "...", theme: "dark" })
 */

(function() {
  window.DreamTeam = function(config) {
    const container = document.getElementById('dreamteam-widget')
    if (!container) {
      console.error('DreamTeam: #dreamteam-widget not found')
      return
    }

    // Create iframe
    const iframe = document.createElement('iframe')
    iframe.src = `https://dreamteam.ai/embed?tenant_id=${config.tenant_id}&de_id=${config.de_id}`
    iframe.style.cssText = `
      width: 100%;
      height: 100%;
      border: none;
      border-radius: 8px;
    `
    container.appendChild(iframe)

    // Setup postMessage communication
    window.addEventListener('message', (e) => {
      if (e.origin !== 'https://dreamteam.ai') return
      // Handle widget events (e.g., resize, answer submitted)
    })
  }
})()
```

### Wiring (Next Steps)
1. Create `/embed` route (new page) that renders EmbedWidget component
2. Tenant ID + DE ID come from query params
3. POST `/api/embed-token` to get JWT (tenant_id scoped, answer-only)
4. Pass token in iframe data attribute for authentication
5. Deploy embed-widget.js to CDN
6. Add embed URL to tenant settings (each customer gets their own embed code)

---

## Blocker 3: Support DE Configuration

**What it does**: Set refund_limit, escalation_rules, preapproval_strategy, knowledge_sources via UI.

### Frontend ✅
- `src/components/ConfigurationUIGenerator.tsx` — Dynamic form from schema (already built & wired)
- `src/lib/configurationFramework.ts` — Config API (already built & tested)

### Wiring (FINAL STEP)
1. Open `src/pages/tenant/WorkforceDEsPage.tsx`
2. In TabProfile (or new Tab 11 "Configuration"):
   - Call `getConfig(tenant_id, 'de', de.id)` on mount
   - Render `<ConfigurationUIGenerator schema={schema} onSaved={refetch} />`
3. Call `setConfig()` on save
4. On Outsourcetel Support DE:
   - Pre-populate schema with template: support domain (refund_limit, escalation_rules, preapproval_strategy, knowledge_sources)
   - User fills in: refund_limit=$500, escalation_rules=5 rules, preapproval_strategy=rule_based, knowledge_sources=[Salesforce, SharePoint]

---

## Deployment Checklist

### Week 1: Go-Live
- [ ] Apply reply-mode migration to Supabase
- [ ] Wire reply-mode into de-answer edge function (draft submission)
- [ ] Build /embed page + routing
- [ ] Generate embed widget script + deploy to CDN
- [ ] Add Configuration tab to Support DE profile
- [ ] Load support template config schema
- [ ] Fill in Support DE config: refund_limit, escalation_rules, preapproval_strategy
- [ ] Connect Salesforce + SharePoint knowledge sources
- [ ] Test end-to-end: question → draft → approve → send
- [ ] Test embed widget in staging customer site

### Verification
```bash
# 1. Check migration applied
SELECT * FROM draft_responses LIMIT 1;

# 2. Test draft submission
SELECT submit_draft_for_review(
  'de-uuid',
  'conv-uuid',
  'What is your refund policy?',
  'Our refund policy allows 30-day returns...',
  0.85
);

# 3. Check configuration loaded
SELECT * FROM de_config WHERE entity_kind='de' AND entity_id='support-de-uuid';

# 4. Test embed widget
curl https://embed.dreamteam.ai/widget.js | head -5
```

---

## Priority: Implement In This Order

1. **Reply-Mode Migration + Edge Function Wiring** (4 hours)
   - Blocking: customer can't use Support DE without approval flow
   
2. **Support DE Configuration** (2 hours)
   - Blocking: can't customize refund/escalation rules without UI
   
3. **Embed Widget** (6 hours)
   - Blocking: customers can't integrate into their website
   
4. **Live Testing** (2 hours)
   - Prove end-to-end: configure → use → improve

**Total**: ~14 hours parallel = go-live ready by end of Week 1.

