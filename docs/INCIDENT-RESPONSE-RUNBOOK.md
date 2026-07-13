# Security Incident Response Runbook — STARTER TEMPLATE

> ⚠️ **Starter template, not legal advice.** Review with counsel/compliance
> before adoption. Covers general security incidents and the HIPAA breach path
> for PHI. Bracketed `[…]` items are company decisions (names, channels, times).

**Owner:** [HIPAA Security Officer]  **Incident Commander (IC):** [name / on-call rotation]
**Report an incident NOW:** [#security-incidents Slack / security@outsourcetel.com / phone]
**Do this the moment you suspect one — do not investigate alone or stay quiet.**

---

## 0. What counts as an incident

Any suspected or actual: unauthorized access to PHI/data, credential leak,
cross-tenant data exposure, lost/stolen device with access, connector
mis-scope exposing data, malware, ransomware, or availability loss affecting PHI.
**When in doubt, report it** — over-reporting is free; silence is the risk.

## 1. Roles (assign real people)

| Role | Who | Does |
|---|---|---|
| **Incident Commander** | [name] | Owns the response, decisions, timeline. |
| **Security/Eng lead** | [name] | Investigates, contains, remediates. |
| **Privacy/Legal** | [name/counsel] | Breach determination + notifications. |
| **Comms** | [name] | Customer/regulator/public messaging. |
| **Scribe** | [name] | Timestamped log of everything (below). |

## 2. The 6 phases

### 1) Detect & report
Sources: the **immutable audit log** (`verify_audit_chain` — run it; if it
fails, treat as tampering), Sentry error monitoring, Supabase logs, connector
health, a customer report, or a workforce report. Whoever notices → notify the
IC immediately via [channel].

### 2) Triage & declare (target: within [1 hour])
IC assigns severity:
- **SEV-1** — confirmed PHI exposure, cross-tenant leak, or active attacker.
- **SEV-2** — credential leak / vulnerability with likely exposure, no confirmation yet.
- **SEV-3** — contained/no-exposure security event.
Open an incident record; the Scribe starts a **timestamped timeline** (discovery
time is legally important — the 60-day clock starts at *discovery*).

### 3) Contain (stop the bleeding first)
Concrete levers available in DreamTeam:
- **Revoke connector credentials** — disconnect the affected connector (secrets
  are Vault-stored and purged on disconnect).
- **Rotate secrets** — Anthropic key, connector tokens, Supabase keys as needed.
- **Suspend the affected tenant** (`status='suspended'`) and/or disable the DE.
- **Tighten/revoke data-access grants** (migration 029) to cut a DE's reach.
- **Force session invalidation / revoke API keys** (Security page).
- Preserve evidence: **do not delete logs**; the audit chain is append-only —
  export it for the record.

### 4) Eradicate & recover
Remove the root cause (patch, fix the mis-scope, close the vuln), verify the
audit chain is intact, restore from clean backup if integrity is in doubt,
confirm no persistence, then restore normal access.

### 5) Breach determination (PHI only — Privacy/Legal leads)
Run the HIPAA **4-factor risk assessment** to decide if it's a *reportable
breach* of unsecured PHI:
1. Nature/extent of PHI involved (identifiers, sensitivity).
2. Who used/received it.
3. Whether PHI was actually acquired/viewed.
4. Extent to which risk has been mitigated.
**Encryption safe harbor:** if the PHI was encrypted to HHS/NIST standards and
the key wasn't compromised, it is generally *not* a reportable breach — this is
why our at-rest (Vault) + in-transit (TLS) encryption matters.

### 6) Notify (if a reportable breach — strict clocks)
As a **Business Associate**, DreamTeam's primary duty is to the **Covered
Entity**:
- **Covered Entity:** without unreasonable delay, **≤ 60 days** from discovery,
  with the details they need to make their own notifications.
- The Covered Entity then notifies **individuals (≤ 60 days)**, **HHS**, and —
  if **≥ 500 individuals** — prominent **media** and HHS contemporaneously.
- Follow the specific timelines and content in the **signed BAA** — it may set
  shorter deadlines than the regulation.
- For non-PHI security incidents, follow customer-contract breach terms + any
  state data-breach laws.

## 3. Post-incident (within [5 business days])
Blameless post-mortem: timeline, root cause, what worked, what didn't, and
**action items with owners/dates**. File any code fixes; update this runbook and
the risk analysis with what you learned.

## 4. Quick reference — containment commands / actions
- Disconnect connector → Connectors page → Disconnect (purges Vault secret).
- Suspend tenant → platform console / `set` tenant status suspended.
- Verify audit integrity → run `verify_audit_chain` for the tenant.
- Rotate Anthropic key → Settings → AI Engine (re-`platform_config_set`).
- Revoke sessions / API keys → Security & Access page.

## 5. Contacts
- Security Officer: [____] · Privacy Officer: [____] · Counsel: [____]
- Supabase support: [plan/portal] · Anthropic: [support] · Vercel: [support]
- Cyber-insurance carrier / breach hotline: [____]

*Engineering starter; complete the bracketed items and review with counsel.*
