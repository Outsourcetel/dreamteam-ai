import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabase';
import { getSessionTenantId } from '../lib/customerApi';
import { PanelCard, Button, Banner, Chip, Drawer, TabBar, Field, EmptyState, INPUT_CLS } from './primitives';

// Company brand identity — mig 666 (spec: docs/superpowers/specs/
// 2026-08-10-tenant-brand-identity-design.md). Distinct from BrandingCard
// (mig 247), which themes the app: THIS is the tenant's company brand —
// palette, typography, logo, voice, contact identity — that DE work products
// (emails, invoices, documents) will wear in phases 2-3.
//
// Section/field shape is mirrored in THREE places that must stay in step:
// the save RPC's whitelist (mig 666), brand-extract's SECTIONS, and here.

type Brand = Record<string, Record<string, string>>;

const TEXTAREA_CLS = `${INPUT_CLS} min-h-[72px] resize-y`;

type FieldDef = { key: string; label: string; control: 'text' | 'color' | 'textarea'; hint?: string; placeholder?: string };
const SECTIONS: { key: string; label: string; fields: FieldDef[] }[] = [
  { key: 'overview', label: 'Overview', fields: [
    { key: 'name', label: 'Company name', control: 'text' },
    { key: 'tagline', label: 'Tagline', control: 'text', placeholder: 'One line that says what you do' },
    { key: 'industry', label: 'Industry', control: 'text' },
    { key: 'website', label: 'Website', control: 'text', placeholder: 'https://…' },
  ] },
  { key: 'colors', label: 'Colors', fields: [
    { key: 'primary', label: 'Primary', control: 'color', hint: 'Headlines, CTAs, key accents' },
    { key: 'secondary', label: 'Secondary', control: 'color' },
    { key: 'tertiary', label: 'Tertiary', control: 'color' },
    { key: 'dark', label: 'Dark neutral', control: 'color', hint: 'Body text, dark backgrounds' },
    { key: 'light', label: 'Light neutral', control: 'color', hint: 'Backgrounds, card fills' },
  ] },
  { key: 'typography', label: 'Typography', fields: [
    { key: 'headline', label: 'Headline font', control: 'text', placeholder: 'e.g. Poppins' },
    { key: 'body', label: 'Body font', control: 'text', placeholder: 'e.g. Inter' },
  ] },
  { key: 'logo', label: 'Logo', fields: [
    { key: 'url', label: 'Logo URL', control: 'text', placeholder: 'https://…/logo.png' },
    { key: 'placement', label: 'Placement', control: 'text', placeholder: 'e.g. top-left on documents' },
    { key: 'notes', label: 'Usage notes', control: 'textarea', placeholder: 'Clear space, dark/light variants, what never to do' },
  ] },
  { key: 'voice', label: 'Voice', fields: [
    { key: 'tone', label: 'Tone of voice', control: 'textarea', hint: 'How your company writes — 2-3 sentences' },
    { key: 'dos', label: "Do's", control: 'textarea', placeholder: 'plain language, short sentences, warm but direct' },
    { key: 'donts', label: "Don'ts", control: 'textarea', placeholder: 'jargon, exclamation marks, hard sells' },
    { key: 'example', label: 'Example sentence', control: 'text', hint: 'One sentence that sounds exactly like you' },
  ] },
  { key: 'contact', label: 'Contact', fields: [
    { key: 'email', label: 'Email', control: 'text' },
    { key: 'phone', label: 'Phone', control: 'text' },
    { key: 'address', label: 'Address', control: 'textarea' },
    { key: 'footer', label: 'Footer line', control: 'text', hint: 'Appears at the bottom of outbound emails and documents' },
  ] },
  { key: 'outputs', label: 'Outputs', fields: [
    { key: 'email_signoff', label: 'Email sign-off', control: 'text', placeholder: 'e.g. Warm regards, the Acme team' },
    { key: 'invoice_footer', label: 'Invoice footer', control: 'text', placeholder: 'Payment terms, thank-you line' },
    { key: 'social_cta', label: 'Social CTA', control: 'text', placeholder: 'The closing ask on social posts' },
  ] },
];

const emptyBrand = (): Brand =>
  Object.fromEntries(SECTIONS.map(s => [s.key, Object.fromEntries(s.fields.map(f => [f.key, '']))]));

const HEX_RE = /^#[0-9a-f]{6}$/i;

export default function BrandIdentityCard() {
  const [brand, setBrand] = useState<Brand>(emptyBrand);
  const [hasRow, setHasRow] = useState(false);
  const [phase, setPhase] = useState<'loading' | 'error' | 'ready'>('loading');
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState(SECTIONS[0].key);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'neutral' | 'danger' | 'info'; text: string } | null>(null);
  const [draftUrl, setDraftUrl] = useState('');
  const [drafting, setDrafting] = useState(false);

  useEffect(() => {
    supabase.from('tenant_brand_identity').select('brand').maybeSingle().then(
      ({ data, error }) => {
        if (error) { setPhase('error'); return; }
        if (data?.brand && typeof data.brand === 'object') {
          const merged = emptyBrand();
          for (const s of SECTIONS) for (const f of s.fields) {
            const v = (data.brand as Brand)[s.key]?.[f.key];
            if (typeof v === 'string') merged[s.key][f.key] = v;
          }
          setBrand(merged); setHasRow(true);
        }
        setPhase('ready');
      },
      () => setPhase('error'),
    );
  }, []);

  const setField = (section: string, key: string, value: string) => {
    setBrand(b => ({ ...b, [section]: { ...b[section], [key]: value } }));
    setDirty(true); setMsg(null);
  };

  const filledSections = useMemo(
    () => SECTIONS.filter(s => Object.values(brand[s.key] ?? {}).some(v => v.trim() !== '')),
    [brand],
  );
  const palette = Object.values(brand.colors ?? {}).filter(v => HEX_RE.test(v));

  const save = async () => {
    setBusy(true); setMsg(null);
    // ⚠ .rpc() RESOLVES on a Postgres error, and the RPC itself refuses in
    // its payload — classify BOTH, never report a refusal as success.
    const { data, error } = await supabase.rpc('set_tenant_brand_identity', { p_brand: brand });
    setBusy(false);
    if (error) { setMsg({ tone: 'danger', text: `Could not save: ${error.message}` }); return; }
    const r = data as { ok?: boolean; error?: string; field?: string; section?: string } | null;
    if (!r?.ok) {
      const why = r?.error === 'not_permitted' ? 'only owners and admins can edit the brand identity'
        : r?.error === 'color_must_be_hex6' ? `"${r.field}" must be a 6-digit hex color like #1a2b3c`
        : r?.error ?? 'unknown refusal';
      setMsg({ tone: 'danger', text: `Could not save: ${why}` });
      return;
    }
    setDirty(false); setHasRow(true);
    setMsg({ tone: 'neutral', text: 'Saved — your digital employees will wear this brand on their work.' });
  };

  const draftFromSite = async () => {
    let url = draftUrl.trim();
    if (!url) { setMsg({ tone: 'danger', text: 'Paste your website URL first.' }); return; }
    // People type "www.acme.com" — the server's URL guard rightly insists on a
    // scheme, so supply the https:// here rather than bouncing the user.
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    setDrafting(true); setMsg(null);
    // A platform operator has no tenant of their own — the function verifies
    // the asserted tenant against the audited remote-access session, same as
    // every other edge caller (resolveTenantWithRemoteAccess, mig 102).
    const tid = await getSessionTenantId();
    // The gateway (verify_jwt) rejects an EXPIRED access token before the
    // function ever runs — seen live 2026-08-10 as a bare 401 after the tab
    // sat idle. getSession() refreshes an expired token; passing it explicitly
    // avoids racing the client's own auth-state propagation.
    const { data: sess } = await supabase.auth.getSession();
    const { data, error } = await supabase.functions.invoke('brand-extract', {
      body: { url, ...(tid ? { tenant_id: tid } : {}) },
      ...(sess?.session ? { headers: { Authorization: `Bearer ${sess.session.access_token}` } } : {}),
    });
    setDrafting(false);
    const r = data as { ok?: boolean; draft?: Brand; detail?: string } | null;
    if (error || !r?.ok || !r.draft) {
      // On a non-2xx, invoke() hides the function's own refusal inside
      // error.context — surface that, not the generic wrapper message.
      let detail = r?.detail ?? error?.message ?? 'unknown error';
      try {
        const ctx = (error as { context?: Response } | null)?.context;
        const body = await ctx?.json?.();
        if (body?.detail || body?.error) detail = body.detail ?? body.error;
        // A gateway-level 401 carries only {code, msg} — no detail/error —
        // and means the sign-in token expired before the function ever ran.
        else if (ctx?.status === 401) detail = 'your sign-in expired — try again (the page refreshes it), or reload';
        else if (body?.msg) detail = body.msg;
      } catch { /* keep the wrapper message */ }
      setMsg({ tone: 'danger', text: `Could not draft from the site: ${detail}` });
      return;
    }
    // The draft fills only fields you have left empty — it never overwrites
    // anything you have written or saved.
    let filled = 0;
    setBrand(b => {
      const next: Brand = structuredClone(b);
      for (const s of SECTIONS) for (const f of s.fields) {
        const v = r.draft?.[s.key]?.[f.key] ?? '';
        if (v && next[s.key][f.key].trim() === '') { next[s.key][f.key] = v; filled++; }
      }
      return next;
    });
    setDirty(true); setOpen(true);
    setMsg({ tone: 'info', text: `Drafted from your website — review each section, then save. Nothing is stored until you do.` });
    void filled;
  };

  const editor = open && (
    <Drawer title="Brand identity" onClose={() => setOpen(false)} wide>
      <div className="mb-4 flex items-center gap-2">
        <input value={draftUrl} onChange={e => setDraftUrl(e.target.value)} placeholder="https://yourcompany.com"
          aria-label="Website to draft from" className={INPUT_CLS} />
        <Button kind="ai" size="sm" disabled={drafting} onClick={() => void draftFromSite()}>
          {drafting ? 'Drafting…' : 'Draft from website'}
        </Button>
      </div>
      {msg && <Banner tone={msg.tone} className="mb-4">{msg.text}</Banner>}
      <TabBar tabs={SECTIONS.map(s => ({ key: s.key, label: s.label }))} active={tab} onSelect={setTab} />
      <div className="mt-5 grid gap-4">
        {SECTIONS.find(s => s.key === tab)?.fields.map(f => (
          <Field key={f.key} label={f.label} hint={f.hint}>
            {f.control === 'textarea' ? (
              <textarea value={brand[tab][f.key]} placeholder={f.placeholder}
                onChange={e => setField(tab, f.key, e.target.value)} className={TEXTAREA_CLS} />
            ) : f.control === 'color' ? (
              <div className="flex items-center gap-3">
                <input type="color" value={HEX_RE.test(brand[tab][f.key]) ? brand[tab][f.key] : '#000000'}
                  aria-label={`${f.label} color`}
                  onChange={e => setField(tab, f.key, e.target.value)}
                  className="h-9 w-14 rounded-lg border border-dt-border-strong bg-dt-inset cursor-pointer" />
                <input value={brand[tab][f.key]} placeholder="#1a2b3c"
                  onChange={e => setField(tab, f.key, e.target.value)} className={`${INPUT_CLS} font-mono max-w-[10rem]`} />
              </div>
            ) : (
              <input value={brand[tab][f.key]} placeholder={f.placeholder}
                onChange={e => setField(tab, f.key, e.target.value)} className={INPUT_CLS} />
            )}
          </Field>
        ))}
      </div>
      <div className="mt-6 flex items-center gap-3">
        <Button kind="primary" disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save brand identity'}
        </Button>
        <Button kind="ghost" onClick={() => setOpen(false)}>Close</Button>
      </div>
    </Drawer>
  );

  return (
    <PanelCard
      title="Brand identity"
      badge={<Chip tone="accent">company</Chip>}
      actions={phase === 'ready' && (hasRow || dirty)
        ? <Button kind="secondary" size="sm" onClick={() => setOpen(true)}>Edit brand identity</Button>
        : undefined}
      className="mt-8"
    >
      <p className="text-xs text-dt-muted mb-4 max-w-2xl">
        Your company's brand — colors, fonts, logo, tone of voice and contact identity — so the
        work your digital employees produce (emails, invoices, documents) looks and sounds like you.
      </p>

      {phase === 'loading' && (
        <div className="animate-pulse space-y-3">
          <div className="h-4 w-48 rounded bg-dt-inset" />
          <div className="h-4 w-72 rounded bg-dt-inset" />
        </div>
      )}

      {phase === 'error' && (
        <Banner tone="danger">Could not load your brand identity. Refresh to try again.</Banner>
      )}

      {phase === 'ready' && !hasRow && !dirty && (
        <EmptyState headline="No brand identity yet"
          action={
            <div className="flex items-center justify-center gap-2 max-w-md mx-auto">
              <input value={draftUrl} onChange={e => setDraftUrl(e.target.value)} placeholder="https://yourcompany.com"
                aria-label="Website to draft from" className={INPUT_CLS} />
              <Button kind="ai" size="sm" disabled={drafting} onClick={() => void draftFromSite()}>
                {drafting ? 'Drafting…' : 'Draft from website'}
              </Button>
              <Button kind="ghost" size="sm" onClick={() => setOpen(true)}>Start blank</Button>
            </div>
          }>
          Paste your website and we'll draft it for you — you review every field before anything is saved.
        </EmptyState>
      )}

      {phase === 'ready' && (hasRow || dirty) && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          {palette.length > 0 && (
            <div className="flex items-center gap-1.5">
              {palette.map((hex, i) => (
                <span key={i} title={hex} className="w-6 h-6 rounded-md border border-dt-border-strong" style={{ background: hex }} />
              ))}
            </div>
          )}
          {(brand.typography.headline || brand.typography.body) && (
            <span className="text-sm text-dt-support">
              {[brand.typography.headline, brand.typography.body].filter(Boolean).join(' · ')}
            </span>
          )}
          <Chip tone={filledSections.length === SECTIONS.length ? 'ok' : 'neutral'}>
            {filledSections.length} of {SECTIONS.length} sections filled
          </Chip>
          {dirty && <Chip tone="warn">unsaved changes</Chip>}
        </div>
      )}

      {phase === 'ready' && msg && !open && <Banner tone={msg.tone} className="mt-4">{msg.text}</Banner>}
      {editor}
    </PanelCard>
  );
}
