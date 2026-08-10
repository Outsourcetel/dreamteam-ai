// tenant_brand_identity (mig 666) — the ONE way work products read the
// tenant's company brand. Phase 2 of the approved spec (docs/superpowers/
// specs/2026-08-10-tenant-brand-identity-design.md): DE speech and outbound
// email wear the brand; phase 3 extends to generated documents.
//
// Brand text is TENANT-AUTHORED configuration. It rides in the same trust
// class as digital_employees.voice and tenants.vocabulary (both already in
// persona preambles), but it is still sanitized here so a crafted "tone"
// can never smuggle role tags or marker breakouts into a system prompt.
import { sanitizeUntrusted } from './injectionSafety.ts';

// deno-lint-ignore no-explicit-any
type Admin = any;
export type TenantBrand = Record<string, Record<string, string>>;

export async function loadTenantBrand(admin: Admin, tenantId: string | null | undefined): Promise<TenantBrand | null> {
  if (!tenantId) return null;
  try {
    const { data } = await admin.from('tenant_brand_identity').select('brand').eq('tenant_id', tenantId).maybeSingle();
    return data?.brand && typeof data.brand === 'object' ? (data.brand as TenantBrand) : null;
  } catch {
    return null;
  }
}

const clean = (s: unknown): string => sanitizeUntrusted(typeof s === 'string' ? s : '').trim().slice(0, 600);

/** A prompt fragment teaching the writer the company's voice. Empty string
 *  when the tenant has not filled the voice section — today's behavior. */
export function brandVoiceDirective(brand: TenantBrand | null): string {
  if (!brand) return '';
  const v = brand.voice ?? {};
  const o = brand.outputs ?? {};
  const parts: string[] = [];
  const tone = clean(v.tone);
  const dos = clean(v.dos);
  const donts = clean(v.donts);
  const example = clean(v.example);
  const signoff = clean(o.email_signoff);
  if (tone) parts.push(`Company brand voice: ${tone}`);
  if (dos) parts.push(`In writing, do: ${dos}.`);
  if (donts) parts.push(`Avoid: ${donts}.`);
  if (example) parts.push(`One sentence in the brand voice: "${example}"`);
  if (signoff) parts.push(`Sign off outbound messages with: "${signoff}"`);
  return parts.length ? ` ${parts.join(' ')}` : '';
}

/** Append the brand's contact footer to an outgoing email body. No footer
 *  configured (or already present) → the text is returned untouched. */
export function appendBrandFooter(text: string, brand: TenantBrand | null): string {
  const footer = clean(brand?.contact?.footer);
  if (!footer || text.includes(footer)) return text;
  return `${text.trimEnd()}\n\n—\n${footer}`;
}
