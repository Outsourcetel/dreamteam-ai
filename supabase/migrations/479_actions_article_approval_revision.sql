-- 479_actions_article_approval_revision.sql
-- The eval gate's ONE persistent partial under the docs/36 middle-path rule:
-- "Can a Digital Employee take actions in my systems?" judged partial on BOTH
-- 07-25 and 07-27 for omitting the APPROVAL component. The rule's own standard
-- says a gap that survives two draws is real — and the article's opening
-- genuinely buried it (the word appeared first at char 992). This publishes a
-- REVISION (previous_version_id lineage — the gate-exempt fix path BY DESIGN)
-- lifting approval gating into the head: approval tasks, destructive-always-
-- gates, trust-dial-decides — each claim verified against the live gate order
-- (mig 459 asserts) this week. Repo file is the source; this SQL is generated.

do $rev$
declare
  v_old knowledge_docs;
  v_new_id uuid;
begin
  select * into v_old from knowledge_docs d
   where d.external_ref = 'product-kb/connectors/actions-what-des-can-do-in-your-systems'
     and d.is_current
     and d.tenant_id = (select id from tenants where slug='outsourcetel-hq');
  if v_old.id is null then raise exception '479: current actions article not found'; end if;

  -- free the (tenant, source, ref) key, archive the old version
  update knowledge_docs set is_current = false, lifecycle_status = 'archived', external_ref = null
   where id = v_old.id;

  insert into knowledge_docs (
    tenant_id, title, content, source, tags, account_id, external_ref, visibility,
    previous_version_id, is_current, authority, share_archetype_key, owner_user_id,
    review_interval_days, expires_at, inherits_access, restricted_space_id,
    lifecycle_status, content_hash)
  values (
    v_old.tenant_id, $t$Actions — what a DE can do in your systems$t$, $c$# Actions — what a DE can do in your systems

## What it is
Beyond reading, a connector can let a Digital Employee **act** in a system — for example **add an internal note** to a ticket, **update a ticket's status**, **post a reply**, **add tags**, or **post a message**. Each action writes back into your system of record, and each one is governed before it runs: an action that needs a person's sign-off waits as an **approval task** in Approvals & Drafts, destructive actions **always** require human approval, and the trust dial decides which safe actions may run on their own.

## Why it matters
Reading answers questions; acting closes the loop. But writing into a live system is where trust matters most. DreamTeam makes actions **explicit, previewable, and governed**: you choose which actions are enabled, risky ones always require a human approval, and every execution leaves a plain-language receipt in the audit trail.

## How actions are governed
When a DE tries to run an action, DreamTeam applies three checks in order:

1. **Access check** — the connector must permit write-back for that action.
2. **Destructive-always-gates** — if the action is flagged **destructive**, it *always* pauses for human approval, no matter how trusted the DE is. This check runs first and unconditionally.
3. **Guardrails, then trust** — your guardrail rules can block or gate an action; within what's allowed, the DE's trust level decides whether it auto-executes or waits for approval.

An action that's gated becomes a **human task** with the full request attached — for a reply, that includes the exact text the customer would see — so a person approves the real thing, not a summary.

## Preview vs execute
- **Preview** renders the exact request (method, URL, and body) and a plain-language **receipt preview** — *without calling the external system*. It has no side effects beyond a lightweight traceability record. Use it to see precisely what would happen.
- **Execute** runs the governance checks above and, when allowed (auto-executed by a trusted DE, or after a human approves the gated task), actually calls the system and returns a **receipt** describing what was done — for example *"Added an internal note to ticket #1234 (not visible to the customer)"* or *"Posted a public reply on ticket #1234 — the customer will see it."*

## Risk flags travel with every action
Each action carries two honest annotations:
- **Destructive** — has an outward or hard-to-undo effect (a public reply is destructive; an internal note is not). Destructive actions always require approval.
- **Idempotent** — safe to repeat without piling up side effects (adding tags in an append-safe way is idempotent).

These flags let the interface state honestly whether an action *"always requires approval"* or *"currently auto-executes once trusted."*

## Enabling actions (Zendesk example)
For Zendesk, the connector card shows a **Write-back actions — into the system of record** row. Each action (for example **Add internal note**, **Update ticket status**) is a toggle you switch **on** or **off**. A disabled action is refused with *"This write-back action is disabled in the registry."* Registered actions for other providers are governed the same way through the generalized action layer.

## Step by step — see and control what a DE can do
1. Open **Connectors** and find the connector card.
2. For Zendesk, review the **Write-back actions** toggles and enable only the ones you want the DE to perform.
3. Set your **Guardrails** (in Governance) to block or require approval for anything sensitive — guardrails always win over trust.
4. When a DE proposes a destructive or gated action, approve or reject it in **Approvals / Human tasks**, where you can read the full draft before deciding.
5. Review executed actions and their receipts in the **Audit Trail**.

## Tips & best practices
- Enable the least you need. An internal note is low-risk; a public reply is customer-facing — keep it gated until you trust the DE's drafts.
- Use **preview** to sanity-check a new action's exact request before letting it run.
- Lean on **guardrails** for hard rules (e.g. "no unilateral refund promises") — they hold regardless of trust level.
- Raise a DE's trust gradually; "promote slow, demote fast." Trust only ever narrows *within* what guardrails and the destructive flag already allow.

## Troubleshooting
- **Action didn't run, became a task instead** — it's destructive or your guardrails/trust gated it. Approve it in Human tasks.
- **"This write-back action is disabled in the registry."** — enable the action's toggle on the connector card.
- **"No native execution path"** for an action — that action isn't implemented for this provider yet.
- **Nothing changed in my system** — check you ran **execute**, not **preview** (preview never calls the system).

## Related articles
- connecting-your-first-system
- custom-api-connector
- fetch-vs-ingest-modes
- how-credentials-are-kept-safe
$c$, v_old.source, v_old.tags, v_old.account_id,
    'product-kb/connectors/actions-what-des-can-do-in-your-systems', v_old.visibility, v_old.id, true, v_old.authority, v_old.share_archetype_key,
    v_old.owner_user_id, v_old.review_interval_days, v_old.expires_at, v_old.inherits_access,
    v_old.restricted_space_id, 'published', encode(digest($c$# Actions — what a DE can do in your systems

## What it is
Beyond reading, a connector can let a Digital Employee **act** in a system — for example **add an internal note** to a ticket, **update a ticket's status**, **post a reply**, **add tags**, or **post a message**. Each action writes back into your system of record, and each one is governed before it runs: an action that needs a person's sign-off waits as an **approval task** in Approvals & Drafts, destructive actions **always** require human approval, and the trust dial decides which safe actions may run on their own.

## Why it matters
Reading answers questions; acting closes the loop. But writing into a live system is where trust matters most. DreamTeam makes actions **explicit, previewable, and governed**: you choose which actions are enabled, risky ones always require a human approval, and every execution leaves a plain-language receipt in the audit trail.

## How actions are governed
When a DE tries to run an action, DreamTeam applies three checks in order:

1. **Access check** — the connector must permit write-back for that action.
2. **Destructive-always-gates** — if the action is flagged **destructive**, it *always* pauses for human approval, no matter how trusted the DE is. This check runs first and unconditionally.
3. **Guardrails, then trust** — your guardrail rules can block or gate an action; within what's allowed, the DE's trust level decides whether it auto-executes or waits for approval.

An action that's gated becomes a **human task** with the full request attached — for a reply, that includes the exact text the customer would see — so a person approves the real thing, not a summary.

## Preview vs execute
- **Preview** renders the exact request (method, URL, and body) and a plain-language **receipt preview** — *without calling the external system*. It has no side effects beyond a lightweight traceability record. Use it to see precisely what would happen.
- **Execute** runs the governance checks above and, when allowed (auto-executed by a trusted DE, or after a human approves the gated task), actually calls the system and returns a **receipt** describing what was done — for example *"Added an internal note to ticket #1234 (not visible to the customer)"* or *"Posted a public reply on ticket #1234 — the customer will see it."*

## Risk flags travel with every action
Each action carries two honest annotations:
- **Destructive** — has an outward or hard-to-undo effect (a public reply is destructive; an internal note is not). Destructive actions always require approval.
- **Idempotent** — safe to repeat without piling up side effects (adding tags in an append-safe way is idempotent).

These flags let the interface state honestly whether an action *"always requires approval"* or *"currently auto-executes once trusted."*

## Enabling actions (Zendesk example)
For Zendesk, the connector card shows a **Write-back actions — into the system of record** row. Each action (for example **Add internal note**, **Update ticket status**) is a toggle you switch **on** or **off**. A disabled action is refused with *"This write-back action is disabled in the registry."* Registered actions for other providers are governed the same way through the generalized action layer.

## Step by step — see and control what a DE can do
1. Open **Connectors** and find the connector card.
2. For Zendesk, review the **Write-back actions** toggles and enable only the ones you want the DE to perform.
3. Set your **Guardrails** (in Governance) to block or require approval for anything sensitive — guardrails always win over trust.
4. When a DE proposes a destructive or gated action, approve or reject it in **Approvals / Human tasks**, where you can read the full draft before deciding.
5. Review executed actions and their receipts in the **Audit Trail**.

## Tips & best practices
- Enable the least you need. An internal note is low-risk; a public reply is customer-facing — keep it gated until you trust the DE's drafts.
- Use **preview** to sanity-check a new action's exact request before letting it run.
- Lean on **guardrails** for hard rules (e.g. "no unilateral refund promises") — they hold regardless of trust level.
- Raise a DE's trust gradually; "promote slow, demote fast." Trust only ever narrows *within* what guardrails and the destructive flag already allow.

## Troubleshooting
- **Action didn't run, became a task instead** — it's destructive or your guardrails/trust gated it. Approve it in Human tasks.
- **"This write-back action is disabled in the registry."** — enable the action's toggle on the connector card.
- **"No native execution path"** for an action — that action isn't implemented for this provider yet.
- **Nothing changed in my system** — check you ran **execute**, not **preview** (preview never calls the system).

## Related articles
- connecting-your-first-system
- custom-api-connector
- fetch-vs-ingest-modes
- how-credentials-are-kept-safe
$c$, 'sha256'), 'hex'))
  returning id into v_new_id;

  insert into knowledge_doc_chunks (tenant_id, doc_id, chunk_index, content, content_hash)
  values (v_old.tenant_id, v_new_id, 0, $k$# Actions — what a DE can do in your systems

## What it is
Beyond reading, a connector can let a Digital Employee **act** in a system — for example **add an internal note** to a ticket, **update a ticket's status**, **post a reply**, **add tags**, or **post a message**. Each action writes back into your system of record, and each one is governed before it runs: an action that needs a person's sign-off waits as an **approval task** in Approvals & Drafts, destructive actions **always** require human approval, and the trust dial decides which safe actions may run on their own.

## Why it matters
Reading answers questions; acting closes the loop. But writing into a live system is where trust matters most. DreamTeam makes actions **explicit, previewable, and governed**: you choose which actions are enabled, risky ones always require a human approval, and every execution leaves a plain-language receipt in the audit trail.

## How actions are governed
When a DE tries to run an action, DreamTeam applies three checks in order:

1. **Access check** — the connector must permit write-back for that action.
2. **Destructive-always-gates** — if the action is flagged **destructive**, it *always* pauses for human approval, no matter how trusted the DE is. This check runs first and unconditionally.
3. **Guardrails, then trust** — your guardrail rules can block or gate an action; within what's allowed, the DE's trust level decides whether it auto-executes or waits for approval.$k$, encode(digest($k$# Actions — what a DE can do in your systems

## What it is
Beyond reading, a connector can let a Digital Employee **act** in a system — for example **add an internal note** to a ticket, **update a ticket's status**, **post a reply**, **add tags**, or **post a message**. Each action writes back into your system of record, and each one is governed before it runs: an action that needs a person's sign-off waits as an **approval task** in Approvals & Drafts, destructive actions **always** require human approval, and the trust dial decides which safe actions may run on their own.

## Why it matters
Reading answers questions; acting closes the loop. But writing into a live system is where trust matters most. DreamTeam makes actions **explicit, previewable, and governed**: you choose which actions are enabled, risky ones always require a human approval, and every execution leaves a plain-language receipt in the audit trail.

## How actions are governed
When a DE tries to run an action, DreamTeam applies three checks in order:

1. **Access check** — the connector must permit write-back for that action.
2. **Destructive-always-gates** — if the action is flagged **destructive**, it *always* pauses for human approval, no matter how trusted the DE is. This check runs first and unconditionally.
3. **Guardrails, then trust** — your guardrail rules can block or gate an action; within what's allowed, the DE's trust level decides whether it auto-executes or waits for approval.$k$, 'sha256'), 'hex'));
  insert into knowledge_doc_chunks (tenant_id, doc_id, chunk_index, content, content_hash)
  values (v_old.tenant_id, v_new_id, 1, $k$d unconditionally.
3. **Guardrails, then trust** — your guardrail rules can block or gate an action; within what's allowed, the DE's trust level decides whether it auto-executes or waits for approval.

An action that's gated becomes a **human task** with the full request attached — for a reply, that includes the exact text the customer would see — so a person approves the real thing, not a summary.

## Preview vs execute
- **Preview** renders the exact request (method, URL, and body) and a plain-language **receipt preview** — *without calling the external system*. It has no side effects beyond a lightweight traceability record. Use it to see precisely what would happen.
- **Execute** runs the governance checks above and, when allowed (auto-executed by a trusted DE, or after a human approves the gated task), actually calls the system and returns a **receipt** describing what was done — for example *"Added an internal note to ticket #1234 (not visible to the customer)"* or *"Posted a public reply on ticket #1234 — the customer will see it."*

## Risk flags travel with every action
Each action carries two honest annotations:
- **Destructive** — has an outward or hard-to-undo effect (a public reply is destructive; an internal note is not). Destructive actions always require approval.
- **Idempotent** — safe to repeat without piling up side effects (adding tags in an append-safe way is idempotent).$k$, encode(digest($k$d unconditionally.
3. **Guardrails, then trust** — your guardrail rules can block or gate an action; within what's allowed, the DE's trust level decides whether it auto-executes or waits for approval.

An action that's gated becomes a **human task** with the full request attached — for a reply, that includes the exact text the customer would see — so a person approves the real thing, not a summary.

## Preview vs execute
- **Preview** renders the exact request (method, URL, and body) and a plain-language **receipt preview** — *without calling the external system*. It has no side effects beyond a lightweight traceability record. Use it to see precisely what would happen.
- **Execute** runs the governance checks above and, when allowed (auto-executed by a trusted DE, or after a human approves the gated task), actually calls the system and returns a **receipt** describing what was done — for example *"Added an internal note to ticket #1234 (not visible to the customer)"* or *"Posted a public reply on ticket #1234 — the customer will see it."*

## Risk flags travel with every action
Each action carries two honest annotations:
- **Destructive** — has an outward or hard-to-undo effect (a public reply is destructive; an internal note is not). Destructive actions always require approval.
- **Idempotent** — safe to repeat without piling up side effects (adding tags in an append-safe way is idempotent).$k$, 'sha256'), 'hex'));
  insert into knowledge_doc_chunks (tenant_id, doc_id, chunk_index, content, content_hash)
  values (v_old.tenant_id, v_new_id, 2, $k$destructive; an internal note is not). Destructive actions always require approval.
- **Idempotent** — safe to repeat without piling up side effects (adding tags in an append-safe way is idempotent).

These flags let the interface state honestly whether an action *"always requires approval"* or *"currently auto-executes once trusted."*

## Enabling actions (Zendesk example)
For Zendesk, the connector card shows a **Write-back actions — into the system of record** row. Each action (for example **Add internal note**, **Update ticket status**) is a toggle you switch **on** or **off**. A disabled action is refused with *"This write-back action is disabled in the registry."* Registered actions for other providers are governed the same way through the generalized action layer.

## Step by step — see and control what a DE can do
1. Open **Connectors** and find the connector card.
2. For Zendesk, review the **Write-back actions** toggles and enable only the ones you want the DE to perform.
3. Set your **Guardrails** (in Governance) to block or require approval for anything sensitive — guardrails always win over trust.
4. When a DE proposes a destructive or gated action, approve or reject it in **Approvals / Human tasks**, where you can read the full draft before deciding.
5. Review executed actions and their receipts in the **Audit Trail**.$k$, encode(digest($k$destructive; an internal note is not). Destructive actions always require approval.
- **Idempotent** — safe to repeat without piling up side effects (adding tags in an append-safe way is idempotent).

These flags let the interface state honestly whether an action *"always requires approval"* or *"currently auto-executes once trusted."*

## Enabling actions (Zendesk example)
For Zendesk, the connector card shows a **Write-back actions — into the system of record** row. Each action (for example **Add internal note**, **Update ticket status**) is a toggle you switch **on** or **off**. A disabled action is refused with *"This write-back action is disabled in the registry."* Registered actions for other providers are governed the same way through the generalized action layer.

## Step by step — see and control what a DE can do
1. Open **Connectors** and find the connector card.
2. For Zendesk, review the **Write-back actions** toggles and enable only the ones you want the DE to perform.
3. Set your **Guardrails** (in Governance) to block or require approval for anything sensitive — guardrails always win over trust.
4. When a DE proposes a destructive or gated action, approve or reject it in **Approvals / Human tasks**, where you can read the full draft before deciding.
5. Review executed actions and their receipts in the **Audit Trail**.$k$, 'sha256'), 'hex'));
  insert into knowledge_doc_chunks (tenant_id, doc_id, chunk_index, content, content_hash)
  values (v_old.tenant_id, v_new_id, 3, $k$structive or gated action, approve or reject it in **Approvals / Human tasks**, where you can read the full draft before deciding.
5. Review executed actions and their receipts in the **Audit Trail**.

## Tips & best practices
- Enable the least you need. An internal note is low-risk; a public reply is customer-facing — keep it gated until you trust the DE's drafts.
- Use **preview** to sanity-check a new action's exact request before letting it run.
- Lean on **guardrails** for hard rules (e.g. "no unilateral refund promises") — they hold regardless of trust level.
- Raise a DE's trust gradually; "promote slow, demote fast." Trust only ever narrows *within* what guardrails and the destructive flag already allow.

## Troubleshooting
- **Action didn't run, became a task instead** — it's destructive or your guardrails/trust gated it. Approve it in Human tasks.
- **"This write-back action is disabled in the registry."** — enable the action's toggle on the connector card.
- **"No native execution path"** for an action — that action isn't implemented for this provider yet.
- **Nothing changed in my system** — check you ran **execute**, not **preview** (preview never calls the system).

## Related articles
- connecting-your-first-system
- custom-api-connector
- fetch-vs-ingest-modes
- how-credentials-are-kept-safe$k$, encode(digest($k$structive or gated action, approve or reject it in **Approvals / Human tasks**, where you can read the full draft before deciding.
5. Review executed actions and their receipts in the **Audit Trail**.

## Tips & best practices
- Enable the least you need. An internal note is low-risk; a public reply is customer-facing — keep it gated until you trust the DE's drafts.
- Use **preview** to sanity-check a new action's exact request before letting it run.
- Lean on **guardrails** for hard rules (e.g. "no unilateral refund promises") — they hold regardless of trust level.
- Raise a DE's trust gradually; "promote slow, demote fast." Trust only ever narrows *within* what guardrails and the destructive flag already allow.

## Troubleshooting
- **Action didn't run, became a task instead** — it's destructive or your guardrails/trust gated it. Approve it in Human tasks.
- **"This write-back action is disabled in the registry."** — enable the action's toggle on the connector card.
- **"No native execution path"** for an action — that action isn't implemented for this provider yet.
- **Nothing changed in my system** — check you ran **execute**, not **preview** (preview never calls the system).

## Related articles
- connecting-your-first-system
- custom-api-connector
- fetch-vs-ingest-modes
- how-credentials-are-kept-safe$k$, 'sha256'), 'hex'));

  perform append_audit_event_internal(v_old.tenant_id, 'DreamTeam', 'system',
    'Actions article revised — approval gating lifted into the opening (the eval gate''s one persistent partial under docs/36)',
    'knowledge_revision', jsonb_build_object('kind','kb_revision','doc_id',v_new_id,'previous_version_id',v_old.id,'external_ref','product-kb/connectors/actions-what-des-can-do-in-your-systems'));
end $rev$;

-- shelf copy: same content, chunks replaced, embeddings copied after tenant embeds
update platform_knowledge_docs set title = $t$Actions — what a DE can do in your systems$t$, content = $c$# Actions — what a DE can do in your systems

## What it is
Beyond reading, a connector can let a Digital Employee **act** in a system — for example **add an internal note** to a ticket, **update a ticket's status**, **post a reply**, **add tags**, or **post a message**. Each action writes back into your system of record, and each one is governed before it runs: an action that needs a person's sign-off waits as an **approval task** in Approvals & Drafts, destructive actions **always** require human approval, and the trust dial decides which safe actions may run on their own.

## Why it matters
Reading answers questions; acting closes the loop. But writing into a live system is where trust matters most. DreamTeam makes actions **explicit, previewable, and governed**: you choose which actions are enabled, risky ones always require a human approval, and every execution leaves a plain-language receipt in the audit trail.

## How actions are governed
When a DE tries to run an action, DreamTeam applies three checks in order:

1. **Access check** — the connector must permit write-back for that action.
2. **Destructive-always-gates** — if the action is flagged **destructive**, it *always* pauses for human approval, no matter how trusted the DE is. This check runs first and unconditionally.
3. **Guardrails, then trust** — your guardrail rules can block or gate an action; within what's allowed, the DE's trust level decides whether it auto-executes or waits for approval.

An action that's gated becomes a **human task** with the full request attached — for a reply, that includes the exact text the customer would see — so a person approves the real thing, not a summary.

## Preview vs execute
- **Preview** renders the exact request (method, URL, and body) and a plain-language **receipt preview** — *without calling the external system*. It has no side effects beyond a lightweight traceability record. Use it to see precisely what would happen.
- **Execute** runs the governance checks above and, when allowed (auto-executed by a trusted DE, or after a human approves the gated task), actually calls the system and returns a **receipt** describing what was done — for example *"Added an internal note to ticket #1234 (not visible to the customer)"* or *"Posted a public reply on ticket #1234 — the customer will see it."*

## Risk flags travel with every action
Each action carries two honest annotations:
- **Destructive** — has an outward or hard-to-undo effect (a public reply is destructive; an internal note is not). Destructive actions always require approval.
- **Idempotent** — safe to repeat without piling up side effects (adding tags in an append-safe way is idempotent).

These flags let the interface state honestly whether an action *"always requires approval"* or *"currently auto-executes once trusted."*

## Enabling actions (Zendesk example)
For Zendesk, the connector card shows a **Write-back actions — into the system of record** row. Each action (for example **Add internal note**, **Update ticket status**) is a toggle you switch **on** or **off**. A disabled action is refused with *"This write-back action is disabled in the registry."* Registered actions for other providers are governed the same way through the generalized action layer.

## Step by step — see and control what a DE can do
1. Open **Connectors** and find the connector card.
2. For Zendesk, review the **Write-back actions** toggles and enable only the ones you want the DE to perform.
3. Set your **Guardrails** (in Governance) to block or require approval for anything sensitive — guardrails always win over trust.
4. When a DE proposes a destructive or gated action, approve or reject it in **Approvals / Human tasks**, where you can read the full draft before deciding.
5. Review executed actions and their receipts in the **Audit Trail**.

## Tips & best practices
- Enable the least you need. An internal note is low-risk; a public reply is customer-facing — keep it gated until you trust the DE's drafts.
- Use **preview** to sanity-check a new action's exact request before letting it run.
- Lean on **guardrails** for hard rules (e.g. "no unilateral refund promises") — they hold regardless of trust level.
- Raise a DE's trust gradually; "promote slow, demote fast." Trust only ever narrows *within* what guardrails and the destructive flag already allow.

## Troubleshooting
- **Action didn't run, became a task instead** — it's destructive or your guardrails/trust gated it. Approve it in Human tasks.
- **"This write-back action is disabled in the registry."** — enable the action's toggle on the connector card.
- **"No native execution path"** for an action — that action isn't implemented for this provider yet.
- **Nothing changed in my system** — check you ran **execute**, not **preview** (preview never calls the system).

## Related articles
- connecting-your-first-system
- custom-api-connector
- fetch-vs-ingest-modes
- how-credentials-are-kept-safe
$c$
 where source_doc_path = 'product-kb/connectors/actions-what-des-can-do-in-your-systems';
delete from platform_knowledge_chunks pc using platform_knowledge_docs pd
 where pc.doc_id = pd.id and pd.source_doc_path = 'product-kb/connectors/actions-what-des-can-do-in-your-systems';
insert into platform_knowledge_chunks (doc_id, chunk_index, content)
select pd.id, c.chunk_index, c.content
from platform_knowledge_docs pd
join knowledge_docs d on d.external_ref = pd.source_doc_path and d.is_current
join knowledge_doc_chunks c on c.doc_id = d.id
where pd.source_doc_path = 'product-kb/connectors/actions-what-des-can-do-in-your-systems';

-- Asserts: would this pass if the feature were broken? if my change were a no-op?
do $a$
declare v_cur knowledge_docs; n int;
begin
  select * into v_cur from knowledge_docs where external_ref = 'product-kb/connectors/actions-what-des-can-do-in-your-systems' and is_current;
  if v_cur.id is null then raise exception '479: no current row for the ref'; end if;
  -- no-op detector: the current row must be a REVISION (lineage set)
  if v_cur.previous_version_id is null then raise exception '479: current row has no lineage — the revision did not happen'; end if;
  -- feature-level: the retrieval HEAD must now carry the approval concept
  if position('approval task' in lower(left(v_cur.content, 700))) = 0 then
    raise exception '479: the opening does not carry the approval concept — the completeness gap survives';
  end if;
  select count(*) into n from knowledge_docs where external_ref is not null and external_ref = 'product-kb/connectors/actions-what-des-can-do-in-your-systems';
  if n <> 1 then raise exception '479: ref uniqueness broken (% rows)', n; end if;
  select count(*) into n from knowledge_doc_chunks where doc_id = v_cur.id;
  if n < 4 then raise exception '479: revision chunks incomplete (%/4)', n; end if;
  select count(*) into n from platform_knowledge_chunks pc join platform_knowledge_docs pd on pd.id=pc.doc_id where pd.source_doc_path = 'product-kb/connectors/actions-what-des-can-do-in-your-systems';
  if n < 4 then raise exception '479: shelf chunks incomplete'; end if;
  if not exists (select 1 from platform_knowledge_docs where source_doc_path = 'product-kb/connectors/actions-what-des-can-do-in-your-systems' and position('approval task' in lower(left(content,700))) > 0) then
    raise exception '479: shelf copy does not carry the approval opening';
  end if;
end $a$;

notify pgrst, 'reload schema';
