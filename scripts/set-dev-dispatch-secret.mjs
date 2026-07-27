#!/usr/bin/env node
// set-dev-dispatch-secret.mjs — give the DEV project a dispatch secret that
// matches on both sides.
//
// Dispatchers authenticate to edge functions with x-dispatch-secret: the
// database reads it from vault, the edge function reads it from its own env,
// and the two must be the same string. Dev had it in NEITHER place, so
// invoke_knowledge_ingest_drain() returned 'no_secret' and the queue never
// drained no matter how many items were waiting.
//
// Supabase does not expose an edge function secret's VALUE once set, so there
// is no way to copy an existing one into vault. The only reliable move is to
// generate a fresh value and write it to both sides in one go — which is what
// this does. The secret is generated locally, never printed, and never passed
// on a command line.
//
// ⚠ DEV ONLY, enforced below. Rotating production's dispatch secret would break
// every dispatcher between the two writes, and prod's is already correct.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const DEV_REF = 'nmuntxrcdksyhsdywpan';
const NAME = 'playbook_dispatch_secret';
const ENV_NAME = 'PLAYBOOK_DISPATCH_SECRET';

if (process.argv.includes('--project') && process.argv[process.argv.indexOf('--project') + 1] !== 'dev') {
  console.error('REFUSING: this script only ever targets dev.');
  process.exit(1);
}

const token = (() => {
  const env = readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
  const line = env.split(/\r?\n/).find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='));
  if (!line) throw new Error('SUPABASE_ACCESS_TOKEN not found in .env.local');
  return line.slice('SUPABASE_ACCESS_TOKEN='.length).replace(/^["']|["']$/g, '').trim();
})();

const api = (path, init = {}) =>
  fetch(`https://api.supabase.com/v1/projects/${DEV_REF}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });

const secret = randomBytes(32).toString('base64url');
console.log(`generated a ${secret.length}-char secret for dev (value not printed)`);

// ── 1. The edge-function side ───────────────────────────────────────────────
const r1 = await api('/secrets', { method: 'POST', body: JSON.stringify([{ name: ENV_NAME, value: secret }]) });
console.log(`edge function env  ${ENV_NAME}: HTTP ${r1.status}${r1.ok ? ' ✓' : ' ✗ ' + (await r1.text()).slice(0, 200)}`);
if (!r1.ok) process.exit(1);

// ── 2. The database side ────────────────────────────────────────────────────
// Update in place when it already exists: vault.create_secret raises on a
// duplicate name, and a half-rotated secret is worse than none.
const q = `
do $$
declare v_id uuid;
begin
  select id into v_id from vault.secrets where name = '${NAME}';
  if v_id is null then
    perform vault.create_secret('${secret}', '${NAME}', 'x-dispatch-secret shared with the edge functions');
  else
    perform vault.update_secret(v_id, '${secret}');
  end if;
end $$;
select exists(select 1 from vault.decrypted_secrets where name = '${NAME}') as in_vault,
       (select decrypted_secret = '${secret}' from vault.decrypted_secrets where name = '${NAME}') as matches_env;`;

const r2 = await api('/database/query', { method: 'POST', body: JSON.stringify({ query: q }) });
const body = await r2.text();
if (!r2.ok) { console.error(`vault write failed: HTTP ${r2.status}\n${body}`); process.exit(1); }
console.log('vault:', body);
console.log('\nboth sides now hold the same secret. Edge functions pick up a new env var on their next invocation.');
