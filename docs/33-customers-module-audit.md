# 33 — The Customers module: audit, and the ERP question

**Status:** research, 2026-07-27. Measured against the live database and the
repository, not against the roadmap. Nothing here is built.
**Question asked:** should Customers become a small-market ERP, or stay a set of
pages sitting on top of other systems pulling their data?
**Short answer:** neither, and the question rests on a premise the code does not
support. Details below, evidence first.

---

## 1. What is actually there — measured

| table | rows |
|---|---|
| `de_conversations` | **514** |
| `invoices` | 5 |
| `continuity_cases` | 3 |
| `customer_accounts` | **2** |
| `opportunities` | 1 |
| `onboarding_projects` | 1 |
| `de_case_events` | 0 |
| `account_writeback_requests` | **0** |
| `opportunity_writeback_requests` | **0** |
| `invoice_writeback_requests` | **0** |
| `account_activities` | **0** |

Against that, the UI: **5,786 lines** across eleven entity pages, seven of them
`entity_customer*` routes in the nav.

### Three facts that decide the question

**a. No connector has ever synced. Not one.**
22 connectors exist, 20 report `connected` — and `last_sync_at` is **NULL on all
22**. The providers are `generic_rest` (structural), `template` (structural) and
`dreamteam` (the platform managing itself). The single Salesforce row is
`disconnected`.

There is no system of record underneath this module. There never has been.

**b. Every write-back desk writes to our own tables. None reaches an external
system.**
Checked all four — `apply_account_writeback_internal`,
`apply_opportunity_writeback_internal`, `apply_invoice_writeback_internal`,
`apply_continuity_writeback_internal`. Every one performs local `INSERT`/`UPDATE`
against `customer_accounts`, `account_activities` and siblings. **Zero contain an
HTTP call, a connector reference, or any external push.**

A real governed external path does exist — `connector-hub` → `action_executions`,
175 executions recorded. But the customer desks do not use it. They are a
parallel, local-only path.

**c. The Customers module is not connected to the work the product does.**
Of 514 conversations, **0 have an `account_id`**. `account_activities` has never
received a row. 24 objectives exist and **0** came from a mission.

---

## 2. What that means, stated plainly

**The doctrine in `SCALING-ARCHITECTURE.md` §Systems-of-Record says DreamTeam
"never replaces any system of record… actions land IN the SoR — invoice in Zuora,
ticket update in Zendesk."**

For the Customers module, **the code does not do this.** The write-back lands in
our own tables and stops. There is no Zuora, no Zendesk, no Salesforce — and no
sync has ever run to make one available.

So the honest description today is not "a work layer on top of their systems".
It is: **a small ERP schema with a governance wrapper, containing almost no data,
wired to nothing, and disconnected from the digital-employee work that is the
actual product.**

That is not an argument for building an ERP. It is the discovery that **one was
already started by accident**, and that the doctrine has been describing an
integration layer that was never finished.

**This reframes the question.** It is not "ERP or view-layer?". It is: *why does
a 5,786-line module exist that holds 2 accounts, has never synced, has never
written externally, and touches none of the 514 conversations?*

---

## 3. The challenge — where I think the ERP instinct goes wrong

The instinct is understandable and rests on something true: **a small business
has no systems for you to sit on top of.** "Work layer over your SoRs" is
meaningless to a 20-person company that runs on spreadsheets and a shared inbox.
If the buyer has no CRM, someone has to hold the customer record, and it may as
well be us. That is a real gap in the doctrine, which was written for mid-market
and enterprise.

Four reasons I would still not build the ERP.

**1. It contradicts the locked wedge, and not at the edges.**
`docs/24` is founder-locked: **Governed Workforce OS, sold governance-first into
regulated / trust-sensitive mid-market.** A small-business ERP is a different
buyer, a different price point, a different competitor set and a different moat.
Those two products cannot be sold by the same company at this stage. Choosing the
ERP is not an extension of the roadmap of record — it *replaces* it, and it
should be taken as that decision explicitly rather than arrived at through a
module refactor.

**2. ERP is close to the worst market to enter with an AI advantage.**
The moat in ERP is **migration pain**, not intelligence. Odoo is open-source and
free. Zoho runs ~$30/user. NetSuite owns the upper end. Nobody has ever chosen an
ERP for its audit chain, its guardrails or its confidence thresholds — which is
precisely the asset you have spent this quarter building. Entering ERP means
competing on the one axis where you are weakest (breadth of transactional
features, 20 years of edge cases) and getting **zero credit** for the axis where
you are strongest.

**3. It would make the governance moat worth less, not more.**
The judgment layer — audit chain, guardrails, approvals, trust ladder — is
valuable in proportion to *the consequence of the actions it governs*. Governing
a write to a customer's Salesforce or Zuora is worth paying for. Governing a
write to our own empty table is governance theatre. Today the customer desks are
the second kind. Building more of them deepens that, and the diligence a
governance-first buyer runs would find it immediately: they will ask what the
guardrails actually stopped, and the answer would be "an update to a row we own".

**4. The empty tables are not demand — they are the absence of it.**
Two accounts in 5,786 lines of UI is not a module that needs more investment. It
is a module nobody has used, including us, in our own workspace, while running
514 conversations through the product. **Before deciding what Customers should
become, the interesting question is why nothing flowed into it.**

---

## 4. What I would actually do

### The framing that resolves it

The Customers pages were built as if **a human works there** — a CRM surface with
accounts, pipelines, onboarding checklists. But the product thesis is the
opposite: **the digital employee works, and the human governs.** That mismatch,
not the ERP question, is why the module is empty. A human with a CRM does not
need our CRM; a human governing a DE needs to see what the DE did, to whom, and
whether it was allowed.

The SoR doctrine already contains the correct phrase and the code half-implements
it: live tables are a **"working cache / action workspace, never a competing
record."**

### Three options, honestly costed

| | what it is | cost | what it wins | what it risks |
|---|---|---|---|---|
| **A. Build the ERP** | own the customer/financial record for SMB | 18–24 months to Odoo parity | data gravity, lock-in, a buyer with no alternative | abandons the locked wedge; competes on price against free; the governance moat earns nothing |
| **B. Finish the integration layer** | make write-back actually reach Salesforce/Zendesk/Zuora | weeks — the governed action path already exists in `connector-hub` | makes the doctrine TRUE; the governance story becomes demonstrable; unblocks mid-market | still nothing for a buyer with no systems |
| **C. Collapse Customers into the DE work surface** | the account record exists only as a spine to hang DE work on | small — mostly deletion | the module finally matches the thesis; less to maintain; honest | admits the seven-page CRM was a wrong turn |

**My recommendation is C plus B, and explicitly not A.**

- **C**: cut the Customers pages down to *per-account DE work* — what did which
  employee do for this customer, what is pending approval, what did the guardrails
  stop. Delete the pipeline/onboarding CRUD that duplicates a CRM. The account row
  survives as a join key, which is what "working cache" always meant.
- **B**: point the four write-back desks at the real `connector-hub` path so an
  approved action lands in the customer's system. This is the missing last mile,
  and it is the difference between a governance product and a governance demo.
- Revisit **A** only if the founder deliberately changes the wedge — and then as
  a company-level decision with its own GTM, not as a module refactor.

### The SMB objection, answered

If the target really is businesses with no systems, the answer still is not an
ERP. It is: **be the system of record for the WORK, not for the business
objects.** Own the tasks, the decisions, the approvals, the audit chain — the
things nobody else is holding and that no incumbent sells. Do not own the general
ledger, the invoice or the pipeline; those are commodity, and losing that fight
costs the whole company.

---

## 5. What I did not check

- **Whether any live customer has ever wanted this.** N=0 external customers
  ([[project_de_deep_analysis_docs23]]), so the emptiness may reflect pre-PMF
  rather than a design fault. That weakens conclusion 4 and nothing else.
- **The Vendor and Workforce entity pages** (949 lines) — same architectural
  shape, not audited here.
- **Whether the 175 `action_executions` did anything externally observable.**
  They ran against `generic_rest` and `template` connectors, which the connector
  memory records as *structural until real credentials*. So "175 governed actions"
  is unlikely to mean 175 real-world effects, but I did not confirm that.
