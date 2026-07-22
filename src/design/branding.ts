import { supabase } from '../supabase';

// Per-tenant branding runtime (Design System v1 + mig 247). Applies the
// workspace's accent + surface family as CSS variables over the Midnight Navy
// defaults in tokens.css. Guardrailed: accent is one hex (derivations are
// computed here), surfaces come from a curated map — combinations stay legible.

export interface TenantBranding { accent_hex: string | null; surface_key: 'midnight' | 'graphite' }

const SURFACES: Record<string, Record<string, string>> = {
  midnight: {}, // tokens.css defaults
  graphite: {
    '--dt-page': '#0a0a0c', '--dt-panel': '#17171c66', '--dt-card': '#17171c66',
    '--dt-inset': '#0a0a0c99', '--dt-border': '#2c2c3499', '--dt-border-strong': '#3f3f4a',
  },
};

const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
const hexToRgb = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)] as const;
const rgbToHex = (r: number, g: number, b: number) => '#' + [r, g, b].map(v => clamp(v).toString(16).padStart(2, '0')).join('');
const mix = (hex: string, target: number, amt: number) => {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r + (target - r) * amt, g + (target - g) * amt, b + (target - b) * amt);
};

export function applyBranding(b: TenantBranding | null): void {
  const root = document.documentElement;
  // Reset to defaults first so switching back is clean.
  ['--dt-accent', '--dt-accent-strong', '--dt-accent-hover', '--dt-accent-soft', '--dt-accent-text',
    ...Object.keys(SURFACES.graphite)].forEach(k => root.style.removeProperty(k));
  if (!b) return;
  const surf = SURFACES[b.surface_key] ?? {};
  Object.entries(surf).forEach(([k, v]) => root.style.setProperty(k, v));
  if (b.accent_hex && /^#[0-9a-f]{6}$/i.test(b.accent_hex)) {
    const a = b.accent_hex.toLowerCase();
    root.style.setProperty('--dt-accent', a);
    root.style.setProperty('--dt-accent-strong', mix(a, 0, 0.15)); // toward black
    root.style.setProperty('--dt-accent-hover', a);
    root.style.setProperty('--dt-accent-soft', a + '1a');
    root.style.setProperty('--dt-accent-text', mix(a, 255, 0.45)); // toward white
  }
}

/** Fetch this tenant's branding (RLS-scoped) and apply it. Safe no-op if the
 * mig-247 table isn't reachable yet. */
export async function loadAndApplyBranding(): Promise<void> {
  try {
    const { data } = await supabase.from('tenant_branding').select('accent_hex, surface_key').maybeSingle();
    applyBranding((data as TenantBranding) ?? null);
  } catch { /* branding is cosmetic — never block the app on it */ }
}

export async function saveBranding(accentHex: string | null, surfaceKey: string): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase.rpc('set_tenant_branding', { p_accent_hex: accentHex, p_surface_key: surfaceKey });
  if (error) return { ok: false, error: error.message };
  const r = data as { ok?: boolean; error?: string } | null;
  return r?.ok ? { ok: true } : { ok: false, error: r?.error ?? 'could not save' };
}
