-- ═══════════════════════════════════════════════════════════════
-- 188 — Playbook 3.0 Wave 2: blocking gates for judgment steps
--
-- A custom/agentic step may now declare on_gate:'pause' — when the DE's
-- reasoning loop requests a gated action, the loop PAUSES (instead of
-- continuing blind), the playbook run parks on the approval task, and the
-- dispatcher resumes the step with the human's decision injected once it
-- lands. This adds the 'paused_gate' state to the agentic run ledger.
-- ═══════════════════════════════════════════════════════════════

alter table agentic_step_runs drop constraint if exists agentic_step_runs_status_check;
alter table agentic_step_runs add constraint agentic_step_runs_status_check
  check (status = any (array[
    'running'::text, 'completed'::text, 'failed'::text, 'budget_exceeded'::text,
    'max_iterations_exceeded'::text, 'no_progress'::text, 'blocked_llm'::text,
    'rate_limited'::text, 'paused_gate'::text
  ]));
