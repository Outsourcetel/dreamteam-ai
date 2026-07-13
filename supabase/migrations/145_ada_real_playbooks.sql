-- ============================================================
-- 145 — Ada's draft_playbook now produces REAL, runnable playbooks.
--
-- Founder feedback: Ada's playbooks were empty drafts (a title, no steps,
-- not attached) — so a created employee "had no process to follow". The
-- connector-hub dt_draft_playbook executor now builds a genuine runnable
-- step sequence (load record → smart agentic step → optional specialist
-- accuracy check → human approval → complete) and attaches it to the
-- employee. This migration updates the action's param_schema + description
-- so Ada supplies a detailed procedure, names the employee, and flags a
-- specialist check when accuracy matters.
-- ============================================================
update action_definitions
set description = 'Creates a runnable playbook — a procedure the Digital Employee follows. Write the procedure as a clear, numbered set of steps in plain language; the platform turns it into a real, runnable sequence (load the record → a smart step that reads your instructions and routes to the knowledge base, connected systems, or the rules you give → an optional specialist accuracy check → human approval → complete) and attaches it to the employee. ALWAYS requires human approval.',
    param_schema = '[
      {"name":"name","type":"string","required":true,"help":"Playbook name, e.g. Handle appointment reschedule"},
      {"name":"outline","type":"string","required":true,"help":"The procedure as clear numbered steps in plain language — what to do, in what order, what to look up, which system to use, and the rules to follow. Be specific."},
      {"name":"for_de","type":"string","required":false,"help":"The exact name of the Digital Employee this playbook is for, so it gets attached to them"},
      {"name":"needs_specialist","type":"string","required":false,"help":"Set to \"true\" if this procedure needs an accuracy/compliance check by a specialist before approval"},
      {"name":"specialist_key","type":"string","required":false,"help":"Which specialist to consult for the accuracy check, e.g. technical, finance, legal (defaults to technical)"},
      {"name":"description","type":"string","required":false,"help":"One line on what this playbook is for"}
    ]'::jsonb
where scope = 'platform' and category = 'platform_admin' and action_key = 'draft_playbook';
