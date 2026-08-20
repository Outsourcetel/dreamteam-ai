-- 801_a_diary_the_front_desk_can_reach.sql
-- ==========================================================================
-- WHY: C2 of the practical-work program (spec 2026-08-11). Appointment
-- setting had a verb (book_appointment, an internal phone-flow action) and
-- NO DIARY — no calendar category existed, no calendar provider, so a
-- booking could never land where the business actually looks. This adds:
--   · the `calendar` system category (the registry is deliberately closed —
--     a category is a contract, not a label);
--   · the platform action definition for google_calendar_create_event
--     (executor shipped in connector-hub beside the adapter), destructive
--     and human-gated ALWAYS: sendUpdates=all emails the customer, and a
--     promise in a customer's inbox is the dunning-email law again;
--   · gated behind sales_desk (front_desk/sdr/bdr/billing_ar) — booking a
--     meeting is a commercial customer-facing act.
-- The category is NOT added to front_desk's required_connector_categories:
-- booking is one duty of the role, not its essence — a text-only front desk
-- without a diary is legitimate and must stay hireable (grounding gate,
-- mig 796, judges required categories only).
-- ==========================================================================

begin;

insert into system_categories (key, label, description)
select 'calendar', 'Calendar', 'Diaries and scheduling — where appointments actually land'
where not exists (select 1 from system_categories where key = 'calendar');

insert into action_definitions (scope, tenant_id, category, action_key, label, description, provider, param_schema, risk, execution, status, reversible, rollback, requires_role)
select 'platform', null, 'calendar', 'create_calendar_event', 'Book an appointment',
       'Create a real calendar event, emailing the invitation to the attendee. Always requires human approval — this is a promise in a customer''s inbox.',
       'googlecalendar',
       '[{"name":"title","type":"string","required":true,"help":"What the meeting is"},
         {"name":"start_iso","type":"string","required":true,"help":"Start (RFC3339, e.g. 2026-08-20T15:00:00+05:00)"},
         {"name":"end_iso","type":"string","required":true,"help":"End (RFC3339)"},
         {"name":"attendee_email","type":"string","required":false,"help":"The customer to invite"},
         {"name":"description","type":"string","required":false,"help":"Agenda or notes"}]'::jsonb,
       '{"idempotent":false,"destructive":true}'::jsonb,
       '{"execution_key":"google_calendar_create_event"}'::jsonb,
       'active', true,
       '{"how":"Delete the event in Google Calendar; attendees receive a cancellation."}'::jsonb,
       'sales_desk'
where not exists (
  select 1 from action_definitions
   where scope = 'platform' and provider = 'googlecalendar' and action_key = 'create_calendar_event'
);

do $$
declare n int;
begin
  if not exists (select 1 from system_categories where key = 'calendar') then
    raise exception 'calendar category missing';
  end if;
  select count(*) into n from action_definitions
   where scope='platform' and provider='googlecalendar' and action_key='create_calendar_event';
  if n <> 1 then raise exception 'expected exactly 1 calendar definition, found %', n; end if;
end $$;

commit;
