-- Migration 060: brute-force sign-in lockout + an interim signup burst
-- limiter, closing gap 2 from the 2026-07-07 adversarial security pass
-- ("no lockout after repeated wrong passwords, no bot protection on
-- sign-up"). Built entirely on Supabase's native Auth Hooks (Postgres
-- functions Supabase itself calls at the right moment) -- no third-party
-- service, no new account needed. Real CAPTCHA (hCaptcha) remains the
-- stronger long-term fix for signup and is wired in separately once a
-- site/secret key exists.
--
-- SAFETY NOTE: both functions are wrapped in a top-level EXCEPTION
-- handler that defaults to {"decision":"continue"} on ANY unexpected
-- error. These hooks run on every sign-in / every sign-up in the whole
-- product -- a bug that raises an uncaught exception here would risk
-- locking out every user, including the founder. Defaulting to "continue"
-- on error means a bug in this code degrades to "no extra protection
-- this one time," never "nobody can log in."
-- =====================================================================

-- ---------------------------------------------------------------------
-- Sign-in lockout: tracks failed password attempts per user. After 5
-- failures within a 15-minute window, the account is locked for 15
-- minutes -- rejected even if a correct password is supplied during the
-- lockout, since this hook's job is specifically to add an extra reason
-- to deny beyond "was the password right." A successful verification
-- resets the counter. Table only ever written by this SECURITY DEFINER
-- function, never exposed to anon/authenticated directly.
-- ---------------------------------------------------------------------

create table if not exists public.auth_login_lockouts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  failed_count int not null default 0,
  locked_until timestamptz,
  last_attempt_at timestamptz not null default now()
);

alter table public.auth_login_lockouts enable row level security;
alter table public.auth_login_lockouts force row level security;
-- deliberately zero policies: nobody queries this through PostgREST: the
-- hook function (SECURITY DEFINER) is the only writer/reader that matters.
revoke all on public.auth_login_lockouts from public, anon, authenticated;

create or replace function public.hook_password_verification_attempt(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user_id uuid;
  v_valid boolean;
  v_row public.auth_login_lockouts;
  v_new_count int;
  v_max_attempts constant int := 5;
  v_lockout_minutes constant int := 15;
  v_window_minutes constant int := 15;
begin
  v_user_id := (event->>'user_id')::uuid;
  v_valid := coalesce((event->>'valid')::boolean, true);

  if v_user_id is null then
    return jsonb_build_object('decision', 'continue');
  end if;

  select * into v_row from public.auth_login_lockouts where user_id = v_user_id for update;

  if v_row.user_id is not null and v_row.locked_until is not null and v_row.locked_until > now() then
    return jsonb_build_object(
      'decision', 'reject',
      'message', 'Too many failed sign-in attempts. Please try again in a few minutes.'
    );
  end if;

  if v_valid then
    if v_row.user_id is not null then
      update public.auth_login_lockouts
        set failed_count = 0, locked_until = null, last_attempt_at = now()
        where user_id = v_user_id;
    end if;
    return jsonb_build_object('decision', 'continue');
  end if;

  if v_row.user_id is null then
    insert into public.auth_login_lockouts (user_id, failed_count, last_attempt_at)
    values (v_user_id, 1, now());
    return jsonb_build_object('decision', 'continue');
  end if;

  if v_row.last_attempt_at < now() - make_interval(mins => v_window_minutes) then
    update public.auth_login_lockouts
      set failed_count = 1, last_attempt_at = now(), locked_until = null
      where user_id = v_user_id;
    return jsonb_build_object('decision', 'continue');
  end if;

  v_new_count := v_row.failed_count + 1;

  if v_new_count >= v_max_attempts then
    update public.auth_login_lockouts
      set failed_count = v_new_count, last_attempt_at = now(),
          locked_until = now() + make_interval(mins => v_lockout_minutes)
      where user_id = v_user_id;
    return jsonb_build_object(
      'decision', 'reject',
      'message', 'Too many failed sign-in attempts. Please try again in 15 minutes.'
    );
  end if;

  update public.auth_login_lockouts
    set failed_count = v_new_count, last_attempt_at = now()
    where user_id = v_user_id;
  return jsonb_build_object('decision', 'continue');

exception when others then
  return jsonb_build_object('decision', 'continue');
end;
$function$;

revoke all on function public.hook_password_verification_attempt(jsonb) from public, anon, authenticated;
grant execute on function public.hook_password_verification_attempt(jsonb) to supabase_auth_admin;

-- ---------------------------------------------------------------------
-- Signup burst limiter (interim stopgap until hCaptcha is wired in).
-- Postgres auth hooks don't receive the caller's IP, so this can't be a
-- true per-attacker rate limit -- it's a blunt, project-wide guard:
-- reject new sign-ups if more than 8 accounts have been created in the
-- last 10 minutes. Weaker than real CAPTCHA (a slow/patient bot script
-- isn't stopped), but real protection against the kind of rapid
-- automated burst an adversarial test fired at this endpoint today.
-- ---------------------------------------------------------------------

create or replace function public.hook_before_user_created(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_recent_signups int;
  v_burst_threshold constant int := 8;
  v_window_minutes constant int := 10;
begin
  select count(*) into v_recent_signups
  from auth.users
  where created_at > now() - make_interval(mins => v_window_minutes);

  if v_recent_signups >= v_burst_threshold then
    return jsonb_build_object(
      'decision', 'reject',
      'message', 'Too many accounts are being created right now. Please try again shortly.'
    );
  end if;

  return jsonb_build_object('decision', 'continue');

exception when others then
  return jsonb_build_object('decision', 'continue');
end;
$function$;

revoke all on function public.hook_before_user_created(jsonb) from public, anon, authenticated;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
