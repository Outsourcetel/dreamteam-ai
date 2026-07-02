// Supabase Edge Function: send-alert
// Sends email notifications for escalations, budget warnings, etc.
// Reads Resend API key from platform_config table (service-role only).
// Deploy: supabase functions deploy send-alert

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json();
    const { tenant_id, type, payload } = body as {
      tenant_id: string;
      type: 'escalation_alert' | 'budget_warning' | 'csat_negative' | 'de_outbound';
      payload: Record<string, string>;
    };

    if (!tenant_id || !type) {
      return new Response(JSON.stringify({ error: 'missing tenant_id or type' }), { status: 400, headers: corsHeaders });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Read Resend key + alert email from platform_config
    const { data: configs } = await supabase
      .from('platform_config')
      .select('key, value')
      .in('key', ['RESEND_API_KEY', `alert_email_${tenant_id}`, 'alert_email']);

    const configMap: Record<string, string> = {};
    (configs ?? []).forEach((c: { key: string; value: string }) => { configMap[c.key] = c.value; });

    const resendKey = configMap['RESEND_API_KEY'];
    const alertEmail = configMap[`alert_email_${tenant_id}`] || configMap['alert_email'];

    // Handle de_outbound separately — uses to_email from payload, not alertEmail
    if (type === 'de_outbound') {
      const subject = payload.subject || 'Message from our team';
      const html = `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
    <p style="color:#334155">${(payload.body || '').replace(/\n/g, '<br>')}</p>
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
    <p style="color:#94a3b8;font-size:12px">Sent by your AI assistant · To unsubscribe reply STOP</p>
  </div>`;
      const toEmail = payload.to_email;
      if (!resendKey || !toEmail) {
        await supabase.from('notifications').insert({ tenant_id, type, status: 'pending', payload });
        return new Response(JSON.stringify({ ok: true, sent: false, reason: 'no_config' }), { headers: corsHeaders });
      }
      const sendRes2 = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'DreamTeam AI <alerts@dreamteam.ai>', to: [toEmail], subject, html }),
      });
      const sendData2 = await sendRes2.json();
      await supabase.from('notifications').insert({ tenant_id, type, status: sendRes2.ok ? 'sent' : 'failed', payload: { ...payload, resend_response: sendData2 }, sent_at: sendRes2.ok ? new Date().toISOString() : null });
      return new Response(JSON.stringify({ ok: true, sent: sendRes2.ok, id: sendData2.id }), { headers: corsHeaders });
    }

    if (!resendKey || !alertEmail) {
      // Log notification as pending — will be retried when email is configured
      await supabase.from('notifications').insert({
        tenant_id, type, status: 'pending', payload,
      });
      return new Response(JSON.stringify({ ok: true, sent: false, reason: 'no_email_config' }), { headers: corsHeaders });
    }

    // Build email content
    let subject = '';
    let html = '';

    if (type === 'escalation_alert') {
      subject = `[Action Required] Customer escalation — ${payload.customer_name || 'Customer'}`;
      html = `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto">
          <h2 style="color:#f59e0b">⚠ Customer Escalation</h2>
          <p>A customer conversation was escalated because the AI could not answer with sufficient confidence.</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0">
            <tr><td style="padding:8px;color:#64748b;width:140px">Customer</td><td style="padding:8px;font-weight:600">${payload.customer_name || 'Unknown'}</td></tr>
            <tr style="background:#f8fafc"><td style="padding:8px;color:#64748b">Question</td><td style="padding:8px">${payload.question || '—'}</td></tr>
            <tr><td style="padding:8px;color:#64748b">AI Confidence</td><td style="padding:8px">${payload.confidence ? payload.confidence + '%' : '—'}</td></tr>
            <tr style="background:#f8fafc"><td style="padding:8px;color:#64748b">Reason</td><td style="padding:8px">${payload.reason || '—'}</td></tr>
          </table>
          <a href="${payload.inbox_url || '#'}" style="display:inline-block;background:#6366f1;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600">Open Escalation Inbox →</a>
          <p style="color:#94a3b8;font-size:12px;margin-top:24px">Sent by DreamTeam AI · Reply to this email to contact support</p>
        </div>
      `;
    } else if (type === 'budget_warning') {
      subject = `[Warning] Token budget at ${payload.pct}% — ${payload.tenant_name}`;
      html = `<div style="font-family:sans-serif"><h2>Token Budget Warning</h2><p>Tenant <strong>${payload.tenant_name}</strong> has used ${payload.pct}% of their monthly token budget.</p></div>`;
    } else {
      subject = `Negative CSAT received`;
      html = `<div style="font-family:sans-serif"><h2>Negative Customer Rating</h2><p>A customer gave a thumbs-down rating on their conversation.</p></div>`;
    }

    // Send via Resend
    const sendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'DreamTeam AI <alerts@dreamteam.ai>',
        to: [alertEmail],
        subject,
        html,
      }),
    });

    const sendData = await sendRes.json();

    // Log to notifications table
    await supabase.from('notifications').insert({
      tenant_id, type,
      status: sendRes.ok ? 'sent' : 'failed',
      payload: { ...payload, resend_response: sendData },
      sent_at: sendRes.ok ? new Date().toISOString() : null,
    });

    return new Response(JSON.stringify({ ok: true, sent: sendRes.ok, id: sendData.id }), { headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
