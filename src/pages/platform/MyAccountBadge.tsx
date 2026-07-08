import React, { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { checkMyAccountStatus, PLATFORM_INVITE_ROLE_LABELS } from '../../lib/api';
import type { PlatformInviteRole } from '../../lib/api';

// ─────────────────────────────────────────────────────────────────
// The only "who am I" indicator anywhere in the platform console —
// the ordinary tenant Sidebar (the one place a user's name/role ever
// renders) is unconditionally skipped for platform-layer accounts, so
// this small badge in the nav bar is the sole place it can live.
// Refreshes from the DB on mount (not just the cached session) so a
// role change made elsewhere shows up without a re-login.
// ─────────────────────────────────────────────────────────────────
const MyAccountBadge = () => {
  const { authedUser } = useAuth();
  const [role, setRole] = useState<string | null>(authedUser?.role ?? null);

  useEffect(() => {
    let cancelled = false;
    checkMyAccountStatus().then((status) => {
      if (!cancelled && status?.role) setRole(status.role);
    });
    return () => { cancelled = true; };
  }, []);

  if (!authedUser) return null;
  const roleLabel = role && role in PLATFORM_INVITE_ROLE_LABELS
    ? PLATFORM_INVITE_ROLE_LABELS[role as PlatformInviteRole]
    : role || '';

  return (
    <div className="flex items-center gap-2 pr-2" title={authedUser.email}>
      <div className="w-7 h-7 rounded-full bg-indigo-600 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
        {(authedUser.name || authedUser.email || '?')[0].toUpperCase()}
      </div>
      <div className="leading-tight">
        <p className="text-xs text-white font-medium">{authedUser.name || authedUser.email}</p>
        {roleLabel && <p className="text-[10px] text-slate-500">{roleLabel}</p>}
      </div>
    </div>
  );
};

export default MyAccountBadge;
