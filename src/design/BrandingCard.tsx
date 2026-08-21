import { DEFAULT_ACCENT } from './branding';
import { useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { PanelCard, Button, Banner, Chip } from './primitives';
import { applyBranding, saveBranding, saveAutoNight, type TenantBranding } from './branding';

// Workspace appearance — per-tenant branding (mig 247, Design System v1).
// Guardrailed: one accent color + a curated surface family. Live-previews
// instantly; Save persists for everyone in the workspace.
const SURFACES: { key: TenantBranding['surface_key']; label: string; swatch: string }[] = [
  { key: 'daylight', label: 'Daylight', swatch: '#f4f5f7' },
  { key: 'editorial', label: 'Warm Editorial', swatch: '#faf6ef' },
  { key: 'midnight', label: 'Midnight Navy', swatch: '#0c1123' },
  { key: 'graphite', label: 'Graphite', swatch: '#0a0a0c' },
];
// Night surface is restricted to the two dark families (locked decision) —
// filtered from the same SURFACES list above rather than a second literal,
// so a new family added to SURFACES can never silently go unenforced here.
const NIGHT_SURFACES = SURFACES.filter(s => s.key === 'midnight' || s.key === 'graphite');

/* Switch — a real checkbox, styled (same pattern as
   src/components/sso/SsoPolicyPanel.tsx's Switch: custom div-with-onClick
   toggles are invisible to keyboards and screen readers). Reused here rather
   than invented fresh, kept local because the source isn't exported. */
function Switch({ id, checked, onChange, label, description }: {
  id: string; checked: boolean; onChange: (v: boolean) => void; label: string; description: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        aria-describedby={`${id}-desc`}
        onChange={e => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded accent-[var(--dt-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dt-accent"
      />
      <div className="min-w-0">
        <label htmlFor={id} className="block text-sm font-medium text-dt-body cursor-pointer">{label}</label>
        <div id={`${id}-desc`} className="text-xs text-dt-support mt-0.5">{description}</div>
      </div>
    </div>
  );
}

export default function BrandingCard() {
  const [accent, setAccent] = useState(DEFAULT_ACCENT);
  const [surface, setSurface] = useState<TenantBranding['surface_key']>('midnight');
  const [autoNight, setAutoNight] = useState(false);
  const [nightSurface, setNightSurface] = useState<'midnight' | 'graphite'>('midnight');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);

  useEffect(() => {
    // select('*'): see loadAndApplyBranding in branding.ts for why naming
    // auto_switch/night_surface_key explicitly would 400 the whole query
    // pre-migration-843. The two are read optionally below for the same
    // pre-apply degrade.
    supabase.from('tenant_branding').select('*').maybeSingle()
      .then(({ data }) => {
        const row = data as (Record<string, unknown>) | null;
        if (!row) return;
        if (row.accent_hex) setAccent(row.accent_hex as string);
        if (row.surface_key) setSurface(row.surface_key as TenantBranding['surface_key']);
        setAutoNight((row.auto_switch as boolean | undefined) ?? false);
        setNightSurface((row.night_surface_key as 'midnight' | 'graphite' | undefined) ?? 'midnight');
      }, () => {});
  }, []);

  const preview = (a: string, s: TenantBranding['surface_key'], auto = autoNight, night = nightSurface) => {
    applyBranding({ accent_hex: a, surface_key: s, auto_switch: auto, night_surface_key: night });
    setDirty(true); setMsg(null);
  };

  const save = async () => {
    setBusy(true); setMsg(null);
    const r1 = await saveBranding(accent, surface);
    if (!r1.ok) {
      setBusy(false);
      // dirty stays true on failure — the preview is still applied and
      // unsaved, so the Save button must stay reachable rather than
      // stranding it.
      const text = r1.error?.includes('unknown_surface')
        ? "This look isn't enabled for your workspace yet — the platform update that adds it hasn't been applied."
        : (r1.error ?? 'Could not save.');
      setMsg({ tone: 'danger', text });
      return;
    }
    const r2 = await saveAutoNight(autoNight, nightSurface);
    setBusy(false);
    if (r2.ok) {
      setDirty(false);
      setMsg({ tone: 'ok', text: 'Saved — this workspace now wears your brand.' });
    } else {
      // Same rule as above: the accent/surface half already saved, but dirty
      // stays true because the auto-night half didn't — Save must stay
      // reachable to retry rather than silently reporting overall success.
      const text = r2.error?.includes('unknown_surface')
        ? "This look isn't enabled for your workspace yet — the platform update that adds it hasn't been applied."
        : (r2.error ?? 'Could not save.');
      setMsg({ tone: 'danger', text });
    }
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
      <div className="mt-6 pt-6 border-t border-dt-border">
        <Switch
          id="dt-branding-auto-night"
          checked={autoNight}
          onChange={v => { setAutoNight(v); preview(accent, surface, v, nightSurface); }}
          label="Switch to a dark look at night"
          description="From 7pm to 7am in each person's local time."
        />
        {autoNight && (
          <div className="mt-4 ml-7">
            <div className="text-[10px] uppercase tracking-wide text-dt-muted mb-2">Night look</div>
            <div className="flex items-center gap-2">
              {NIGHT_SURFACES.map(s => (
                <button key={s.key}
                  onClick={() => { setNightSurface(s.key as 'midnight' | 'graphite'); preview(accent, surface, autoNight, s.key as 'midnight' | 'graphite'); }}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                    nightSurface === s.key ? 'border-dt-accent text-dt-title bg-dt-accent-soft' : 'border-dt-border text-dt-support hover:border-dt-border-strong'}`}>
                  <span className="w-4 h-4 rounded border border-dt-border-strong" style={{ background: s.swatch }} />
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {msg && <Banner tone={msg.tone === 'ok' ? 'neutral' : 'danger'} className="mt-4">{msg.text}</Banner>}
    </PanelCard>
  );
}
