import { useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { PanelCard, Button, Banner, Chip } from './primitives';
import { applyBranding, saveBranding, type TenantBranding } from './branding';

// Workspace appearance — per-tenant branding (mig 247, Design System v1).
// Guardrailed: one accent color + a curated surface family. Live-previews
// instantly; Save persists for everyone in the workspace.
const SURFACES: { key: TenantBranding['surface_key']; label: string; swatch: string }[] = [
  { key: 'midnight', label: 'Midnight Navy', swatch: '#0c1123' },
  { key: 'graphite', label: 'Graphite', swatch: '#0a0a0c' },
];

export default function BrandingCard() {
  const [accent, setAccent] = useState('#6366f1');
  const [surface, setSurface] = useState<TenantBranding['surface_key']>('midnight');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);

  useEffect(() => {
    supabase.from('tenant_branding').select('accent_hex, surface_key').maybeSingle()
      .then(({ data }) => {
        if (data?.accent_hex) setAccent(data.accent_hex);
        if (data?.surface_key) setSurface(data.surface_key as TenantBranding['surface_key']);
      }, () => {});
  }, []);

  const preview = (a: string, s: TenantBranding['surface_key']) => {
    applyBranding({ accent_hex: a, surface_key: s });
    setDirty(true); setMsg(null);
  };

  const save = async () => {
    setBusy(true); setMsg(null);
    const r = await saveBranding(accent, surface);
    setBusy(false); setDirty(false);
    setMsg(r.ok ? { tone: 'ok', text: 'Saved — this workspace now wears your brand.' }
                : { tone: 'danger', text: r.error ?? 'Could not save.' });
  };

  return (
    <PanelCard
      title="Workspace appearance"
      badge={<Chip tone="accent">brand</Chip>}
      actions={dirty ? <Button kind="primary" size="sm" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save for everyone'}</Button> : undefined}
      className="mt-8"
    >
      <p className="text-xs text-dt-muted mb-4 max-w-2xl">
        Make DreamTeam wear your brand — pick your accent color and a surface family. Changes preview instantly for you and apply to the whole workspace when saved.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-dt-muted mb-2">Accent color</div>
          <div className="flex items-center gap-3">
            <input type="color" value={accent} aria-label="Accent color"
              onChange={e => { setAccent(e.target.value); preview(e.target.value, surface); }}
              className="h-9 w-14 rounded-lg border border-dt-border-strong bg-dt-inset cursor-pointer" />
            <span className="text-sm text-dt-body font-mono">{accent}</span>
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-dt-muted mb-2">Surface family</div>
          <div className="flex items-center gap-2">
            {SURFACES.map(s => (
              <button key={s.key} onClick={() => { setSurface(s.key); preview(accent, s.key); }}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                  surface === s.key ? 'border-dt-accent text-dt-title bg-dt-accent-soft' : 'border-dt-border text-dt-support hover:border-dt-border-strong'}`}>
                <span className="w-4 h-4 rounded border border-dt-border-strong" style={{ background: s.swatch }} />
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {msg && <Banner tone={msg.tone === 'ok' ? 'neutral' : 'danger'} className="mt-4">{msg.text}</Banner>}
    </PanelCard>
  );
}
