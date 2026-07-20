// The workspace sending identity (EXEC 0.4). When a DE's outbound email draft is
// approved, it sends from this address (via Resend). Owner/admin only.
import React, { useEffect, useState } from 'react';
import { getCommsSettings, setCommsSettings } from '../lib/commsApi';

export default function CommsSettingsCard({ accentColor = '#6366f1' }: { accentColor?: string }) {
  const [fromEmail, setFromEmail] = useState('');
  const [fromName, setFromName] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try { const s = await getCommsSettings(); setFromEmail(s.from_email ?? ''); setFromName(s.from_name ?? ''); }
      catch { /* honest empty */ }
      finally { setLoading(false); }
    })();
  }, []);

  const save = async () => {
    setSaving(true); setStatus('idle'); setError(null);
    try { await setCommsSettings(fromEmail.trim(), fromName.trim()); setStatus('saved'); }
    catch (e) { setStatus('error'); setError((e as Error).message); }
    finally { setSaving(false); }
  };

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
      <h2 className="text-sm font-semibold text-white mb-1">Communications</h2>
      <p className="text-xs text-slate-500 mb-4">
        The address your digital employees send approved emails from. Sending stays draft-for-approval — nothing goes out
        without a person approving it — and needs an email provider key (Settings → AI Engine) to actually deliver.
      </p>
      {loading ? (
        <p className="text-xs text-slate-500">Loading…</p>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-slate-400 block mb-1.5">From address</label>
            <input value={fromEmail} onChange={e => setFromEmail(e.target.value)} type="email" placeholder="renewals@yourcompany.com"
              className="w-full bg-slate-700 border border-slate-600 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500" />
            <p className="text-[11px] text-slate-600 mt-1">Must be on a domain you've verified with your email provider.</p>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-400 block mb-1.5">From name (optional)</label>
            <input value={fromName} onChange={e => setFromName(e.target.value)} placeholder="Acme Renewals"
              className="w-full bg-slate-700 border border-slate-600 text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500" />
          </div>
          <div className="flex items-center gap-3">
            <button onClick={() => void save()} disabled={saving || !fromEmail.trim()}
              className="px-6 py-2.5 text-white text-sm font-medium rounded-xl disabled:opacity-50 transition-all" style={{ backgroundColor: accentColor }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            {status === 'saved' && <span className="text-xs text-emerald-400">Saved</span>}
            {status === 'error' && <span className="text-xs text-red-400">{error ?? 'Save failed'}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
