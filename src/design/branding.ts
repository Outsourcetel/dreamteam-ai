import { supabase } from '../supabase';

// Per-tenant branding runtime (Design System v1 + mig 247). Applies the
// workspace's accent + surface family as CSS variables over the Midnight Navy
// defaults in tokens.css. Guardrailed: accent is one hex (derivations are
// computed here), surfaces come from a curated map — combinations stay legible.

/** The accent a workspace gets before it chooses one — Midnight Navy's indigo.
 *
 *  It lives here because it was written out as a literal `#6366f1` in fifteen
 *  places across nine files: two chat surfaces, the platform console, settings,
 *  user management, the auth context (twice), and every component that takes an
 *  `accentColor` prop with a fallback. Fifteen copies of one default is the
 *  same shape as any other list that must agree and has nothing checking it —
 *  changing the product's default accent meant finding all fifteen, and missing
 *  one meant two defaults in one product.
 *
 *  This is deliberately NOT a CSS token: it is a JavaScript fallback for a
 *  per-tenant value that arrives at runtime and is applied as an inline style,
 *  so it cannot be resolved at stylesheet time. tokens.css owns the static
 *  palette; this owns the dynamic one's default. */
export const DEFAULT_ACCENT = '#6366f1';

export interface TenantBranding { accent_hex: string | null; surface_key: 'midnight' | 'graphite' | 'daylight' }

const SURFACES: Record<string, Record<string, string>> = {
  midnight: {}, // tokens.css :root defaults
  daylight: {}, // tokens.css :root.light defaults — the class carries it
  graphite: {
    '--dt-page': '#0a0a0c', '--dt-panel': '#17171c66', '--dt-card': '#17171c66',
    '--dt-inset': '#0a0a0c99', '--dt-border': '#2c2c3499', '--dt-border-strong': '#3f3f4a',
  },
};
// Must stay identical to LIGHT_SURFACES in src/main.tsx (boot-time copy).
const LIGHT_SURFACES = new Set(['daylight']);

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
  ['--dt-accent', '--dt-accent-strong', '--dt-accent-hover', '--dt-accent-soft', '--dt-accent-text', '--dt-accent-border',
    ...Object.keys(SURFACES.graphite)].forEach(k => root.style.removeProperty(k));
  const key = b?.surface_key ?? 'midnight';
  document.documentElement.classList.toggle('light', LIGHT_SURFACES.has(key));
  try { localStorage.setItem('dt.surface', key); } catch { /* cosmetic */ }
  if (!b) return;
  const surf = SURFACES[b.surface_key] ?? {};
  Object.entries(surf).forEach(([k, v]) => root.style.setProperty(k, v));
  if (b.accent_hex && /^#[0-9a-f]{6}$/i.test(b.accent_hex)) {
    const a = b.accent_hex.toLowerCase();
    root.style.setProperty('--dt-accent', a);
    root.style.setProperty('--dt-accent-strong', mix(a, 0, 0.15)); // toward black
    root.style.setProperty('--dt-accent-hover', a);
    root.style.setProperty('--dt-accent-soft', a + '1a');
    // Readable on white means darker, not lighter.
    root.style.setProperty('--dt-accent-text', LIGHT_SURFACES.has(key) ? mix(a, 0, 0.25) : mix(a, 255, 0.45));
    root.style.setProperty('--dt-accent-border', a + '4d');
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
