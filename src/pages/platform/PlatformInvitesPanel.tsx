import React, { useEffect, useState } from 'react';
import {
  invitePlatformTeamMember, listPlatformInvites, revokePlatformInvite,
  PLATFORM_INVITE_ROLE_LABELS, type PlatformInvite, type PlatformInviteRole,
} from '../../lib/api';

// ─────────────────────────────────────────────────────────────────
// Owner-controlled platform team invitations. Plain language throughout
// — this founder is non-technical. Email delivery is not depended on
// here (Resend domain verification still pending as of this build), so
// the invite code/link is shown directly with a copy button — the owner
// shares it themselves for now. Every invite is created/revoked through
// guarded RPCs (invite_platform_team_member / revoke_platform_invite),
// gated server-side to platform admins only.
// ─────────────────────────────────────────────────────────────────
const ROLE_OPTIONS: PlatformInviteRole[] = ['platform_support', 'platform_billing', 'platform_super_admin'];

const inviteLink = (code: string) => `${window.location.origin}/platform/redeem?code=${code}`;

const PlatformInvitesPanel = () => {
  const [invites, setInvites] = useState<PlatformInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<PlatformInviteRole>('platform_support');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [justCreated, setJustCreated] = useState<{ email: string; code: string } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    listPlatformInvites().then((rows) => { setInvites(rows); setLoading(false); });
  };

  useEffect(() => { load(); }, []);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError('');
    if (!email.trim()) { setCreateError('An email address is required.'); return; }
    setCreating(true);
    const res = await invitePlatformTeamMember(email.trim(), role);
    setCreating(false);
    if (!res.ok || !res.invite_code) {
      setCreateError(res.error || 'Could not create the invite.');
      return;
    }
    setJustCreated({ email: res.email || email.trim(), code: res.invite_code });
    setEmail('');
    load();
  };

  const handleRevoke = async (id: string) => {
    setBusyId(id);
    await revokePlatformInvite(id);
    setBusyId(null);
    load();
  };

  const copyToClipboard = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 2000);
    } catch { /* clipboard unavailable — user can still select/copy manually */ }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 mb-6">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-white">Your platform team</h2>
        <p className="text-xs text-slate-400 mt-0.5">
          The only way anyone else gets access to this platform. Invite someone you trust, share the link
          with them yourself, and revoke it any time before they use it.
        </p>
      </div>

      <form onSubmit={handleInvite} className="flex flex-col sm:flex-row gap-2 mb-4">
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          type="email"
          placeholder="teammate@company.com"
          className="flex-1 bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-3 py-2 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as PlatformInviteRole)}
          className="bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-500"
        >
          {ROLE_OPTIONS.map((r) => (
            <option key={r} value={r}>{PLATFORM_INVITE_ROLE_LABELS[r]}</option>
          ))}
        </select>
        <button
          type="submit"
          disabled={creating}
          className="px-4 py-2 rounded-xl text-white text-sm font-medium bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 transition-all whitespace-nowrap"
        >
          {creating ? 'Creating…' : 'Send invite'}
        </button>
      </form>
      {createError && <p className="text-xs text-red-400 mb-3">{createError}</p>}

      {justCreated && (
        <div className="mb-4 p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-xl">
          <p className="text-xs text-emerald-300 font-medium mb-1">
            Invite created for {justCreated.email}
          </p>
          <p className="text-[11px] text-emerald-400/70 mb-2">
            Email delivery isn't set up yet — copy this link and send it to them yourself (Slack, text,
            however you'd normally reach them).
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-[11px] text-slate-300 bg-slate-950 rounded-lg px-2 py-1.5 overflow-x-auto whitespace-nowrap">
              {inviteLink(justCreated.code)}
            </code>
            <button
              onClick={() => copyToClipboard(inviteLink(justCreated.code), 'new')}
              className="text-xs px-2 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition-all whitespace-nowrap"
            >
              {copiedId === 'new' ? 'Copied!' : 'Copy link'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-xs text-slate-500 text-center py-4">Loading invites…</p>
      ) : invites.length === 0 ? (
        <p className="text-xs text-slate-500 text-center py-4">No invites yet.</p>
      ) : (
        <div className="divide-y divide-slate-800">
          {invites.map((inv) => (
            <div key={inv.id} className="py-2.5 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm text-white truncate">{inv.email}</div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  {PLATFORM_INVITE_ROLE_LABELS[inv.role]} · {new Date(inv.created_at).toLocaleDateString()}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                  inv.status === 'pending' ? 'bg-amber-500/15 text-amber-300'
                  : inv.status === 'redeemed' ? 'bg-emerald-500/15 text-emerald-300'
                  : 'bg-slate-700 text-slate-400'
                }`}>
                  {inv.status}
                </span>
                {inv.status === 'pending' && (
                  <>
                    <button
                      onClick={() => copyToClipboard(inviteLink(inv.invite_code), inv.id)}
                      className="text-xs px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition-all"
                    >
                      {copiedId === inv.id ? 'Copied!' : 'Copy link'}
                    </button>
                    <button
                      disabled={busyId === inv.id}
                      onClick={() => handleRevoke(inv.id)}
                      className="text-xs px-2 py-1 bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded-lg transition-all disabled:opacity-50"
                    >
                      Revoke
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default PlatformInvitesPanel;
