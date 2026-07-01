import React, { useState, useRef, useEffect } from 'react';
import { executeDE, type DEExecuteResult } from '../services/deExecutionService';

interface Message {
  role: 'user' | 'assistant';
  text: string;
  result?: DEExecuteResult;
  ts: string;
}

interface DETestPanelProps {
  tenantId: string;
  deId?: string;
  deName: string;
  accentColor?: string;
}

const ConfidenceBadge = ({ value, threshold }: { value: number; threshold: number }) => {
  const color = value >= threshold ? 'text-emerald-400 bg-emerald-400/10' : value >= threshold * 0.7 ? 'text-amber-400 bg-amber-400/10' : 'text-red-400 bg-red-400/10';
  return (
    <span className={`text-xs px-2 py-0.5 rounded font-mono font-medium ${color}`}>
      {value}% confidence
    </span>
  );
};

export const DETestPanel: React.FC<DETestPanelProps> = ({ tenantId, deId, deName, accentColor = '#6366f1' }) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');

    const userMsg: Message = { role: 'user', text, ts: new Date().toLocaleTimeString() };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);

    const result = await executeDE({ tenantId, deId, message: text });
    const assistantMsg: Message = {
      role: 'assistant',
      text: result.error ? `Error: ${result.error}` : result.response,
      result,
      ts: new Date().toLocaleTimeString(),
    };
    setMessages(prev => [...prev, assistantMsg]);
    setLoading(false);
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <div className="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold"
          style={{ backgroundColor: accentColor + '25', color: accentColor }}>
          {deName[0]}
        </div>
        <div>
          <div className="text-xs font-semibold text-white">Testing: {deName}</div>
          <div className="text-xs text-slate-500">Responses come from your knowledge base via Claude</div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto space-y-3 mb-3 min-h-0">
        {messages.length === 0 && (
          <div className="text-center py-8 text-slate-600 text-xs">
            Send a message to test how this DE responds using your knowledge base
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] space-y-1.5 ${m.role === 'user' ? 'items-end' : 'items-start'} flex flex-col`}>
              <div className={`px-3 py-2 rounded-xl text-xs leading-relaxed ${
                m.role === 'user'
                  ? 'text-white rounded-br-sm'
                  : 'bg-slate-800 text-slate-200 rounded-bl-sm'
              }`} style={m.role === 'user' ? { backgroundColor: accentColor } : {}}>
                {m.text}
              </div>

              {/* Metadata row for assistant messages */}
              {m.role === 'assistant' && m.result && !m.result.error && (
                <div className="flex flex-wrap items-center gap-1.5 px-1">
                  <ConfidenceBadge value={m.result.confidence} threshold={m.result.threshold} />
                  <span className={`text-xs px-2 py-0.5 rounded font-medium ${
                    m.result.status === 'answered'
                      ? 'text-emerald-400 bg-emerald-400/10'
                      : 'text-amber-400 bg-amber-400/10'
                  }`}>
                    {m.result.status === 'answered' ? '✓ answered' : '⚠ escalated to approvals'}
                  </span>
                  {m.result.search_mode && (
                    <span className="text-xs text-slate-600">
                      {m.result.search_mode === 'semantic' ? '⚛ semantic' : '≡ keyword'} · {m.result.chunks_found} chunks
                    </span>
                  )}
                  {m.result.model_used && (
                    <span className="text-xs text-slate-600">
                      {m.result.model_used.modelId.split('-').slice(0, 3).join('-')}
                      {m.result.escalated ? ' ↑ escalated' : ''}
                    </span>
                  )}
                  {m.result.routed_by === 'intent_router' && (
                    <span className="text-xs text-slate-600">auto-routed</span>
                  )}
                </div>
              )}

              {/* Sources */}
              {m.role === 'assistant' && m.result?.sources?.length > 0 && (
                <div className="px-1 space-y-0.5">
                  {m.result.sources.slice(0, 3).map((s, si) => (
                    <div key={si} className="flex items-center gap-1.5 text-xs text-slate-600">
                      <span className="text-slate-700">◈</span>
                      <span className="truncate">{s.title}</span>
                      <span className="text-slate-700 font-mono flex-shrink-0">{s.similarity}%</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="text-xs text-slate-700 px-1">{m.ts}</div>
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-slate-800 rounded-xl rounded-bl-sm px-3 py-2 text-xs text-slate-500">
              <span className="animate-pulse">{deName} is thinking…</span>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="flex gap-2">
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          placeholder="Ask something your knowledge base should cover…"
          rows={2}
          className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 resize-none"
        />
        <button
          onClick={send}
          disabled={loading || !input.trim()}
          className="px-4 rounded-xl text-white text-xs font-medium disabled:opacity-40 transition-all self-stretch"
          style={{ backgroundColor: accentColor }}
        >
          {loading ? '…' : '→'}
        </button>
      </div>
      <div className="text-xs text-slate-700 mt-1">
        Enter to send · Low-confidence responses auto-create an approval request
      </div>
    </div>
  );
};

export default DETestPanel;
