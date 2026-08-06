import React, { useEffect, useState } from 'react';
import { savePlatformConfig, hasPlatformConfigKey } from '../lib/api';

// ════════════════════════════════════════════════════════════════════════
// The Resend API key — outbound email for the whole platform.
//
// ⚠ WHY THIS LIVES IN THE PLATFORM CONSOLE AND NOT IN A WORKSPACE'S SETTINGS.
// It was first built onto Settings → AI Engine, next to the LLM keys. That was
// wrong twice over:
//
//   1. Every key on that tab is THAT WORKSPACE'S OWN (saveTenantLlmKey). This
//      is ONE credential shared by every workspace, so it does not belong in a
//      per-workspace surface no matter how it is labelled.
//   2. Writing it needs `billing.manage`, which only a platform_super_admin
//      holds — so the person who can change it would have had to sign in as
//      their platform account and then navigate INTO a tenant to reach a
//      global setting. Nobody would find it, and nobody did.
//
// `platform_config_set` re-checks the capability server-side; this panel being
// on a platform page is convenience, not the security boundary.
//
// The value is never read back. `hasPlatformConfigKey` answers only whether a
// key exists — there is no path in the product that returns a stored secret to
// a browser, and this panel does not add one.
// ════════════════════════════════════════════════════════════════════════

export default function PlatformEmailKeyPanel() {
  const [value, setValue] = useState('');
  const [isSet, setIsSet] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    hasPlatformConfigKey('RESEND_API_KEY').then(setIsSet).catch(() => setIsSet(false));
  }, []);

  const save = async () => {
    const key = value.trim();
    if (!key) return;
    // A shape check, not a validity check — only Resend can say whether a key
    // works. This catches the common paste error (the wrong key, a Stripe key,
    // half a key) before it replaces a working one.
    if (!key.startsWith('re_') || key.length < 20) {
      setStatus('error');
      setError('That does not look like a Resend key — they begin “re_”. Nothing was saved.');
      return;
    }
    setSaving(true); setError(null);
    const ok = await savePlatformConfig({ RESEND_API_KEY: key });
    setSaving(false);
    if (ok) {
      setStatus('saved');
      setIsSet(true);
      setValue('');            // never leave a secret sitting in component state
    } else {
      setStatus('error');
      setError('Save failed — this needs a platform administrator with billing access.');
    }
  };

  return (
    // No bottom margin: the panel rendered beneath this one supplies the gap
    // with its own top padding. Adding one here doubles it.
    <div className="bg-dt-card border border-dt-border rounded-xl p-5">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-sm font-semibold text-white">Outbound email — Resend API key</h2>
        {isSet === null
          ? <span className="text-xs text-dt-muted">checking…</span>
          : isSet
            ? <span className="text-xs text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded">Configured</span>
            : <span className="text-xs text-dt-muted bg-slate-600/50 px-2 py-0.5 rounded">Not set — email sending is dormant</span>}
      </div>

      <p className="text-xs text-dt-support mb-3">
        One credential for <strong>every workspace</strong> — replacing it changes who sends email for all of
        them at once. Saving takes effect immediately, but it does <strong>not</strong> revoke the old key:
        delete that in Resend afterwards, or it keeps working.
      </p>

      <div className="flex gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => { setValue(e.target.value); setStatus('idle'); setError(null); }}
          placeholder={isSet ? 'Enter new key to replace existing…' : 're_…'}
          className="flex-1 bg-dt-panel border border-dt-border-strong text-white text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500 font-mono"
        />
        <button
          onClick={() => void save()}
          disabled={saving || !value.trim()}
          className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-xl disabled:opacity-40 transition-all"
        >
          {saving ? 'Saving…' : isSet ? 'Replace key' : 'Save key'}
        </button>
      </div>

      <p className="text-xs text-dt-faint mt-1">
        Get a key at resend.com → API Keys. Stored encrypted in the vault; it is never shown again after
        saving, here or anywhere else.
      </p>

      {status === 'saved' && (
        <p className="text-xs text-emerald-400 mt-2">
          Saved — sending uses it immediately. <strong>Now delete the previous key in Resend</strong>; until
          you do, the old one still works.
        </p>
      )}
      {status === 'error' && error && <p className="text-xs text-rose-300 mt-2">{error}</p>}
    </div>
  );
}
