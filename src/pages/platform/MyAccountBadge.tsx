import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { checkMyAccountStatus, PLATFORM_INVITE_ROLE_LABELS } from '../../lib/api';
import type { PlatformInviteRole } from '../../lib/api';
import ChangePasswordModal from '../../components/ChangePasswordModal';

// ─────────────────────────────────────────────────────────────────
// The only "who am I" indicator anywhere in the platform console —
// the ordinary tenant Sidebar (the one place a user's name/role ever
// renders) is unconditionally skipped for platform-layer accounts, so
// this small badge in the nav bar is the sole place it can live.
// Click opens a small menu (change password, sign out) — the same
// place a person would look for account actions.
// ─────────────────────────────────────────────────────────────────
const MyAccountBadge = () => {
  const { authedUser, handleLogout } = useAuth();
  const [role, setRole] = useState<string | null>(authedUser?.role ?? null);
  const [open, setOpen] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    checkMyAccountStatus().then((status) => {
      if (!cancelled && status?.role) setRole(status.role);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  if (!authedUser) return null;
  const roleLabel = role && role in PLATFORM_INVITE_ROLE_LABELS
    ? PLATFORM_INVITE_ROLE_LABELS[role as PlatformInviteRole]
    : role || '';

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 pr-1 rounded-lg hover:bg-dt-panel transition-colors py-1"
        title={authedUser.email}
      >
        <div className="w-7 h-7 rounded-full bg-indigo-600 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
          {(authedUser.name || authedUser.email || '?')[0].toUpperCase()}
        </div>
        <span className="text-xs text-white font-medium whitespace-nowrap hidden sm:inline">{authedUser.name || authedUser.email}</span>
        <span className="text-dt-faint text-[10px]">▾</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-56 bg-dt-card border border-dt-border-strong rounded-xl shadow-2xl overflow-hidden z-40">
          <div className="px-3 py-2.5 border-b border-dt-border">
            <p className="text-xs text-white font-medium truncate">{authedUser.name || authedUser.email}</p>
            <p className="text-[11px] text-dt-muted truncate">{authedUser.email}</p>
            {roleLabel && <p className="text-[10px] text-indigo-400 mt-1">{roleLabel}</p>}
          </div>
          <button
            onClick={() => { setShowChangePassword(true); setOpen(false); }}
            className="w-full text-left px-3 py-2 text-xs text-dt-support hover:bg-dt-panel transition-colors"
          >
            Change password
          </button>
          <button
            onClick={() => void handleLogout()}
            className="w-full text-left px-3 py-2 text-xs text-rose-400 hover:bg-dt-panel transition-colors"
          >
            Sign out
          </button>
        </div>
      )}

      {showChangePassword && <ChangePasswordModal onClose={() => setShowChangePassword(false)} />}
    </div>
  );
};

export default MyAccountBadge;
