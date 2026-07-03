/**
 * DreamTeam AI — embeddable "Ask Alex" widget (no build step, no dependencies).
 *
 * Usage:
 *   <script src="https://YOUR-DREAMTEAM-HOST/widget.js"></script>
 *   <script>
 *     DreamTeamWidget.init({
 *       key: 'dtw_...',                                  // publishable widget key
 *       apiUrl: 'https://<ref>.supabase.co/functions/v1/widget-ask',
 *       accountRef: 'acct-4821',                         // your customer's account id
 *       endUserRef: 'user-77',                           // the employee asking
 *       displayName: 'Jane Doe',
 *       accent: '#6366f1',                               // optional brand colour
 *     });
 *   </script>
 */
(function () {
  'use strict';

  var state = { cfg: null, open: false, busy: false, conversationId: null, els: {} };

  function h(tag, style, text) {
    var el = document.createElement(tag);
    if (style) el.style.cssText = style;
    if (text) el.textContent = text;
    return el;
  }

  var BASE_FONT = 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';

  function addMessage(role, text, meta) {
    var wrap = h('div', 'display:flex;margin:6px 12px;' + (role === 'user' ? 'justify-content:flex-end;' : 'justify-content:flex-start;'));
    var accent = state.cfg.accent;
    var bubble = h('div',
      'max-width:80%;padding:9px 12px;border-radius:14px;font-size:13px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word;' +
      (role === 'user'
        ? 'background:' + accent + ';color:#fff;border-bottom-right-radius:4px;'
        : 'background:#f1f3f6;color:#1a202c;border-bottom-left-radius:4px;'),
      text);
    wrap.appendChild(bubble);
    state.els.messages.appendChild(wrap);
    if (meta) {
      var m = h('div', 'margin:2px 14px 4px;font-size:10.5px;color:#8a94a3;text-align:left;', meta);
      state.els.messages.appendChild(m);
    }
    state.els.messages.scrollTop = state.els.messages.scrollHeight;
    return bubble;
  }

  function setBusy(b) {
    state.busy = b;
    state.els.send.disabled = b;
    state.els.send.style.opacity = b ? '0.5' : '1';
    state.els.input.disabled = b;
  }

  function ask(question) {
    var cfg = state.cfg;
    addMessage('user', question);
    setBusy(true);
    var thinking = addMessage('assistant', 'Thinking…');

    fetch(cfg.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        widget_key: cfg.key,
        question: question,
        account_ref: cfg.accountRef || null,
        end_user_ref: cfg.endUserRef || null,
        display_name: cfg.displayName || null,
        conversation_id: state.conversationId,
      }),
    })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (res) {
        var j = res.body || {};
        if (j.conversation_id) state.conversationId = j.conversation_id;
        if (j.error === 'llm_not_configured') {
          thinking.textContent = "The assistant isn't activated yet. Please contact support directly.";
        } else if (j.error === 'invalid_widget_key') {
          thinking.textContent = 'This widget is not configured correctly (invalid key).';
        } else if (j.error === 'rate_limited') {
          thinking.textContent = "We're getting a lot of questions right now — please try again in a minute.";
        } else if (j.error) {
          thinking.textContent = 'Something went wrong. Please try again.';
        } else {
          thinking.textContent = j.answer || '…';
          var metaParts = [];
          if (typeof j.confidence === 'number' && j.confidence > 0) metaParts.push('Confidence ' + j.confidence + '%');
          if (j.needs_escalation) metaParts.push('Escalated to the team — a human will follow up');
          if (metaParts.length) {
            var m = h('div', 'margin:2px 14px 4px;font-size:10.5px;color:' + (j.needs_escalation ? '#d97706' : '#8a94a3') + ';', metaParts.join(' · '));
            state.els.messages.appendChild(m);
          }
        }
        state.els.messages.scrollTop = state.els.messages.scrollHeight;
      })
      .catch(function () {
        thinking.textContent = 'Network error — please try again.';
      })
      .then(function () { setBusy(false); state.els.input.focus(); });
  }

  function submit() {
    var q = state.els.input.value.trim();
    if (!q || state.busy) return;
    state.els.input.value = '';
    ask(q);
  }

  function togglePanel() {
    state.open = !state.open;
    state.els.panel.style.display = state.open ? 'flex' : 'none';
    state.els.button.textContent = state.open ? '×' : '?';
    if (state.open) state.els.input.focus();
  }

  function build() {
    var cfg = state.cfg;
    var root = h('div', 'position:fixed;bottom:20px;right:20px;z-index:2147483000;' + BASE_FONT);

    // Floating button
    var btn = h('button',
      'width:56px;height:56px;border-radius:50%;border:none;cursor:pointer;background:' + cfg.accent +
      ';color:#fff;font-size:26px;line-height:1;box-shadow:0 4px 14px rgba(0,0,0,0.25);display:flex;align-items:center;justify-content:center;', '?');
    btn.setAttribute('aria-label', 'Ask ' + cfg.assistantName);
    btn.onclick = togglePanel;

    // Panel
    var panel = h('div',
      'position:absolute;bottom:70px;right:0;width:340px;max-width:calc(100vw - 40px);height:460px;max-height:calc(100vh - 120px);' +
      'background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,0.28);display:none;flex-direction:column;overflow:hidden;');

    var header = h('div', 'padding:13px 16px;background:' + cfg.accent + ';color:#fff;');
    header.appendChild(h('div', 'font-size:14px;font-weight:600;', 'Ask ' + cfg.assistantName));
    header.appendChild(h('div', 'font-size:11px;opacity:0.85;margin-top:1px;', 'AI support assistant'));
    panel.appendChild(header);

    var messages = h('div', 'flex:1;overflow-y:auto;padding:8px 0;background:#fafbfc;');
    panel.appendChild(messages);

    var inputRow = h('div', 'display:flex;gap:8px;padding:10px;border-top:1px solid #e6e9ee;background:#fff;');
    var input = h('input', 'flex:1;border:1px solid #d5dae2;border-radius:10px;padding:9px 12px;font-size:13px;outline:none;color:#1a202c;background:#fff;' + BASE_FONT);
    input.placeholder = 'Ask a question…';
    input.onkeydown = function (e) { if (e.key === 'Enter') submit(); };
    var send = h('button', 'border:none;border-radius:10px;padding:0 14px;cursor:pointer;background:' + cfg.accent + ';color:#fff;font-size:13px;font-weight:600;' + BASE_FONT, 'Send');
    send.onclick = submit;
    inputRow.appendChild(input);
    inputRow.appendChild(send);
    panel.appendChild(inputRow);

    root.appendChild(panel);
    root.appendChild(btn);
    document.body.appendChild(root);

    state.els = { root: root, button: btn, panel: panel, messages: messages, input: input, send: send };

    addMessage('assistant',
      'Hi' + (cfg.displayName ? ' ' + cfg.displayName : '') + '! I’m ' + cfg.assistantName +
      ', the AI support assistant. Ask me anything about the product.');
  }

  window.DreamTeamWidget = {
    init: function (cfg) {
      if (!cfg || !cfg.key || !cfg.apiUrl) {
        console.error('[DreamTeamWidget] init requires { key, apiUrl }');
        return;
      }
      if (state.cfg) return; // already initialised
      state.cfg = {
        key: cfg.key,
        apiUrl: cfg.apiUrl,
        accountRef: cfg.accountRef || null,
        endUserRef: cfg.endUserRef || null,
        displayName: cfg.displayName || null,
        accent: cfg.accent || '#6366f1',
        assistantName: cfg.assistantName || 'Alex',
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', build);
      } else {
        build();
      }
    },
  };
})();
