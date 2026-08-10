# Push Notifications — Design (approved 2026-08-10)

**Why.** The phone shell (`/m`) exists to attack the decision bottleneck — the certification review's verdict was "the bottleneck is human decisions; the surface is wired and starved." A decision surface nobody is told to open decides nothing. This puts every new decision on the founder's lock screen, tap-through to `/m`.

**Founder decisions (locked in brainstorm):**
- Platforms: **iPhone and Android both** → real Web Push, app made installable. iOS requires Add to Home Screen (Apple's rule); the UI detects Safari-not-installed and says exactly that.
- Noise policy: **every decision, one ping, instantly.** No burst-guard, no quiet hours in v1 (they would contradict "instantly"). Measured volume at decision time: ~6 escalations/day + ~4 money approvals/week.

## Mechanism (approach A — trigger → instant HTTP → send)

1. **`push_subscriptions`** (migration via `migrate:next`): one row per device — `tenant_id, user_id, endpoint (unique), p256dh, auth_key, ua, created_at, last_seen_at`. RLS: owner-only (`user_id = auth.uid()`) for ALL commands; the sender reads with service role. Subscriptions are created only from `/m`, which is APPROVALS-gated, so a subscription's existence is already an authorization statement.
2. **Trigger** `AFTER INSERT ON human_tasks` (`WHEN status='pending'`): `net.http_post` to `platform_fn_url('/functions/v1/push-send')` carrying `task_id` + `tenant_id`, using migration 640's exact idiom (anon Bearer + `x-dispatch-secret`). Fire-and-forget: a lost ping is a courtesy lost, never data — the task is still in `/m`. **No outbox, no cron, nothing to rot.**
3. **`push-send` edge function** (new file, no shared-function collision risk): verifies the dispatch secret; loads the task; recipients = **the assigned user if `assigned_user_id` is set, else every subscribed device in the tenant**; sends Web Push (`npm:web-push`, VAPID) with payload `{title: "Approve: <task title>" | "Escalation: …" by type, body: detail slice, url: "/m"}`; deletes subscriptions the push service reports gone (404/410). Logs every failure — best-effort, never silent.
4. **VAPID keys:** generated once; private half + subject stored as Supabase function secrets; public half is a frontend constant (public by design).
5. **Installability + client:** `public/manifest.webmanifest`, generated solid-brand PNG icons (192/512 + apple-touch-icon; replaceable with real brand art later), `public/sw.js` (show notification, focus-or-open `/m` on tap), `index.html` links. On `/m`: a Notifications block — one `size="touch"` button, per-device toggle with honest states: unsupported / iOS-Safari-not-installed (instruction shown) / permission denied (how to fix) / on (device registered, with "turn off on this device").

## Verification strategy
- Pure parts pinned by tests where they exist client-side (payload truncation lives edge-side; the client block is state rendering).
- Live proof without the founder's phone: insert a fake subscription with a dead endpoint + a test pending task → show trigger fired (`net._http_response` row), `push-send` attempted delivery, and pruned the dead subscription. Clean all test rows after, verified zero residue.
- The final hop — a real lock-screen ping — is the founder's: turn it on, I fire one test task.

## Out of scope (named)
- Burst-guard and quiet hours (contradict the chosen policy; one-line future change).
- Email fallback via Resend (not needed — both platforms get real push).
- Per-tenant branded icons (global DreamTeam icon v1; the brand-identity system could feed this later).
- Pings for parked-conversation returns (no task row exists; revisit if wanted).
