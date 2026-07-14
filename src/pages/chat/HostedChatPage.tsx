import React from 'react';
import ChatCore from '../../components/chat/ChatCore';

// Public, unauthenticated hosted support-chat page. A tenant shares a URL
// like /chat?k=<publishable widget key> (optionally &brand=Acme). Renders
// the same ChatCore the embeddable widget uses. No app auth — the widget
// key is the auth, exactly like the embed.
export default function HostedChatPage() {
  const params = new URLSearchParams(window.location.search);
  const widgetKey = params.get('k') || params.get('key') || '';
  const brand = params.get('brand') || 'Support';

  if (!widgetKey) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-100 p-6">
        <div className="max-w-md text-center">
          <h1 className="text-lg font-semibold text-slate-800 mb-1">Chat link is missing its key</h1>
          <p className="text-sm text-slate-500">This support chat needs a valid link. Ask the team for the correct URL (it should include <code className="bg-slate-200 px-1 rounded">?k=…</code>).</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-100 to-slate-200 flex items-center justify-center p-0 sm:p-6">
      <div className="w-full h-screen sm:h-[min(90vh,760px)] sm:max-w-[440px] sm:rounded-2xl sm:shadow-2xl sm:shadow-slate-400/30 overflow-hidden bg-white">
        <ChatCore widgetKey={widgetKey} channel="hosted" brandName={brand} />
      </div>
    </div>
  );
}
