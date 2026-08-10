// ── push-send — one decision, every registered device, instantly ───────────
// Called by the mig-670 trigger (net.http_post) the moment a pending
// human_task is inserted. Spec: docs/superpowers/specs/
// 2026-08-10-push-notifications-design.md.
//
// Contract:
//   · Auth is the dispatch secret — the same one every cron dispatcher
//     carries. No secret, no service. (verify_jwt=false at deploy; the anon
//     bearer only gets the request through the gateway.)
//   · Recipients: the task's assigned user if routing assigned one, else
//     every subscribed device in the tenant. A subscription only ever comes
//     from /m (APPROVALS-gated), so its existence is an authorization claim.
//   · Best-effort, never silent: every failed send logs; a push service
//     saying the device is GONE (404/410) deletes that subscription — a
//     dead phone must not be pinged forever.
//   · Founder's noise policy, implemented literally: one ping per task, all
//     types, no collapsing, no quiet hours.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import webpush from 'npm:web-push@3.6.7';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const TITLE_BY_TYPE: Record<string, string> = {
  action_approval: 'Approve',
  approval_gate: 'Approve',
  escalation: 'Needs you',
  review_gate: 'Review',
  knowledge_revision: 'Review',
  inquiry_review: 'Review',
  trust_promotion: 'Decide',
};

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const dispatchSecret = Deno.env.get('PLAYBOOK_DISPATCH_SECRET') ?? '';
  const headerSecret = req.headers.get('x-dispatch-secret') ?? '';
  if (!dispatchSecret || headerSecret !== dispatchSecret) return json({ error: 'unauthorized' }, 401);

  const vapidPublic = Deno.env.get('VAPID_PUBLIC_KEY') ?? '';
  const vapidPrivate = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
  const vapidSubject = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:ops@dreamteam.local';
  if (!vapidPublic || !vapidPrivate) {
    console.error('push-send: VAPID keys not configured');
    return json({ error: 'vapid_unconfigured' }, 503);
  }
  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

  let body: { task_id?: string; tenant_id?: string };
  try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
  if (!body.task_id || !body.tenant_id) return json({ error: 'task_id and tenant_id required' }, 400);

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const { data: task, error: taskErr } = await admin.from('human_tasks')
    .select('id, tenant_id, type, title, detail, assigned_user_id, status')
    .eq('id', body.task_id).eq('tenant_id', body.tenant_id).maybeSingle();
  if (taskErr) { console.error('push-send task read:', taskErr.message); return json({ error: 'task_read_failed' }, 500); }
  if (!task) return json({ error: 'task_not_found' }, 404);
  // Raced: decided between insert and ping → say nothing. A ping for a task
  // that no longer needs anyone is noise with a deep link to confusion.
  if (task.status !== 'pending') return json({ ok: true, skipped: 'already_decided' });

  let q = admin.from('push_subscriptions')
    .select('id, endpoint, p256dh, auth_key')
    .eq('tenant_id', task.tenant_id);
  if (task.assigned_user_id) q = q.eq('user_id', task.assigned_user_id);
  const { data: subs, error: subErr } = await q;
  if (subErr) { console.error('push-send subs read:', subErr.message); return json({ error: 'subs_read_failed' }, 500); }
  if (!subs || subs.length === 0) return json({ ok: true, sent: 0, note: 'no devices registered' });

  const payload = JSON.stringify({
    title: `${TITLE_BY_TYPE[task.type] ?? 'Decide'}: ${String(task.title ?? '').slice(0, 90)}`,
    body: String(task.detail ?? '').slice(0, 140),
    url: '/m',
  });

  let sent = 0, pruned = 0, failed = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } },
        payload,
      );
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode ?? 0;
      if (code === 404 || code === 410) {
        // The push service says this device is gone. Deleting is the honest
        // response — a dead phone must not be pinged forever.
        const { error: delErr } = await admin.from('push_subscriptions').delete().eq('id', s.id);
        if (delErr) console.error('push-send prune:', delErr.message); else pruned++;
      } else {
        failed++;
        console.error(`push-send delivery failed (${code || 'no status'}):`, String(e).slice(0, 200));
      }
    }
  }
  console.log(`push-send task=${task.id} sent=${sent} pruned=${pruned} failed=${failed}`);
  return json({ ok: true, sent, pruned, failed });
});
