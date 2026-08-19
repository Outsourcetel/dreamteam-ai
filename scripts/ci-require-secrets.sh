#!/usr/bin/env bash
# ── WHY THIS CHECKS SHAPE, NOT JUST PRESENCE ────────────────────────────────
#
# The three live-data CI jobs each asked only "is it empty?". That passes a
# secret whose value is the whole `NAME=value` line copied out of .env.test —
# and the run then dies twenty lines later inside supabase-js with
#
#     Invalid supabaseUrl: Must be a valid HTTP or HTTPS URL.
#
# an error naming neither the secret nor the mistake. Worse, the failure
# surfaces at teardown as
#
#     TypeError: Cannot read properties of undefined (reading 'tenantId')
#
# because setup never assigned the tenant, so the visible error points at a
# line that is fine. On 2026-08-19 all three jobs were red for exactly this,
# on main and on every open PR, and the logs did not say so.
#
# A guard that lets a bad value through and leaves the diagnosis to a stack
# trace is doing half its job. Each check below names its own fix.
#
# ⚠ VALUES ARE NEVER ECHOED. Every check compares; none print. The only thing
# that reaches the log is which check failed and how to correct it.
#
# One implementation, three call sites. It was three near-identical inline
# blocks, which is how the shape check ended up on one of them and not the
# other two.
#
# Usage:  bash scripts/ci-require-secrets.sh <isolation|invariants|golden-path>
# ---------------------------------------------------------------------------
set -u

PRODUCTION_REF='rfsvmhcqeiyrxivbmpel'
DEV_REF='nmuntxrcdksyhsdywpan'

BAD=0
fail() { echo "::error::$1"; BAD=1; }

JOB="${1:-}"
need_url=0; need_key=0; need_token=0
case "$JOB" in
  isolation)   need_url=1; need_key=1 ;;
  invariants)                          need_token=1 ;;
  golden-path) need_url=1; need_key=1; need_token=1 ;;
  *)
    # Not a secret problem — a wiring problem. Say so differently, and exit
    # with a different code, so it can never be mistaken for a missing secret.
    echo "::error::ci-require-secrets.sh called with unknown job '${JOB}'. Expected one of: isolation, invariants, golden-path."
    exit 2
    ;;
esac

# A pasted .env line, a quoted value, or anything carrying whitespace. Covers
# `NAME=value`, "value", 'value', value-with-a-space, and value<newline>.
#
# ⚠ THE WHITESPACE TEST CANNOT USE grep. grep is line-oriented: it strips the
# line terminator before matching, so `[[:space:]]` never sees a TRAILING
# NEWLINE — and a trailing newline is the most common way a secret gets pasted
# wrong. The first version of this function used grep for everything and
# happily passed "key\n". `case` matches the whole string, terminator and all.
has_whitespace() {
  case "$1" in *[[:space:]]*) return 0 ;; esac
  return 1
}

looks_pasted() {
  has_whitespace "$1" && return 0
  printf '%s' "$1" | grep -qE '^[A-Za-z_][A-Za-z0-9_]*=|^"|"$|^'"'"'|'"'"'$'
}

if [ "$need_url" = 1 ]; then
  if [ -z "${VITE_TEST_SUPABASE_URL:-}" ]; then
    fail "VITE_TEST_SUPABASE_URL is unset or empty."
  elif has_whitespace "$VITE_TEST_SUPABASE_URL"; then
    # Checked BEFORE the pattern below, for the same reason: an anchored grep
    # would match "https://x.supabase.co\n" quite happily, and supabase-js
    # would then reject the value the guard just approved.
    fail "VITE_TEST_SUPABASE_URL carries whitespace — most likely a trailing newline from the paste. Set the value with nothing before or after it."
  else
    # ⚠ The dots are ESCAPED. Unescaped, `.` matches any character, so
    # https://abcXsupabaseYco satisfied the old pattern.
    if ! printf '%s' "$VITE_TEST_SUPABASE_URL" | grep -qE '^https://[a-z0-9]+\.supabase\.co$'; then
      fail "VITE_TEST_SUPABASE_URL is not a bare Supabase project URL. Expected exactly https://<ref>.supabase.co (the dev project is ${DEV_REF}). Paste the VALUE only — no NAME= prefix, no quotes, no trailing slash or path."
    fi
    # ⛔ THE ONE MISCONFIGURATION WORSE THAN A RED TICK.
    # tenant-isolation.test.ts signs up real users and creates real tenants
    # through the public signup flow. Aimed at production it would write live
    # data on every CI run, which is the entire reason a separate dev project
    # exists. This refuses rather than reports.
    if printf '%s' "$VITE_TEST_SUPABASE_URL" | grep -q "$PRODUCTION_REF"; then
      fail "VITE_TEST_SUPABASE_URL points at PRODUCTION. This suite creates real users and tenants through the public signup flow and must only ever run against the isolated dev project. Refusing to run."
    fi
  fi
fi

if [ "$need_key" = 1 ]; then
  if [ -z "${VITE_TEST_SUPABASE_ANON_KEY:-}" ]; then
    fail "VITE_TEST_SUPABASE_ANON_KEY is unset or empty."
  elif looks_pasted "${VITE_TEST_SUPABASE_ANON_KEY}"; then
    fail "VITE_TEST_SUPABASE_ANON_KEY looks like a pasted .env line rather than a bare key — it carries a NAME= prefix, quotes or whitespace."
  fi
fi

if [ "$need_token" = 1 ]; then
  if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
    fail "SUPABASE_ACCESS_TOKEN is unset or empty."
  elif looks_pasted "${SUPABASE_ACCESS_TOKEN}"; then
    fail "SUPABASE_ACCESS_TOKEN looks like a pasted .env line rather than a bare token — it carries a NAME= prefix, quotes or whitespace."
  fi
fi

if [ "$BAD" = 1 ]; then
  case "$JOB" in
    isolation)
      echo "::error::This job FAILS rather than passing silently: these are the only automated proof that one tenant cannot read another's data."
      ;;
    invariants)
      echo "::error::This job FAILS rather than passing silently: this suite asserts the SHAPE of the live security layer (no FOR ALL policies, escalation guards present, nothing anon-reachable). It found a real hole on its first run."
      ;;
    golden-path)
      echo "::error::This job FAILS rather than passing silently: golden-path is the only end-to-end proof that the product's core loop runs — signup, hire, equip, intake, escalate, a HUMAN DECIDES, gate, evidence, trust."
      ;;
  esac
  echo "::error::Set them under Settings -> Secrets and variables -> Actions. Values are in .env.test locally — copy only what follows the '=' on each line, with no surrounding quotes."
  exit 1
fi
