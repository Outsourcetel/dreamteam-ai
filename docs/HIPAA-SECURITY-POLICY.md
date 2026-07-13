# HIPAA Security & Privacy Policy — STARTER TEMPLATE

> ⚠️ **This is a starter template, not legal advice.** It must be reviewed and
> completed by qualified HIPAA counsel / a compliance professional before it is
> adopted or relied upon. Bracketed `[…]` items are decisions for the company.
> It maps the HIPAA Security Rule safeguards to the controls DreamTeam AI
> actually implements today, and honestly flags the gaps that are
> organizational (policy/training) rather than technical.

**Entity:** [Outsourcetel, Inc.] — acting as a **Business Associate** when
processing Protected Health Information (PHI) on behalf of a Covered Entity
(a healthcare customer) through DreamTeam AI.
**Effective date:** [____]  **Owner:** [HIPAA Security Officer — name/role]
**Review cadence:** at least annually and after any material change.

---

## 1. Scope

Applies to all workforce members, systems, and subprocessors that create,
receive, maintain, or transmit PHI via DreamTeam AI. PHI enters the system
**only** through an authorized healthcare connector (athenahealth, Epic,
Cerner) and **only after** (a) a signed BAA with the covered entity and (b)
signed BAAs with our subprocessors are in force. Until both exist, connecting
a real EHR is prohibited.

## 2. Roles

| Role | Responsibility |
|---|---|
| **HIPAA Security Officer** [name] | Owns this policy, risk analysis, and the safeguards below. |
| **HIPAA Privacy Officer** [name] | Owns minimum-necessary, patient rights, disclosures. |
| **Incident Commander** [name/on-call] | Runs the [Incident-Response Runbook](INCIDENT-RESPONSE-RUNBOOK.md). |
| **Workforce members** | Complete training; report suspected incidents immediately. |

## 3. Subprocessors & their BAAs (must be signed BEFORE any PHI)

| Subprocessor | Role | BAA status |
|---|---|---|
| **Supabase** (database, storage, edge functions) | Stores/processes PHI at rest | [ ] required — request via Team/Enterprise |
| **Anthropic** (Claude API) | DE reasoning sees PHI in prompts | [ ] required — request BAA + enable zero-retention |
| **Vercel** (frontend hosting) | PHI may transit the UI | [ ] required if PHI reaches the client — Enterprise |
| [others] | | |

## 4. Administrative Safeguards (§164.308)

- **Risk analysis & management** [§164.308(a)(1)]: conduct and document a risk
  analysis of PHI flows (connector → Supabase → Anthropic → UI) **before
  go-live**; re-run annually and after material changes. *(Status: to do.)*
- **Sanction policy**: [define consequences for workforce violations].
- **Information-system activity review**: DreamTeam writes an **immutable,
  hash-chained audit log** (`append_audit_event` / `verify_audit_chain`) of
  DE actions and data access. Assign an owner to review it on a [weekly] cadence.
- **Workforce security & clearance**: role-based access; least privilege.
- **Security awareness & training**: all workforce complete HIPAA training at
  hire and annually. *(Status: to do — organizational gap.)*
- **Contingency plan**: backups (Supabase point-in-time recovery [confirm
  plan tier]), documented restore procedure, and the incident runbook.
- **Business Associate contracts**: §3 above; keep a BAA register.

## 5. Physical Safeguards (§164.310)

Primarily satisfied by subprocessors' certified data centers (Supabase/AWS,
Vercel) — reference their SOC 2 / HITRUST attestations. Company-side:
[workstation-use policy, device encryption, clean-desk] for any workforce
member who could view PHI.

## 6. Technical Safeguards (§164.312) — mapped to what DreamTeam has

| Requirement | Status in DreamTeam | Evidence |
|---|---|---|
| **Access control / unique user ID** [§312(a)] | ✅ Real | Per-user auth; unique logins; no shared accounts. |
| **Emergency access** | [ ] define break-glass procedure | — |
| **Automatic logoff** | ✅ Configurable | Session-policy enforcement (Security page). |
| **Encryption at rest** [§312(a)(2)(iv)] | ✅ Real | Secrets in Supabase **Vault** (migration 087/088); DB encryption. |
| **Audit controls** [§312(b)] | ✅ Strong | Immutable **hash-chained** audit log; tamper-evident, verified against superuser tamper attempts. |
| **Integrity** [§312(c)] | ✅ Real | Audit chain + append-only event model. |
| **Person/entity authentication** [§312(d)] | ✅ Real | Auth + **MFA** available (Security page). |
| **Transmission security / encryption in transit** [§312(e)] | ✅ Real | TLS everywhere (Supabase, Anthropic, connectors); SSRF-guarded outbound. |
| **Minimum necessary / need-to-know** | ✅ **Differentiator** | **Default-deny data-access grants** (migration 029): a DE can access only the systems/scopes explicitly granted — a support DE cannot see financials/PHI by construction, enforced server-side. |

**Honest read:** the *technical* bar is largely met — encryption, audit,
authentication, and (unusually) real least-privilege enforcement already
exist. The gaps are **organizational**: the written risk analysis, workforce
training, sanction/contingency policies, the break-glass procedure, and the
signed BAAs. Those are process, not code.

## 7. Minimum Necessary & the DE

Configure each healthcare DE with the narrowest data-access grant that lets it
do its job. PHI in prompts to Claude must be limited to what the task requires;
prefer de-identified context where possible. Guardrails and the trust dial
gate what a DE may do with PHI.

## 8. Patient Rights (Privacy — coordinate with the Covered Entity)

As a Business Associate, DreamTeam supports the Covered Entity's obligations
(access, amendment, accounting of disclosures, restrictions). Requests are
routed to the Covered Entity; DreamTeam provides the audit trail and data
export needed to fulfill them.

## 9. Breach response

See **[INCIDENT-RESPONSE-RUNBOOK.md](INCIDENT-RESPONSE-RUNBOOK.md)**. Key rule:
notify the Covered Entity **without unreasonable delay and no later than 60
days** after discovery of a breach of unsecured PHI.

## 10. Review & attestation

This policy is reviewed at least annually by the Security Officer. Workforce
members attest to having read it at hire and annually.

*Prepared as an engineering starter; complete with counsel before adoption.*
