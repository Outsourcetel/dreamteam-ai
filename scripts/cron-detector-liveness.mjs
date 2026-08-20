#!/usr/bin/env node
// ============================================================================
// cron-detector-liveness.mjs — WHO WATCHES THE WATCHER.
//
//   node scripts/cron-detector-liveness.mjs           # report + exit code
//   node scripts/cron-detector-liveness.mjs --json    # machine-readable
//
// ⚠ WHY THIS FILE EXISTS AND WHY IT IS NOT IN THE DATABASE.
//
// Migration 818 installs `cron-health-scan-15min`, which notices when any of
// this platform's cron jobs stops succeeding and raises an ops_alert. It is
// itself a cron job. If IT dies, nothing reports that — and every convenient
// answer to that problem is circular:
//
//   · "it scans itself" — a permanently dead detector is not running to notice
//     its own death, and a transiently failed one already has a fresh success
//     by the time it next looks. Self-inclusion covers NOTHING, and 818's
//     header says so in those words rather than taking the credit.
//   · "a second watchdog job" — both watchers share pg_cron. The failure that
//     matters most (the scheduler itself stops) takes both of them.
//
// The recursion has to stop somewhere OUTSIDE the database. This is that stop:
// a command a person or a CI job runs, which asks the database one question and
// exits non-zero if the answer is bad.
//
// ⚠ AND IT IS NOT WIRED INTO ANYTHING YET. `npm run certify` is deliberately
// not modified by the change that added this — another session held uncommitted
// edits to scripts/certify.mjs at the time, and editing a file someone else is
// mid-change on is how work gets lost. So today the outermost watcher is a
// human typing this command. Until it is wired into certify or CI, a dead
// detector is quiet. That is a real, named gap, not an oversight.
//
// ⚠⚠ VACUITY GUARD. "I could not check" and "it is fine" are not the same
// sentence, and only one of them is safe to act on. This exits NON-ZERO when
// the function is missing, when the job is unscheduled, when it is inactive,
// when it has never succeeded, when it has failed recently, and when the
// database cannot be reached at all — never with a reassuring zero it did not
// earn. A liveness check that passes when it learned nothing is the exact shape
// of thing migration 818 exists to end.
// ============================================================================
import { readFileSync } from 'node:fs';

const PROJECT_REF = 'rfsvmhcqeiyrxivbmpel';
const ENDPOINT = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;
const JOB = 'cron-health-scan-15min';
/** The job runs every 15 minutes. Four missed ticks is an hour, which is also
 *  the tightest grace the detector itself ever applies — so this threshold is
 *  the same statement about the same clock, not a second opinion. */
const STALE_AFTER_MINUTES = 60;
const JSON_OUT = process.argv.includes('--json');

/** Thrown by fail() to unwind; caught at the bottom so the process ends
 *  naturally with exitCode 1. process.exit() mid-fetch trips a libuv assertion
 *  on Windows and reports 127 — the shell only knows "non-zero", but a human
 *  reading 127 goes looking for a missing binary. */
class LivenessFailure extends Error {}

function token() {
  const env = readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
  const line = env.split(/\r?\n/).find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='));
  if (!line) throw new Error('SUPABASE_ACCESS_TOKEN not found in .env.local');
  return line.slice('SUPABASE_ACCESS_TOKEN='.length).replace(/^["']|["']$/g, '').trim();
}

async function sql(query) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`db: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

const QUERY = [
  "select jsonb_build_object(",
  "  'installed',   (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  "                   where n.nspname = 'public' and p.proname = 'cron_health_scan'),",
  `  'scheduled',   (select count(*) from cron.job where jobname = '${JOB}'),`,
  `  'active',      (select bool_or(active) from cron.job where jobname = '${JOB}'),`,
  `  'schedule',    (select max(schedule) from cron.job where jobname = '${JOB}'),`,
  "  'last_success',(select max(d.start_time) from cron.job_run_details d",
  "                    join cron.job j on j.jobid = d.jobid",
  `                   where j.jobname = '${JOB}' and d.status = 'succeeded'),`,
  "  'recent_fails',(select count(*) from cron.job_run_details d",
  "                    join cron.job j on j.jobid = d.jobid",
  `                   where j.jobname = '${JOB}' and d.status = 'failed'`,
  "                     and d.start_time > now() - interval '24 hours'),",
  "  'open_alerts', (select count(*) from ops_alerts",
  "                   where resolved_at is null and kind like 'cron\\_job\\_broken:%'),",
  "  'now',         now()",
  ") as r;",
].join('\n');

function fail(lines, state) {
  if (JSON_OUT) {
    console.log(JSON.stringify({ ok: false, problems: lines.filter(Boolean), ...state }, null, 2));
  } else {
    console.error('CRON DETECTOR LIVENESS: FAILED');
    for (const l of lines) console.error('  ' + l);
  }
  process.exitCode = 1;
  throw new LivenessFailure();
}

async function main() {
  let r = null;
  try {
    const rows = await sql(QUERY);
    r = rows && rows[0] ? rows[0].r : null;
  } catch (e) {
    // Unreachable database is a FAILURE, not a pass. See the vacuity note above.
    fail([
      'could not ask the database whether ' + JOB + ' is alive: ' + String(e.message ?? e).slice(0, 300),
      'A check that could not run has not passed. Fix the connection and run it again.',
    ], { reason: 'unreachable', error: String(e.message ?? e) });
  }

  if (!r) fail(['the liveness query returned no row — nothing was compared.'], { reason: 'no_row' });

  const ageMin = r.last_success
    ? Math.round((new Date(r.now).getTime() - new Date(r.last_success).getTime()) / 60000)
    : null;

  const problems = [];
  if (Number(r.installed) === 0) {
    problems.push('public.cron_health_scan() does not exist — migration 818 has not been applied.');
  }
  if (Number(r.scheduled) === 0) {
    problems.push('cron job "' + JOB + '" is not scheduled. Nothing is watching the other jobs.');
  } else if (r.active !== true) {
    problems.push('cron job "' + JOB + '" exists but is INACTIVE. Somebody disabled the detector.');
  }
  if (r.last_success === null) {
    problems.push('"' + JOB + '" has never succeeded in the retained run history.');
  } else if (ageMin > STALE_AFTER_MINUTES) {
    problems.push('"' + JOB + '" last succeeded ' + ageMin + ' minutes ago (threshold '
      + STALE_AFTER_MINUTES + '). The detector is stale.');
  }
  if (Number(r.recent_fails) > 0) {
    problems.push('"' + JOB + '" has ' + r.recent_fails + ' failed run(s) in the last 24 hours.');
  }

  if (problems.length > 0) {
    problems.push('', 'While any of the above is true, silence from the cron-health channel is not evidence that the jobs are healthy.');
    fail(problems, { ...r, age_minutes: ageMin });
  }

  const summary = {
    ok: true,
    job: JOB,
    schedule: r.schedule,
    last_success: r.last_success,
    age_minutes: ageMin,
    failed_runs_24h: Number(r.recent_fails),
    open_cron_job_broken_alerts: Number(r.open_alerts),
  };
  if (JSON_OUT) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('CRON DETECTOR LIVENESS: OK');
    console.log('  ' + JOB + ' (' + r.schedule + ') last succeeded ' + ageMin + ' minute(s) ago.');
    console.log('  open cron_job_broken alerts right now: ' + r.open_alerts);
    console.log('  (this says the WATCHER is alive. What it FOUND is cron_health_status().)');
  }
}

// A LivenessFailure has already printed and set exitCode 1, so it unwinds
// silently. Anything else is a bug in THIS file and must never be mistaken for
// a healthy detector, so it also exits non-zero and says which it was.
try {
  await main();
} catch (e) {
  if (!(e instanceof LivenessFailure)) {
    console.error('CRON DETECTOR LIVENESS: the check itself failed —', e);
    process.exitCode = 1;
  }
}
