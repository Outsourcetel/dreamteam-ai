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

export interface TenantBranding {
  accent_hex: string | null;
  surface_key: 'midnight' | 'graphite' | 'daylight' | 'editorial';
  // Auto night-switching (Task 9). Optional: BrandingCard's preview() call
  // constructs a TenantBranding with only accent_hex/surface_key, and that
  // must keep meaning "auto off" rather than becoming a type error.
  auto_switch?: boolean;
  night_surface_key?: 'midnight' | 'graphite' | null;
}

const SURFACES: Record<string, Record<string, string>> = {
  midnight: {}, // tokens.css :root defaults
  daylight: {}, // tokens.css :root.light defaults — the class carries it
  editorial: {}, // tokens.css :root.light.editorial defaults — the class carries it
  graphite: {
    '--dt-page': '#0a0a0c', '--dt-panel': '#17171c66', '--dt-card': '#17171c66',
    '--dt-inset': '#0a0a0c99', '--dt-border': '#2c2c3499', '--dt-border-strong': '#3f3f4a',
  },
};
// Must stay identical to LIGHT_SURFACES in src/main.tsx (boot-time copy).
const LIGHT_SURFACES = new Set(['daylight', 'editorial']);

// Auto night-switching (Task 9). Day window is 07:00-18:59 local; night is
// 19:00-06:59. Hardcoded — a configurable window is a later ask (brief,
// locked decisions). Must stay identical to the inline twin in
// src/main.tsx's boot block (flash-free boot cannot afford to import this
// module before first paint).
const NIGHT_STARTS = 19, NIGHT_ENDS = 7;
export const isNightNow = (d: Date = new Date()): boolean => {
  const h = d.getHours();
  return h >= NIGHT_STARTS || h < NIGHT_ENDS;
};

/** The key that should actually be on screen right now: the night surface
 * when auto-switching is on and it's night by the viewer's local clock,
 * otherwise the workspace's chosen day surface. */
export function effectiveSurface(b: TenantBranding | null): TenantBranding['surface_key'] {
  if (!b) return 'midnight';
  if (b.auto_switch && isNightNow()) return b.night_surface_key ?? 'midnight';
  return b.surface_key ?? 'midnight';
}

// Scheduler state (module-level — one per page, started by
// loadAndApplyBranding). lastApplied is whatever TenantBranding was last
// handed to applyBranding (initial load, or a BrandingCard preview), so a
// tick recomputes against what's actually on screen rather than a stale copy.
let lastApplied: TenantBranding | null = null;
let lastEffectiveKey: TenantBranding['surface_key'] | null = null;
let schedulerStarted = false;

function recomputeIfChanged(): void {
  if (!lastApplied) return;
  // Re-derive from lastApplied rather than trust lastEffectiveKey drifting —
  // only re-apply (and re-touch the DOM/localStorage) when the boundary was
  // actually crossed, so a tick every 60s does not mean 60s of churn.
  if (effectiveSurface(lastApplied) !== lastEffectiveKey) applyBranding(lastApplied);
}

function startScheduler(): void {
  if (schedulerStarted) return; // never double-start: StrictMode double-invoke, re-navigation, etc.
  schedulerStarted = true;
  setInterval(recomputeIfChanged, 60_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') recomputeIfChanged();
  });
}

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
  // The EFFECTIVE key — night surface instead of the day one when auto is on
  // and it's night right now. Accent handling below is unaffected: the accent
  // persists across day/night, only the surface family swaps.
  const key = effectiveSurface(b);
  document.documentElement.classList.toggle('light', LIGHT_SURFACES.has(key));
  // Forced (not just added) so switching editorial → any other family removes
  // it in the same pass as `light` above, rather than leaving it stuck on.
  document.documentElement.classList.toggle('editorial', key === 'editorial');
  lastApplied = b;
  lastEffectiveKey = key;
  try {
    localStorage.setItem('dt.surface', key); // caches the EFFECTIVE key, unchanged contract
    // dt.branding caches the RAW config (not the effective key) so a reload
    // at any hour can recompute night/day itself rather than replay a key
    // that may already be stale by the time the page loads.
    localStorage.setItem('dt.branding', JSON.stringify({
      surface: b?.surface_key ?? 'midnight',
      auto: b?.auto_switch ?? false,
      night: b?.night_surface_key ?? null,
    }));
  } catch { /* cosmetic */ }
  if (!b) return;
  const surf = SURFACES[key] ?? {};
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
 * mig-247 table isn't reachable yet.
 *
 * Selects `*` rather than naming auto_switch/night_surface_key explicitly:
 * this code ships before migration 843 is applied (repo law — code deploys,
 * a human applies the migration separately), and PostgREST 400s an ENTIRE
 * query that names a column the table doesn't have yet. Naming all four
 * columns in one select would have blanked accent_hex/surface_key too during
 * that window, not just degraded the two new fields — the exact failure this
 * task calls out to avoid. `select('*')` returns whatever columns exist
 * either way, and the two new ones are read optionally below. */
export async function loadAndApplyBranding(): Promise<void> {
  try {
    const { data } = await supabase.from('tenant_branding').select('*').maybeSingle();
    const row = data as (Partial<TenantBranding> & Record<string, unknown>) | null;
    applyBranding(row ? {
      accent_hex: (row.accent_hex as string | null) ?? null,
      surface_key: (row.surface_key as TenantBranding['surface_key']) ?? 'midnight',
      auto_switch: (row.auto_switch as boolean | undefined) ?? false,
      night_surface_key: (row.night_surface_key as TenantBranding['night_surface_key'] | undefined) ?? null,
    } : null);
    startScheduler();
  } catch { /* branding is cosmetic — never block the app on it */ }
}

export async function saveBranding(accentHex: string | null, surfaceKey: string): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase.rpc('set_tenant_branding', { p_accent_hex: accentHex, p_surface_key: surfaceKey });
  if (error) return { ok: false, error: error.message };
  const r = data as { ok?: boolean; error?: string } | null;
  return r?.ok ? { ok: true } : { ok: false, error: r?.error ?? 'could not save' };
}

/** Save the auto night-switching preference via the companion RPC (locked
 * decision: not a widened set_tenant_branding — see migration 843). */
export async function saveAutoNight(autoSwitch: boolean, nightSurfaceKey: 'midnight' | 'graphite' | null): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase.rpc('set_tenant_branding_auto', { p_auto_switch: autoSwitch, p_night_surface_key: nightSurfaceKey });
  if (error) return { ok: false, error: error.message };
  const r = data as { ok?: boolean; error?: string } | null;
  return r?.ok ? { ok: true } : { ok: false, error: r?.error ?? 'could not save' };
}
