# Per-tenant Brand Identity — design (approved 2026-08-10)

Founder approval: full spec depth, all consumers phased, AI website-extract assist included.

## Problem

`tenant_branding` (mig 247) themes the app — one accent + surface family. Nothing
describes the tenant's *company* — logo, palette, fonts, tone of voice, contact
identity — so DE work products (chase emails, support replies, invoices,
documents) cannot wear the tenant's brand. Global feature: every tenant gets it
via baseline, no flags.

## Phase 1 (this build)

**Data.** New table `tenant_brand_identity` (666): `tenant_id` PK → tenants,
`brand jsonb` (sections: overview, colors, typography, logo, voice, contact,
outputs), `updated_by`, `updated_at`. RLS: tenant-scoped SELECT via
`auth_tenant_id()`. Writes ONLY through `set_tenant_brand_identity(p_brand jsonb)`
— SECURITY DEFINER, tenant derived from auth (never a parameter), role gate
`tenant_owner`/`tenant_admin`, strict validation: known top-level sections only,
hex fields must match `^#[0-9a-f]{6}$`, size cap 20 KB. EXECUTE revoked from
public/anon/authenticated then granted to authenticated + service_role
(migs 610+630 rule).

**UI.** `BrandIdentityCard` (src/design/) on Company Setup beside BrandingCard.
Summary view: logo, palette swatches, font names, section-completeness meter.
"Edit brand identity" opens a Drawer with a TabBar section per spec area.
Empty state action: "Draft it from your website". Primitives + dt tokens only;
four states; drift check before ship.

**AI assist.** New edge function `brand-extract` (new file — cannot clobber
parallel sessions' functions). Caller = signed-in user (JWT verified). Fetches
the given URL server-side, extracts text/colors, LLM drafts the brand JSON.
Returns a draft only — nothing persisted until the user reviews and saves via
the RPC.

## Phase 2 (follow-up)

One resolver (`get_tenant_brand_identity` or direct select) feeding outbound
email composition (dunning chases, support replies): tone, sign-off, footer.
Sequenced separately because those senders are active parallel-session surfaces.

## Phase 3 (follow-up)

Generated documents/invoices carry logo, colors, letterhead, invoice footer.

## First user

Outsourcetel: run the website assist on outsourcetel.com, founder approves,
saved as tenant row; approved values mirrored into the local brand-applicator
skill so agent-produced assets match product output.

## Parallel-session rules for this build

Migration numbered 665 (664 belongs to another session, uncommitted; filename is
identity). Never touch scripts/certify*.mjs (another session's edits). Commit
only this feature's files. Fetch + rebase before any deploy; new edge function
only.
