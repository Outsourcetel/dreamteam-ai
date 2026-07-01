import React, { useState, useRef, useEffect } from 'react';
import type { AuthUser, Tenant, Page } from '../../types';
import { runPortalTurn, submitCSAT } from '../../lib/api';
import { PageTabs, PORTAL_TABS } from '../../components';

interface ChatMessage {
  id: string;
  role: 'user' | 'de' | 'system';
  text: string;
  ts: string;
  confidence?: number;
  status?: 'answered' | 'escalated';
  sources?: { title: string; similarity: number }[];
  deName?: string;
  modelId?: string;
  escalated?: boolean;
}

function ts() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const EndUserChatPage = ({
  user,
  tenant,
  setPage,
}: {
  user?: AuthUser;
  tenant?: Tenant;
  setPage?: (p: Page) => void;
}) => {
  const accentColor = tenant?.primaryColor || '#6366f1';
  const tenantName = tenant?.name || 'AI Support';

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'de',
      text: `Hi! I'm your AI assistant from ${tenantName}. I can answer questions, help you find information, and connect you with our team when needed. How can I help you today?`,
      ts: ts(),
      deName: 'Assistant',
    },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [escalated, setEscalated] = useState(false);
  const [customerName] = useState(user?.name || 'Customer');
  const [csatRated, setCsatRated] = useState<Record<string, 1 | -1>>({});
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const tenantId = tenant?.id || (user as any)?.tenantId || null;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = async () => {
    const text = input.trim();
    if (!text || loading || escalated) return;
    if (!tenantId) {
      setMessages(prev => [...prev, {
        id: Date.now() + '_sys',
        role: 'system',
        text: 'Chat is not configured yet. Please contact your administrator.',
        ts: ts(),
      }]);
      return;
    }

    setInput('');
    const userMsg: ChatMessage = { id: Date.now() + '_u', role: 'user', text, ts: ts() };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);

    const result = await runPortalTurn(tenantId, text, {
      conversationId,
      customerName,
    });

    if (result.conversationId) setConversationId(result.conversationId);
    if (result.escalated) setEscalated(true);

    const confPct = result.confidence != null ? Math.round(result.confidence * 100) : undefined;
    const deMsg: ChatMessage = {
      id: Date.now() + '_de',
      role: result.escalated ? 'system' : 'de',
      text: result.escalated
        ? 'Your question has been passed to our team. A human agent will be in touch shortly.'
        : result.answer,
      ts: ts(),
      confidence: confPct,
      status: result.escalated ? 'escalated' : 'answered',
      sources: result.sources as any,
      deName: result.agentName || 'Assistant',
      escalated: result.escalated,
    };

    setMessages(prev => [...prev, deMsg]);
    setLoading(false);
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const startNew = () => {
    setConversationId(null);
    setEscalated(false);
    setInput('');
    setMessages([{
      id: 'welcome_' + Date.now(),
      role: 'de',
      text: `Hi again! How can I help you?`,
      ts: ts(),
      deName: 'Assistant',
    }]);
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-950 overflow-hidden">
      <div className="flex-shrink-0 px-6 pt-6">
        <PageTabs tabs={PORTAL_TABS} page={'eu_chat' as Page} setPage={setPage} accentColor={accentColor} />
      </div>

      {/* Header */}
      <div className="flex-shrink-0 border-b border-slate-800 px-6 py-4 flex items-center justify-between"
        style={{ borderBottomColor: accentColor + '30' }}>
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center text-sm font-bold text-white"
            style={{ backgroundColor: accentColor }}>
            {tenantName[0]}
          </div>
          <div>
            <div className="text-sm font-semibold text-white">{tenantName}</div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              <span className="text-xs text-slate-400">AI Assistant · Online</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {conversationId && (
            <button
              onClick={startNew}
              className="text-xs text-slate-500 hover:text-slate-300 px-3 py-1.5 rounded-lg border border-slate-700 hover:border-slate-600 transition-all"
            >
              New conversation
            </button>
          )}
          {setPage && (
            <button
              onClick={() => setPage('portal_conversations')}
              className="text-xs text-slate-500 hover:text-slate-300 px-3 py-1.5 rounded-lg border border-slate-700 hover:border-slate-600 transition-all"
            >
              Admin view →
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-5">
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {m.role !== 'user' && (
              <div className="w-7 h-7 rounded-lg flex-shrink-0 flex items-center justify-center text-xs font-bold text-white mr-2.5 mt-0.5"
                style={{ backgroundColor: m.role === 'system' ? '#64748b' : accentColor }}>
                {m.role === 'system' ? '!' : tenantName[0]}
              </div>
            )}

            <div className={`max-w-[72%] space-y-1.5 ${m.role === 'user' ? 'items-end' : 'items-start'} flex flex-col`}>
              {m.role !== 'user' && m.deName && (
                <div className="text-xs text-slate-500 px-1">{m.deName}</div>
              )}

              <div className={`px-4 py-3 rounded-2xl text-sm leading-relaxed ${
                m.role === 'user'
                  ? 'text-white rounded-br-sm'
                  : m.role === 'system'
                  ? 'bg-amber-500/10 border border-amber-500/30 text-amber-200 rounded-bl-sm'
                  : 'bg-slate-800 text-slate-100 rounded-bl-sm'
              }`}
                style={m.role === 'user' ? { backgroundColor: accentColor } : {}}>
                {m.text}
              </div>

              {/* Confidence + sources */}
              {m.role === 'de' && m.confidence !== undefined && (
                <div className="flex flex-wrap items-center gap-2 px-1">
                  <span className={`text-xs px-2 py-0.5 rounded font-mono ${
                    m.confidence >= 80 ? 'text-emerald-400 bg-emerald-400/10'
                    : m.confidence >= 60 ? 'text-amber-400 bg-amber-400/10'
                    : 'text-slate-500 bg-slate-700/50'
                  }`}>
                    {m.confidence}% confident
                  </span>
                </div>
              )}

              {m.sources && m.sources.length > 0 && (
                <div className="px-1 space-y-0.5">
                  {m.sources.slice(0, 2).map((s, i) => (
                    <div key={i} className="text-xs text-slate-600 flex items-center gap-1">
                      <span>◈</span>
                      <span className="truncate">{s.title}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* CSAT rating — shown after DE messages when conversation is live */}
              {m.role === 'de' && !m.escalated && conversationId && tenantId && (
                <div className="flex items-center gap-2 px-1 mt-0.5">
                  {csatRated[m.id] ? (
                    <span className="text-xs text-slate-600">
                      {csatRated[m.id] === 1 ? 'Thanks for the feedback!' : 'Thanks — we\'ll improve.'}
                    </span>
                  ) : (
                    <>
                      <span className="text-xs text-slate-600">Helpful?</span>
                      <button
                        onClick={async () => {
                          setCsatRated(prev => ({ ...prev, [m.id]: 1 }));
                          await submitCSAT(conversationId, tenantId, 1);
                        }}
                        className="text-slate-600 hover:text-emerald-400 transition-colors text-sm"
                        title="Yes, helpful"
                      >👍</button>
                      <button
                        onClick={async () => {
                          setCsatRated(prev => ({ ...prev, [m.id]: -1 }));
                          await submitCSAT(conversationId, tenantId, -1);
                        }}
                        className="text-slate-600 hover:text-red-400 transition-colors text-sm"
                        title="Not helpful"
                      >👎</button>
                    </>
                  )}
                </div>
              )}

              <div className="text-xs text-slate-700 px-1">{m.ts}</div>
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="w-7 h-7 rounded-lg flex-shrink-0 flex items-center justify-center text-xs font-bold text-white mr-2.5"
              style={{ backgroundColor: accentColor }}>
              {tenantName[0]}
            </div>
            <div className="bg-slate-800 rounded-2xl rounded-bl-sm px-4 py-3">
              <div className="flex gap-1">
                {[0, 1, 2].map(i => (
                  <span key={i} className="w-1.5 h-1.5 rounded-full bg-slate-500 animate-bounce"
                    style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
              </div>
            </div>
          </div>
        )}

        {escalated && (
          <div className="flex justify-center">
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-5 py-3 text-center max-w-sm">
              <div className="text-xs font-medium text-amber-300 mb-1">Handed to our team</div>
              <div className="text-xs text-slate-400">A human agent will review your conversation and respond shortly.</div>
              <button onClick={startNew}
                className="mt-3 text-xs text-slate-400 hover:text-white underline transition-all">
                Start a new conversation
              </button>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="flex-shrink-0 border-t border-slate-800 px-6 py-4">
        {escalated ? (
          <div className="text-center text-xs text-slate-600">
            This conversation has been escalated to our team.{' '}
            <button onClick={startNew} className="text-indigo-400 hover:text-indigo-300 underline">Start new</button>
          </div>
        ) : (
          <div className="flex gap-3 items-end">
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Type your message…"
              rows={2}
              className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 resize-none transition-all"
              style={{ '--tw-border-opacity': 1 } as any}
            />
            <button
              onClick={send}
              disabled={loading || !input.trim()}
              className="px-5 py-3 rounded-xl text-white text-sm font-medium disabled:opacity-40 transition-all flex-shrink-0"
              style={{ backgroundColor: accentColor }}
            >
              {loading ? '…' : 'Send'}
            </button>
          </div>
        )}
        <div className="flex items-center justify-between mt-2">
          <div className="text-xs text-slate-700">Enter to send · Shift+Enter for new line</div>
          <div className="text-xs text-slate-700">Powered by {tenantName} AI</div>
        </div>
      </div>
    </div>
  );
};

export default EndUserChatPage;
