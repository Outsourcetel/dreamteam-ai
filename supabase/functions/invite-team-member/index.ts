/**
 * invite-team-member — the real backing for team invites (F3, 2026-07-09
 * adversarial audit fix).
 *
 * Found: useUsers.ts's invite() had no RPC at all (unlike its 5 siblings,
 * migrated to real SECURITY DEFINER RPCs in migration 065) — a raw
 * client-side signUp() + a second raw insert('profiles') as the INVITING
 * admin's own session, targeting a user_id that handle_new_user's trigger
 * already claimed. That insert has no legitimate path to succeed (unique
 * constraint collision, and no RLS policy anywhere permits one user to
 * create a profiles row for a different user_id), and the resulting error
 * was silently swallowed (`console.warn`, never surfaced). Even in a best
 * case, the invitee got a Math.random() temp password never emailed to
 * them, with no way to ever log in.
 *
 * A Postgres RPC cannot fix this on its own — creating an auth.users row
 * (and sending a real invite email) requires the Supabase Auth ADMIN API
 * (GoTrue), which only an edge function running with the service-role key
 * can reach. This function:
 *   1. Authenticates the caller and requires tenant_owner/tenant_admin.
 *   2. Calls admin.auth.admin.inviteUserByEmail() — creates the auth user
 *      AND sends Supabase's real transactional invite email with a real
 *      accept-invite link (far better than the old unminted temp password).
 *   3. handle_new_user()'s trigger fires as usual, inserting a profiles
 *      row with tenant_id=null, role='agent' (the same safe default every
 *      signup gets — migration 056's privilege-escalation fix untouched).
 *   4. This function then updates that SAME row, AS SERVICE ROLE (so RLS
 *      is a non-issue), to set tenant_id/role/department correctly —
 *      before the invitee ever logs in, so they land in a fully linked
 *      workspace the first time they accept.
 * No error is ever swallowed — every failure returns a real message the
 * frontend surfaces to the inviting admin.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

const VALID_ROLES = [
  'tenant_admin', 'tenant_manager', 'knowledge_manager', 'approver', 'tenant_user', 'read_only',
];

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const { email, full_name, role, department } = await req.json();
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return json({ error: 'a valid email is required' }, 400);
    }
    if (!full_name || typeof full_name !== 'string' || !full_name.trim()) {
      return json({ error: 'full_name is required' }, 400);
    }
    // Owner is deliberately not invitable here — matches update_team_
    // member_role's own restriction (065): ownership only moves via the
    // dedicated, current-owner-only transfer_tenant_ownership flow.
    if (!role || !VALID_ROLES.includes(role)) {
      return json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` }, 400);
    }

    // ── Auth: resolve the caller from their JWT ──
    const authHeader = req.headers.get('Authorization') ?? '';
    const jwt = authHeader.replace(/^Bearer\s+/i, '');
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401);

    const { data: callerProfile } = await admin
      .from('profiles')
      .select('tenant_id, role, full_name, is_active')
      .eq('user_id', userData.user.id)
      .single();
    if (!callerProfile?.tenant_id) return json({ error: 'not a member of any workspace' }, 403);
    if (!callerProfile.is_active) return json({ error: 'account is deactivated' }, 403);
    if (!['tenant_owner', 'tenant_admin'].includes(callerProfile.role)) {
      return json({ error: 'only workspace owners/admins can invite team members' }, 403);
    }
    const tenantId: string = callerProfile.tenant_id;

    // ── Create the auth user + send the real invite email ──
    const { data: inviteData, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(
      email.trim(),
      { data: { full_name: full_name.trim(), invited_to_tenant: tenantId } }
    );
    if (inviteErr || !inviteData?.user) {
      // Supabase returns a real, specific error here (e.g. "User already
      // registered") — surfaced verbatim, not swallowed.
      return json({ error: inviteErr?.message ?? 'invite failed' }, 400);
    }
    const newUserId = inviteData.user.id;

    // ── Link the new profile to this tenant with the right role.
    // handle_new_user's trigger already inserted a row (tenant_id=null,
    // role='agent') a moment ago — this UPDATE (service role, bypasses
    // RLS) is the actual fix: correcting it BEFORE the invitee ever logs
    // in, so they land in a fully linked workspace on first accept. ──
    const { error: linkErr } = await admin
      .from('profiles')
      .update({
        tenant_id: tenantId,
        role,
        department: department ?? '',
        invited_by: callerProfile.full_name ?? 'a workspace admin',
        is_active: true,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', newUserId)
      .is('tenant_id', null);
    if (linkErr) {
      return json({ error: `invite sent, but linking the account to this workspace failed: ${linkErr.message}` }, 500);
    }

    await admin.rpc('append_audit_event_internal', {
      p_tenant_id: tenantId,
      p_actor: callerProfile.full_name ?? 'a workspace admin',
      p_actor_type: 'human',
      p_action: `Invited ${full_name.trim()} (${email.trim()}) as ${role}`,
      p_category: 'config_change',
      p_detail: { kind: 'team_member_invited', user_id: newUserId, email: email.trim(), role, department: department ?? '' },
    });

    return json({ ok: true, user_id: newUserId, email: email.trim() });
  } catch (err) {
    console.error('invite-team-member error:', err);
    return json({ error: String(err) }, 500);
  }
});
