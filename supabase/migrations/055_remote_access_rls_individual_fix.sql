-- Migration 055: Remote Access -- individually-reasoned RLS fixes for the
-- policies migration 054 deliberately did NOT touch with a blanket
-- find-and-replace.
-- =====================================================================
-- Migration 054 covered 62 policies where the inlined
-- `tenant_id IN/= (select profiles.tenant_id from profiles where
-- profiles.user_id = auth.uid())` subquery WAS the entire tenant-scoping
-- predicate, so swapping it for `tenant_id = auth_tenant_id()` is a pure,
-- behavior-preserving substitution for every ordinary tenant user.
--
-- This migration handles the remaining 19 policies found by the same
-- pg_policies survey, split into three groups:
--
--   A) Four "Platform admins manage all X" policies (agent_actions,
--      conversations, knowledge_articles, messages) gate purely on
--      `layer = 'platform'` -- they are NOT tenant-scoped at all and are
--      NOT altered here. They already grant a platform-layer account
--      full access to every tenant's rows unconditionally, which is a
--      materially broader permission than "see this one tenant's data
--      only while an audited remote-access session against it is
--      active." Folding auth_tenant_id()'s session-aware fallback into
--      these would be redundant at best (the layer='platform' check
--      already passes for any platform admin) and at worst papers over
--      the fact that these four policies represent a separate, older,
--      un-session-scoped admin bypass that predates Remote Access and
--      deserves its own deliberate review -- not a silent behavior
--      change bundled into this migration. Left exactly as-is:
--        - agent_actions      | "Platform admins manage all agent actions"
--        - conversations      | "Platform admins manage all conversations"
--        - knowledge_articles | "Platform admins manage all articles"
--        - messages           | "Platform admins manage all messages"
--
--   B) Nine EXISTS-based tenant-membership checks
--      (`EXISTS (select 1 from profiles p where p.user_id = auth.uid()
--      and p.tenant_id = <table>.tenant_id [and p.role = ANY (...)])`).
--      For a normal user, `p.tenant_id = <table>.tenant_id` together
--      with `p.user_id = auth.uid()` is equivalent to
--      `<table>.tenant_id = auth_tenant_id()`, so the tenant-membership
--      half of each predicate is rewritten to call auth_tenant_id().
--      Where a role = ANY (...) clause rides alongside the tenant check
--      (three policies), it is preserved unchanged as a separate EXISTS
--      -- a platform admin's own profile has role = 'platform_super_admin'
--      (confirmed live), which is never a member of any of these tenant
--      role arrays, so these role-gated policies will NOT grant a
--      platform admin write access during remote access; they will
--      still correctly deny writes gated on tenant-staff roles the
--      platform admin's own profile doesn't hold. That is a known,
--      deliberate limit of this migration (see report) rather than an
--      oversight -- expanding role-gated write access to platform admins
--      is a separate decision this migration does not make.
--        - agent_actions      | "Tenant members view agent actions" (no role gate)
--        - conversations      | "Tenant members view conversations" (no role gate)
--        - conversations      | "Tenant agents manage conversations" (role gate kept)
--        - knowledge_articles | "Tenant members read published articles" (no role gate)
--        - knowledge_articles | "Tenant staff manage articles" (role gate kept)
--        - messages           | "Tenant members view messages" (no role gate)
--        - messages           | "Tenant agents insert messages" (role gate kept)
--
--   C) Six role-gated `tenant_id IN (select ... where role = ANY (...))`
--      write policies. Same reasoning as group B's role-gated cases:
--      the tenant portion is rewritten to auth_tenant_id(), the role
--      check is preserved unchanged as a separate EXISTS so normal-user
--      write permissions are byte-identical to today. A blanket
--      substitution here (dropping the role check) would have silently
--      granted tenant_manager-and-below users write access currently
--      reserved for tenant_owner/tenant_admin -- exactly the kind of
--      unusual structure the task asked to flag rather than
--      find-and-replace blindly.
--        - capabilities       | capabilities_tenant_write
--        - departments        | departments_tenant_write
--        - workspaces         | workspaces_tenant_write
--        - digital_employees  | de_tenant_admin_delete
--        - digital_employees  | de_tenant_admin_update
--        - digital_employees  | de_tenant_admin_write
--
--   D) Two policies that OR the tenant-membership EXISTS together with
--      an unconditional is_platform_admin()/requested_by_user_id branch.
--      Only the tenant-membership branch is rewritten; the other
--      branches are untouched (is_platform_admin() already grants
--      platform admins blanket read access to these two rows
--      independent of any remote-access session -- these are
--      platform-administration tables, not tenant product data, so that
--      existing blanket-admin-read behavior is left exactly as it was):
--        - tenant_feature_overrides    | tfo_select
--        - tenant_provisioning_requests| tpr_select
-- =====================================================================

-- Uses `alter policy ... using (...) with check (...)` -- this changes
-- the expressions in place on the existing policy object. ALTER POLICY
-- cannot change the command type (SELECT/INSERT/UPDATE/DELETE/ALL) or
-- the policy name, which is fine here since none of these rewrites
-- change what command each policy applies to.

-- Group B: EXISTS-based tenant-membership checks, no role gate.

alter policy "Tenant members view agent actions" on public.agent_actions
  to public
  using (agent_actions.tenant_id = auth_tenant_id());

alter policy "Tenant members view conversations" on public.conversations
  to public
  using (conversations.tenant_id = auth_tenant_id());

alter policy "Tenant members read published articles" on public.knowledge_articles
  to public
  using ((status = 'published'::text) AND (knowledge_articles.tenant_id = auth_tenant_id()));

alter policy "Tenant members view messages" on public.messages
  to public
  using (messages.tenant_id = auth_tenant_id());

-- Group B: EXISTS-based tenant-membership checks, role gate preserved.

alter policy "Tenant agents manage conversations" on public.conversations
  to public
  using (
    conversations.tenant_id = auth_tenant_id()
    and exists (
      select 1 from public.profiles p
      where p.user_id = auth.uid()
        and p.role = any (array['tenant_admin'::text, 'tenant_manager'::text, 'agent'::text])
    )
  );

alter policy "Tenant staff manage articles" on public.knowledge_articles
  to public
  using (
    knowledge_articles.tenant_id = auth_tenant_id()
    and exists (
      select 1 from public.profiles p
      where p.user_id = auth.uid()
        and p.role = any (array['tenant_admin'::text, 'tenant_manager'::text, 'agent'::text])
    )
  );

alter policy "Tenant agents insert messages" on public.messages
  to public
  with check (
    messages.tenant_id = auth_tenant_id()
    and exists (
      select 1 from public.profiles p
      where p.user_id = auth.uid()
        and p.role = any (array['tenant_admin'::text, 'tenant_manager'::text, 'agent'::text])
    )
  );

-- Group C: role-gated tenant_id IN (...) write policies, role gate preserved.

alter policy "capabilities_tenant_write" on public.capabilities
  to public
  using (
    tenant_id = auth_tenant_id()
    and exists (
      select 1 from public.profiles
      where profiles.user_id = auth.uid()
        and profiles.role = any (array['tenant_owner'::text, 'tenant_admin'::text, 'tenant_manager'::text])
    )
  );

alter policy "departments_tenant_write" on public.departments
  to public
  using (
    tenant_id = auth_tenant_id()
    and exists (
      select 1 from public.profiles
      where profiles.user_id = auth.uid()
        and profiles.role = any (array['tenant_owner'::text, 'tenant_admin'::text, 'tenant_manager'::text])
    )
  );

alter policy "workspaces_tenant_write" on public.workspaces
  to public
  using (
    tenant_id = auth_tenant_id()
    and exists (
      select 1 from public.profiles
      where profiles.user_id = auth.uid()
        and profiles.role = any (array['tenant_owner'::text, 'tenant_admin'::text])
    )
  );

alter policy "de_tenant_admin_delete" on public.digital_employees
  to public
  using (
    tenant_id = auth_tenant_id()
    and exists (
      select 1 from public.profiles
      where profiles.user_id = auth.uid()
        and profiles.role = any (array['tenant_owner'::text, 'tenant_admin'::text])
    )
  );

alter policy "de_tenant_admin_update" on public.digital_employees
  to public
  using (
    tenant_id = auth_tenant_id()
    and exists (
      select 1 from public.profiles
      where profiles.user_id = auth.uid()
        and profiles.role = any (array['tenant_owner'::text, 'tenant_admin'::text])
    )
  )
  with check (
    tenant_id = auth_tenant_id()
    and exists (
      select 1 from public.profiles
      where profiles.user_id = auth.uid()
        and profiles.role = any (array['tenant_owner'::text, 'tenant_admin'::text])
    )
  );

alter policy "de_tenant_admin_write" on public.digital_employees
  to public
  with check (
    tenant_id = auth_tenant_id()
    and exists (
      select 1 from public.profiles
      where profiles.user_id = auth.uid()
        and profiles.role = any (array['tenant_owner'::text, 'tenant_admin'::text])
    )
  );

-- Group D: mixed OR -- only the tenant-membership EXISTS branch is rewritten.

alter policy "tfo_select" on public.tenant_feature_overrides
  to public
  using (
    is_platform_admin()
    or tenant_feature_overrides.tenant_id = auth_tenant_id()
  );

alter policy "tpr_select" on public.tenant_provisioning_requests
  to public
  using (
    requested_by_user_id = auth.uid()
    or is_platform_admin()
    or tenant_provisioning_requests.proposed_parent_tenant_id = auth_tenant_id()
  );
