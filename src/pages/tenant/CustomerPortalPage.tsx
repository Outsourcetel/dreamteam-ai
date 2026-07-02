import React, { useState, useEffect, useRef } from 'react'
import { AuthUser, Tenant, Page } from '../../types'
import { Badge, StatCard, PageTabs, PORTAL_TABS } from '../../components'
import { supabase } from '../../supabase'
import { runAgentLoop, resolveConversation } from '../../lib/api'
import * as api from '../../lib/api'

// ── Sentiment helper ───────────────────────────────────────────
const getSentiment = (text: string): '😤' | '😊' | '😐' => {
  const t = (text || '').toLowerCase();
  if (/frustrated|angry|terrible|awful|worst|hate|useless|broken|horrible/.test(t)) return '😤';
  if (/happy|great|love|excellent|thank|awesome|perfect|amazing|good/.test(t)) return '😊';
  return '😐';
};

// ── SLA elapsed helper ─────────────────────────────────────────
const elapsedMinutes = (createdAt: string): number => {
  return Math.floor((Date.now() - new Date(createdAt).getTime()) / 60000);
};

const slaStatus = (mins: number, urgentMins: number, normalMins: number): 'green' | 'amber' | 'red' => {
  if (mins > normalMins) return 'red';
  if (mins > normalMins * 0.7) return 'amber';
  return 'green';
};

const SLADot = ({ color }: { color: 'green' | 'amber' | 'red' }) => (
  <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
    color === 'green' ? 'bg-emerald-400' : color === 'amber' ? 'bg-amber-400' : 'bg-red-400'
  }`} />
);

const CustomerPortalPage = ({
  user,
  tenant,
  subPage,
  setPage,
}: {
  user?: AuthUser;
  tenant?: Tenant;
  subPage: string;
  setPage: (p: Page) => void;
}) => {
  const dbConvIdRef = React.useRef<string | null>(null);
  const accentColor = tenant?.primaryColor || '#6366f1';
  const tenantId = (tenant as any)?.id || null;

  const [chatInput, setChatInput] = useState('');
  const [messages, setMessages] = useState<
    {
      role: 'user' | 'agent';
      text: string;
      time: string;
      confidence?: number;
      actions?: string[];
    }[]
  >([
    {
      role: 'agent',
      text: 'Hi! I am your AI assistant. I can answer questions, look up your account info, and perform actions on your behalf. How can I help you today?',
      time: '10:00 AM',
    },
    {
      role: 'user',
      text: 'What is my current plan and how much have I used this month?',
      time: '10:01 AM',
    },
    {
      role: 'agent',
      text: 'You are on the Growth plan. This month you have used 980,000 of your 2,000,000 token allowance (49%). Your billing period resets in 18 days. Would you like me to send a usage summary to your email?',
      time: '10:01 AM',
      confidence: 97,
      actions: ['Send Usage Summary', 'Upgrade Plan', 'View Billing History'],
    },
  ]);
  const [typing, setTyping] = useState(false);
  const [traceVisible, setTraceVisible] = useState(false);
  const [traceSteps, setTraceSteps] = useState<
    {
      stage: string;
      status: 'pending' | 'running' | 'done' | 'escalated';
      detail: string;
      confidence?: number;
      duration?: number;
    }[]
  >([]);
  const [agentUsed, setAgentUsed] = useState('Support Agent');
  // ----- rebuilt live portal chat state -----
  const pTenantId: string | null = (user && (user as any).tenantId) || (tenant && (tenant as any).id) || null;
  const pIsUuid = (v: any) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  const pLive = pIsUuid(pTenantId);
  const [pConvos, setPConvos] = useState<any[]>([]);
  const [pActiveId, setPActiveId] = useState<string | null>(null);
  const [pMessages, setPMessages] = useState<any[]>([]);
  const [pInput, setPInput] = useState('');
  const [pSending, setPSending] = useState(false);
  const [pEscalating, setPEscalating] = useState(false);
  const [pLastResult, setPLastResult] = useState<any>(null);

  // ----- portal settings state -----
  const [settingsSection, setSettingsSection] = useState<string>('branding');

  // Branding
  const [brandName, setBrandName] = useState(() => {
    try { const s = JSON.parse(localStorage.getItem('dt_portal_brand_' + pTenantId) || '{}'); return s.brandName || ''; } catch { return ''; }
  });
  const [brandHeadline, setBrandHeadline] = useState(() => {
    try { const s = JSON.parse(localStorage.getItem('dt_portal_brand_' + pTenantId) || '{}'); return s.brandHeadline || ''; } catch { return ''; }
  });
  const [brandColor, setBrandColor] = useState(() => {
    try { const s = JSON.parse(localStorage.getItem('dt_portal_brand_' + pTenantId) || '{}'); return s.brandColor || accentColor; } catch { return accentColor; }
  });
  const [brandLogoUrl, setBrandLogoUrl] = useState(() => {
    try { const s = JSON.parse(localStorage.getItem('dt_portal_brand_' + pTenantId) || '{}'); return s.brandLogoUrl || ''; } catch { return ''; }
  });
  const [widgetPosition, setWidgetPosition] = useState<'left' | 'right'>(() => {
    try { const s = JSON.parse(localStorage.getItem('dt_portal_brand_' + pTenantId) || '{}'); return s.widgetPosition || 'right'; } catch { return 'right'; }
  });
  const [showPoweredBy, setShowPoweredBy] = useState(() => {
    try { const s = JSON.parse(localStorage.getItem('dt_portal_brand_' + pTenantId) || '{}'); return s.showPoweredBy !== false; } catch { return true; }
  });
  const [brandSaving, setBrandSaving] = useState(false);
  const [brandSaved, setBrandSaved] = useState(false);

  // Widget embed tab
  const [embedTab, setEmbedTab] = useState<'vanilla' | 'react'>('vanilla');
  const [widgetTestOpen, setWidgetTestOpen] = useState(false);
  const [widgetCopied, setWidgetCopied] = useState(false);

  // Pre-chat form
  const [prechatEnabled, setPrechatEnabled] = useState(false);
  const [prechatFields, setPrechatFields] = useState<{ id: string; label: string; type: string; required: boolean }[]>([
    { id: 'f1', label: 'Name', type: 'text', required: true },
    { id: 'f2', label: 'Email', type: 'email', required: true },
    { id: 'f3', label: 'What can we help you with?', type: 'select', required: false },
  ]);
  const [prechatPreviewOpen, setPrechatPreviewOpen] = useState(false);

  // SLA
  const [slaUrgent, setSlaUrgent] = useState(() => {
    try { return JSON.parse(localStorage.getItem('dt_portal_sla_' + pTenantId) || '{}').urgent ?? 5; } catch { return 5; }
  });
  const [slaNormal, setSlaNormal] = useState(() => {
    try { return JSON.parse(localStorage.getItem('dt_portal_sla_' + pTenantId) || '{}').normal ?? 60; } catch { return 60; }
  });
  const [slaLow, setSlaLow] = useState(() => {
    try { return JSON.parse(localStorage.getItem('dt_portal_sla_' + pTenantId) || '{}').low ?? 24; } catch { return 24; }
  });
  const [slaAlertEnabled, setSlaAlertEnabled] = useState(false);
  const [slaAlertEmail, setSlaAlertEmail] = useState('');

  // Labels
  const labelColors = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
  const defaultLabels = ['Bug Report', 'Feature Request', 'Billing', 'General', 'Refund', 'Complaint', 'Praise'];
  const [conversationLabels, setConversationLabels] = useState<{ id: string; name: string; color: string }[]>(() => {
    try {
      const saved = localStorage.getItem('dt_portal_labels_' + pTenantId);
      if (saved) return JSON.parse(saved);
    } catch {}
    return defaultLabels.map((name, i) => ({ id: 'l' + i, name, color: labelColors[i % labelColors.length] }));
  });
  const [newLabelName, setNewLabelName] = useState('');

  // Conversation labels applied per conv
  const [appliedLabels, setAppliedLabels] = useState<Record<string, string[]>>(() => {
    try { return JSON.parse(localStorage.getItem('dt_conv_labels_' + pTenantId) || '{}'); } catch { return {}; }
  });
  const applyLabelToConv = (convId: string, labelId: string) => {
    setAppliedLabels(prev => {
      const curr = prev[convId] || [];
      const next = curr.includes(labelId) ? curr.filter(id => id !== labelId) : [...curr, labelId];
      const updated = { ...prev, [convId]: next };
      try { localStorage.setItem('dt_conv_labels_' + pTenantId, JSON.stringify(updated)); } catch {}
      return updated;
    });
  };

  const saveBrandSettings = async () => {
    if (!pTenantId) return;
    setBrandSaving(true);
    const payload = { brandName, brandHeadline, brandColor, brandLogoUrl, widgetPosition, showPoweredBy };
    try { localStorage.setItem('dt_portal_brand_' + pTenantId, JSON.stringify(payload)); } catch {}
    try {
      await supabase.from('platform_config').upsert({ tenant_id: pTenantId, key: 'portal_brand', value: JSON.stringify(payload) }, { onConflict: 'tenant_id,key' });
    } catch {}
    setBrandSaving(false);
    setBrandSaved(true);
    setTimeout(() => setBrandSaved(false), 3000);
  };

  const saveSlaSettings = () => {
    if (!pTenantId) return;
    try { localStorage.setItem('dt_portal_sla_' + pTenantId, JSON.stringify({ urgent: slaUrgent, normal: slaNormal, low: slaLow, alertEnabled: slaAlertEnabled, alertEmail: slaAlertEmail })); } catch {}
  };

  const saveLabels = (labels: { id: string; name: string; color: string }[]) => {
    setConversationLabels(labels);
    try { localStorage.setItem('dt_portal_labels_' + pTenantId, JSON.stringify(labels)); } catch {}
  };

  // Embed code snippets
  const vanillaCode = `<script>
  window.DreamTeamConfig = {
    tenantId: "${pTenantId || '[your-tenant-id]'}",
    portalName: "${brandName || ((tenant?.name || 'Support Center'))}",
    primaryColor: "${brandColor}",
    position: "${widgetPosition}"
  };
</script>
<script src="https://widget.dreamteam.ai/v1/chat.js" async></script>`;

  const reactCode = `import { DreamTeamWidget } from '@dreamteam-ai/widget';

<DreamTeamWidget
  tenantId="${pTenantId || '[your-tenant-id]'}"
  primaryColor="${brandColor}"
  position="${widgetPosition}"
/>`;

  // ----- human escalation inbox state -----
  const eList = React.useState<any[]>([]);
  const eItems = eList[0]; const setEItems = eList[1];
  const eActive = React.useState<any>(null);
  const eSel = eActive[0]; const setESel = eActive[1];
  const eReplyS = React.useState('');
  const eReply = eReplyS[0]; const setEReply = eReplyS[1];
  const eBusyS = React.useState(false);
  const eBusy = eBusyS[0]; const setEBusy = eBusyS[1];
  const [eResolved, setEResolved] = React.useState<string | null>(null);
  const [eResolvedReply, setEResolvedReply] = React.useState('');
  const [showKBSuggest, setShowKBSuggest] = React.useState<any>(null);
  const [kbSuggestTitle, setKbSuggestTitle] = React.useState('');
  const [kbSuggestBody, setKbSuggestBody] = React.useState('');
  const [kbSuggestSaving, setKbSuggestSaving] = React.useState(false);
  const [eConvMessages, setEConvMessages] = React.useState<any[]>([]);
  const [eConvOpen, setEConvOpen] = React.useState(false);
  const eLoadEsc = React.useCallback(async () => {
    if (!pLive || !pTenantId) return;
    const open = await api.fetchEscalations(pTenantId, 'open');
    const assigned = await api.fetchEscalations(pTenantId, 'assigned');
    setEItems([...(open || []), ...(assigned || [])]);
  }, [pLive, pTenantId]);
  React.useEffect(() => {
    if (pLive && subPage === 'portal_escalations') eLoadEsc();
  }, [pLive, subPage, eLoadEsc]);
  React.useEffect(() => {
    if (!eSel?.conversation_id) { setEConvMessages([]); return; }
    supabase.from('messages').select('*').eq('conversation_id', eSel.conversation_id).order('created_at', { ascending: true }).then(({ data }) => setEConvMessages(data || []));
  }, [eSel?.conversation_id]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    if (pLive && subPage === 'portal_settings' && pTenantId) {
      api.fetchAlertEmail(pTenantId).then(e => { if (e) setAlertEmail(e); });
    }
  }, [pLive, subPage, pTenantId]);
  const eClaim = async (row: any) => {
    if (!row || !pTenantId) return;
    setEBusy(true);
    const me = ((user as any) && ((user as any).id || (user as any).userId)) || null;
    const r = await api.claimEscalation(row.id, me);
    if (r.ok) { await eLoadEsc(); setESel({ ...row, status: 'assigned', assigned_to: me }); }
    setEBusy(false);
  };
  const eResolve = async (row: any) => {
    if (!row || !pTenantId || !eReply.trim()) return;
    setEBusy(true);
    const me = ((user as any) && ((user as any).id || (user as any).userId)) || null;
    const sentReply = eReply;
    const r = await api.resolveEscalation({ escalationId: row.id, tenantId: pTenantId, conversationId: row.conversation_id || null, reply: eReply, resolvedBy: me });
    if (r.ok) {
      setEResolvedReply(sentReply);
      setEResolved(row.id);
      setEReply('');
      await eLoadEsc();
    }
    setEBusy(false);
  };
  const pLoadConvos = React.useCallback(async () => {
    if (!pLive || !pTenantId) return;
    const cs = await api.fetchConversations(pTenantId);
    setPConvos(cs as any);
  }, [pLive, pTenantId]);

  const pOpenConvo = React.useCallback(async (id: string) => {
    if (!pTenantId) return;
    setPActiveId(id);
    const ms = await api.fetchConversationMessages(id);
    setPMessages(ms as any);
  }, [pTenantId]);

  React.useEffect(() => {
    if (pLive && subPage === 'portal_conversations') { pLoadConvos(); }
  }, [pLive, subPage, pLoadConvos]);

  const pSend = async () => {
    const q = pInput.trim();
    if (!q || !pTenantId || pSending) return;
    setPSending(true);
    setPInput('');
    setPMessages((m) => [...m, { role: 'user', content: q, _local: true }]);
    const res = await api.runPortalTurn(pTenantId, q, { conversationId: pActiveId, customerName: (user && (user as any).name) || 'Web Visitor' });
    setPLastResult(res);
    if (res.conversationId) { setPActiveId(res.conversationId); await pOpenConvo(res.conversationId); }
    await pLoadConvos();
    setPSending(false);
  };

  const pEscalate = async () => {
    if (!pTenantId || !pActiveId || pEscalating) return;
    setPEscalating(true);
    const lastQ = [...pMessages].reverse().find((m) => m.role === 'user');
    await api.escalateConversation(pTenantId, pActiveId, (lastQ && lastQ.content) || 'Customer requested a human');
    await pOpenConvo(pActiveId); await pLoadConvos();
    setPEscalating(false);
  };

  const pNewChat = () => { setPActiveId(null); setPMessages([]); setPLastResult(null); setPInput(''); };

  const runAgentPipeline = (query: string) => {
    const isBilling = /bill|invoice|charge|payment|refund/.test(query.toLowerCase());
    const isSecurity = /password|2fa|login|access|reset/.test(query.toLowerCase());
    const chosenAgent = isBilling ? 'Billing Agent' : isSecurity ? 'Account Agent' : 'Support Agent';
    setAgentUsed(chosenAgent);
    setTraceVisible(true);
    const stages = [
      { stage: 'Intent Classification', status: 'running' as const, detail: 'Classifying query intent and routing to best agent...', confidence: undefined, duration: undefined },
      { stage: 'KB Retrieval', status: 'pending' as const, detail: '', confidence: undefined, duration: undefined },
      { stage: 'Knowledge Validation', status: 'pending' as const, detail: '', confidence: undefined, duration: undefined },
      { stage: 'LLM Reasoning', status: 'pending' as const, detail: '', confidence: undefined, duration: undefined },
      { stage: 'Confidence Gate', status: 'pending' as const, detail: '', confidence: undefined, duration: undefined },
      { stage: 'Response Generation', status: 'pending' as const, detail: '', confidence: undefined, duration: undefined },
    ];
    setTraceSteps(stages);
    setTimeout(() => { setTraceSteps((prev) => prev.map((s, i) => i === 0 ? { ...s, status: 'done', detail: 'Routed to ' + chosenAgent + ' — confidence 97%', confidence: 97, duration: 120 } : i === 1 ? { ...s, status: 'running', detail: 'Searching knowledge base...' } : s)); }, 600);
    setTimeout(() => { setTraceSteps((prev) => prev.map((s, i) => i === 1 ? { ...s, status: 'done', detail: 'Retrieved 3 sources', confidence: 89, duration: 340 } : i === 2 ? { ...s, status: 'running', detail: 'Knowledge Curator bot validating chunk freshness and relevance...' } : s)); }, 1200);
    setTimeout(() => { setTraceSteps((prev) => prev.map((s, i) => i === 2 ? { ...s, status: 'done', detail: 'All chunks passed freshness check.', confidence: 92, duration: 180 } : i === 3 ? { ...s, status: 'running', detail: 'Reasoning over retrieved context...' } : s)); }, 1900);
    setTimeout(() => { const fc = isBilling ? 94 : isSecurity ? 88 : 91; setTraceSteps((prev) => prev.map((s, i) => i === 3 ? { ...s, status: 'done', detail: 'Chain-of-thought complete.', confidence: fc, duration: 820 } : i === 4 ? { ...s, status: 'running', detail: 'Running Confidence Reviewer, Safety Guard, Hallucination Detector...' } : s)); }, 2800);
    setTimeout(() => { const fc = isBilling ? 94 : isSecurity ? 88 : 91; setTraceSteps((prev) => prev.map((s, i) => i === 4 ? { ...s, status: 'done', detail: 'All validators passed.', confidence: fc, duration: 95 } : i === 5 ? { ...s, status: 'running', detail: 'Formatting final response...' } : s)); }, 3500);
    setTimeout(() => { setTraceSteps((prev) => prev.map((s, i) => i === 5 ? { ...s, status: 'done', detail: 'Response delivered. Audit log written.', confidence: undefined, duration: 55 } : s)); setTyping(false); }, 4200);
  };

  const sendMessage = () => {
    if (!chatInput.trim()) return;
    const msgText = chatInput.trim();
    const userMsg = { role: 'user' as const, text: msgText, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
    setMessages((prev) => [...prev, userMsg]);
    setChatInput('');
    setTyping(true);
    runAgentPipeline(msgText);
    if (tenant?.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenant.id)) {
      (async () => {
        try {
          const { action, draft } = await runAgentLoop(tenant.id, msgText, { customerName: user?.name, audience: 'customer' });
          if (action) dbConvIdRef.current = action.conversation_id || dbConvIdRef.current;
          const confPct = Math.round(draft.confidence * 100);
          const reply = draft.requiresApproval ? draft.answer + '\n\n⚠️ Below the confidence threshold (' + confPct + '%) — sent to a human teammate for approval before delivery.' : draft.answer;
          setTimeout(() => { setMessages((prev) => [...prev, { role: 'agent' as const, text: reply, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), confidence: confPct, actions: draft.sources.map((s) => 'Source: ' + s.title) }]); setTyping(false); }, 4300);
        } catch (e) { console.error('[DT] agent loop:', e); setTyping(false); }
      })();
    } else {
      setTimeout(() => { setMessages((prev) => [...prev, { role: 'agent' as const, text: 'I found relevant information in the knowledge base and drafted a response. (Demo mode — sign in to a live workspace to persist this conversation and run the real approval loop.)', time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), confidence: 91, actions: ['Show Setup Guide', 'Email Step-by-Step Guide', 'Book a Demo'] }]); setTyping(false); }, 4300);
    }
  };

  const [pendingApprovals, setPendingApprovals] = useState([
    { id: 'ap1', customer: 'Emily Carter', email: 'emily@acmeuser.com', action: 'Issue $350 credit to account', agent: 'Billing Agent', requestedAt: '15 min ago', confidence: 94, risk: 'medium' },
    { id: 'ap2', customer: 'James Liu', email: 'james@globexuser.com', action: 'Reset 2FA and send recovery codes', agent: 'Security Agent', requestedAt: '1 hr ago', confidence: 88, risk: 'high' },
    { id: 'ap3', customer: 'Maria Santos', email: 'maria@initechuser.com', action: 'Downgrade plan from Enterprise to Growth', agent: 'Account Agent', requestedAt: '2 hr ago', confidence: 97, risk: 'low' },
    { id: 'ap4', customer: 'Tom Baker', email: 'tom@hooliuser.com', action: 'Export all account data as CSV', agent: 'Data Agent', requestedAt: '3 hr ago', confidence: 99, risk: 'low' },
  ]);

  const [decisionLog, setDecisionLog] = useState<any[]>([]);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [alertEmail, setAlertEmail] = useState('');
  const [alertEmailSaving, setAlertEmailSaving] = useState(false);
  const [alertEmailSaved, setAlertEmailSaved] = useState(false);
  const [decisionToast, setDecisionToast] = useState<any>(null);

  const handleDecision = async (item: any, decision: string) => {
    setDecidingId(item.id);
    const decidedAt = new Date();
    const deciderName = ((user && user.name) ? user.name : 'You');
    const isRealRow = typeof item.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(item.id);
    try {
      const { data: au } = await supabase.auth.getUser();
      const approverId = au && au.user ? au.user.id : null;
      if (isRealRow) {
        await supabase.from('agent_actions').update({ status: decision === 'approve' ? 'approved' : 'rejected', approved_by: approverId, approved_at: decidedAt.toISOString(), requires_approval: false }).eq('id', item.id);
      }
    } catch (e) { /* audit/persistence optional in demo */ }
    setPendingApprovals((prev) => prev.filter((x) => x.id !== item.id));
    setDecisionLog((prev) => [{ ...item, decision, deciderName, decidedAtLabel: decidedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }, ...prev]);
    setDecidingId(null);
    setDecisionToast({ decision, action: item.action });
    setTimeout(() => setDecisionToast(null), 3200);
  };

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase.from('agent_actions').select('id, agent_name, action_type, description, confidence_score, payload, created_at').eq('requires_approval', true).eq('status', 'pending').order('created_at', { ascending: false });
        if (cancelled || error || !data || data.length === 0) return;
        const mapped = data.map((r) => { const p = r.payload || {}; return { id: r.id, customer: p.customer || p.customer_name || 'Customer', email: p.email || p.customer_email || '', action: r.description || r.action_type || 'Pending action', agent: r.agent_name || 'Agent', requestedAt: r.created_at ? new Date(r.created_at).toLocaleString() : 'just now', confidence: r.confidence_score != null ? Math.round(Number(r.confidence_score) * (Number(r.confidence_score) <= 1 ? 100 : 1)) : 90, risk: p.risk || 'medium' }; });
        setPendingApprovals(mapped);
      } catch (e) { /* offline/demo: keep seeded queue */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const riskColors: Record<string, string> = { low: 'green', medium: 'amber', high: 'red' };

  const agentActions = [
    { name: 'Reset Password', description: 'Trigger password reset email for customer', risk: 'low', approval: false, usedToday: 142 },
    { name: 'Issue Credit', description: 'Apply account credit up to $200 auto, above $200 requires approval', risk: 'medium', approval: true, usedToday: 23 },
    { name: 'Upgrade Plan', description: 'Move customer to higher plan tier immediately', risk: 'low', approval: false, usedToday: 8 },
    { name: 'Downgrade Plan', description: 'Reduce plan tier with confirmation workflow', risk: 'medium', approval: true, usedToday: 4 },
    { name: 'Export Account Data', description: 'Generate full data export GDPR compliant', risk: 'low', approval: false, usedToday: 31 },
    { name: 'Suspend Account', description: 'Temporarily suspend customer access', risk: 'high', approval: true, usedToday: 2 },
    { name: 'Reset 2FA', description: 'Disable and reset two-factor authentication', risk: 'high', approval: true, usedToday: 7 },
    { name: 'Change Billing Email', description: 'Update billing contact email address', risk: 'low', approval: false, usedToday: 19 },
  ];

  const tickets = [
    { id: 'T-9921', customer: 'James Liu', subject: 'Login issue 2FA not working', priority: 'urgent', status: 'open', assignee: 'Human Agent', created: '1 hr ago' },
    { id: 'T-9920', customer: 'Alex Patel', subject: 'Billing discrepancy on October invoice', priority: 'high', status: 'in_progress', assignee: 'Billing Agent', created: '3 hr ago' },
    { id: 'T-9919', customer: 'Sarah Kim', subject: 'API key rotation request', priority: 'medium', status: 'resolved', assignee: 'Tech Agent', created: '1 day ago' },
    { id: 'T-9918', customer: 'Oliver Chen', subject: 'Cannot download invoices as PDF', priority: 'low', status: 'resolved', assignee: 'Support Agent', created: '2 days ago' },
    { id: 'T-9917', customer: 'Emma Wilson', subject: 'SSO setup assistance needed', priority: 'medium', status: 'open', assignee: 'Tech Agent', created: '2 days ago' },
  ];

  const priorityColors: Record<string, string> = { urgent: 'red', high: 'amber', medium: 'blue', low: 'slate' };

  if (subPage === 'portal_overview') {
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <PageTabs tabs={PORTAL_TABS} page={subPage} setPage={setPage} accentColor={accentColor} />
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">Customer Support</h1>
          <p className="text-slate-400 text-sm mt-1">Digital Employees serve your customers 24/7 — answering questions, resolving issues, and taking action on their behalf</p>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard label="Conversations Today" value="1,284" icon="✉" color="blue" trend="+18%" />
          <StatCard label="Self-Served" value="89%" icon="★" color="emerald" trend="No human needed" />
          <StatCard label="Pending Approvals" value="12" icon="⚠" color="amber" trend="3 urgent" />
          <StatCard label="Avg Response Time" icon="✚" value="< 2s" color="indigo" trend="AI-instant" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4">Customer Satisfaction Trend</h2>
            <div className="flex items-end gap-2 h-24">
              {[82, 85, 87, 86, 90, 92, 94].map((v, i) => {
                const days = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
                return (
                  <div key={i} className="flex-1 flex flex-col items-center gap-1">
                    <div className="w-full rounded-t" style={{ height: ((v - 80) / 15) * 100 + '%', backgroundColor: accentColor, minHeight: '4px' }} />
                    <span className="text-xs text-slate-600">{days[i]}</span>
                  </div>
                );
              })}
            </div>
            <div className="mt-3 flex justify-between text-xs text-slate-400">
              <span>Average this week: <span className="text-emerald-400">91.7%</span></span>
              <span>Target: 90%</span>
            </div>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4">Resolution Breakdown</h2>
            <div className="space-y-3">
              {[{ label: 'Fully resolved by AI', pct: 71, color: '#10b981' }, { label: 'AI plus action taken', pct: 18, color: accentColor }, { label: 'Escalated to human', pct: 8, color: '#f59e0b' }, { label: 'Created ticket', pct: 3, color: '#ef4444' }].map((item, i) => (
                <div key={i}>
                  <div className="flex justify-between text-xs text-slate-400 mb-1"><span>{item.label}</span><span className="text-white">{item.pct}%</span></div>
                  <div className="h-2 bg-slate-800 rounded-full"><div className="h-full rounded-full" style={{ width: item.pct + '%', backgroundColor: item.color }} /></div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Conversations inbox state (declared here so available for portal_conversations) ──
  const [convFilter, setConvFilter] = React.useState<string>('all');
  const [humanReply, setHumanReply] = React.useState('');
  const [humanBusy, setHumanBusy] = React.useState(false);
  const [convToast, setConvToast] = React.useState<string | null>(null);
  const [labelMenuId, setLabelMenuId] = React.useState<string | null>(null);

  const convStatusColor = (s: string) => {
    if (s === 'resolved') return 'bg-emerald-500/15 text-emerald-300';
    if (s === 'escalated') return 'bg-red-500/15 text-red-300';
    if (s === 'pending') return 'bg-amber-500/15 text-amber-300';
    return 'bg-slate-700/50 text-slate-400';
  };

  const convFiltered = convFilter === 'all' ? pConvos : pConvos.filter(c => c.status === convFilter);

  const doTakeOver = async () => {
    if (!pActiveId || !humanReply.trim() || !pTenantId) return;
    setHumanBusy(true);
    const me = (user as any)?.id ?? null;
    const ok = await resolveConversation(pTenantId, pActiveId, humanReply.trim(), me);
    if (ok) {
      setHumanReply('');
      await pOpenConvo(pActiveId);
      await pLoadConvos();
      setConvToast('Conversation resolved — your reply was posted.');
      setTimeout(() => setConvToast(null), 3000);
    }
    setHumanBusy(false);
  };

  const doMarkResolved = async () => {
    if (!pActiveId || !pTenantId) return;
    setHumanBusy(true);
    const { error } = await supabase.from('conversations').update({ status: 'resolved', resolved_at: new Date().toISOString(), resolution_type: 'human' }).eq('id', pActiveId).eq('tenant_id', pTenantId);
    if (!error) { await pLoadConvos(); setConvToast('Marked as resolved.'); setTimeout(() => setConvToast(null), 2500); }
    setHumanBusy(false);
  };

  if (subPage === 'portal_conversations') {
    const activeConv = pConvos.find(c => c.id === pActiveId);
    return (
      <div className="flex-1 flex flex-col overflow-hidden bg-slate-950">
        <div className="flex-shrink-0 px-6 pt-6">
          <PageTabs tabs={PORTAL_TABS} page={subPage} setPage={setPage} accentColor={accentColor} />
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-xl font-bold text-white">Conversations Inbox</h1>
              <p className="text-slate-400 text-xs mt-0.5">All customer conversations — review, reply as human, or resolve.</p>
            </div>
            <button onClick={pLoadConvos} className="px-3 py-1.5 text-xs font-medium rounded-lg text-white" style={{ backgroundColor: accentColor }}>Refresh</button>
          </div>
          {!pLive && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 mb-4">
              <p className="text-amber-300 font-medium text-sm">Demo account</p>
              <p className="mt-1 text-xs text-slate-300">The conversations inbox shows real customer conversations from your tenant. Sign in with a provisioned tenant account to see live data.</p>
            </div>
          )}
          {pLive && (
            <div className="flex gap-1 bg-slate-800 rounded-lg p-1 mb-4 w-fit">
              {['all', 'open', 'escalated', 'pending', 'resolved'].map(f => (
                <button key={f} onClick={() => setConvFilter(f)}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium capitalize transition-all ${convFilter === f ? 'text-white' : 'text-slate-400 hover:text-white'}`}
                  style={convFilter === f ? { backgroundColor: accentColor } : {}}>{f}</button>
              ))}
            </div>
          )}
        </div>

        {pLive && (
          <div className="flex-1 flex overflow-hidden px-6 pb-6 gap-4">
            {/* Left: conversation list */}
            <div className="w-72 flex-shrink-0 flex flex-col overflow-hidden">
              <div className="flex-1 overflow-y-auto space-y-1">
                {convFiltered.length === 0 && (
                  <p className="text-sm text-slate-600 py-4 text-center">No conversations found.</p>
                )}
                {convFiltered.map(c => {
                  const lastMsg = c.last_message || c.subject || '';
                  const sentiment = getSentiment(lastMsg);
                  const convLabels = (appliedLabels[c.id] || []).map((lid: string) => conversationLabels.find(l => l.id === lid)).filter(Boolean);
                  return (
                    <div key={c.id} className="relative">
                      <button onClick={() => pOpenConvo(c.id)}
                        className={'w-full text-left px-3 py-3 rounded-xl border transition-all ' + (pActiveId === c.id ? 'border-indigo-500/60 bg-indigo-500/10' : 'border-slate-800 bg-slate-900/40 hover:border-slate-700')}>
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <span className="text-sm font-medium text-white truncate">{c.customer_name || 'Customer'}</span>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <span className="text-sm">{sentiment}</span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${convStatusColor(c.status)}`}>{c.status}</span>
                          </div>
                        </div>
                        <div className="text-xs text-slate-500 truncate mb-1">{c.subject || 'Untitled conversation'}</div>
                        <div className="flex items-center gap-2 text-[10px] text-slate-600 mb-1">
                          <span>{c.channel || 'chat'}</span>
                          {typeof c.confidence_score === 'number' && (<><span>·</span><span>{Math.round(c.confidence_score * 100)}% conf</span></>)}
                          <span>·</span>
                          <span>{new Date(c.created_at).toLocaleDateString()}</span>
                        </div>
                        {convLabels.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {convLabels.map((l: any) => (
                              <span key={l.id} className="text-[9px] px-1.5 py-0.5 rounded-full text-white font-medium" style={{ backgroundColor: l.color }}>{l.name}</span>
                            ))}
                          </div>
                        )}
                      </button>
                      <button
                        onClick={e => { e.stopPropagation(); setLabelMenuId(labelMenuId === c.id ? null : c.id); }}
                        className="absolute top-2 right-2 w-5 h-5 rounded text-slate-600 hover:text-slate-300 hover:bg-slate-700 flex items-center justify-center text-xs"
                        title="Apply label">🏷</button>
                      {labelMenuId === c.id && (
                        <div className="absolute right-0 top-8 z-20 bg-slate-800 border border-slate-700 rounded-xl shadow-xl p-2 w-44">
                          <p className="text-[10px] text-slate-500 px-1 mb-1">Apply label</p>
                          {conversationLabels.map(l => {
                            const applied = (appliedLabels[c.id] || []).includes(l.id);
                            return (
                              <button key={l.id} onClick={() => { applyLabelToConv(c.id, l.id); setLabelMenuId(null); }}
                                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-left hover:bg-slate-700 transition-all">
                                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: l.color }} />
                                <span className="flex-1 text-slate-200">{l.name}</span>
                                {applied && <span className="text-emerald-400">✓</span>}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Right: thread + actions */}
            <div className="flex-1 flex flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/40">
              {!pActiveId ? (
                <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">Select a conversation to review.</div>
              ) : (
                <>
                  <div className="flex-shrink-0 border-b border-slate-800 px-5 py-3 flex items-center justify-between">
                    <div>
                      <div className="text-sm font-semibold text-white">{pConvos.find(c => c.id === pActiveId)?.customer_name || 'Customer'}</div>
                      <div className="text-xs text-slate-500">{pConvos.find(c => c.id === pActiveId)?.subject || 'chat'}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      {pConvos.find(c => c.id === pActiveId)?.status !== 'resolved' && (
                        <button onClick={doMarkResolved} disabled={humanBusy}
                          className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-700 text-slate-300 hover:border-emerald-500/50 hover:text-emerald-300 transition-all disabled:opacity-40">
                          Mark resolved
                        </button>
                      )}
                      {pConvos.find(c => c.id === pActiveId) && (
                        <span className={`text-xs px-2 py-1 rounded-full ${convStatusColor(pConvos.find(c => c.id === pActiveId)?.status)}`}>{pConvos.find(c => c.id === pActiveId)?.status}</span>
                      )}
                    </div>
                  </div>

                  <div className="flex-1 overflow-y-auto p-5 space-y-3">
                    {pMessages.length === 0 && (<div className="text-center text-slate-600 text-sm pt-8">No messages yet.</div>)}
                    {pMessages.map((m, i) => (
                      <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm ${m.role === 'user' ? 'text-white rounded-br-sm' : 'bg-slate-800 text-slate-200 rounded-bl-sm'}`} style={m.role === 'user' ? { backgroundColor: accentColor } : {}}>
                          <p className="whitespace-pre-wrap leading-relaxed">{m.content}</p>
                          <div className="flex items-center gap-2 mt-1 flex-wrap">
                            {m.role !== 'user' && (<span className="text-[10px] text-slate-500">{m.role === 'system' ? 'System' : 'DE'}</span>)}
                            {typeof m.confidence_score === 'number' && (<span className="text-[10px] text-slate-600">{Math.round(m.confidence_score * 100)}% conf</span>)}
                            <span className="text-[10px] text-slate-700">{new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {pConvos.find(c => c.id === pActiveId)?.status !== 'resolved' && (
                    <div className="flex-shrink-0 border-t border-slate-800 p-4">
                      <p className="text-xs text-slate-500 mb-2">Reply as human agent — this resolves the conversation</p>
                      <div className="flex gap-2">
                        <textarea value={humanReply} onChange={e => setHumanReply(e.target.value)} rows={2} placeholder="Type your reply to the customer…" className="flex-1 rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 resize-none" />
                        <button onClick={doTakeOver} disabled={humanBusy || !humanReply.trim()} className="px-4 rounded-lg text-sm font-medium text-white self-stretch disabled:opacity-40 transition-all" style={{ backgroundColor: accentColor }}>
                          {humanBusy ? '…' : 'Send & resolve'}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {convToast && (<div className="fixed bottom-6 right-6 z-50 px-4 py-3 rounded-xl bg-emerald-600 shadow-lg text-sm font-medium text-white">{convToast}</div>)}
      </div>
    );
  }

  if (subPage === 'portal_actions') {
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <PageTabs tabs={PORTAL_TABS} page={subPage} setPage={setPage} accentColor={accentColor} />
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">Workforce Actions</h1>
          <p className="text-slate-400 text-sm mt-1">Configure what actions Digital Employees can perform on behalf of customers — with confidence gates and approval flows</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {agentActions.map((action, i) => (
            <div key={i} className="bg-slate-900 border border-slate-800 rounded-xl p-5 hover:border-slate-700 transition-all">
              <div className="flex items-start justify-between mb-2">
                <div className="text-sm font-semibold text-white">{action.name}</div>
                <div className="flex gap-2">
                  <Badge label={action.risk + ' risk'} color={riskColors[action.risk]} />
                  {action.approval && (<Badge label="Requires Approval" color="amber" />)}
                </div>
              </div>
              <p className="text-xs text-slate-400 mb-3">{action.description}</p>
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">Used today: <span className="text-white">{action.usedToday}</span></span>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" className="sr-only" defaultChecked />
                  <div className="w-9 h-5 bg-indigo-500 rounded-full"><div className="w-4 h-4 bg-white rounded-full shadow mt-0.5 ml-4" /></div>
                </label>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (subPage === 'portal_approvals') {
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <PageTabs tabs={PORTAL_TABS} page={subPage} setPage={setPage} accentColor={accentColor} />
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white">Approvals Queue</h1>
            <p className="text-slate-400 text-sm mt-1">Human-in-the-loop — review agent actions that exceed confidence or risk thresholds</p>
          </div>
          <Badge label={pendingApprovals.length + ' pending'} color="amber" />
        </div>
        <div className="space-y-4">
          {pendingApprovals.map((item) => (
            <div key={item.id} className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-semibold text-white">{item.action}</span>
                    <Badge label={item.risk + ' risk'} color={riskColors[item.risk]} />
                  </div>
                  <div className="text-xs text-slate-400">Customer: <span className="text-white">{item.customer}</span> · {item.email}</div>
                  <div className="text-xs text-slate-400 mt-0.5">Requested by: <span className="text-white">{item.agent}</span> · {item.requestedAt}</div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-bold text-emerald-400">{item.confidence}%</div>
                  <div className="text-xs text-slate-500">confidence</div>
                </div>
              </div>
              <div className="h-1 bg-slate-800 rounded-full mb-3"><div className="h-full rounded-full bg-emerald-500" style={{ width: item.confidence + '%' }} /></div>
              <div className="flex gap-3">
                <button onClick={() => handleDecision(item, 'approved')} disabled={decidingId === item.id} className="flex-1 py-2 text-sm font-medium text-white rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 transition-all">{decidingId === item.id ? 'Working...' : '✓ Approve'}</button>
                <button onClick={() => handleDecision(item, 'rejected')} disabled={decidingId === item.id} className="flex-1 py-2 text-sm font-medium text-white rounded-xl bg-red-600/50 hover:bg-red-600/70 disabled:opacity-50 transition-all">{decidingId === item.id ? 'Working...' : '✕ Reject'}</button>
                <button className="px-4 py-2 text-sm text-slate-400 hover:text-white bg-slate-800 rounded-xl transition-all">View Context</button>
              </div>
            </div>
          ))}
        </div>
        {pendingApprovals.length === 0 && (
          <div className="text-center py-12 bg-slate-900 border border-slate-800 rounded-xl">
            <div className="text-3xl mb-2">✓</div>
            <p className="text-white font-semibold">Queue clear</p>
            <p className="text-slate-400 text-sm mt-1">All agent actions have been reviewed.</p>
          </div>
        )}
        {decisionLog.length > 0 && (
          <div className="mt-8">
            <h2 className="text-sm font-semibold text-slate-300 mb-3">Recent decisions</h2>
            <div className="space-y-2">
              {decisionLog.map((d, idx) => (
                <div key={d.id + '-' + idx} className="flex items-center justify-between bg-slate-900/60 border border-slate-800 rounded-lg px-4 py-2.5">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className={'text-xs font-semibold px-2 py-0.5 rounded-full ' + (d.decision === 'approved' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400')}>{d.decision === 'approved' ? 'Approved' : 'Rejected'}</span>
                    <span className="text-sm text-white truncate">{d.action}</span>
                    <span className="text-xs text-slate-500 truncate">{d.customer}</span>
                  </div>
                  <div className="text-xs text-slate-500 whitespace-nowrap ml-3">{d.deciderName} · {d.decidedAtLabel}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        {decisionToast && (
          <div className={'fixed bottom-6 right-6 z-50 px-4 py-3 rounded-xl shadow-lg text-sm font-medium text-white ' + (decisionToast.decision === 'approved' ? 'bg-emerald-600' : 'bg-red-600')}>
            {(decisionToast.decision === 'approved' ? 'Approved: ' : 'Rejected: ') + decisionToast.action}
          </div>
        )}
      </div>
    );
  }

  if (subPage === 'portal_escalations') {
    const eTone = (v: any) => v === 'failed' ? "bg-rose-500/15 text-rose-300 border-rose-500/30" : v === 'review' ? "bg-amber-500/15 text-amber-300 border-amber-500/30" : "bg-slate-700/40 text-slate-300 border-slate-600/40";
    const eReasonLabel = (r: any) => r === 'low_confidence' ? 'Low confidence' : r === 'no_answer' ? 'No answer found' : r === 'audit_failed' ? 'Audit failed' : r === 'customer_request' ? 'Customer requested human' : (r || 'Escalated');
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <PageTabs tabs={PORTAL_TABS} page={subPage} setPage={setPage} accentColor={accentColor} />
        <div className="flex items-center justify-between mb-5">
          <div>
            <h1 className="text-2xl font-bold text-white">Escalation Inbox</h1>
            <p className="text-slate-400 text-sm mt-1">Questions the AI handed off to a human — claim one, reply, and resolve it back to the customer.</p>
          </div>
          <button onClick={() => eLoadEsc()} className="px-3 py-2 text-sm font-medium rounded-lg text-white" style={{ backgroundColor: accentColor }}>Refresh</button>
        </div>
        {!pLive ? (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-6">
            <p className="text-amber-300 font-medium">Demo account</p>
            <p className="mt-2 text-sm text-slate-300 max-w-2xl">The escalation inbox runs on real, tenant-isolated data. Sign in with a provisioned tenant account to claim escalations raised by the AI, post a human reply into the conversation, and resolve it.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            <div className="lg:col-span-1">
              <p className="text-xs uppercase tracking-wide text-slate-500 mb-2">Open & assigned ({eItems.length})</p>
              <div className="space-y-1 max-h-[65vh] overflow-y-auto">
                {eItems.length === 0 ? (
                  <p className="text-sm text-slate-600">Nothing in the queue — the AI is handling everything.</p>
                ) : eItems.map((row: any) => {
                  const mins = row.created_at ? elapsedMinutes(row.created_at) : 0;
                  const dot = slaStatus(mins, slaUrgent, slaNormal);
                  const elapsed = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
                  return (
                    <button key={row.id} onClick={() => { setESel(row); setEReply(''); }} className={"w-full text-left px-3 py-2 rounded-lg border text-sm transition " + (eSel && eSel.id === row.id ? "border-indigo-500/60 bg-indigo-500/10" : "border-slate-800 hover:border-slate-700 bg-slate-900/40")}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <SLADot color={dot} />
                          <span className="truncate text-slate-200">{row.question || 'Escalated question'}</span>
                        </div>
                        <span className={"text-[10px] px-1.5 py-0.5 rounded border flex-shrink-0 " + (row.status === 'assigned' ? "bg-amber-500/15 text-amber-300 border-amber-500/30" : "bg-rose-500/15 text-rose-300 border-rose-500/30")}>{row.status}</span>
                      </div>
                      <div className="text-[10px] text-slate-500 mt-0.5 flex gap-1 flex-wrap">
                        <span>{eReasonLabel(row.reason)}</span>
                        {typeof row.confidence === 'number' && <span>· conf {Math.round(row.confidence * 100)}%</span>}
                        <span>· waiting {elapsed}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="lg:col-span-2">
              {!eSel ? (
                <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-8 text-center text-slate-500 text-sm">Select an escalation to review and respond.</div>
              ) : (
                <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 space-y-4">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <span className={"text-[11px] px-2 py-0.5 rounded border " + eTone(eSel.audit_verdict)}>{eReasonLabel(eSel.reason)}</span>
                    <span className="text-xs text-slate-500">{eSel.status === 'assigned' ? 'Claimed' : 'Unclaimed'}</span>
                    {eSel.created_at && (() => {
                      const mins = elapsedMinutes(eSel.created_at);
                      const dot = slaStatus(mins, slaUrgent, slaNormal);
                      const elapsed = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
                      const slaLabel = dot === 'red' ? `SLA: ${slaNormal}m ⚠ Breached` : dot === 'amber' ? `SLA: ${slaNormal}m (approaching)` : `SLA: ${slaNormal}m (within target)`;
                      return <span className={`text-xs font-medium ${dot === 'red' ? 'text-red-400' : dot === 'amber' ? 'text-amber-400' : 'text-emerald-400'}`}>⏱ Waiting {elapsed} · {slaLabel}</span>;
                    })()}
                  </div>

                  {eSel.conversation_id && (
                    <div>
                      <button onClick={() => setEConvOpen((v: boolean) => !v)} className="text-xs text-slate-400 hover:text-slate-200 flex items-center gap-1">
                        <span>{eConvOpen ? '▼' : '▶'}</span> Full conversation {eConvMessages.length > 0 ? `(${eConvMessages.length} messages)` : ''}
                      </button>
                      {eConvOpen && eConvMessages.length > 0 && (
                        <div className="mt-2 space-y-1.5 max-h-48 overflow-y-auto border border-slate-800 rounded-lg p-2">
                          {eConvMessages.map((m: any, i: number) => (
                            <div key={m.id || i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                              <div className={`max-w-[80%] rounded-lg px-2.5 py-1.5 text-xs ${m.role === 'user' ? 'bg-indigo-500/20 text-indigo-200' : 'bg-slate-800 text-slate-400'}`}>
                                {m.content || m.body || ''}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  <div>
                    <p className="text-xs uppercase tracking-wide text-slate-500">Customer asked</p>
                    <p className="text-slate-100 mt-1">{eSel.question || '—'}</p>
                  </div>

                  <div>
                    <p className="text-xs uppercase tracking-wide text-slate-500">
                      AI draft answer
                      {typeof eSel.confidence === 'number' && (
                        <span className={`ml-2 px-1.5 py-0.5 rounded text-[10px] font-medium ${eSel.confidence < 0.4 ? 'bg-rose-500/20 text-rose-300' : eSel.confidence < 0.65 ? 'bg-amber-500/20 text-amber-300' : 'bg-emerald-500/20 text-emerald-300'}`}>
                          {Math.round(eSel.confidence * 100)}% confidence
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-slate-500 mt-1">The DE searched your knowledge base but could not answer with sufficient confidence.</p>
                    {eSel.draft_answer && (<div className="mt-1.5 rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-sm text-slate-400 whitespace-pre-wrap font-mono text-xs opacity-70">{eSel.draft_answer}</div>)}
                    {!eSel.draft_answer && (<div className="mt-1 text-xs text-slate-600 italic">No answer was produced — the AI could not find a confident match.</div>)}
                  </div>

                  <div>
                    <p className="text-xs uppercase tracking-wide text-slate-500 mb-1">Your reply to the customer</p>
                    <textarea value={eReply} onChange={(e) => setEReply((e.target as any).value)} rows={4} placeholder="Write the human answer that will be posted into the conversation..." className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm text-slate-100 focus:outline-none focus:border-indigo-500" />
                  </div>

                  <div className="flex items-center gap-2">
                    {eSel.status !== 'assigned' && (<button disabled={eBusy} onClick={() => eClaim(eSel)} className="px-3 py-2 text-sm rounded-lg border border-slate-700 text-slate-200 hover:border-slate-500 disabled:opacity-50">Claim</button>)}
                    <button disabled={eBusy || !eReply.trim()} onClick={() => eResolve(eSel)} className="px-4 py-2 text-sm font-medium rounded-lg text-white disabled:opacity-50" style={{ backgroundColor: accentColor }}>{eBusy ? 'Working...' : 'Send reply & resolve'}</button>
                  </div>

                  {eResolved === eSel.id && (
                    <div className="flex items-center gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
                      <span className="text-emerald-400 text-sm">✓ Reply sent</span>
                      <button onClick={() => { setShowKBSuggest(eSel); setKbSuggestTitle(eSel.question || ''); setKbSuggestBody(eResolvedReply); }} className="text-xs text-indigo-400 hover:text-indigo-300 underline">Add this answer to Knowledge Base →</button>
                    </div>
                  )}

                  <p className="text-[11px] text-slate-600">Resolving posts your reply into the conversation and marks both the escalation and the conversation as resolved. The AI never auto-sends a human reply.</p>
                </div>
              )}

              {showKBSuggest && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
                  <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-lg shadow-2xl">
                    <h3 className="text-white font-semibold mb-4">Add to Knowledge Base</h3>
                    <div className="space-y-3">
                      <div>
                        <label className="text-xs text-slate-400 block mb-1">Title</label>
                        <input value={kbSuggestTitle} onChange={e => setKbSuggestTitle(e.target.value)} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none" />
                      </div>
                      <div>
                        <label className="text-xs text-slate-400 block mb-1">Body</label>
                        <textarea value={kbSuggestBody} onChange={e => setKbSuggestBody(e.target.value)} rows={5} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none" />
                      </div>
                    </div>
                    <div className="flex gap-2 mt-4">
                      <button disabled={kbSuggestSaving} onClick={async () => { if (!pTenantId) return; setKbSuggestSaving(true); await api.upsertKnowledgeArticle({ tenant_id: pTenantId, title: kbSuggestTitle, body: kbSuggestBody, audience: 'customer', category: 'Support', status: 'draft' }); setKbSuggestSaving(false); setShowKBSuggest(null); }} className="px-4 py-2 text-sm rounded-lg border border-slate-600 text-slate-200 hover:border-slate-400 disabled:opacity-50">Save Draft</button>
                      <button disabled={kbSuggestSaving} onClick={async () => { if (!pTenantId) return; setKbSuggestSaving(true); await api.upsertKnowledgeArticle({ tenant_id: pTenantId, title: kbSuggestTitle, body: kbSuggestBody, audience: 'customer', category: 'Support', status: 'published' }); setKbSuggestSaving(false); setShowKBSuggest(null); }} className="px-4 py-2 text-sm font-medium rounded-lg text-white disabled:opacity-50" style={{ backgroundColor: accentColor }}>Publish</button>
                      <button onClick={() => setShowKBSuggest(null)} className="ml-auto px-3 py-2 text-sm text-slate-400 hover:text-slate-200">Cancel</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (subPage === 'portal_tickets') {
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <PageTabs tabs={PORTAL_TABS} page={subPage} setPage={setPage} accentColor={accentColor} />
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white">Support Tickets</h1>
            <p className="text-slate-400 text-sm mt-1">Escalated issues requiring human review — AI continues to assist in context</p>
          </div>
          <button className="flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-medium" style={{ backgroundColor: accentColor }}>+ New Ticket</button>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-800">
                {['Ticket ID', 'Customer', 'Subject', 'Priority', 'Status', 'Assignee', 'Created'].map((h) => (
                  <th key={h} className="text-left px-4 py-3 text-xs font-medium text-slate-400 uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {tickets.map((t) => (
                <tr key={t.id} className="hover:bg-slate-800/30 cursor-pointer transition-all">
                  <td className="px-4 py-3 text-xs font-mono text-indigo-400">{t.id}</td>
                  <td className="px-4 py-3 text-sm text-white">{t.customer}</td>
                  <td className="px-4 py-3 text-sm text-slate-300">{t.subject}</td>
                  <td className="px-4 py-3"><Badge label={t.priority} color={priorityColors[t.priority]} /></td>
                  <td className="px-4 py-3"><Badge label={t.status.replace('_', ' ')} color={t.status === 'resolved' ? 'green' : t.status === 'open' ? 'red' : 'amber'} /></td>
                  <td className="px-4 py-3 text-xs text-slate-400">{t.assignee}</td>
                  <td className="px-4 py-3 text-xs text-slate-500">{t.created}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (subPage === 'portal_settings') {
    const SETTINGS_SECTIONS = [
      { id: 'branding', label: 'Branding', icon: '🎨' },
      { id: 'embed', label: 'Widget Embed', icon: '</>' },
      { id: 'prechat', label: 'Pre-chat Form', icon: '📋' },
      { id: 'sla', label: 'SLA Rules', icon: '⏱' },
      { id: 'labels', label: 'Labels & Alerts', icon: '🏷' },
    ];
    const PRESET_COLORS = ['#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#14b8a6'];

    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <PageTabs tabs={PORTAL_TABS} page={subPage} setPage={setPage} accentColor={accentColor} />
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">Portal Settings</h1>
          <p className="text-slate-400 text-sm mt-1">Configure the customer-facing AI portal experience</p>
        </div>

        <div className="flex gap-6">
          {/* Left nav */}
          <div className="w-44 flex-shrink-0">
            <nav className="space-y-1">
              {SETTINGS_SECTIONS.map(s => (
                <button key={s.id} onClick={() => setSettingsSection(s.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-medium text-left transition-all ${settingsSection === s.id ? 'text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800/60'}`}
                  style={settingsSection === s.id ? { backgroundColor: accentColor + '22', outline: '1px solid ' + accentColor + '44' } : {}}>
                  <span className="text-base">{s.icon}</span>
                  {s.label}
                </button>
              ))}
            </nav>
          </div>

          {/* Content */}
          <div className="flex-1 max-w-3xl">

            {/* ── BRANDING ── */}
            {settingsSection === 'branding' && (
              <div className="flex gap-5">
                <div className="flex-1 space-y-5 bg-slate-900 border border-slate-800 rounded-xl p-5">
                  <h2 className="text-sm font-semibold text-white">Portal Branding</h2>

                  <div>
                    <label className="text-xs font-medium text-slate-400 block mb-1.5">Portal name</label>
                    <input value={brandName} onChange={e => setBrandName(e.target.value)} placeholder={(tenant?.name || 'Company') + ' Support Center'}
                      className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500" />
                  </div>

                  <div>
                    <label className="text-xs font-medium text-slate-400 block mb-1.5">Welcome headline</label>
                    <input value={brandHeadline} onChange={e => setBrandHeadline(e.target.value)} placeholder="How can we help you today?"
                      className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500" />
                  </div>

                  <div>
                    <label className="text-xs font-medium text-slate-400 block mb-1.5">Brand color</label>
                    <div className="flex items-center gap-2 flex-wrap">
                      {PRESET_COLORS.map(c => (
                        <button key={c} onClick={() => setBrandColor(c)}
                          className={`w-7 h-7 rounded-full transition-all ${brandColor === c ? 'ring-2 ring-white ring-offset-2 ring-offset-slate-900 scale-110' : 'hover:scale-105'}`}
                          style={{ backgroundColor: c }} />
                      ))}
                      <input type="text" value={brandColor} onChange={e => setBrandColor(e.target.value)}
                        className="w-24 bg-slate-800 border border-slate-700 text-white text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500 font-mono" />
                      <span className="w-6 h-6 rounded-full border border-slate-600" style={{ backgroundColor: brandColor }} />
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-medium text-slate-400 block mb-1.5">Logo URL</label>
                    <input value={brandLogoUrl} onChange={e => setBrandLogoUrl(e.target.value)} placeholder="https://...your-logo.png"
                      className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500" />
                    {brandLogoUrl && (
                      <div className="mt-2 flex items-center gap-2">
                        <div className="w-10 h-10 rounded-lg bg-slate-800 border border-slate-700 overflow-hidden flex items-center justify-center">
                          <img src={brandLogoUrl} alt="logo" className="w-full h-full object-contain"
                            onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                        </div>
                        <span className="text-xs text-slate-500">Logo preview</span>
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="text-xs font-medium text-slate-400 block mb-1.5">Widget position</label>
                    <div className="flex gap-2">
                      {(['left', 'right'] as const).map(pos => (
                        <button key={pos} onClick={() => setWidgetPosition(pos)}
                          className={`flex-1 py-2 text-sm font-medium rounded-xl border transition-all capitalize ${widgetPosition === pos ? 'text-white border-transparent' : 'border-slate-700 text-slate-400 hover:text-white'}`}
                          style={widgetPosition === pos ? { backgroundColor: brandColor } : {}}>
                          {pos}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center justify-between p-3 rounded-xl bg-slate-800/50">
                    <div>
                      <div className="text-sm text-white">Powered by DreamTeam</div>
                      <div className="text-xs text-slate-500">Show branding in widget footer</div>
                    </div>
                    <button onClick={() => setShowPoweredBy(v => !v)}
                      className="w-9 h-5 rounded-full transition-all relative flex-shrink-0"
                      style={{ backgroundColor: showPoweredBy ? brandColor : '#334155' }}>
                      <div className={`w-4 h-4 bg-white rounded-full shadow absolute top-0.5 transition-all ${showPoweredBy ? 'left-4' : 'left-0.5'}`} />
                    </button>
                  </div>

                  <button onClick={saveBrandSettings} disabled={brandSaving}
                    className="px-5 py-2.5 text-sm font-medium text-white rounded-xl disabled:opacity-50 transition-all"
                    style={{ backgroundColor: brandColor }}>
                    {brandSaving ? 'Saving…' : brandSaved ? '✓ Saved' : 'Save Branding'}
                  </button>
                </div>

                {/* Live preview */}
                <div className="w-52 flex-shrink-0">
                  <p className="text-xs text-slate-500 mb-2 font-medium uppercase tracking-wider">Live preview</p>
                  <div className="bg-slate-800 border border-slate-700 rounded-2xl p-3 relative min-h-72 overflow-hidden">
                    <div className="text-[10px] text-slate-600 mb-3 text-center">Widget preview</div>
                    {/* Mini chat panel */}
                    <div className="bg-slate-900 rounded-xl border border-slate-700 p-2 mb-2">
                      <div className="flex items-center gap-1.5 mb-2">
                        <div className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[9px] font-bold" style={{ backgroundColor: brandColor }}>
                          {brandLogoUrl ? <img src={brandLogoUrl} alt="" className="w-4 h-4 object-contain rounded-full" /> : 'A'}
                        </div>
                        <span className="text-[10px] text-white font-medium truncate">{brandName || (tenant?.name || 'Support') + ' Chat'}</span>
                      </div>
                      <p className="text-[9px] text-slate-300 leading-tight">{brandHeadline || 'How can we help you today?'}</p>
                      <div className="mt-2 bg-slate-800 rounded-lg px-2 py-1">
                        <span className="text-[8px] text-slate-600">Type a message…</span>
                      </div>
                    </div>
                    {/* Chat bubble */}
                    <div className={`absolute bottom-4 ${widgetPosition === 'right' ? 'right-3' : 'left-3'}`}>
                      <div className="w-12 h-12 rounded-full shadow-xl flex items-center justify-center text-white text-xl cursor-pointer" style={{ backgroundColor: brandColor }}>
                        {brandLogoUrl ? <img src={brandLogoUrl} alt="" className="w-8 h-8 object-contain rounded-full" /> : '💬'}
                      </div>
                      {showPoweredBy && <div className="text-[8px] text-slate-600 text-center mt-0.5">by DT</div>}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ── EMBED ── */}
            {settingsSection === 'embed' && (
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
                <div>
                  <h2 className="text-sm font-semibold text-white mb-1">Embed your support widget</h2>
                  <p className="text-xs text-slate-400">Paste this code into your website's <code className="text-slate-300 bg-slate-800 px-1 rounded">&lt;body&gt;</code> tag to add the AI support chat widget.</p>
                </div>
                <div className="flex gap-1 bg-slate-800 rounded-lg p-1 w-fit">
                  {[{ id: 'vanilla', label: 'Vanilla JS' }, { id: 'react', label: 'React / Next.js' }].map(t => (
                    <button key={t.id} onClick={() => setEmbedTab(t.id as any)}
                      className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${embedTab === t.id ? 'text-white' : 'text-slate-400 hover:text-white'}`}
                      style={embedTab === t.id ? { backgroundColor: accentColor } : {}}>{t.label}</button>
                  ))}
                </div>
                <div className="relative">
                  <pre className="bg-slate-950 border border-slate-700 rounded-xl p-4 text-xs text-slate-300 font-mono overflow-x-auto whitespace-pre-wrap leading-relaxed">
                    {embedTab === 'vanilla' ? vanillaCode : reactCode}
                  </pre>
                  <button onClick={() => { navigator.clipboard.writeText(embedTab === 'vanilla' ? vanillaCode : reactCode).then(() => { setWidgetCopied(true); setTimeout(() => setWidgetCopied(false), 2000); }); }}
                    className="absolute top-3 right-3 px-2.5 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg border border-slate-700 transition-all">
                    {widgetCopied ? '✓ Copied' : 'Copy'}
                  </button>
                </div>
                <button onClick={() => setWidgetTestOpen(true)}
                  className="px-4 py-2.5 text-sm font-medium text-white rounded-xl transition-all hover:opacity-90"
                  style={{ backgroundColor: accentColor }}>
                  Test your widget →
                </button>

                {widgetTestOpen && (
                  <div className="fixed inset-0 z-50 bg-black/60 flex items-end justify-end p-6" onClick={() => setWidgetTestOpen(false)}>
                    <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-80 flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800" style={{ backgroundColor: brandColor + '22' }}>
                        <div className="flex items-center gap-2">
                          {brandLogoUrl && <img src={brandLogoUrl} alt="" className="w-6 h-6 rounded-full object-contain" />}
                          <span className="text-sm font-semibold text-white">{brandName || (tenant?.name || 'Support') + ' Chat'}</span>
                        </div>
                        <button onClick={() => setWidgetTestOpen(false)} className="text-slate-400 hover:text-white text-lg leading-none">×</button>
                      </div>
                      <div className="flex-1 p-4 min-h-40">
                        <p className="text-sm text-slate-300 font-medium mb-3">{brandHeadline || 'How can we help you today?'}</p>
                        <div className="flex justify-start">
                          <div className="max-w-[85%] rounded-2xl rounded-bl-sm px-4 py-2.5 text-sm bg-slate-800 text-slate-200">
                            Hi! I'm your AI support assistant. How can I help?
                          </div>
                        </div>
                      </div>
                      <div className="border-t border-slate-800 p-3 flex gap-2">
                        <input className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none" placeholder="Type a message…" />
                        <button className="px-3 py-2 text-sm text-white rounded-lg" style={{ backgroundColor: brandColor }}>Send</button>
                      </div>
                      {showPoweredBy && <div className="text-center text-[10px] text-slate-600 py-1.5">Powered by DreamTeam AI</div>}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── PRE-CHAT FORM ── */}
            {settingsSection === 'prechat' && (
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-5">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-sm font-semibold text-white">Pre-chat Form</h2>
                    <p className="text-xs text-slate-400 mt-1">Collect visitor details before starting a chat</p>
                  </div>
                  <button onClick={() => setPrechatEnabled(v => !v)}
                    className="w-9 h-5 rounded-full transition-all relative flex-shrink-0"
                    style={{ backgroundColor: prechatEnabled ? accentColor : '#334155' }}>
                    <div className={`w-4 h-4 bg-white rounded-full shadow absolute top-0.5 transition-all ${prechatEnabled ? 'left-4' : 'left-0.5'}`} />
                  </button>
                </div>

                {prechatEnabled && (
                  <>
                    <div className="space-y-2">
                      {prechatFields.map((field, idx) => (
                        <div key={field.id} className="flex items-center gap-2 bg-slate-800/60 rounded-xl px-3 py-2.5">
                          <span className="text-slate-600 text-xs w-4">{idx + 1}.</span>
                          <input value={field.label} onChange={e => { const f = [...prechatFields]; f[idx] = { ...f[idx], label: e.target.value }; setPrechatFields(f); }}
                            className="flex-1 bg-transparent text-sm text-white focus:outline-none placeholder-slate-600" placeholder="Field label" />
                          <select value={field.type} onChange={e => { const f = [...prechatFields]; f[idx] = { ...f[idx], type: e.target.value }; setPrechatFields(f); }}
                            className="bg-slate-700 border border-slate-600 text-xs text-slate-300 rounded-lg px-2 py-1 focus:outline-none">
                            {['text', 'email', 'phone', 'select'].map(t => <option key={t} value={t}>{t}</option>)}
                          </select>
                          <button onClick={() => { const f = [...prechatFields]; f[idx] = { ...f[idx], required: !f[idx].required }; setPrechatFields(f); }}
                            className={`text-xs px-2 py-1 rounded-lg border transition-all ${field.required ? 'border-indigo-500/50 text-indigo-300 bg-indigo-500/10' : 'border-slate-700 text-slate-500 hover:text-slate-300'}`}>
                            {field.required ? 'Req' : 'Opt'}
                          </button>
                          <button onClick={() => setPrechatFields(prev => prev.filter((_, i) => i !== idx))}
                            className="text-slate-600 hover:text-red-400 transition-colors text-sm">✕</button>
                        </div>
                      ))}
                    </div>
                    {prechatFields.length < 6 && (
                      <button onClick={() => setPrechatFields(prev => [...prev, { id: 'f' + Date.now(), label: '', type: 'text', required: false }])}
                        className="text-xs text-slate-400 hover:text-white border border-dashed border-slate-700 hover:border-slate-500 rounded-xl px-4 py-2 w-full transition-all">
                        + Add field
                      </button>
                    )}
                    <button onClick={() => setPrechatPreviewOpen(true)}
                      className="px-4 py-2 text-sm font-medium rounded-xl border border-slate-700 text-slate-300 hover:text-white hover:border-slate-500 transition-all">
                      Preview form
                    </button>

                    {prechatPreviewOpen && (
                      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
                        <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-sm shadow-2xl">
                          <div className="flex items-center justify-between mb-4">
                            <h3 className="text-white font-semibold text-sm">Before we start…</h3>
                            <button onClick={() => setPrechatPreviewOpen(false)} className="text-slate-400 hover:text-white text-lg leading-none">×</button>
                          </div>
                          <div className="space-y-3">
                            {prechatFields.map(f => (
                              <div key={f.id}>
                                <label className="text-xs text-slate-400 block mb-1">{f.label}{f.required && <span className="text-red-400 ml-0.5">*</span>}</label>
                                {f.type === 'select' ? (
                                  <select className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none"><option>Select an option…</option></select>
                                ) : (
                                  <input type={f.type} placeholder={f.label} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none" />
                                )}
                              </div>
                            ))}
                          </div>
                          <button className="mt-4 w-full py-2.5 text-sm font-medium text-white rounded-xl" style={{ backgroundColor: accentColor }}>Start chat</button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* ── SLA RULES ── */}
            {settingsSection === 'sla' && (
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-5">
                <div>
                  <h2 className="text-sm font-semibold text-white mb-1">Response Time Targets</h2>
                  <p className="text-xs text-slate-400">Set SLA targets for each priority level</p>
                </div>
                <div className="space-y-3">
                  {[
                    { label: '🔴 Urgent', state: slaUrgent, setter: setSlaUrgent, unit: 'minutes' },
                    { label: '🟡 Normal', state: slaNormal, setter: setSlaNormal, unit: 'minutes' },
                    { label: '⚪ Low', state: slaLow, setter: setSlaLow, unit: 'hours' },
                  ].map(row => (
                    <div key={row.label} className="flex items-center gap-4 bg-slate-800/50 rounded-xl px-4 py-3">
                      <span className="text-sm text-white w-24">{row.label}</span>
                      <span className="text-xs text-slate-500">First response within</span>
                      <input type="number" min={1} value={row.state}
                        onChange={e => row.setter(Number(e.target.value))}
                        className="w-16 bg-slate-800 border border-slate-700 text-white text-sm rounded-lg px-2 py-1 text-center focus:outline-none focus:border-indigo-500" />
                      <span className="text-xs text-slate-400">{row.unit}</span>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl px-4 py-3">
                  <span className="text-emerald-400 text-lg">✓</span>
                  <span className="text-sm text-slate-300">Current month: <span className="text-emerald-400 font-semibold">94%</span> within SLA</span>
                </div>
                <div className="flex items-center justify-between p-3 rounded-xl bg-slate-800/50">
                  <div>
                    <div className="text-sm text-white">Alert team when SLA breached</div>
                    <div className="text-xs text-slate-500">Get notified when a response is overdue</div>
                  </div>
                  <button onClick={() => setSlaAlertEnabled(v => !v)}
                    className="w-9 h-5 rounded-full transition-all relative flex-shrink-0"
                    style={{ backgroundColor: slaAlertEnabled ? accentColor : '#334155' }}>
                    <div className={`w-4 h-4 bg-white rounded-full shadow absolute top-0.5 transition-all ${slaAlertEnabled ? 'left-4' : 'left-0.5'}`} />
                  </button>
                </div>
                {slaAlertEnabled && (
                  <div>
                    <label className="text-xs font-medium text-slate-400 block mb-1.5">SLA breach alert email</label>
                    <input type="email" value={slaAlertEmail || alertEmail} onChange={e => setSlaAlertEmail(e.target.value)}
                      placeholder="ops@yourcompany.com"
                      className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500" />
                  </div>
                )}
                <button onClick={saveSlaSettings} className="px-5 py-2.5 text-sm font-medium text-white rounded-xl transition-all hover:opacity-90" style={{ backgroundColor: accentColor }}>
                  Save SLA Rules
                </button>
              </div>
            )}

            {/* ── LABELS & ALERTS ── */}
            {settingsSection === 'labels' && (
              <div className="space-y-5">
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                  <h2 className="text-sm font-semibold text-white mb-4">Conversation Labels</h2>
                  <div className="flex flex-wrap gap-2 mb-4">
                    {conversationLabels.map(l => (
                      <div key={l.id} className="flex items-center gap-1.5 rounded-full px-3 py-1.5" style={{ backgroundColor: l.color + '22', border: '1px solid ' + l.color + '44' }}>
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: l.color }} />
                        <span className="text-xs text-white">{l.name}</span>
                        <button onClick={() => saveLabels(conversationLabels.filter(x => x.id !== l.id))}
                          className="text-slate-500 hover:text-red-400 transition-colors ml-0.5 text-xs leading-none">✕</button>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <input value={newLabelName} onChange={e => setNewLabelName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && newLabelName.trim()) { saveLabels([...conversationLabels, { id: 'l' + Date.now(), name: newLabelName.trim(), color: labelColors[conversationLabels.length % labelColors.length] }]); setNewLabelName(''); } }}
                      placeholder="New label name…"
                      className="flex-1 bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500" />
                    <button onClick={() => { if (!newLabelName.trim()) return; saveLabels([...conversationLabels, { id: 'l' + Date.now(), name: newLabelName.trim(), color: labelColors[conversationLabels.length % labelColors.length] }]); setNewLabelName(''); }}
                      className="px-4 py-2.5 text-sm font-medium text-white rounded-xl transition-all hover:opacity-90" style={{ backgroundColor: accentColor }}>Add</button>
                  </div>
                </div>

                <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                  <h2 className="text-sm font-semibold text-white mb-1">Escalation Alerts</h2>
                  <p className="text-xs text-slate-500 mb-4">Get an email when a conversation is escalated to your team. Powered by Resend — add your API key in Platform Config to activate.</p>
                  <div>
                    <label className="text-xs font-medium text-slate-400 block mb-1.5">Alert Email Address</label>
                    <div className="flex gap-2">
                      <input type="email" value={alertEmail} onChange={e => { setAlertEmail(e.target.value); setAlertEmailSaved(false); }}
                        placeholder="ops@yourcompany.com"
                        className="flex-1 bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500" />
                      <button onClick={async () => { if (!alertEmail || !tenantId) return; setAlertEmailSaving(true); await api.saveAlertEmail(tenantId, alertEmail); setAlertEmailSaving(false); setAlertEmailSaved(true); setTimeout(() => setAlertEmailSaved(false), 3000); }}
                        disabled={alertEmailSaving || !alertEmail}
                        className="px-4 py-2.5 text-sm font-medium rounded-xl text-white disabled:opacity-50 transition-all"
                        style={{ backgroundColor: accentColor }}>
                        {alertEmailSaving ? 'Saving…' : alertEmailSaved ? 'Saved ✓' : 'Save'}
                      </button>
                    </div>
                    <p className="text-xs text-slate-600 mt-1.5">Emails sent from <span className="font-mono">alerts@dreamteam.ai</span> · replies go to your address</p>
                  </div>
                </div>
              </div>
            )}

          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 p-6">
      <p className="text-slate-400">Customer Portal</p>
    </div>
  );
};

export default CustomerPortalPage;
