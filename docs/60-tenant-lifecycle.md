# 60 — Workstream Q: tenant lifecycle & commercial machinery (2026-08-18)

Every transition a paying customer travels, driven live on the disposable Review Lab tenant.
This workstream also **corrects an overstatement in docs/56**.

## 1. The lifecycle, transition by transition

| # | Transition | Verdict | Evidence |
|---|---|---|---|
| 1 | **provision** (signup → workspace) | 🟢 proven | doc 50 — real `complete_signup` path, baseline employees auto-provision |
| 2 | **operate** (trial) | 🟢 proven | intake accepted, HTTP 200 |
| 3 | **suspend** | 🟢 proven | status → `suspended` |
| 4 | **suspended: work actually stops** | 🟢 **proven by refusal** | intake answers **HTTP 402 `tenant_suspended`** — an active refusal, not silence |
| 5 | **suspended: runtime starves too** | 🟢 proven | `claim_de_work_items` yields **0 items** for a suspended tenant |
| 6 | **resume** | 🟢 proven | status restored, intake back to HTTP 200 |
| 7 | **delete — guards** | 🟢 proven | refused for a non-platform caller; refused with no authenticated identity |
| 8 | **delete — execution** | ⚪ **not exercised** | needs a platform-admin identity; see §4 |

**8 of 8 attempted checks passed.**

### Why check 4 matters more than it looks

Project memory records the dormancy trap: *"with dedup, 'nothing happened' proves nothing."* A
suspended tenant that simply produced no rows would be indistinguishable from a broken probe. It
does not: it **refuses, with a specific code and a human-readable reason**. That is a positive
control, and it is the right shape.

## 2. `delete_tenant` — a genuinely well-built destructive path

Read in full. Before it removes anything it requires **all** of:

* an authenticated caller, holding the platform capability `tenants.manage`
* the tenant **already suspended** — *"suspend the tenant before deleting it — deletion is
  permanent and irreversible"*
* `p_confirm_slug` matching the tenant slug **exactly**
* no sub-tenants remaining
* not the demo tenant, and **not the caller's own tenant**

Then it **counts the rows it is about to destroy, before destroying them**, and writes a receipt.
The comment says why, and it is the discipline this project preaches: *"rows removed on a receipt
has to be a measurement, not an inference from a post-delete count of zero."*

Two guards were probed live and both fired correctly (checks 7 above).

## 3. Correction to docs/56

> docs/56 §5 stated the product **"cannot honour a deletion request."** That is too strong, and
> this workstream withdraws it.

The accurate statement is narrower and more useful:

| Capability | Reality |
|---|---|
| Delete an entire customer workspace | ✅ **exists, guarded, receipted** — manual, platform-admin |
| Automated retention for telemetry | ✅ **exists** — `otel-spans-prune`, `adjudication-retention`, `dispatch-log-prune`, all daily |
| Erase **one person's** data on request | ❌ **no function exists** (`forget_de_memory` and `redact_old_adjudications` are neither) |
| Retention policy for customer **content** | ❌ none — conversations, messages and knowledge are kept indefinitely |

So: a customer can be offboarded; **a data subject cannot be forgotten.** Filed as register
**A-7**.

Exposure is small *today* — only **7 conversations** carry end-user identifiers, because the
external channels are barely used. That is a reprieve, not a defence: it grows with the first real
pilot, and lighting the email channel (D-9) grows it immediately.

## 4. The one untested transition, and why I stopped

Executing a real `delete_tenant` requires a caller holding `tenants.manage`. I did **not** grant
that capability to a test identity: doing so would escalate privileges on production to make a
test pass, which is exactly the move this review exists to catch elsewhere.

**Proposal, needs founder go-ahead:** create a second throwaway tenant, and either (a) run the
deletion as an existing platform admin, or (b) authorise a temporary capability grant that is
revoked in the same session. Review Lab itself should be **kept** — docs 50, 58 and this document
cite its rows as evidence.

## 5. Commercial machinery on the lifecycle

| Item | State |
|---|---|
| Plan / subscription rows | 🔴 `tenant_billing_config` = **0 rows** (docs/56) |
| Price on anything | 🔴 `tenant_outcome_pricing` = **0 rows** |
| AI budget ceiling | 🟢 set on **18/18** tenants and enforced (docs/59) |
| Suspension stops spend | 🟢 implied and now evidenced — no intake, no work claimed |
| Trial → paid transition | ⚪ untestable — there is no paid state to move to |

**No money-math errors were found, because no money math runs yet.** The `trial` state exists in
the vocabulary (`active | suspended | trial`) and Review Lab sits in it, but nothing converts a
trial into a paying account because no plan or price exists.

## 6. Verdict

**The lifecycle is the healthiest subsystem this review has examined.** Every transition that can
be tested without escalating privileges passes, suspension is a real refusal rather than a
silence, and the destructive path is better guarded than most production systems I would expect at
this stage.

Two gaps carry forward, and neither is a lifecycle defect:

1. **Per-person erasure** (A-7) — a compliance gap, ranked with docs/56 §5 for counsel.
2. **Nothing to bill** — the trial state has no paid state to graduate into. That is the docs/56
   billing blocker, seen from the lifecycle end.
