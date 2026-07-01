import React, { useState, useEffect, useRef } from 'react'
import { AuthUser, Tenant, Page } from '../../types'
import { Badge, StatCard, PageTabs, PORTAL_TABS } from '../../components'
import { supabase } from '../../supabase'
import { runAgentLoop, resolveConversation } from '../../lib/api'
import * as api from '../../lib/api'

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

  // ----- human escalation inbox state -----
  const eList = React.useState<any[]>([]);
  const eItems = eList[0]; const setEItems = eList[1];
  const eActive = React.useState<any>(null);
  const eSel = eActive[0]; const setESel = eActive[1];
  const eReplyS = React.useState('');
  const eReply = eReplyS[0]; const setEReply = eReplyS[1];
  const eBusyS = React.useState(false);
  const eBusy = eBusyS[0]; const setEBusy = eBusyS[1];
  const eLoadEsc = React.useCallback(async () => {
    if (!pLive || !pTenantId) return;
    const open = await api.fetchEscalations(pTenantId, 'open');
    const assigned = await api.fetchEscalations(pTenantId, 'assigned');
    setEItems([...(open || []), ...(assigned || [])]);
  }, [pLive, pTenantId]);
  React.useEffect(() => {
    if (pLive && subPage === 'portal_escalations') eLoadEsc();
  }, [pLive, subPage, eLoadEsc]);
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
    const r = await api.resolveEscalation({ escalationId: row.id, tenantId: pTenantId, conversationId: row.conversation_id || null, reply: eReply, resolvedBy: me });
    if (r.ok) { setEReply(''); setESel(null); await eLoadEsc(); }
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
    const isBilling =
      query.toLowerCase().includes('bill') ||
      query.toLowerCase().includes('invoice') ||
      query.toLowerCase().includes('charge') ||
      query.toLowerCase().includes('payment') ||
      query.toLowerCase().includes('refund');
    const isSecurity =
      query.toLowerCase().includes('password') ||
      query.toLowerCase().includes('2fa') ||
      query.toLowerCase().includes('login') ||
      query.toLowerCase().includes('access') ||
      query.toLowerCase().includes('reset');
    const chosenAgent = isBilling
      ? 'Billing Agent'
      : isSecurity
      ? 'Account Agent'
      : 'Support Agent';
    setAgentUsed(chosenAgent);
    setTraceVisible(true);
    const stages = [
      {
        stage: 'Intent Classification',
        status: 'running' as const,
        detail: 'Classifying query intent and routing to best agent...',
        confidence: undefined,
        duration: undefined,
      },
      {
        stage: 'KB Retrieval',
        status: 'pending' as const,
        detail: '',
        confidence: undefined,
        duration: undefined,
      },
      {
        stage: 'Knowledge Validation',
        status: 'pending' as const,
        detail: '',
        confidence: undefined,
        duration: undefined,
      },
      {
        stage: 'LLM Reasoning',
        status: 'pending' as const,
        detail: '',
        confidence: undefined,
        duration: undefined,
      },
      {
        stage: 'Confidence Gate',
        status: 'pending' as const,
        detail: '',
        confidence: undefined,
        duration: undefined,
      },
      {
        stage: 'Response Generation',
        status: 'pending' as const,
        detail: '',
        confidence: undefined,
        duration: undefined,
      },
    ];
    setTraceSteps(stages);

    const kbChunks = isBilling
      ? [
          {
            title: 'How to Request a Refund',
            breadcrumb:
              'DreamTeam Platform › Billing › Invoices › Refund Policy',
            connector: null,
            score: 0.94,
            fresh: 98,
          },
          {
            title: 'Understanding Your Invoice',
            breadcrumb:
              'DreamTeam Platform › Billing › Invoices › Invoice Downloads',
            connector: null,
            score: 0.88,
            fresh: 95,
          },
          {
            title: 'Invoice #inv_2026_0621',
            breadcrumb:
              'Stripe Billing › Invoice › amount, status, periodStart, lineItems',
            connector: 'Stripe Billing',
            score: 0.91,
            fresh: 100,
          },
        ]
      : isSecurity
      ? [
          {
            title: 'Setting Up Two-Factor Authentication',
            breadcrumb:
              'Customer Portal › Self-Service › Password & Security › 2FA',
            connector: null,
            score: 0.96,
            fresh: 99,
          },
          {
            title: 'RBAC Roles and Permissions Reference',
            breadcrumb:
              'DreamTeam Platform › Getting Started › Onboarding › Workspace Config',
            connector: null,
            score: 0.81,
            fresh: 96,
          },
          {
            title: 'Contact #c_00128',
            breadcrumb: 'Salesforce CRM › Contact › id, email, lastActivity',
            connector: 'Salesforce CRM',
            score: 0.77,
            fresh: 100,
          },
        ]
      : [
          {
            title: 'Agent Pipeline Design Best Practices',
            breadcrumb:
              'DreamTeam Platform › Agent Management › Configuration › Pipeline Design',
            connector: null,
            score: 0.89,
            fresh: 100,
          },
          {
            title: 'Release Notes v4.2',
            breadcrumb:
              'DreamTeam Platform › Agent Management › Configuration › LLM Model Selection',
            connector: null,
            score: 0.83,
            fresh: 100,
          },
          {
            title: 'API_Reference_v4.2.md',
            breadcrumb: 'Imported File › Integrations & APIs › API Reference',
            connector: 'Google Drive / Files',
            score: 0.74,
            fresh: 95,
          },
        ];

    setTimeout(() => {
      setTraceSteps((prev) =>
        prev.map((s, i) =>
          i === 0
            ? {
                ...s,
                status: 'done',
                detail: 'Routed to ' + chosenAgent + ' — confidence 97%',
                confidence: 97,
                duration: 120,
              }
            : i === 1
            ? { ...s, status: 'running', detail: 'Searching knowledge base...' }
            : s
        )
      );
    }, 600);
    setTimeout(() => {
      setTraceSteps((prev) =>
        prev.map((s, i) =>
          i === 1
            ? {
                ...s,
                status: 'done',
                detail:
                  'Retrieved ' +
                  kbChunks.length +
                  ' sources — ' +
                  kbChunks
                    .map(
                      (c) =>
                        (c.connector ? '[' + c.connector + '] ' : '[KB] ') +
                        c.title +
                        ' (' +
                        (c.score * 100).toFixed(0) +
                        '%)'
                    )
                    .join(' | '),
                confidence: 89,
                duration: 340,
              }
            : i === 2
            ? {
                ...s,
                status: 'running',
                detail:
                  'Knowledge Curator bot validating chunk freshness and relevance...',
              }
            : s
        )
      );
    }, 1200);
    setTimeout(() => {
      setTraceSteps((prev) =>
        prev.map((s, i) =>
          i === 2
            ? {
                ...s,
                status: 'done',
                detail:
                  'All chunks passed freshness check. Avg relevance score: 0.87',
                confidence: 92,
                duration: 180,
              }
            : i === 3
            ? {
                ...s,
                status: 'running',
                detail:
                  'Reasoning over retrieved context with ' +
                  (isBilling
                    ? 'GPT-4o'
                    : isSecurity
                    ? 'Claude Haiku 3.5'
                    : 'Claude Sonnet 4.5') +
                  '...',
              }
            : s
        )
      );
    }, 1900);
    setTimeout(() => {
      const finalConfidence = isBilling ? 94 : isSecurity ? 88 : 91;
      setTraceSteps((prev) =>
        prev.map((s, i) =>
          i === 3
            ? {
                ...s,
                status: 'done',
                detail: 'Chain-of-thought complete. Draft response generated.',
                confidence: finalConfidence,
                duration: 820,
              }
            : i === 4
            ? {
                ...s,
                status: 'running',
                detail:
                  'Running Confidence Reviewer, Safety Guard, Hallucination Detector...',
              }
            : s
        )
      );
    }, 2800);
    setTimeout(() => {
      const fc = isBilling ? 94 : isSecurity ? 88 : 91;
      const passed = fc >= 80;
      setTraceSteps((prev) =>
        prev.map((s, i) =>
          i === 4
            ? {
                ...s,
                status: passed ? 'done' : 'escalated',
                detail: passed
                  ? 'All validators passed. Confidence ' +
                    fc +
                    '% above threshold of ' +
                    (isBilling ? '92' : isSecurity ? '90' : '80') +
                    '%. Auto-responding.'
                  : 'Confidence ' +
                    fc +
                    '% below threshold. Escalating to human.',
                confidence: fc,
                duration: 95,
              }
            : i === 5
            ? {
                ...s,
                status: 'running',
                detail: 'Formatting final response...',
              }
            : s
        )
      );
    }, 3500);
    setTimeout(() => {
      setTraceSteps((prev) =>
        prev.map((s, i) =>
          i === 5
            ? {
                ...s,
                status: 'done',
                detail: 'Response delivered. Audit log written.',
                confidence: undefined,
                duration: 55,
              }
            : s
        )
      );
      setTyping(false);
      // (final agent message is now pushed by sendMessage via the real agent loop)
    }, 4200);
  };

  const sendMessage = () => {
    if (!chatInput.trim()) return;
    const msgText = chatInput.trim();
    const userMsg = {
      role: 'user' as const,
      text: msgText,
      time: new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      }),
    };
    setMessages((prev) => [...prev, userMsg]);
    setChatInput('');
    setTyping(true);
    runAgentPipeline(msgText);
    if (tenant?.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenant.id)) {
      // Real end-to-end agent loop: KB retrieval + confidence + approval gate, persisted.
      (async () => {
        try {
          const { action, draft } = await runAgentLoop(tenant.id, msgText, {
            customerName: user?.name,
            audience: 'customer',
          });
          if (action) dbConvIdRef.current = action.conversation_id || dbConvIdRef.current;
          const confPct = Math.round(draft.confidence * 100);
          const reply = draft.requiresApproval
            ? draft.answer + '\n\n⚠️ Below the confidence threshold (' + confPct + '%) — sent to a human teammate for approval before delivery.'
            : draft.answer;
          setTimeout(() => {
            setMessages((prev) => [
              ...prev,
              {
                role: 'agent' as const,
                text: reply,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                confidence: confPct,
                actions: draft.sources.map((s) => 'Source: ' + s.title),
              },
            ]);
            setTyping(false);
          }, 4300);
        } catch (e) { console.error('[DT] agent loop:', e); setTyping(false); }
      })();
    } else {
      // Demo tenant (no real UUID): simulated reply for the trace demo.
      setTimeout(() => {
        setMessages((prev) => [
          ...prev,
          {
            role: 'agent' as const,
            text: 'I found relevant information in the knowledge base and drafted a response. (Demo mode — sign in to a live workspace to persist this conversation and run the real approval loop.)',
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            confidence: 91,
            actions: ['Show Setup Guide', 'Email Step-by-Step Guide', 'Book a Demo'],
          },
        ]);
        setTyping(false);
      }, 4300);
    }
  };

  const [pendingApprovals, setPendingApprovals] = useState([
    {
      id: 'ap1',
      customer: 'Emily Carter',
      email: 'emily@acmeuser.com',
      action: 'Issue $350 credit to account',
      agent: 'Billing Agent',
      requestedAt: '15 min ago',
      confidence: 94,
      risk: 'medium',
    },
    {
      id: 'ap2',
      customer: 'James Liu',
      email: 'james@globexuser.com',
      action: 'Reset 2FA and send recovery codes',
      agent: 'Security Agent',
      requestedAt: '1 hr ago',
      confidence: 88,
      risk: 'high',
    },
    {
      id: 'ap3',
      customer: 'Maria Santos',
      email: 'maria@initechuser.com',
      action: 'Downgrade plan from Enterprise to Growth',
      agent: 'Account Agent',
      requestedAt: '2 hr ago',
      confidence: 97,
      risk: 'low',
    },
    {
      id: 'ap4',
      customer: 'Tom Baker',
      email: 'tom@hooliuser.com',
      action: 'Export all account data as CSV',
      agent: 'Data Agent',
      requestedAt: '3 hr ago',
      confidence: 99,
      risk: 'low',
    },
  ]);

  // Human-in-the-loop decision state + audit trail
  const [decisionLog, setDecisionLog] = useState([]);
  const [decidingId, setDecidingId] = useState(null);
  const [decisionToast, setDecisionToast] = useState(null);
  const handleDecision = async (item, decision) => {
    setDecidingId(item.id);
    const decidedAt = new Date();
    const deciderName = ((user && user.name) ? user.name : 'You');
    const isRealRow = typeof item.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(item.id);
    // Persist decision to the real agent_actions row when it exists; never block the UI
    try {
      const { data: au } = await supabase.auth.getUser();
      const approverId = au && au.user ? au.user.id : null;
      if (isRealRow) {
        await supabase.from('agent_actions').update({
          status: decision === 'approve' ? 'approved' : 'rejected',
          approved_by: approverId,
          approved_at: decidedAt.toISOString(),
          requires_approval: false
        }).eq('id', item.id);
      }
    } catch (e) { /* audit/persistence optional in demo */ }
    setPendingApprovals((prev) => prev.filter((x) => x.id !== item.id));
    setDecisionLog((prev) => [
      { ...item, decision, deciderName, decidedAtLabel: decidedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) },
      ...prev,
    ]);
    setDecidingId(null);
    setDecisionToast({ decision, action: item.action });
    setTimeout(() => setDecisionToast(null), 3200);
  };
  // Load real pending approvals from agent_actions; keep demo set as graceful fallback
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase
          .from('agent_actions')
          .select('id, agent_name, action_type, description, confidence_score, payload, created_at')
          .eq('requires_approval', true)
          .eq('status', 'pending')
          .order('created_at', { ascending: false });
        if (cancelled || error || !data || data.length === 0) return;
        const mapped = data.map((r) => {
          const p = r.payload || {};
          return {
            id: r.id,
            customer: p.customer || p.customer_name || 'Customer',
            email: p.email || p.customer_email || '',
            action: r.description || r.action_type || 'Pending action',
            agent: r.agent_name || 'Agent',
            requestedAt: r.created_at ? new Date(r.created_at).toLocaleString() : 'just now',
            confidence: r.confidence_score != null ? Math.round(Number(r.confidence_score) * (Number(r.confidence_score) <= 1 ? 100 : 1)) : 90,
            risk: p.risk || 'medium',
          };
        });
        setPendingApprovals(mapped);
      } catch (e) { /* offline/demo: keep seeded queue */ }
    })();
    return () => { cancelled = true; };
  }, []);


  const riskColors: Record<string, string> = {
    low: 'green',
    medium: 'amber',
    high: 'red',
  };

  const conversations = [
    {
      id: 'c1',
      customer: 'Emily Carter',
      preview: 'I need to update my payment method...',
      agent: 'Billing Agent',
      status: 'resolved',
      time: '10 min ago',
      messages: 6,
    },
    {
      id: 'c2',
      customer: 'James Liu',
      preview: 'My password reset link is not working',
      agent: 'Support Agent',
      status: 'escalated',
      time: '45 min ago',
      messages: 12,
    },
    {
      id: 'c3',
      customer: 'Sarah Kim',
      preview: 'Can you explain the API rate limits?',
      agent: 'Technical Agent',
      status: 'resolved',
      time: '1 hr ago',
      messages: 4,
    },
    {
      id: 'c4',
      customer: 'David Brown',
      preview: 'I want to add 3 more seats to my plan',
      agent: 'Account Agent',
      status: 'pending',
      time: '2 hr ago',
      messages: 8,
    },
    {
      id: 'c5',
      customer: 'Lisa Chen',
      preview: 'Onboarding help where do I start?',
      agent: 'Onboarding Agent',
      status: 'resolved',
      time: '3 hr ago',
      messages: 15,
    },
  ];

  const statusColors: Record<string, string> = {
    resolved: 'green',
    escalated: 'red',
    pending: 'amber',
  };

  const agentActions = [
    {
      name: 'Reset Password',
      description: 'Trigger password reset email for customer',
      risk: 'low',
      approval: false,
      usedToday: 142,
    },
    {
      name: 'Issue Credit',
      description:
        'Apply account credit up to $200 auto, above $200 requires approval',
      risk: 'medium',
      approval: true,
      usedToday: 23,
    },
    {
      name: 'Upgrade Plan',
      description: 'Move customer to higher plan tier immediately',
      risk: 'low',
      approval: false,
      usedToday: 8,
    },
    {
      name: 'Downgrade Plan',
      description: 'Reduce plan tier with confirmation workflow',
      risk: 'medium',
      approval: true,
      usedToday: 4,
    },
    {
      name: 'Export Account Data',
      description: 'Generate full data export GDPR compliant',
      risk: 'low',
      approval: false,
      usedToday: 31,
    },
    {
      name: 'Suspend Account',
      description: 'Temporarily suspend customer access',
      risk: 'high',
      approval: true,
      usedToday: 2,
    },
    {
      name: 'Reset 2FA',
      description: 'Disable and reset two-factor authentication',
      risk: 'high',
      approval: true,
      usedToday: 7,
    },
    {
      name: 'Change Billing Email',
      description: 'Update billing contact email address',
      risk: 'low',
      approval: false,
      usedToday: 19,
    },
  ];

  const tickets = [
    {
      id: 'T-9921',
      customer: 'James Liu',
      subject: 'Login issue 2FA not working',
      priority: 'urgent',
      status: 'open',
      assignee: 'Human Agent',
      created: '1 hr ago',
    },
    {
      id: 'T-9920',
      customer: 'Alex Patel',
      subject: 'Billing discrepancy on October invoice',
      priority: 'high',
      status: 'in_progress',
      assignee: 'Billing Agent',
      created: '3 hr ago',
    },
    {
      id: 'T-9919',
      customer: 'Sarah Kim',
      subject: 'API key rotation request',
      priority: 'medium',
      status: 'resolved',
      assignee: 'Tech Agent',
      created: '1 day ago',
    },
    {
      id: 'T-9918',
      customer: 'Oliver Chen',
      subject: 'Cannot download invoices as PDF',
      priority: 'low',
      status: 'resolved',
      assignee: 'Support Agent',
      created: '2 days ago',
    },
    {
      id: 'T-9917',
      customer: 'Emma Wilson',
      subject: 'SSO setup assistance needed',
      priority: 'medium',
      status: 'open',
      assignee: 'Tech Agent',
      created: '2 days ago',
    },
  ];

  const priorityColors: Record<string, string> = {
    urgent: 'red',
    high: 'amber',
    medium: 'blue',
    low: 'slate',
  };

  if (subPage === 'portal_overview') {
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageTabs tabs={PORTAL_TABS} page={subPage} setPage={setPage} accentColor={accentColor} />
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">Customer Portal</h1>
          <p className="text-slate-400 text-sm mt-1">
            Digital Employees serve your customers 24/7 — answering questions, resolving
            issues, and taking action on their behalf
          </p>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard
            label="Conversations Today"
            value="1,284"
            icon="✉"
            color="blue"
            trend="+18%"
          />
          <StatCard
            label="Self-Served"
            value="89%"
            icon="★"
            color="emerald"
            trend="No human needed"
          />
          <StatCard
            label="Pending Approvals"
            value="12"
            icon="⚠"
            color="amber"
            trend="3 urgent"
          />
          <StatCard
            label="Avg Response Time"
            icon="✚"
            value="< 2s"
            color="indigo"
            trend="AI-instant"
          />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4">
              Customer Satisfaction Trend
            </h2>
            <div className="flex items-end gap-2 h-24">
              {[82, 85, 87, 86, 90, 92, 94].map((v, i) => {
                const days = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
                return (
                  <div
                    key={i}
                    className="flex-1 flex flex-col items-center gap-1"
                  >
                    <div
                      className="w-full rounded-t"
                      style={{
                        height: ((v - 80) / 15) * 100 + '%',
                        backgroundColor: accentColor,
                        minHeight: '4px',
                      }}
                    />
                    <span className="text-xs text-slate-600">{days[i]}</span>
                  </div>
                );
              })}
            </div>
            <div className="mt-3 flex justify-between text-xs text-slate-400">
              <span>
                Average this week:{' '}
                <span className="text-emerald-400">91.7%</span>
              </span>
              <span>Target: 90%</span>
            </div>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4">
              Resolution Breakdown
            </h2>
            <div className="space-y-3">
              {[
                { label: 'Fully resolved by AI', pct: 71, color: '#10b981' },
                { label: 'AI plus action taken', pct: 18, color: accentColor },
                { label: 'Escalated to human', pct: 8, color: '#f59e0b' },
                { label: 'Created ticket', pct: 3, color: '#ef4444' },
              ].map((item, i) => (
                <div key={i}>
                  <div className="flex justify-between text-xs text-slate-400 mb-1">
                    <span>{item.label}</span>
                    <span className="text-white">{item.pct}%</span>
                  </div>
                  <div className="h-2 bg-slate-800 rounded-full">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: item.pct + '%',
                        backgroundColor: item.color,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Conversations inbox (admin view) ─────────────────────────
  const [convFilter, setConvFilter] = React.useState<string>('all');
  const [humanReply, setHumanReply] = React.useState('');
  const [humanBusy, setHumanBusy] = React.useState(false);
  const [convToast, setConvToast] = React.useState<string | null>(null);

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
          {/* Filter bar */}
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
                {convFiltered.map(c => (
                  <button key={c.id} onClick={() => pOpenConvo(c.id)}
                    className={'w-full text-left px-3 py-3 rounded-xl border transition-all ' + (pActiveId === c.id ? 'border-indigo-500/60 bg-indigo-500/10' : 'border-slate-800 bg-slate-900/40 hover:border-slate-700')}>
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <span className="text-sm font-medium text-white truncate">{c.customer_name || 'Customer'}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0 ${convStatusColor(c.status)}`}>{c.status}</span>
                    </div>
                    <div className="text-xs text-slate-500 truncate mb-1">{c.subject || 'Untitled conversation'}</div>
                    <div className="flex items-center gap-2 text-[10px] text-slate-600">
                      <span>{c.channel || 'chat'}</span>
                      {typeof c.confidence_score === 'number' && (<><span>·</span><span>{Math.round(c.confidence_score * 100)}% conf</span></>)}
                      <span>·</span>
                      <span>{new Date(c.created_at).toLocaleDateString()}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Right: thread + actions */}
            <div className="flex-1 flex flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/40">
              {!pActiveId ? (
                <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">Select a conversation to review.</div>
              ) : (
                <>
                  {/* Thread header */}
                  <div className="flex-shrink-0 border-b border-slate-800 px-5 py-3 flex items-center justify-between">
                    <div>
                      <div className="text-sm font-semibold text-white">{activeConv?.customer_name || 'Customer'}</div>
                      <div className="text-xs text-slate-500">{activeConv?.subject || activeConv?.channel || 'chat'}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      {activeConv?.status !== 'resolved' && (
                        <button onClick={doMarkResolved} disabled={humanBusy}
                          className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-700 text-slate-300 hover:border-emerald-500/50 hover:text-emerald-300 transition-all disabled:opacity-40">
                          Mark resolved
                        </button>
                      )}
                      {activeConv && (
                        <span className={`text-xs px-2 py-1 rounded-full ${convStatusColor(activeConv.status)}`}>{activeConv.status}</span>
                      )}
                    </div>
                  </div>

                  {/* Messages */}
                  <div className="flex-1 overflow-y-auto p-5 space-y-3">
                    {pMessages.length === 0 && (<div className="text-center text-slate-600 text-sm pt-8">No messages yet.</div>)}
                    {pMessages.map((m, i) => (
                      <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm ${
                          m.role === 'user' ? 'text-white rounded-br-sm' : 'bg-slate-800 text-slate-200 rounded-bl-sm'
                        }`} style={m.role === 'user' ? { backgroundColor: accentColor } : {}}>
                          <p className="whitespace-pre-wrap leading-relaxed">{m.content}</p>
                          <div className="flex items-center gap-2 mt-1 flex-wrap">
                            {m.role !== 'user' && (
                              <span className="text-[10px] text-slate-500">
                                {m.role === 'system' ? 'System' : 'DE'}
                              </span>
                            )}
                            {typeof m.confidence_score === 'number' && (
                              <span className="text-[10px] text-slate-600">{Math.round(m.confidence_score * 100)}% conf</span>
                            )}
                            <span className="text-[10px] text-slate-700">{new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Human reply / take-over panel */}
                  {activeConv?.status !== 'resolved' && (
                    <div className="flex-shrink-0 border-t border-slate-800 p-4">
                      <p className="text-xs text-slate-500 mb-2">Reply as human agent — this resolves the conversation</p>
                      <div className="flex gap-2">
                        <textarea
                          value={humanReply}
                          onChange={e => setHumanReply(e.target.value)}
                          rows={2}
                          placeholder="Type your reply to the customer…"
                          className="flex-1 rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 resize-none"
                        />
                        <button onClick={doTakeOver} disabled={humanBusy || !humanReply.trim()}
                          className="px-4 rounded-lg text-sm font-medium text-white self-stretch disabled:opacity-40 transition-all"
                          style={{ backgroundColor: accentColor }}>
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

        {convToast && (
          <div className="fixed bottom-6 right-6 z-50 px-4 py-3 rounded-xl bg-emerald-600 shadow-lg text-sm font-medium text-white">
            {convToast}
          </div>
        )}
      </div>
    );
  }

  if (subPage === 'portal_actions') {
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageTabs tabs={PORTAL_TABS} page={subPage} setPage={setPage} accentColor={accentColor} />
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">Workforce Actions</h1>
          <p className="text-slate-400 text-sm mt-1">
            Configure what actions Digital Employees can perform on behalf of customers —
            with confidence gates and approval flows
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {agentActions.map((action, i) => (
            <div
              key={i}
              className="bg-slate-900 border border-slate-800 rounded-xl p-5 hover:border-slate-700 transition-all"
            >
              <div className="flex items-start justify-between mb-2">
                <div className="text-sm font-semibold text-white">
                  {action.name}
                </div>
                <div className="flex gap-2">
                  <Badge
                    label={action.risk + ' risk'}
                    color={riskColors[action.risk]}
                  />
                  {action.approval && (
                    <Badge label="Requires Approval" color="amber" />
                  )}
                </div>
              </div>
              <p className="text-xs text-slate-400 mb-3">
                {action.description}
              </p>
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">
                  Used today:{' '}
                  <span className="text-white">{action.usedToday}</span>
                </span>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" className="sr-only" defaultChecked />
                  <div className="w-9 h-5 bg-indigo-500 rounded-full">
                    <div className="w-4 h-4 bg-white rounded-full shadow mt-0.5 ml-4" />
                  </div>
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
            <p className="text-slate-400 text-sm mt-1">
              Human-in-the-loop — review agent actions that exceed confidence or
              risk thresholds
            </p>
          </div>
          <Badge label={pendingApprovals.length + ' pending'} color="amber" />
        </div>
        <div className="space-y-4">
          {pendingApprovals.map((item) => (
            <div
              key={item.id}
              className="bg-slate-900 border border-slate-800 rounded-xl p-5"
            >
              <div className="flex items-start justify-between mb-3">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-semibold text-white">
                      {item.action}
                    </span>
                    <Badge
                      label={item.risk + ' risk'}
                      color={riskColors[item.risk]}
                    />
                  </div>
                  <div className="text-xs text-slate-400">
                    Customer:{' '}
                    <span className="text-white">{item.customer}</span> ·{' '}
                    {item.email}
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    Requested by:{' '}
                    <span className="text-white">{item.agent}</span> ·{' '}
                    {item.requestedAt}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-bold text-emerald-400">
                    {item.confidence}%
                  </div>
                  <div className="text-xs text-slate-500">confidence</div>
                </div>
              </div>
              <div className="h-1 bg-slate-800 rounded-full mb-3">
                <div
                  className="h-full rounded-full bg-emerald-500"
                  style={{ width: item.confidence + '%' }}
                />
              </div>
                <div className="flex gap-3">
                <button
                  onClick={() => handleDecision(item, 'approved')}
                  disabled={decidingId === item.id}
                  className="flex-1 py-2 text-sm font-medium text-white rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 transition-all"
                >
                  {decidingId === item.id ? 'Working...' : '✓ Approve'}
                </button>
                <button
                  onClick={() => handleDecision(item, 'rejected')}
                  disabled={decidingId === item.id}
                  className="flex-1 py-2 text-sm font-medium text-white rounded-xl bg-red-600/50 hover:bg-red-600/70 disabled:opacity-50 transition-all"
                >
                  {decidingId === item.id ? 'Working...' : '✕ Reject'}
                </button>
                <button className="px-4 py-2 text-sm text-slate-400 hover:text-white bg-slate-800 rounded-xl transition-all">
                  View Context
                </button>
                </div>
            </div>
          ))}
        </div>
        {pendingApprovals.length === 0 && (
          <div className="text-center py-12 bg-slate-900 border border-slate-800 rounded-xl">
            <div className="text-3xl mb-2">{'✓'}</div>
            <p className="text-white font-semibold">Queue clear</p>
            <p className="text-slate-400 text-sm mt-1">All agent actions have been reviewed. New items appear here when agents hit a confidence or risk threshold.</p>
          </div>
        )}
        {decisionLog.length > 0 && (
          <div className="mt-8">
            <h2 className="text-sm font-semibold text-slate-300 mb-3">Recent decisions</h2>
            <div className="space-y-2">
              {decisionLog.map((d, idx) => (
                <div key={d.id + '-' + idx} className="flex items-center justify-between bg-slate-900/60 border border-slate-800 rounded-lg px-4 py-2.5">
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className={'text-xs font-semibold px-2 py-0.5 rounded-full ' + (d.decision === 'approved' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400')}
                    >
                      {d.decision === 'approved' ? 'Approved' : 'Rejected'}
                    </span>
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
          <div
            className={'fixed bottom-6 right-6 z-50 px-4 py-3 rounded-xl shadow-lg text-sm font-medium text-white ' + (decisionToast.decision === 'approved' ? 'bg-emerald-600' : 'bg-red-600')}
          >
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
                ) : eItems.map((row: any) => (
                  <button key={row.id} onClick={() => { setESel(row); setEReply(''); }} className={"w-full text-left px-3 py-2 rounded-lg border text-sm transition " + (eSel && eSel.id === row.id ? "border-indigo-500/60 bg-indigo-500/10" : "border-slate-800 hover:border-slate-700 bg-slate-900/40")}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-slate-200">{row.question || 'Escalated question'}</span>
                      <span className={"text-[10px] px-1.5 py-0.5 rounded border " + (row.status === 'assigned' ? "bg-amber-500/15 text-amber-300 border-amber-500/30" : "bg-rose-500/15 text-rose-300 border-rose-500/30")}>{row.status}</span>
                    </div>
                    <div className="text-[10px] text-slate-500 mt-0.5">{eReasonLabel(row.reason)}{typeof row.confidence === 'number' ? " · conf " + Math.round(row.confidence * 100) + "%" : ""}</div>
                  </button>
                ))}
              </div>
            </div>
            <div className="lg:col-span-2">
              {!eSel ? (
                <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-8 text-center text-slate-500 text-sm">Select an escalation to review and respond.</div>
              ) : (
                <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <span className={"text-[11px] px-2 py-0.5 rounded border " + eTone(eSel.audit_verdict)}>{eReasonLabel(eSel.reason)}</span>
                    <span className="text-xs text-slate-500">{eSel.status === 'assigned' ? 'Claimed' : 'Unclaimed'}</span>
                  </div>
                  <p className="text-xs uppercase tracking-wide text-slate-500">Customer asked</p>
                  <p className="text-slate-100 mt-1 mb-4">{eSel.question || '—'}</p>
                  <p className="text-xs uppercase tracking-wide text-slate-500">AI draft answer{typeof eSel.confidence === 'number' ? " (" + Math.round(eSel.confidence * 100) + "% confidence)" : ""}</p>
                  <div className="mt-1 mb-4 rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-sm text-slate-300 whitespace-pre-wrap">{eSel.draft_answer || 'No answer was produced — the AI could not find a confident match.'}</div>
                  <p className="text-xs uppercase tracking-wide text-slate-500 mb-1">Your reply to the customer</p>
                  <textarea value={eReply} onChange={(e) => setEReply((e.target as any).value)} rows={4} placeholder="Write the human answer that will be posted into the conversation..." className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm text-slate-100 focus:outline-none focus:border-indigo-500" />
                  <div className="flex items-center gap-2 mt-3">
                    {eSel.status !== 'assigned' && (
                      <button disabled={eBusy} onClick={() => eClaim(eSel)} className="px-3 py-2 text-sm rounded-lg border border-slate-700 text-slate-200 hover:border-slate-500 disabled:opacity-50">Claim</button>
                    )}
                    <button disabled={eBusy || !eReply.trim()} onClick={() => eResolve(eSel)} className="px-4 py-2 text-sm font-medium rounded-lg text-white disabled:opacity-50" style={{ backgroundColor: accentColor }}>{eBusy ? 'Working...' : 'Send reply & resolve'}</button>
                  </div>
                  <p className="text-[11px] text-slate-600 mt-2">Resolving posts your reply into the conversation and marks both the escalation and the conversation as resolved. The AI never auto-sends a human reply.</p>
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
            <p className="text-slate-400 text-sm mt-1">
              Escalated issues requiring human review — AI continues to assist
              in context
            </p>
          </div>
          <button
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-medium"
            style={{ backgroundColor: accentColor }}
          >
            + New Ticket
          </button>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-800">
                {[
                  'Ticket ID',
                  'Customer',
                  'Subject',
                  'Priority',
                  'Status',
                  'Assignee',
                  'Created',
                ].map((h) => (
                  <th
                    key={h}
                    className="text-left px-4 py-3 text-xs font-medium text-slate-400 uppercase tracking-wider"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {tickets.map((t) => (
                <tr
                  key={t.id}
                  className="hover:bg-slate-800/30 cursor-pointer transition-all"
                >
                  <td className="px-4 py-3 text-xs font-mono text-indigo-400">
                    {t.id}
                  </td>
                  <td className="px-4 py-3 text-sm text-white">{t.customer}</td>
                  <td className="px-4 py-3 text-sm text-slate-300">
                    {t.subject}
                  </td>
                  <td className="px-4 py-3">
                    <Badge
                      label={t.priority}
                      color={priorityColors[t.priority]}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <Badge
                      label={t.status.replace('_', ' ')}
                      color={
                        t.status === 'resolved'
                          ? 'green'
                          : t.status === 'open'
                          ? 'red'
                          : 'amber'
                      }
                    />
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400">
                    {t.assignee}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {t.created}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (subPage === 'portal_settings') {
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageTabs tabs={PORTAL_TABS} page={subPage} setPage={setPage} accentColor={accentColor} />
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">Portal Settings</h1>
          <p className="text-slate-400 text-sm mt-1">
            Configure the customer-facing AI portal experience
          </p>
        </div>
        <div className="max-w-2xl space-y-6">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4">
              Portal Identity
            </h2>
            <div className="space-y-4">
              {[
                {
                  label: 'Portal Name',
                  value: (tenant?.name || 'Company') + ' Support',
                },
                {
                  label: 'Welcome Message',
                  value: 'Hi! How can I help you today?',
                },
                { label: 'Fallback Email', value: 'support@company.com' },
              ].map((f, i) => (
                <div key={i}>
                  <label className="text-xs font-medium text-slate-400 block mb-1.5">
                    {f.label}
                  </label>
                  <input
                    defaultValue={f.value}
                    className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              ))}
            </div>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4">
              Agent Behaviour
            </h2>
            <div className="space-y-3">
              {[
                {
                  label: 'Allow agents to take actions without approval',
                  desc: 'Low-risk actions are executed immediately',
                  checked: true,
                },
                {
                  label: 'Show confidence score to customers',
                  desc: 'Displays AI confidence below each response',
                  checked: false,
                },
                {
                  label: 'Enable conversation ratings',
                  desc: 'Prompt customers to rate at end of conversation',
                  checked: true,
                },
                {
                  label: 'Auto-create ticket on escalation',
                  desc: 'When agent cannot resolve, a ticket is auto-created',
                  checked: true,
                },
              ].map((setting, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between p-3 rounded-xl bg-slate-800/50"
                >
                  <div>
                    <div className="text-sm text-white">{setting.label}</div>
                    <div className="text-xs text-slate-500">{setting.desc}</div>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer ml-4">
                    <input
                      type="checkbox"
                      className="sr-only"
                      defaultChecked={setting.checked}
                    />
                    <div
                      className={`w-9 h-5 rounded-full ${
                        setting.checked ? 'bg-indigo-500' : 'bg-slate-700'
                      }`}
                      style={
                        setting.checked ? { backgroundColor: accentColor } : {}
                      }
                    >
                      <div
                        className={`w-4 h-4 bg-white rounded-full shadow mt-0.5 transition-all ${
                          setting.checked ? 'ml-4' : 'ml-0.5'
                        }`}
                      />
                    </div>
                  </label>
                </div>
              ))}
            </div>
          </div>
          <button
            className="px-6 py-2.5 text-white text-sm font-medium rounded-xl"
            style={{ backgroundColor: accentColor }}
          >
            Save Settings
          </button>
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
