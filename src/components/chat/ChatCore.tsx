import React, { useCallback, useEffect, useRef, useState } from 'react';
import { askWidget, askWidgetStream, submitWidgetCsat, pollWidget, type WidgetAskResult } from '../../lib/widgetChatApi';
import { speechProvider, resolveSpeechProvider, type SpeechProvider } from '../../lib/speech';

// The shared, premium customer-support chat surface. INFRASTRUCTURE ONLY —
// it renders whatever the DE (via widget-ask) decides: live token-streamed
// answers (SSE, guardrail-buffered server-side; typewriter fallback for
// non-streamed replies), inline sources, a holding state when a reply is
// drafting for a human, CSAT, and free browser voice. Zero answer logic.

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
    <div className="max-w-[85%] self-start cc-in">
      <div className="rounded-2xl rounded-tl-sm bg-white/[0.06] text-slate-100 border border-white/10 backdrop-blur-md px-4 py-2.5 text-[15px] leading-relaxed shadow-[0_2px_20px_-8px_rgba(0,0,0,0.6)] whitespace-pre-wrap">
        {shown || <span className="inline-flex gap-1 py-1">{[0, 1, 2].map(i => (
          <span key={i} className="w-1.5 h-1.5 rounded-full bg-indigo-300/70 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
        ))}</span>}
      </div>
      {msg.needsHuman && (
        <div className="mt-1.5 text-[11px] text-indigo-300 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" /> A teammate will follow up here
        </div>
      )}
      {msg.sources && msg.sources.length > 0 && shown === msg.full && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {msg.sources.slice(0, 4).map((s, i) => (
            <span key={i} className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-200 border border-indigo-400/20">{s}</span>
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
  // True once the conversation is in draft/holding mode (a human is reviewing
  // or replying) — subsequent turns skip streaming and use the JSON path.
  const holdingRef = useRef(false);
  // Voice: browser by default; upgrades to premium if the relay reports a key.
  const [voice, setVoice] = useState<SpeechProvider>(speechProvider);
  useEffect(() => { resolveSpeechProvider(widgetKey).then(setVoice).catch(() => {}); }, [widgetKey]);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }, [messages]);

  // Live receive: poll for delivered messages the customer didn't request —
  // an approved draft or a human reply from the support inbox. Dedupes by id.
  useEffect(() => {
    if (!conversationId) return;
    let alive = true;
    const tick = async () => {
      // A failed poll (network blip) must not surface as an unhandled
      // rejection every 5s — quietly retry on the next interval.
      let r: Awaited<ReturnType<typeof pollWidget>>;
      try { r = await pollWidget(widgetKey, conversationId); } catch { return; }
      if (!alive) return;
      const fresh = r.messages.filter(m => !seenIds.current.has(m.id));
      if (fresh.length) {
        fresh.forEach(m => seenIds.current.add(m.id));
        setMessages(prev => [...prev, ...fresh.map(m => ({ id: nextId(), role: 'assistant' as const, full: m.content, animate: true }))]);
        if (voiceMode && voice.ttsSupported) fresh.forEach(m => voice.speak(m.content, lastLang));
      }
    };
    const iv = setInterval(() => { void tick(); }, 5000);
    return () => { alive = false; clearInterval(iv); };
  }, [conversationId, widgetKey, voiceMode, lastLang, voice]);

  const send = useCallback(async (text: string) => {
    const q = text.trim();
    if (!q || sending) return;
    setInput('');
    setCsat('idle');
    const userMsg: Msg = { id: nextId(), role: 'user', full: q };
    const placeholder: Msg = { id: nextId(), role: 'assistant', full: '', pending: true };
    setMessages(prev => [...prev, userMsg, placeholder]);
    setSending(true);

    // Shared final-result handling — identical semantics for the streamed
    // `final` event and the JSON response. `streamed` skips the typewriter
    // (the text already arrived live) but still replaces the bubble with the
    // canonical answer (the server holds back a tail buffer while streaming).
    const applyResult = (r: WidgetAskResult, streamed: boolean) => {
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
      holdingRef.current = r.delivery === 'draft_pending' || r.status === 'needs_human';
      setMessages(prev => prev.map(m => m.id === placeholder.id
        ? { ...m, full: answer, pending: false, animate: !streamed, sources: r.sources, delivery: r.delivery, needsHuman }
        : m));
      // Voice speaks on final only — never per-delta.
      if (voiceMode && voice.ttsSupported && r.delivery === "sent") voice.speak(answer, r.language);
      if (!needsHuman && !r.error && r.conversation_id) setTimeout(() => setCsat('shown'), 900);
    };

    try {
      // Stream when the conversation is NOT in draft/holding mode. The server
      // returns plain JSON for draft-mode DEs / cache hits (handled inside
      // askWidgetStream via onFinal); any stream failure falls back to the
      // JSON path below so nothing regresses.
      if (!holdingRef.current) {
        try {
          let streamed = false;
          await askWidgetStream(widgetKey, q, conversationId, {
            onDelta: (t) => {
              streamed = true;
              setMessages(prev => prev.map(m => m.id === placeholder.id
                ? { ...m, full: m.full + t, pending: false, animate: false }
                : m));
            },
            onBlocked: (msg) => {
              // Guardrail retraction: replace the ENTIRE bubble content.
              setMessages(prev => prev.map(m => m.id === placeholder.id
                ? { ...m, full: msg, pending: false, animate: false, delivery: 'blocked', needsHuman: true }
                : m));
            },
            onFinal: (r) => applyResult(r, streamed),
          }, { channel, accountRef, endUserRef, displayName });
          return;
        } catch {
          // Reset the bubble (partial deltas may have rendered), then fall
          // back to the battle-tested JSON call.
          setMessages(prev => prev.map(m => m.id === placeholder.id
            ? { ...m, full: '', pending: true, animate: false }
            : m));
        }
      }
      const r = await askWidget({ widgetKey, question: q, conversationId, channel, accountRef, endUserRef, displayName });
      applyResult(r, false);
    } catch {
      setMessages(prev => prev.map(m => m.id === placeholder.id
        ? { ...m, full: "I couldn't reach the server — please try again.", pending: false, animate: true, needsHuman: true }
        : m));
    } finally {
      setSending(false);
    }
  }, [widgetKey, conversationId, channel, accountRef, endUserRef, displayName, sending, voiceMode, voice]);

  const toggleMic = useCallback(() => {
    if (listening) { stopListenRef.current?.(); setListening(false); return; }
    if (!voice.sttSupported) return;
    setVoiceMode(true);
    setListening(true);
    stopListenRef.current = voice.startListening(
      (text) => { setListening(false); void send(text); },
      () => setListening(false),
      lastLang,
    );
  }, [listening, send, lastLang, voice]);

  const rateCsat = async (score: 1 | -1) => {
    setCsat('done');
    if (conversationId) await submitWidgetCsat(widgetKey, conversationId, score);
  };

  return (
    <div className={`relative flex flex-col h-full ${className ?? ''}`}>
      <style>{`
        @keyframes cc-in { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
        .cc-in{animation:cc-in .35s cubic-bezier(.2,.7,.3,1) both}
        @keyframes cc-spin { to{transform:rotate(360deg)} }
        @media (prefers-reduced-motion: reduce){ .cc-in{animation:none} }
      `}</style>

      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3.5 border-b border-white/10 bg-white/[0.03]">
        <div className="relative w-9 h-9 flex-shrink-0">
          <div className="absolute inset-0 rounded-full bg-gradient-to-br from-indigo-400 via-violet-500 to-cyan-400 blur-[6px] opacity-70" />
          <div className="relative w-9 h-9 rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-white flex items-center justify-center text-sm font-semibold ring-1 ring-white/20">
            {brandName.charAt(0).toUpperCase()}
          </div>
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-white truncate">{brandName}</p>
          <p className="text-[11px] text-emerald-300/90 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_2px_rgba(52,211,153,0.7)]" /> Online now
          </p>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-5 flex flex-col gap-3.5">
        {messages.map(m => m.role === 'user'
          ? (
            <div key={m.id} className="max-w-[85%] self-end cc-in">
              <div className="rounded-2xl rounded-tr-sm bg-gradient-to-br from-indigo-500 to-violet-600 text-white px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap shadow-[0_4px_20px_-6px_rgba(99,102,241,0.7)]">{m.full}</div>
            </div>
          )
          : <AssistantBubble key={m.id} msg={m} />)}

        {csat === 'shown' && (
          <div className="self-start flex items-center gap-2 text-[12px] text-slate-400 mt-1 cc-in">
            <span>Was this helpful?</span>
            <button onClick={() => rateCsat(1)} className="w-7 h-7 rounded-full bg-white/5 hover:bg-emerald-500/20 border border-white/10 text-slate-300 hover:text-emerald-300 transition-colors">👍</button>
            <button onClick={() => rateCsat(-1)} className="w-7 h-7 rounded-full bg-white/5 hover:bg-rose-500/20 border border-white/10 text-slate-300 hover:text-rose-300 transition-colors">👎</button>
          </div>
        )}
        {csat === 'done' && <div className="self-start text-[12px] text-slate-500">Thanks for the feedback!</div>}
      </div>

      {/* Composer */}
      <div className="border-t border-white/10 bg-white/[0.03] px-3 py-3">
        <div className="flex items-end gap-2">
          {voice.sttSupported && (
            <button
              onClick={toggleMic}
              aria-label={listening ? 'Stop listening' : 'Speak'}
              className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center transition-all ${listening ? 'bg-gradient-to-br from-indigo-500 to-violet-600 text-white scale-110 shadow-[0_0_20px_2px_rgba(99,102,241,0.7)] animate-pulse' : 'bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10'}`}
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
            className="flex-1 resize-none max-h-32 rounded-2xl bg-white/5 border border-white/10 px-4 py-2.5 text-[15px] text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-400/60 focus:ring-1 focus:ring-indigo-400/40"
          />
          <button
            onClick={() => void send(input)}
            disabled={sending || !input.trim()}
            className="flex-shrink-0 w-10 h-10 rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-white flex items-center justify-center disabled:opacity-40 disabled:shadow-none shadow-[0_4px_20px_-4px_rgba(99,102,241,0.8)] hover:brightness-110 transition-all"
            aria-label="Send"
          >
            {sending ? <span className="inline-block w-4 h-4 rounded-full border-2 border-white/40 border-t-white" style={{ animation: 'cc-spin .7s linear infinite' }} /> : '↑'}
          </button>
        </div>
        <p className="text-[10px] text-slate-500 text-center mt-2.5">AI-assisted support · answers in your language</p>
      </div>
    </div>
  );
}
