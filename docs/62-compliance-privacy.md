# 62 — Workstream N: compliance, privacy & legal readiness (2026-08-18)

What a pilot customer's security review would ask, answered from live production. This is a
readiness assessment, **not legal advice** — it gets you to "ready for counsel", not "cleared".

## 1. Personal data inventory — genuinely small

| Where | Fields | Rows today |
|---|---|---|
| `profiles` | full_name | 23 |
| `vendors` | email | 5 |
| `customers` | email | 4 |
| `de_conversations` | end_user_name, end_user_ref | **7** |
| `end_user_sessions` | display_name, end_user_ref | 5 |
| `customer_account_contacts` | email, phone, end_user_ref | 0 |
| `platform_invites` | email | 0 |

**≈44 personal records in total.** That is a real advantage: the compliance surface is small
enough to fix cheaply *now*. It is small only because the external channels are dark — lighting
email (D-9) changes this immediately, and every figure above becomes a customer's data, not ours.

## 2. Where the data flows — and the disclosure gap (register **A-8**)

**Today, one AI subprocessor receives customer content: Anthropic.** Proven, not assumed: 30-day
usage shows only `claude-sonnet-5`, `claude-haiku-4-5` and `claude-haiku-4-5-20251001`, and no
OpenAI or Google key rows exist in `platform_config`.

**But the code can route to four.** `supabase/functions/_shared/llm.ts` implements a failover
chain — `anthropic → bedrock (AWS) → openai → google` — and its own comment states the rule:
*"A provider is in the chain only when its key is configured (Settings → AI Engine, or env)."*

That is the finding. **The disclosure is pinned to today's configuration, not to the system's
capability.** Setting one key in a settings screen adds a processor to the path that customer
conversations travel — with no policy change, no customer notice, and no gate. The privacy policy
names Anthropic alone.

Other data egress in the codebase: Google Drive / OAuth endpoints (knowledge ingestion — read
paths), and Resend (email, currently dormant).

## 3. Data-subject rights — the real gap (register **A-7**, from docs/60)

| Right | Can we honour it? |
|---|---|
| Delete an entire customer workspace | ✅ `delete_tenant` — guarded, receipted (docs/60) |
| **Erase one person's data on request** | ❌ **no function exists** |
| Export a customer's data | 🟡 `tenant-export` edge function exists — untested by this review |
| Retention limit on customer content | ❌ none — conversations and knowledge kept indefinitely |
| Retention on telemetry | ✅ three daily prune jobs (otel, adjudications, dispatch log) |

A GDPR or CCPA request from an end user (*"delete what you hold about me"*) has **no mechanism**.
At 7 identified conversations that is a morning's work by hand; after a pilot it is not.

## 4. Security posture a questionnaire would probe

| Question | Answer | Evidence |
|---|---|---|
| Tenant isolation | 🟢 **proven by attack** | 21 probes, 0 holes (docs/50 Workstream C) |
| Credentials at rest | 🟢 **Vault references, not plaintext** | `connector_secrets`: 2 rows, **2 vault refs**, 0 raw values — mig 580's plaintext history is remediated |
| Decrypted-secret view exposure | 🟢 permission-denied to tenant users | Workstream C probe |
| Access logging | 🟢 present | 87 platform-access events · 123 data-access grants · 219 remote-access writes logged |
| Audit trail integrity | 🟢 chain verified by `certify` | `audit-chain-verifies-hq` |
| Backups | 🟢 daily, verified | 7/7 snapshots (docs/54) |
| Disaster recovery | 🟡 schema restore proven; **data restore never performed** | docs/54 |
| Point-in-time recovery | 🔴 **off** — up to 24h loss | docs/54 |
| Encryption in transit | 🟢 HTTPS throughout | — |
| Sub-processor list | 🔴 **incomplete** — see A-8 | — |
| DPA | 🔴 does not exist | — |
| SOC 2 | 🔴 not started | not recommended yet |

## 5. The contracts — honest drafts, still unsignable

`TermsOfServicePage` and `PrivacyPolicyPage` are real prose that **name their own gaps** — a
genuinely good sign, and rarer than it should be. Open placeholders, verbatim:

* trial length and what happens when it ends
* limitation-of-liability cap and indemnification
* **governing jurisdiction**
* confirmation of each AI provider's data-processing terms
* *"there is currently no automated retention/deletion window"*

**One item to remove rather than complete:** `docs/HIPAA-SECURITY-POLICY.md` describes a HIPAA
programme that does not exist. A policy document asserting safeguards nobody operates is worse
than silence in a diligence pack — it is the document a plaintiff reads aloud. Either stand the
programme up or delete the file. (The connector catalogue's `athenahealth` entry already carries
the right instinct: *"PHI — a signed BAA is REQUIRED before connecting real patient data."*)

## 6. What to do, in order

1. **Name every possible subprocessor now** (Anthropic, AWS Bedrock, OpenAI, Google) and state
   that failover may route to them — or **gate key-setting** behind an explicit acknowledgement.
   Hours of work; closes A-8 before it can ever bite.
2. **Write `forget_end_user(tenant, end_user_ref)`** — erase or pseudonymise conversations,
   messages and session rows for one subject, with a receipt like `delete_tenant` has. Cheap at 7
   rows; expensive after a pilot.
3. **Set a content retention window** and run it on the cron pattern that already prunes telemetry.
4. **Delete or fulfil the HIPAA policy document.**
5. **Counsel** on jurisdiction, liability cap, indemnity — then a DPA naming (1).

## 7. Verdict

**No compliance finding blocks a *demo*. Two block a signed *pilot*:** an incomplete
sub-processor disclosure and no way to honour an individual's deletion request. Both are hours of
engineering plus a lawyer's afternoon — not architecture.

The underlying posture is better than the paperwork suggests: isolation proven by attack,
credentials in Vault, access logged, audit chain verified, backups running. **The gap is
documentation and one missing function, not a weak system.**
