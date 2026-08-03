# 40 — Native Top-5 Integration Program (+ MCP long tail)

**Status:** PLAN, awaiting founder phase pick. Nothing built beyond what's marked live.
**Date:** 2026-07-30
**Directive (founder):** identify the top 5 systems in each category and make them true
native integrations where the customer needs *only an API key* — with MCP as the
supported extension path for everything else.

---

## 1. The quality ladder (what "native" honestly means)

| Level | Meaning | Customer experience |
|---|---|---|
| **L3 — Full native** | key-only wizard + live test + category reads + **governed write actions** (gated, audited, human-approved) + health | "Paste key → your workforce reads AND acts, under approval" |
| **L2 — Native reads** | key-only wizard + live test + category reads; no write actions yet | "Paste key → your workforce sees, cites, answers" |
| L1 — Registered | listed in the wizard, adapter honest-not-built | "Registers now" |
| L0 — Absent | not listed | → MCP / template builder / generic REST |

**Current truth (audited from the live code, not the marketing flag):** ~66 providers at
L2, only **8 at L3** (zendesk, freshdesk, servicenow, slack, github, gitlab, asana,
erpnext). The moat is the governed *action* — so the program's center of gravity is
promoting top-5 systems from L2 → L3, not adding more L2 logos.

## 2. Top 5 per category — SMB-weighted, mapped to today's ladder

Picks are from stable market knowledge; per-provider API-openness gets a live check at
build time (standing rule: API-openness beats popularity). ★ = has native reads today.

| Category | Top 5 (SMB) | Today | Gap to close |
|---|---|---|---|
| **CRM** | HubSpot★, Salesforce★, Pipedrive★, Zoho CRM, Dynamics★ | 4/5 at L2 | → L3 writes for HubSpot + Salesforce + Pipedrive; **build Zoho CRM** |
| **Helpdesk** | Zendesk★(L3), Freshdesk★(L3), Intercom★, Zoho Desk, Gorgias★ | 2 L3, 2 L2 | → L3 for Intercom + Gorgias; **build Zoho Desk** |
| **Knowledge** | Notion★, Confluence★, SharePoint★, Google Drive★, Guru★ | 5/5 at L2 | reads suffice for KB (writes rare) — polish sync; optional L3 later |
| **ERP / Financials** | QuickBooks★, Xero★, ERPNext★(L3), NetSuite★, Sage | 1 L3, 3 L2 | → L3 for QuickBooks + Xero (AR ingest + dunning, the proven ERPNext pattern); **build Sage** (or Zoho Books) |
| **Billing** | Stripe★, QuickBooks★, Chargebee, Square★, Recurly | 3/5 at L2 | → L3 for Stripe (refund/credit gated); **build Chargebee** (Recurly via MCP first) |
| **Payroll / HCM** | Gusto★, BambooHR★, ADP, Rippling, Deel | 2/5 at L2 | → L3 for Gusto + BambooHR (time-off approve = naturally gated); ADP/Rippling/Deel APIs are partner-gated — **MCP first**, native later if demand |
| **POS** | Square★, Shopify★, Toast★, Clover, Lightspeed | 3/5 at L2 | → L3 for Square + Shopify; **build Clover**; Lightspeed via MCP |
| **Product system** | (customer's own product) | generic_rest + template builder | this category's "top 5" IS the long tail → **MCP + template builder are the answer** |

Missing-adapter shortlist that actually cracks a top-5: **Zoho family (CRM/Desk — one
auth), Sage, Chargebee, Clover.** Everything else top-5 already has native reads.

## 3. The MCP leg ("PLUS MCP option")

Already founder-approved + designed (docs/mcp-governed-connector-design.md; reference
server live and proven). MCP is the *governed* long-tail: any allowlisted MCP server's
tools become gated action_definitions (annotations→risk, fail-safe destructive). This is
what makes "top 5 native, everything else still supported" an honest sentence — the
6th-through-Nth system in every category connects via MCP **under the same gate**.
Remaining: tasks #18–21 (M1 annotations capture + provider, M2 governed call path, M3/M4
DE exposure + UI). ~4–6 sessions.

## 4. UI changes (small — the wizard already does key-only)

- Category landing: show the **top-5 rail** first with capability badges ("reads · acts
  (gated)" vs "reads"), long tail behind search, MCP + template builder as the explicit
  "not listed?" path.
- Badges derive from the ladder (L3/L2), not a hand-set flag — no overselling.
- Reconnect/Remove + in-place reconnect already shipped.

## 5. Phases (each provider promotion = the proven ERPNext playbook: action_definitions
rows + native executor + gate proof + write-back proof)

| Phase | Scope | Sessions (est.) |
|---|---|---|
| **P1 — Money + CRM writes** ✅ **SHIPPED 2026-07-30** (migs 539+540, commits 59cdbbd/d024538) | L3 for HubSpot, Salesforce, QuickBooks, Xero, Stripe. 11 platform action_definitions on canonical category keys; native executors deployed. Native-write providers 9 → 14. ⚠ per-provider write-proofs are built-unverified (R3) until each connector exists | done |
| **P2 — MCP governed connector** ✅ **M1+M2 SHIPPED 2026-08-04** (mig 541, commit 32ee618) | the long tail now inherits the gate: any allowlisted MCP server's tools register as tenant-scoped gated actions, risk derived fail-safe from annotations. M3/M4 shipped 2026-08-04 (commit 4951fc5): tools reach DEs automatically, and an MCP server is connectable from the wizard with one-click tool registration. Only the allowlist admin UI remains | done |
| **P3 — Support + people writes** ✅ **SHIPPED 2026-08-04** (mig 542, commit 69160d9) | L3 for Intercom, Gorgias, BambooHR, Square, Shopify — 9 actions. Intercom/Gorgias reuse the canonical helpdesk keys; BambooHR/Square/Shopify establish the payroll_hcm + pos write vocabulary. ⚠ **Gusto omitted on purpose**: read-centric API, payroll-grade writes — stays reads-only until a safe write is verified against a real account | done (5 of 6) |
| **P4 — Missing top-5 adapters** ✅ **SHIPPED 2026-08-04** (migs 543+544, commit 8ab9502) | Chargebee, Clover, Zoho CRM, Zoho Desk — reads + category translators, all connectable with customer-held credentials (Zoho via self-client, own refresh helper, DC-aware). **⚠ SAGE NOT BUILT** — needs a registered developer app + redirect OAuth, so it can't be connected by pasting credentials; that's a founder/commercial decision. Also fixed a latent bug blocking ~40 "leave the URL blank" providers from ever saving | done (4 of 5) |
| **P5 — Top-5 rail UI + badges** ✅ **SHIPPED 2026-08-04** (commit 5d4e22a) | wizard leads with "Most used for {category}", long tail under "Everything else"; each card badged **reads · acts (approval-gated)** vs **reads only**, DERIVED live from registered platform-scope action_definitions (never a hand-set flag → cannot over-claim; degrades to "reads only" if the lookup fails) | done |

P1 and P2 are independent — can interleave. Recommended order: **P1 → P2 → P5 → P3 → P4**
(money/CRM writes prove the moat where customers feel it; MCP then honestly covers
everything the natives don't; the rail makes it visible; then breadth).

## 6. Founder decisions — LOCKED 2026-07-30

| # | Decision | **Ruling** |
|---|---|---|
| D1 | Ladder + top-5 map (§1–2) | **APPROVED** |
| D2 | Phase order | **P1 → P2 → P5 → P3 → P4** |
| D3 | Zoho/Sage/Chargebee/Clover | **Build native in P4**; MCP bridges meanwhile |
| D4 | Start | **GO — P1 begins with HubSpot writes** |

> P1 proof dependency (R3): live write-proofs need each provider connected with real
> credentials. HubSpot's is the founder's private-app token (being added via the UI);
> until connected, P1 HubSpot code is **built-unverified**, proven the moment the
> connector exists.
