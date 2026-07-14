import React, { useCallback, useEffect, useRef, useState } from 'react';
import { askWidget, submitWidgetCsat, pollWidget, type WidgetAskResult } from '../../lib/widgetChatApi';
import { speechProvider } from '../../lib/speech';

// The shared, premium customer-support chat surface. INFRASTRUCTURE ONLY —
// it renders whatever the DE (via widget-ask) decides: streamed (typewriter)
// answers, inline sources, a holding state when a reply is drafting for a
// human, CSAT, and free browser voice. It contains zero answer logic.

export interface ChatCoreProps {
  widgetKey: string;
  channel?: 'widget' | 'hosted';
  brandName?: string;
  greeting?: string;
  accountRef?: string | null;
  endUserRef?: string | null;
  displayName?: string | null;
  className?: string;
}

interface Msg {
  id: string;
  role: 'user' | 'assistant';
  full: string;
  sources?: string[];
  delivery?: WidgetAskResult['delivery'];
  needsHuman?: boolean;
  pending?: boolean;   // still awaiting the network
  animate?: boolean;   // typewriter on first reveal
}

let idc = 0;
const nextId = () => `m${++idc}`;

function AssistantBubble({ msg, onDone }: { msg: Msg; onDone?: () => void }) {
  const [shown, setShown] = useState(msg.animate ? '' : msg.full);
  useEffect(() => {
    if (!msg.animate) { setShown(msg.full); return; }
    let i = 0;
    const step = Math.max(1, Math.round(msg.full.length / 90)); // ~90 frames total
    const t = setInterval(() => {
      i = Math.min(msg.full.length, i + step);
      setShown(msg.full.slice(0, i));
      if (i >= msg.full.length) { clearInterval(t); onDone?.(); }
    }, 16);
    return () => clearInterval(t);
  }, [msg.full, msg.animate]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="max-w-[85%] self-start">
      <div className="rounded-2xl rounded-tl-sm bg-white text-slate-800 px-4 py-2.5 text-[15px] leading-relaxed shadow-sm border border-slate-200/70 whitespace-pre-wrap">
        {shown || <span className="inline-flex gap-1 py-1">{[0, 1, 2].map(i => (
          <span key={i} className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
        ))}</span>}
      </div>
      {msg.needsHuman && (
        <div className="mt-1 text-[11px] text-indigo-500 flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" /> A teammate will follow up here
        </div>
      )}
      {msg.sources && msg.sources.length > 0 && shown === msg.full && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {msg.sources.slice(0, 4).map((s, i) => (
            <span key={i} className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200">{s}</span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ChatCore({
  widgetKey, channel = 'hosted', brandName = 'Support', greeting = 'Hi! How can I help you today?',
  accountRef, endUserRef, displayName, className,
}: ChatCoreProps) {
  const [messages, setMessages] = useState<Msg[]>([{ id: nextId(), role: 'assistant', full: greeting }]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  const [csat, setCsat] = useState<'idle' | 'shown' | 'done'>('idle');
  const [lastLang, setLastLang] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stopListenRef = useRef<(() => void) | null>(null);
  const seenIds = useRef<Set<string>>(new Set());

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }, [messages]);

  // Live receive: poll for delivered messages the customer didn't request —
  // an approved draft or a human reply from the support inbox. Dedupes by id.
  useEffect(() => {
    if (!conversationId) return;
    let alive = true;
    const tick = async () => {
      const r = await pollWidget(widgetKey, conversationId);
      if (!alive) return;
      const fresh = r.messages.filter(m => !seenIds.current.has(m.id));
      if (fresh.length) {
        fresh.forEach(m => seenIds.current.add(m.id));
        setMessages(prev => [...prev, ...fresh.map(m => ({ id: nextId(), role: 'assistant' as const, full: m.content, animate: true }))]);
        if (voiceMode && speechProvider.ttsSupported) fresh.forEach(m => speechProvider.speak(m.content, lastLang));
      }
    };
    const iv = setInterval(() => { void tick(); }, 5000);
    return () => { alive = false; clearInterval(iv); };
  }, [conversationId, widgetKey, voiceMode, lastLang]);

  const send = useCallback(async (text: string) => {
    const q = text.trim();
    if (!q || sending) return;
    setInput('');
    setCsat('idle');
    const userMsg: Msg = { id: nextId(), role: 'user', full: q };
    const placeholder: Msg = { id: nextId(), role: 'assistant', full: '', pending: true };
    setMessages(prev => [...prev, userMsg, placeholder]);
    setSending(true);
    try {
      const r = await askWidget({ widgetKey, question: q, conversationId, channel, accountRef, endUserRef, displayName });
      if (r.conversation_id) setConversationId(r.conversation_id);
      // Don't let the live poll re-show the answer we already rendered.
      if (r.message_id) seenIds.current.add(r.message_id);
      setLastLang(r.language ?? null);
      const answer = r.error
        ? (r.error === 'llm_not_configured' ? "I'm not fully set up to answer yet — please check back soon."
          : r.error === 'ai_budget_exceeded' ? "I'm briefly at capacity — a teammate will help you shortly."
          : "Something went wrong on my side — let me get a teammate to help.")
        : r.answer;
      const needsHuman = !!r.needs_escalation || r.status === 'needs_human' || r.delivery === 'draft_pending' || r.delivery === 'blocked';
      setMessages(prev => prev.map(m => m.id === placeholder.id
        ? { ...m, full: answer, pending: false, animate: true, sources: r.sources, delivery: r.delivery, needsHuman }
        : m));
      if (voiceMode && speechProvider.ttsSupported && r.delivery === 'sent') speechProvider.speak(answer, r.language);
      if (!needsHuman && !r.error && r.conversation_id) setTimeout(() => setCsat('shown'), 900);
    } catch {
      setMessages(prev => prev.map(m => m.id === placeholder.id
        ? { ...m, full: "I couldn't reach the server — please try again.", pending: false, animate: true, needsHuman: true }
        : m));
    } finally {
      setSending(false);
    }
  }, [widgetKey, conversationId, channel, accountRef, endUserRef, displayName, sending, voiceMode]);

  const toggleMic = useCallback(() => {
    if (listening) { stopListenRef.current?.(); setListening(false); return; }
    if (!speechProvider.sttSupported) return;
    setVoiceMode(true);
    setListening(true);
    stopListenRef.current = speechProvider.startListening(
      (text) => { setListening(false); void send(text); },
      () => setListening(false),
      lastLang,
    );
  }, [listening, send, lastLang]);

  const rateCsat = async (score: 1 | -1) => {
    setCsat('done');
    if (conversationId) await submitWidgetCsat(widgetKey, conversationId, score);
  };

  return (
    <div className={`flex flex-col h-full bg-slate-50 ${className ?? ''}`}>
      <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-200 bg-white">
        <div className="w-8 h-8 rounded-full bg-indigo-600 text-white flex items-center justify-center text-sm font-semibold">{brandName.charAt(0).toUpperCase()}</div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-800 truncate">{brandName}</p>
          <p className="text-[11px] text-emerald-600 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> Online now</p>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3">
        {messages.map(m => m.role === 'user'
          ? (
            <div key={m.id} className="max-w-[85%] self-end">
              <div className="rounded-2xl rounded-tr-sm bg-indigo-600 text-white px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap">{m.full}</div>
            </div>
          )
          : <AssistantBubble key={m.id} msg={m} />)}

        {csat === 'shown' && (
          <div className="self-start flex items-center gap-2 text-[12px] text-slate-500 mt-1">
            <span>Was this helpful?</span>
            <button onClick={() => rateCsat(1)} className="w-7 h-7 rounded-full hover:bg-emerald-50 border border-slate-200 text-slate-500 hover:text-emerald-600 transition-colors">👍</button>
            <button onClick={() => rateCsat(-1)} className="w-7 h-7 rounded-full hover:bg-rose-50 border border-slate-200 text-slate-500 hover:text-rose-600 transition-colors">👎</button>
          </div>
        )}
        {csat === 'done' && <div className="self-start text-[12px] text-slate-400">Thanks for the feedback!</div>}
      </div>

      <div className="border-t border-slate-200 bg-white px-3 py-3">
        <div className="flex items-end gap-2">
          {speechProvider.sttSupported && (
            <button
              onClick={toggleMic}
              aria-label={listening ? 'Stop listening' : 'Speak'}
              className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center transition-all ${listening ? 'bg-indigo-600 text-white scale-110 shadow-lg shadow-indigo-300 animate-pulse' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
            >
              {listening ? '●' : '🎤'}
            </button>
          )}
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); } }}
            placeholder={listening ? 'Listening…' : 'Type your message…'}
            rows={1}
            className="flex-1 resize-none max-h-32 rounded-2xl border border-slate-300 px-4 py-2.5 text-[15px] text-slate-800 placeholder-slate-400 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
          />
          <button
            onClick={() => void send(input)}
            disabled={sending || !input.trim()}
            className="flex-shrink-0 w-10 h-10 rounded-full bg-indigo-600 text-white flex items-center justify-center disabled:opacity-40 hover:bg-indigo-700 transition-colors"
            aria-label="Send"
          >
            ↑
          </button>
        </div>
        <p className="text-[10px] text-slate-400 text-center mt-2">AI-assisted support · answers in your language</p>
      </div>
    </div>
  );
}
