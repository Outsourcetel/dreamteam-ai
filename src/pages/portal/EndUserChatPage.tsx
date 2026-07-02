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
  isImageAttachment?: boolean;
}

interface CustomerIdentity {
  name: string;
  email: string;
  customFields: Record<string, string>;
}

function ts() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
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
  const tenantId = tenant?.id || (user as any)?.tenantId || null;

  // ── Customer identity ──────────────────────────────────────────
  const [customerIdentity, setCustomerIdentity] = useState<CustomerIdentity | null>(() => {
    if (!tenantId) return { name: user?.name || 'Anonymous User', email: user?.email || '', customFields: {} };
    try {
      const saved = localStorage.getItem('dt_portal_customer_' + tenantId);
      if (saved) return JSON.parse(saved);
    } catch {}
    return null;
  });

  // Load portal brand config for pre-chat form
  const portalBrandConfig = (() => {
    try { return JSON.parse(localStorage.getItem('dt_portal_brand_' + tenantId) || '{}'); } catch { return {}; }
  })();
  const prechatEnabled = portalBrandConfig.prechatEnabled !== false;
  const prechatFields: { id: string; label: string; type: string; required: boolean }[] = (() => {
    try {
      const s = JSON.parse(localStorage.getItem('dt_portal_brand_' + tenantId) || '{}');
      if (s.prechatFields && s.prechatFields.length > 0) return s.prechatFields;
    } catch {}
    return [
      { id: 'f1', label: 'Name', type: 'text', required: true },
      { id: 'f2', label: 'Email', type: 'email', required: true },
    ];
  })();

  // Pre-chat form state
  const [prechatValues, setPrechatValues] = useState<Record<string, string>>({});
  const [prechatErrors, setPrechatErrors] = useState<Record<string, boolean>>({});

  // ── Chat state ─────────────────────────────────────────────────
  const getWelcomeMsg = (identity: CustomerIdentity | null): ChatMessage => ({
    id: 'welcome',
    role: 'de',
    text: identity
      ? `Hi ${identity.name}! I'm your AI assistant from ${tenantName}. How can I help you today?`
      : `Hi! I'm your AI assistant from ${tenantName}. I can answer questions, help you find information, and connect you with our team when needed. How can I help you today?`,
    ts: ts(),
    deName: 'Assistant',
  });

  const [messages, setMessages] = useState<ChatMessage[]>([getWelcomeMsg(customerIdentity)]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [escalated, setEscalated] = useState(false);
  const [csatRated, setCsatRated] = useState<Record<string, 1 | -1>>({});

  // ── Attachment state ───────────────────────────────────────────
  const [attachments, setAttachments] = useState<{ name: string; size: number; type: string; dataUrl: string }[]>([]);
  const [messageAttachments, setMessageAttachments] = useState<Record<string, string>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const customerName = customerIdentity?.name || user?.name || 'Customer';

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ── Pre-chat submit ────────────────────────────────────────────
  const submitPrechat = () => {
    const errors: Record<string, boolean> = {};
    prechatFields.forEach(f => {
      if (f.required && !prechatValues[f.id]?.trim()) errors[f.id] = true;
    });
    if (Object.keys(errors).length > 0) { setPrechatErrors(errors); return; }

    const nameField = prechatFields.find(f => f.label.toLowerCase() === 'name' || f.type === 'text');
    const emailField = prechatFields.find(f => f.type === 'email');
    const identity: CustomerIdentity = {
      name: (nameField ? prechatValues[nameField.id] : '') || 'Customer',
      email: (emailField ? prechatValues[emailField.id] : '') || '',
      customFields: Object.fromEntries(
        prechatFields
          .filter(f => f.id !== nameField?.id && f.id !== emailField?.id)
          .map(f => [f.label, prechatValues[f.id] || ''])
      ),
    };
    try { localStorage.setItem('dt_portal_customer_' + tenantId, JSON.stringify(identity)); } catch {}
    setCustomerIdentity(identity);
    setMessages([getWelcomeMsg(identity)]);
  };

  // ── File attachment handler ────────────────────────────────────
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = () => {
        setAttachments(prev => [...prev, {
          name: file.name,
          size: file.size,
          type: file.type,
          dataUrl: reader.result as string,
        }]);
      };
      reader.readAsDataURL(file);
    });
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeAttachment = (idx: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== idx));
  };

  // ── Send ───────────────────────────────────────────────────────
  const send = async () => {
    const text = input.trim();
    const hasAttachments = attachments.length > 0;
    if ((!text && !hasAttachments) || loading || escalated) return;
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
    const localAttachments = [...attachments];
    setAttachments([]);

    // Send text message if any
    if (text) {
      const userMsg: ChatMessage = { id: Date.now() + '_u', role: 'user', text, ts: ts() };
      setMessages(prev => [...prev, userMsg]);
      setLoading(true);

      const result = await runPortalTurn(tenantId, text, { conversationId, customerName });
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
    }

    // Send attachments
    if (localAttachments.length > 0) {
      for (const att of localAttachments) {
        const isImage = att.type.startsWith('image/');
        const attachMsgId = Date.now() + '_att_' + Math.random().toString(36).slice(2);

        if (isImage) {
          setMessageAttachments(prev => ({ ...prev, [attachMsgId]: att.dataUrl }));
        }

        const attachMsg: ChatMessage = {
          id: attachMsgId,
          role: 'user',
          text: `[Attachment: ${att.name} (${att.type})]`,
          ts: ts(),
          isImageAttachment: isImage,
        };
        setMessages(prev => [...prev, attachMsg]);

        if (isImage) {
          const imgReply: ChatMessage = {
            id: Date.now() + '_imgde',
            role: 'de',
            text: "I can see you've shared an image. Let me help you with that. Could you describe what you're seeing or what assistance you need?",
            ts: ts(),
            deName: 'Assistant',
          };
          setMessages(prev => [...prev, imgReply]);
        } else {
          setLoading(true);
          const result = await runPortalTurn(tenantId, `[Attachment: ${att.name} (${att.type})]`, { conversationId, customerName });
          if (result.conversationId) setConversationId(result.conversationId);
          const deMsg: ChatMessage = {
            id: Date.now() + '_de',
            role: 'de',
            text: result.answer,
            ts: ts(),
            deName: result.agentName || 'Assistant',
          };
          setMessages(prev => [...prev, deMsg]);
          setLoading(false);
        }
      }
    }
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const startNew = () => {
    setConversationId(null);
    setEscalated(false);
    setInput('');
    setAttachments([]);
    setMessages([{
      id: 'welcome_' + Date.now(),
      role: 'de',
      text: `Hi again! How can I help you?`,
      ts: ts(),
      deName: 'Assistant',
    }]);
  };

  // ── Pre-chat form view ─────────────────────────────────────────
  if (!customerIdentity && prechatEnabled && tenantId) {
    const brandColor = portalBrandConfig.brandColor || accentColor;
    const headline = portalBrandConfig.brandHeadline || 'How can we help?';
    const logoUrl = portalBrandConfig.brandLogoUrl || '';

    return (
      <div className="flex-1 flex flex-col h-full bg-slate-950 overflow-hidden">
        <div className="flex-shrink-0 px-6 pt-6">
          <PageTabs tabs={PORTAL_TABS} page={'eu_chat' as Page} setPage={setPage} accentColor={accentColor} />
        </div>
        <div className="flex-1 flex items-center justify-center px-6">
          <div className="w-full max-w-sm">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl">
              <div className="flex flex-col items-center mb-5">
                {logoUrl ? (
                  <img src={logoUrl} alt={tenantName} className="w-12 h-12 object-contain rounded-xl mb-3" />
                ) : (
                  <div className="w-12 h-12 rounded-xl flex items-center justify-center text-xl font-bold text-white mb-3"
                    style={{ backgroundColor: brandColor }}>
                    {tenantName[0]}
                  </div>
                )}
                <h2 className="text-lg font-bold text-white text-center">{headline}</h2>
                <p className="text-xs text-slate-400 mt-1 text-center">Please fill in your details to start chatting</p>
              </div>

              <div className="space-y-3">
                {prechatFields.map(field => (
                  <div key={field.id}>
                    <label className="text-xs font-medium text-slate-400 block mb-1">
                      {field.label}{field.required && <span className="text-red-400 ml-0.5">*</span>}
                    </label>
                    {field.type === 'select' ? (
                      <select
                        value={prechatValues[field.id] || ''}
                        onChange={e => { setPrechatValues(prev => ({ ...prev, [field.id]: e.target.value })); setPrechatErrors(prev => ({ ...prev, [field.id]: false })); }}
                        className={`w-full bg-slate-800 border rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none ${prechatErrors[field.id] ? 'border-red-500' : 'border-slate-700 focus:border-indigo-500'}`}>
                        <option value="">Select…</option>
                        <option>Billing question</option>
                        <option>Technical issue</option>
                        <option>Account help</option>
                        <option>General inquiry</option>
                      </select>
                    ) : (
                      <input
                        type={field.type}
                        value={prechatValues[field.id] || ''}
                        onChange={e => { setPrechatValues(prev => ({ ...prev, [field.id]: e.target.value })); setPrechatErrors(prev => ({ ...prev, [field.id]: false })); }}
                        placeholder={field.label}
                        className={`w-full bg-slate-800 border rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-600 focus:outline-none ${prechatErrors[field.id] ? 'border-red-500' : 'border-slate-700 focus:border-indigo-500'}`}
                      />
                    )}
                    {prechatErrors[field.id] && <p className="text-xs text-red-400 mt-1">{field.label} is required</p>}
                  </div>
                ))}
              </div>

              <button
                onClick={submitPrechat}
                className="mt-5 w-full py-3 text-sm font-semibold text-white rounded-xl transition-all hover:opacity-90"
                style={{ backgroundColor: brandColor }}>
                Start Chat
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Main chat view ─────────────────────────────────────────────
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
        <div className="flex items-center gap-3">
          {customerIdentity && (
            <div className="text-xs text-slate-500">Chatting as <span className="text-slate-300">{customerIdentity.name}</span></div>
          )}
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
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-5">
        {messages.map((m) => {
          const isAttachmentMsg = /^\[Attachment: .+\]$/.test(m.text);
          const isImageMsg = isAttachmentMsg && m.isImageAttachment;
          const isFileMsg = isAttachmentMsg && !isImageMsg;
          const attachDataUrl = messageAttachments[m.id];

          return (
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

                {isImageMsg && attachDataUrl ? (
                  <div className="rounded-2xl rounded-br-sm overflow-hidden">
                    <img src={attachDataUrl} alt={m.text} className="max-w-full max-h-64 object-cover rounded-2xl" />
                  </div>
                ) : isFileMsg ? (
                  <div className="bg-slate-800 rounded-lg px-3 py-2 flex items-center gap-2">
                    <span className="text-lg">📄</span>
                    <div>
                      <div className="text-xs text-white font-medium">
                        {m.text.replace(/^\[Attachment: (.+) \(.+\)\]$/, '$1')}
                      </div>
                    </div>
                  </div>
                ) : (
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
                )}

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

                {/* CSAT rating */}
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
          );
        })}

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
          <>
            {/* Attachment previews */}
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {attachments.map((att, idx) => (
                  <div key={idx} className="relative group">
                    {att.type.startsWith('image/') ? (
                      <div className="relative">
                        <img src={att.dataUrl} alt={att.name}
                          className="w-10 h-10 rounded-lg object-cover border border-slate-700" />
                        <button onClick={() => removeAttachment(idx)}
                          className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-slate-700 hover:bg-red-600 text-white text-[10px] flex items-center justify-center transition-colors">
                          ✕
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 pr-6 relative">
                        <span className="text-sm">📄</span>
                        <div className="min-w-0">
                          <div className="text-xs text-white truncate max-w-24">{att.name}</div>
                          <div className="text-[10px] text-slate-500">{formatBytes(att.size)}</div>
                        </div>
                        <button onClick={() => removeAttachment(idx)}
                          className="absolute top-0.5 right-1 text-slate-500 hover:text-red-400 text-xs transition-colors">
                          ✕
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2 items-end">
              {/* Hidden file input */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,.pdf,.doc,.docx,.txt,.csv"
                multiple
                className="hidden"
                onChange={handleFileChange}
              />
              {/* Paperclip button */}
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex-shrink-0 w-10 h-10 rounded-xl border border-slate-700 hover:border-slate-500 bg-slate-800 hover:bg-slate-700 flex items-center justify-center text-slate-400 hover:text-white transition-all"
                title="Attach file"
              >
                📎
              </button>
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKey}
                placeholder="Type your message…"
                rows={2}
                className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 resize-none transition-all"
              />
              <button
                onClick={send}
                disabled={loading || (!input.trim() && attachments.length === 0)}
                className="px-5 py-3 rounded-xl text-white text-sm font-medium disabled:opacity-40 transition-all flex-shrink-0"
                style={{ backgroundColor: accentColor }}
              >
                {loading ? '…' : 'Send'}
              </button>
            </div>
          </>
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
