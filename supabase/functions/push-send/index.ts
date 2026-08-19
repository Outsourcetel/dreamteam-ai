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

type Sub = { id: string; endpoint: string; p256dh: string; auth_key: string };

/** Send one payload to every device, pruning the ones the push service says are
 *  gone. Shared by both senders (a decision, and a system alert) so a fix to
 *  delivery or pruning can never apply to only one of them. */
async function deliver(
  admin: ReturnType<typeof createClient>,
  subs: Sub[],
  payload: string,
): Promise<{ sent: number; pruned: number; failed: number }> {
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
  return { sent, pruned, failed };
}

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

  let body: { task_id?: string; tenant_id?: string; alert_id?: string };
  try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
  // Two senders, one delivery path. A decision waiting on a person and a system
  // that has broken are both "a human needs to know", and the review found the
  // second one reaching nobody for twenty days (register C-8) while the first
  // one had a working phone the whole time. Rather than build a second pinger,
  // this endpoint accepts either an alert_id or a task_id and shares everything
  // below — subscription lookup, delivery, dead-device pruning.
  if (!body.alert_id && (!body.task_id || !body.tenant_id)) {
    return json({ error: 'task_id and tenant_id, or alert_id, required' }, 400);
  }

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // ── Alert branch (C-8) ───────────────────────────────────────────────────
  // ops_alerts has no tenant_id COLUMN, but every alert raised in production
  // carries one in its detail (measured: 133 of 133 unresolved). Routing on
  // that keeps this generic — an alert reaches the workspace it belongs to,
  // with no tenant hardcoded anywhere.
  if (body.alert_id) {
    const { data: alert, error: alertErr } = await admin.from('ops_alerts')
      .select('id, kind, message, detail, resolved_at')
      .eq('id', body.alert_id).maybeSingle();
    if (alertErr) { console.error('push-send alert read:', alertErr.message); return json({ error: 'alert_read_failed' }, 500); }
    if (!alert) return json({ error: 'alert_not_found' }, 404);
    // Raced: resolved between insert and ping. Same reasoning as a task that
    // was decided — a ping about a fixed thing is noise.
    if (alert.resolved_at) return json({ ok: true, skipped: 'already_resolved' });

    const alertTenant = (alert.detail as { tenant_id?: string } | null)?.tenant_id ?? null;
    if (!alertTenant) return json({ ok: true, sent: 0, note: 'alert carries no tenant to route to' });

    const { data: aSubs, error: aSubErr } = await admin.from('push_subscriptions')
      .select('id, endpoint, p256dh, auth_key').eq('tenant_id', alertTenant);
    if (aSubErr) { console.error('push-send subs read:', aSubErr.message); return json({ error: 'subs_read_failed' }, 500); }
    if (!aSubs || aSubs.length === 0) return json({ ok: true, sent: 0, note: 'no devices registered' });

    const alertPayload = JSON.stringify({
      title: `Something needs attention: ${String(alert.kind ?? '').replace(/_/g, ' ').slice(0, 70)}`,
      body: String(alert.message ?? '').slice(0, 140),
      url: '/m',
    });
    const r = await deliver(admin, aSubs, alertPayload);
    console.log(`push-send alert=${alert.id} kind=${alert.kind} sent=${r.sent} pruned=${r.pruned} failed=${r.failed}`);
    return json({ ok: true, ...r });
  }

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

  const { sent, pruned, failed } = await deliver(admin, subs, payload);
  console.log(`push-send task=${task.id} sent=${sent} pruned=${pruned} failed=${failed}`);
  return json({ ok: true, sent, pruned, failed });
});
