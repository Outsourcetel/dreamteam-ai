import React from 'react';
import ChatCore from '../../components/chat/ChatCore';

// Public, unauthenticated hosted support portal. A tenant shares a URL
// like /chat?k=<publishable widget key> (optionally &brand=Acme). Renders
// the same ChatCore the embeddable widget uses inside a futuristic,
// full-screen "aurora" shell. No app auth — the widget key is the auth,
// exactly like the embed. This IS the customer portal: link-accessible,
// immediately testable, nothing to log into.
export default function HostedChatPage() {
  const params = new URLSearchParams(window.location.search);
  const widgetKey = params.get('k') || params.get('key') || '';
  const brand = params.get('brand') || 'Support';

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#070816] text-slate-100 flex flex-col items-center justify-center p-0 sm:p-6">
      <PortalStyles />
      {/* Aurora field */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="hp-orb hp-orb-1" />
        <div className="hp-orb hp-orb-2" />
        <div className="hp-orb hp-orb-3" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_-10%,rgba(99,102,241,0.18),transparent_55%)]" />
        <div className="absolute inset-0 opacity-[0.04] hp-grid" />
      </div>

      {!widgetKey ? (
        <div className="relative z-10 max-w-md text-center px-6">
          <div className="mx-auto mb-5 w-14 h-14 rounded-2xl bg-white/5 border border-white/10 backdrop-blur-xl flex items-center justify-center text-2xl">🔑</div>
          <h1 className="text-lg font-semibold text-white mb-1.5">This chat link is missing its key</h1>
          <p className="text-sm text-slate-400 leading-relaxed">Ask the team for the correct URL — it should include{' '}
            <code className="bg-white/10 px-1.5 py-0.5 rounded text-slate-200">?k=…</code>.</p>
        </div>
      ) : (
        <div className="relative z-10 w-full h-[100dvh] sm:h-[min(88vh,780px)] sm:max-w-[460px] flex flex-col">
          {/* Ambient glow behind the card */}
          <div aria-hidden className="absolute -inset-4 rounded-[2rem] bg-gradient-to-b from-indigo-500/20 via-violet-500/10 to-transparent blur-2xl" />
          <div className="relative flex-1 min-h-0 overflow-hidden rounded-none sm:rounded-[1.75rem] border border-white/10 bg-white/[0.04] backdrop-blur-2xl shadow-[0_20px_80px_-20px_rgba(79,70,229,0.5)]">
            <ChatCore widgetKey={widgetKey} channel="hosted" brandName={brand} />
          </div>
          <p className="relative text-center text-[11px] text-slate-500 mt-3 hidden sm:block">
            Secured support portal · powered by <span className="text-slate-400">DreamTeam</span>
          </p>
        </div>
      )}
    </div>
  );
}

// Scoped keyframes for the aurora orbs + grid. Injected here so the public
// page needs no global CSS/Tailwind-config changes.
function PortalStyles() {
  return (
    <style>{`
      @keyframes hp-float-1 { 0%,100%{transform:translate(0,0) scale(1)} 50%{transform:translate(6%,4%) scale(1.08)} }
      @keyframes hp-float-2 { 0%,100%{transform:translate(0,0) scale(1)} 50%{transform:translate(-5%,6%) scale(1.12)} }
      @keyframes hp-float-3 { 0%,100%{transform:translate(0,0) scale(1)} 50%{transform:translate(4%,-6%) scale(1.06)} }
      .hp-orb{position:absolute;border-radius:9999px;filter:blur(80px);opacity:.55}
      .hp-orb-1{width:46vmax;height:46vmax;left:-12vmax;top:-14vmax;background:radial-gradient(circle,#6366f1,transparent 68%);animation:hp-float-1 18s ease-in-out infinite}
      .hp-orb-2{width:40vmax;height:40vmax;right:-12vmax;top:8vmax;background:radial-gradient(circle,#8b5cf6,transparent 68%);animation:hp-float-2 22s ease-in-out infinite}
      .hp-orb-3{width:38vmax;height:38vmax;left:20vmax;bottom:-18vmax;background:radial-gradient(circle,#22d3ee,transparent 70%);animation:hp-float-3 26s ease-in-out infinite}
      .hp-grid{background-image:linear-gradient(rgba(255,255,255,.6) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.6) 1px,transparent 1px);background-size:44px 44px}
      @media (prefers-reduced-motion: reduce){ .hp-orb{animation:none} }
    `}</style>
  );
}
