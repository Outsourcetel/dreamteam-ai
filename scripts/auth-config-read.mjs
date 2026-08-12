#!/usr/bin/env node
// auth-config-read.mjs — READ-ONLY check of the Supabase auth configuration
// fields that decide whether the public signup funnel works: where the
// confirmation link points (site_url / uri_allow_list) and whether real SMTP
// is configured (default Supabase SMTP is rate-limited to a handful of mails
// per hour and often lands in spam — a silent funnel killer).
//
// Prints ONLY non-secret fields. Token comes from .env.local, same as
// db-query.mjs. Usage: node scripts/auth-config-read.mjs
import { readFileSync } from 'node:fs';

const PROJECT_REF = 'rfsvmhcqeiyrxivbmpel';
const env = readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
const line = env.split(/\r?\n/).find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='));
if (!line) throw new Error('SUPABASE_ACCESS_TOKEN not found in .env.local');
const token = line.slice('SUPABASE_ACCESS_TOKEN='.length).replace(/^["']|["']$/g, '').trim();

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/config/auth`, {
  headers: { Authorization: `Bearer ${token}` },
});
if (!res.ok) { console.error(`auth config read failed: HTTP ${res.status}`); process.exit(1); }
const c = await res.json();

// Non-secret allowlist only — never print smtp_pass or secrets.
console.log(JSON.stringify({
  site_url: c.site_url,
  uri_allow_list: c.uri_allow_list,
  mailer_autoconfirm: c.mailer_autoconfirm,          // true = no email confirmation required
  external_email_enabled: c.external_email_enabled,
  smtp_host: c.smtp_host ?? null,                    // null/empty = default Supabase SMTP (rate-limited)
  smtp_sender_name: c.smtp_sender_name ?? null,
  smtp_admin_email: c.smtp_admin_email ?? null,
  rate_limit_email_sent: c.rate_limit_email_sent ?? null,
}, null, 2));
