# Embedding the "Ask Alex" Widget

Let your customers' employees ask your Digital Employee questions from inside **your** product. End users need no accounts — they are traffic, not seats (see [SCALING-ARCHITECTURE.md](SCALING-ARCHITECTURE.md)).

## Embed snippet (6 lines)

```html
<script src="https://dreamteam-ai-five.vercel.app/widget.js"></script>
<script>
  DreamTeamWidget.init({
    key: 'dtw_YOUR_WIDGET_KEY',
    apiUrl: 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/widget-ask',
    accountRef: 'acct-4821', endUserRef: 'user-77', displayName: 'Jane Doe',
  });
</script>
```

## Config reference

| Option | Required | Description |
|---|---|---|
| `key` | yes | Publishable widget key from Settings → Widget & API. Shown once at generation. |
| `apiUrl` | yes | The DreamTeam public ask endpoint (`…/functions/v1/widget-ask`). |
| `accountRef` | no | Your identifier for the business customer (account) this end user belongs to. Enables per-account escalation context and analytics roll-up. |
| `endUserRef` | no | Your identifier for the individual employee asking. |
| `displayName` | no | Name shown in greetings and escalation tasks. |
| `accent` | no | Brand colour hex for the button/panel (default `#6366f1`). |
| `assistantName` | no | Rename the assistant (default `Alex`). |

## What the widget shows

- Answers with a **confidence** percentage.
- When confidence is low (or the DE asks for help), the answer is flagged **"Escalated to the team — a human will follow up"** and a task appears in your Workforce HQ human-tasks queue with the account and end-user context.
- If the AI engine isn't activated yet, end users see a friendly "The assistant isn't activated yet" message — never an error dump.

## Security note

The widget key is **publishable** — it is safe to ship in client-side code, like a Stripe publishable key. It is scope-limited: it can only *ask questions* through the widget endpoint. It cannot read conversations, knowledge, accounts, or any other data, and cannot modify anything. Keys are stored server-side only as SHA-256 hashes; revoke a key at any time in Settings → Widget & API and it stops working immediately. Requests are rate-limited per key.
