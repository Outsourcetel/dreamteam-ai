/**
 * DreamTeam AI — embeddable support chat widget (v2, no build step, no deps).
 *
 * Usage:
 *   <script src="https://YOUR-DREAMTEAM-HOST/widget.js"></script>
 *   <script>
 *     DreamTeamWidget.init({
 *       key: 'wk_...',                                   // publishable widget key
 *       apiUrl: 'https://<ref>.supabase.co/functions/v1/widget-ask', // optional
 *       accountRef: 'acct-4821', endUserRef: 'user-77', displayName: 'Jane Doe',
 *       brandName: 'Acme', greeting: 'Hi! How can I help?',
 *     });
 *   </script>
 *
 * INFRASTRUCTURE ONLY — renders whatever the DE (via widget-ask) decides:
 * typewriter answers, source chips, a "teammate will follow up" note when a
 * reply is drafting for a human, thumbs CSAT, free browser voice. No answer
 * logic here. Style-isolated via Shadow DOM.
 */
(function () {
  'use strict';
  if (window.DreamTeamWidget && window.DreamTeamWidget.__mounted) return;

  var DEFAULT_API = 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/widget-ask';
  var cfg = {};
  var conversationId = null;
  var csatDone = false;
  var listening = false, recog = null;
  var msgs, input, sendBtn, micBtn;

  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function scrollDown() { if (msgs) msgs.scrollTop = msgs.scrollHeight; }

  var STYLE = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}',
    '.launch{position:fixed;bottom:20px;right:20px;width:56px;height:56px;border-radius:50%;background:var(--acc);color:#fff;border:none;cursor:pointer;box-shadow:0 6px 24px rgba(79,70,229,.4);font-size:24px;z-index:2147483000;display:flex;align-items:center;justify-content:center;transition:transform .15s}',
    '.launch:hover{transform:scale(1.06)}',
    '.panel{position:fixed;bottom:88px;right:20px;width:380px;max-width:calc(100vw - 32px);height:min(600px,calc(100vh - 120px));background:#f8fafc;border-radius:16px;box-shadow:0 12px 48px rgba(15,23,42,.28);z-index:2147483000;display:none;flex-direction:column;overflow:hidden}',
    '.panel.open{display:flex}',
    '.head{display:flex;align-items:center;gap:10px;padding:14px 16px;background:#fff;border-bottom:1px solid #e2e8f0}',
    '.av{width:32px;height:32px;border-radius:50%;background:var(--acc);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:14px}',
    '.htitle{font-size:14px;font-weight:600;color:#1e293b;line-height:1.1}',
    '.hstatus{font-size:11px;color:#059669;display:flex;align-items:center;gap:4px;margin-top:2px}',
    '.dot{width:6px;height:6px;border-radius:50%;background:#10b981;display:inline-block}',
    '.close{margin-left:auto;background:none;border:none;color:#94a3b8;font-size:20px;cursor:pointer;line-height:1}',
    '.msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}',
    '.b{max-width:85%;padding:10px 14px;font-size:14px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word}',
    '.u{align-self:flex-end;background:var(--acc);color:#fff;border-radius:16px 16px 4px 16px}',
    '.a{align-self:flex-start;background:#fff;color:#334155;border:1px solid #e2e8f0;border-radius:16px 16px 16px 4px;box-shadow:0 1px 2px rgba(15,23,42,.04)}',
    '.note{align-self:flex-start;font-size:11px;color:#6366f1;margin-top:-6px;display:flex;align-items:center;gap:5px}',
    '.srcs{align-self:flex-start;display:flex;flex-wrap:wrap;gap:4px;margin-top:-6px}',
    '.src{font-size:10px;padding:2px 8px;border-radius:999px;background:#f1f5f9;color:#64748b;border:1px solid #e2e8f0}',
    '.typing{display:inline-flex;gap:4px}.typing span{width:6px;height:6px;border-radius:50%;background:#94a3b8;animation:tb 1s infinite}.typing span:nth-child(2){animation-delay:.15s}.typing span:nth-child(3){animation-delay:.3s}',
    '@keyframes tb{0%,80%,100%{opacity:.3}40%{opacity:1}}',
    '.csat{align-self:flex-start;display:flex;align-items:center;gap:8px;font-size:12px;color:#64748b}',
    '.csat button{width:28px;height:28px;border-radius:50%;border:1px solid #e2e8f0;background:#fff;cursor:pointer;font-size:13px}',
    '.foot{border-top:1px solid #e2e8f0;background:#fff;padding:10px 12px;display:flex;gap:8px;align-items:flex-end}',
    '.mic{flex:0 0 auto;width:38px;height:38px;border-radius:50%;border:none;background:#f1f5f9;color:#64748b;cursor:pointer;font-size:16px}',
    '.mic.on{background:var(--acc);color:#fff;animation:pulse 1s infinite}',
    '@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.08)}}',
    '.inp{flex:1;resize:none;max-height:96px;border:1px solid #cbd5e1;border-radius:18px;padding:9px 14px;font-size:14px;color:#1e293b;outline:none}',
    '.inp:focus{border-color:var(--acc)}',
    '.send{flex:0 0 auto;width:38px;height:38px;border-radius:50%;border:none;background:var(--acc);color:#fff;cursor:pointer;font-size:16px}',
    '.send:disabled{opacity:.4;cursor:default}',
    '.tag{text-align:center;font-size:10px;color:#94a3b8;padding:4px 0 2px}',
  ].join('');

  function addUser(text) { msgs.appendChild(el('div', { class: 'b u' }, esc(text))); scrollDown(); }
  function addTyping() {
    var t = el('div', { class: 'b a' }, '<span class="typing"><span></span><span></span><span></span></span>');
    msgs.appendChild(t); scrollDown(); return t;
  }
  function typewriter(node, text) {
    node.textContent = '';
    var i = 0, step = Math.max(1, Math.round(text.length / 80));
    var iv = setInterval(function () {
      i = Math.min(text.length, i + step);
      node.textContent = text.slice(0, i);
      scrollDown();
      if (i >= text.length) clearInterval(iv);
    }, 18);
  }

  function addAssistant(res) {
    var text = res.error
      ? (res.error === 'llm_not_configured' ? "I'm not fully set up to answer yet — please check back soon."
        : res.error === 'ai_budget_exceeded' ? "I'm briefly at capacity — a teammate will help you shortly."
        : "Something went wrong on my side — let me get a teammate to help.")
      : res.answer;
    var bubble = el('div', { class: 'b a' });
    msgs.appendChild(bubble);
    typewriter(bubble, text);
    var needsHuman = res.needs_escalation || res.status === 'needs_human' || res.delivery === 'draft_pending' || res.delivery === 'blocked';
    if (needsHuman) msgs.appendChild(el('div', { class: 'note' }, '<span class="dot" style="background:#6366f1"></span> A teammate will follow up here'));
    if (res.sources && res.sources.length) {
      var s = el('div', { class: 'srcs' });
      res.sources.slice(0, 4).forEach(function (x) { s.appendChild(el('span', { class: 'src' }, esc(x))); });
      msgs.appendChild(s);
    }
    if (cfg.voiceMode && res.delivery === 'sent' && 'speechSynthesis' in window) {
      try { speechSynthesis.speak(new SpeechSynthesisUtterance(text)); } catch (e) { /* noop */ }
    }
    if (!needsHuman && !res.error && res.conversation_id && !csatDone) setTimeout(showCsat, 800);
    scrollDown();
  }

  function showCsat() {
    var c = el('div', { class: 'csat' });
    c.appendChild(el('span', null, 'Was this helpful?'));
    ['👍', '👎'].forEach(function (emoji, idx) {
      var b = el('button', null, emoji);
      b.onclick = function () { rateCsat(idx === 0 ? 1 : -1, c); };
      c.appendChild(b);
    });
    msgs.appendChild(c); scrollDown();
  }
  function rateCsat(score, node) {
    csatDone = true;
    node.innerHTML = '<span style="color:#94a3b8">Thanks for the feedback!</span>';
    if (!conversationId) return;
    fetch(cfg.apiUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ widget_key: cfg.key, action: 'csat', conversation_id: conversationId, score: score }),
    }).catch(function () { /* noop */ });
  }

  function send() {
    var q = (input.value || '').trim();
    if (!q) return;
    input.value = ''; sendBtn.disabled = true; csatDone = false;
    addUser(q);
    var typing = addTyping();
    fetch(cfg.apiUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        widget_key: cfg.key, question: q, conversation_id: conversationId || undefined,
        channel: 'widget', account_ref: cfg.accountRef || undefined,
        end_user_ref: cfg.endUserRef || undefined, display_name: cfg.displayName || undefined,
      }),
    }).then(function (r) { return r.json(); }).then(function (res) {
      typing.remove();
      if (res.conversation_id) conversationId = res.conversation_id;
      addAssistant(res);
    }).catch(function () {
      typing.remove();
      addAssistant({ answer: "I couldn't reach the server — please try again.", needs_escalation: true });
    }).finally(function () { sendBtn.disabled = false; });
  }

  function toggleMic() {
    var R = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!R) return;
    if (listening) { try { recog.stop(); } catch (e) { /* noop */ } return; }
    cfg.voiceMode = true;
    recog = new R(); recog.interimResults = false; recog.maxAlternatives = 1;
    recog.onresult = function (e) { input.value = e.results[0][0].transcript; send(); };
    recog.onend = function () { listening = false; micBtn.className = 'mic'; };
    recog.onerror = function () { listening = false; micBtn.className = 'mic'; };
    try { recog.start(); listening = true; micBtn.className = 'mic on'; } catch (e) { /* noop */ }
  }

  function build() {
    var host = el('div');
    document.body.appendChild(host);
    var sh = host.attachShadow({ mode: 'open' });
    var style = el('style', null, STYLE);
    sh.appendChild(style);
    var acc = cfg.accent || '#4f46e5';

    var launch = el('button', { class: 'launch', 'aria-label': 'Chat with support', style: '--acc:' + acc }, '💬');
    var panel = el('div', { class: 'panel', style: '--acc:' + acc });
    var brand = cfg.brandName || 'Support';

    var head = el('div', { class: 'head' });
    head.appendChild(el('div', { class: 'av' }, esc(brand.charAt(0).toUpperCase())));
    var box = el('div');
    box.appendChild(el('div', { class: 'htitle' }, esc(brand)));
    box.appendChild(el('div', { class: 'hstatus' }, '<span class="dot"></span> Online now'));
    head.appendChild(box);
    var x = el('button', { class: 'close', 'aria-label': 'Close' }, '×');
    x.onclick = function () { panel.classList.remove('open'); };
    head.appendChild(x);
    panel.appendChild(head);

    msgs = el('div', { class: 'msgs' });
    msgs.appendChild(el('div', { class: 'b a' }, esc(cfg.greeting || 'Hi! How can I help you today?')));
    panel.appendChild(msgs);

    var foot = el('div', { class: 'foot' });
    if (window.SpeechRecognition || window.webkitSpeechRecognition) {
      micBtn = el('button', { class: 'mic', 'aria-label': 'Speak' }, '🎤');
      micBtn.onclick = toggleMic;
      foot.appendChild(micBtn);
    }
    input = el('textarea', { class: 'inp', rows: '1', placeholder: 'Type your message…' });
    input.onkeydown = function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
    foot.appendChild(input);
    sendBtn = el('button', { class: 'send', 'aria-label': 'Send' }, '↑');
    sendBtn.onclick = send;
    foot.appendChild(sendBtn);
    var wrap = el('div');
    wrap.appendChild(foot);
    wrap.appendChild(el('div', { class: 'tag' }, 'AI-assisted support · answers in your language'));
    panel.appendChild(wrap);

    launch.onclick = function () { panel.classList.toggle('open'); if (panel.classList.contains('open')) input.focus(); };
    sh.appendChild(launch);
    sh.appendChild(panel);
  }

  window.DreamTeamWidget = {
    __mounted: false,
    init: function (options) {
      if (window.DreamTeamWidget.__mounted) return;
      cfg = options || {};
      if (!cfg.key) { console.error('[DreamTeamWidget] init requires a { key }.'); return; }
      cfg.apiUrl = cfg.apiUrl || DEFAULT_API;
      window.DreamTeamWidget.__mounted = true;
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
      else build();
    },
  };
})();
