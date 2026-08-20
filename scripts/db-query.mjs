#!/usr/bin/env node
// db-query.mjs — run a SQL statement against the Supabase project via the
// Management API. SQL comes from a file (arg) or --sql "<inline>", so the
// vault-referencing SQL never sits on the shell command line.
//
//   node scripts/db-query.mjs supabase/migrations/264_eval_run_driver.sql
//   node scripts/db-query.mjs --sql "select 1"
//
// Token is read from .env.local (SUPABASE_ACCESS_TOKEN), BOM-stripped.

import { readFileSync, existsSync } from 'node:fs';
// THE checksum — shared with certify's migration-files-match-ledger-checksums
// section and with migrate:status, so the hash this file WRITES into the ledger
// and the hashes those two COMPARE it against cannot become three definitions
// of "the same migration". See that file for why the CRLF normalisation is
// load-bearing on this repo.
import { migrationChecksum } from './migration-committed-check.mjs';

const PROJECT_REF = 'rfsvmhcqeiyrxivbmpel';
const ENDPOINT = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

function readToken() {
  const env = readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
  const line = env.split(/\r?\n/).find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='));
  if (!line) throw new Error('SUPABASE_ACCESS_TOKEN not found in .env.local');
  return line.slice('SUPABASE_ACCESS_TOKEN='.length).replace(/^["']|["']$/g, '').trim();
}

function readSql(argv) {
  const i = argv.indexOf('--sql');
  if (i !== -1) {
    const sql = argv[i + 1];
    if (!sql) throw new Error('--sql requires a value');
    return sql;
  }
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) throw new Error('usage: db-query.mjs <file.sql> | --sql "<statement>"');
  return readFileSync(file, 'utf8');
}

const token = readToken();
const query = readSql(process.argv.slice(2));

// ── Refuse to apply a migration that is not COMMITTED, exactly as it is ───
// On 2026-08-10 two migrations (667, 668) were applied to PRODUCTION while
// their files existed in no git tree — not local, not origin. Production was
// running schema the repository could not reproduce, and nothing said so until
// certify's ORPHANED check caught it hours later. An applied-but-uncommitted
// migration is the worst state available: the effect is permanent, the source
// is one `rm` away from gone, and a rebuilt environment silently differs.
//
// ⚠ The first version of this guard called ONLY `git ls-files --error-unmatch`,
// which consults the INDEX. That catches a file git has never seen and nothing
// else — a TRACKED BUT MODIFIED migration applied without a word. Proven live
// on 2026-08-13: migration 737 was committed, its apply failed on illegal SQL,
// the file was edited, and the edited version went to production straight from
// the working tree. Production ran uncommitted schema for ~25 seconds. Nothing
// objected, because "is it in the index" is not the question. The question is
// whether the bytes about to run are the bytes anyone else can ever recover,
// and only HEAD can answer it.
//
// The escape hatch is deliberate and narrow, and now covers all three states.
// It exists so nobody is BLOCKED — only so that shipping schema the repository
// cannot rebuild has to be a decision somebody typed, and one that says so
// loudly on the way past.
{
  const f = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (f && /supabase[\\/]migrations[\\/]/.test(f)) {
    const ALLOW = process.argv.includes('--allow-uncommitted');
    const { spawnSync } = await import('node:child_process');
    const git = (args, opts = {}) =>
      spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });

    // Context a person hitting this at 2am needs, not a stack trace: WHICH
    // commit "HEAD" means here. On a detached HEAD or mid-rebase it is not the
    // branch tip, and the difference is otherwise invisible.
    const gitDir = git(['rev-parse', '--git-dir']).stdout?.trim();
    // symbolic-ref, not `rev-parse --abbrev-ref`: the latter prints the literal
    // string "HEAD" for BOTH a detached HEAD and an unborn branch, so it would
    // tell someone in a brand-new repo that they had detached — a wrong
    // diagnosis at the exact moment they are reading for one.
    const symref = git(['symbolic-ref', '--short', '-q', 'HEAD']);
    const branch = symref.status === 0 ? symref.stdout.trim() : null;
    const midOp = gitDir && ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD']
      .filter((n) => existsSync(`${gitDir}/${n}`));
    const whereAmI = () => {
      const bits = [];
      const sha = git(['rev-parse', '--short', 'HEAD']);
      const head = sha.status === 0 ? sha.stdout.trim() : null;
      if (branch && !head) bits.push(`branch ${branch}, which has NO COMMITS YET`);
      else if (branch) bits.push(`branch ${branch}`);
      else bits.push('DETACHED HEAD (not on a branch)');
      // A rebase or merge in flight means HEAD is not the branch tip, so
      // "committed" here is a weaker claim than usual. Say so rather than let
      // someone read a pass as more than it is.
      if (midOp?.length) bits.push(`mid-${midOp[0].startsWith('rebase') ? 'rebase' : midOp[0] === 'MERGE_HEAD' ? 'merge' : 'cherry-pick'} — HEAD is not the branch tip`);
      if (head) bits.push(`HEAD ${head}`);
      return `  (you are on: ${bits.join(', ')})`;
    };
    const stop = (headline, lines) => {
      if (ALLOW) {
        // LOUD. The whole point of the hatch is that it is a statement, not a
        // shortcut, so it announces exactly which protection was waived.
        console.error('');
        console.error('⚠  --allow-uncommitted: APPLYING SCHEMA THE REPOSITORY CANNOT REBUILD  ⚠');
        console.error(`   ${headline}`);
        console.error(whereAmI().trim() || '');
        console.error('   You have said you mean it. Commit the file, unchanged, the moment this');
        console.error('   returns — until you do, this migration exists only on this machine.');
        console.error('');
        return;
      }
      console.error(`REFUSED: ${headline}`);
      for (const l of lines) console.error(`  ${l}`);
      const w = whereAmI();
      if (w) console.error(w);
      console.error('  Or, if you really mean to apply it uncommitted, say so out loud:');
      console.error(`      node scripts/db-query.mjs ${f} --allow-uncommitted`);
      process.exit(1);
    };

    // Is git answerable at all? A missing binary, a non-repo directory or an
    // unborn branch all land here, and none of them is a pass: this guard fails
    // CLOSED, because "we could not check" and "it is fine" are not the same
    // sentence and only one of them is safe to act on.
    const headSha = git(['rev-parse', '--verify', 'HEAD^{commit}']);
    if (headSha.error || headSha.status !== 0) {
      stop(`git cannot be consulted about ${f}, so "is it committed?" has no answer.`, [
        `git said: ${String(headSha.stderr ?? headSha.error).trim().slice(0, 160)}`,
        'A repository with no commits yet, a directory that is not a repo, or no git on PATH.',
        'Fix that first — an unverifiable migration must not reach production by default.',
      ]);
    }

    // Path as git knows it — --full-name is relative to the repo root, so this
    // works from any cwd and normalises the Windows backslashes callers use.
    const lsFiles = git(['ls-files', '--full-name', '--error-unmatch', '--', f]);
    const repoPath = lsFiles.status === 0 ? lsFiles.stdout.trim().split(/\r?\n/)[0] : null;
    if (!repoPath) {
      stop(`${f} is not committed to git — git has never seen this file.`, [
        'Applying it would put schema in production that the repo cannot rebuild',
        '— exactly how 667 and 668 became orphans. Commit it first:',
        `    git add ${f} && git commit`,
      ]);
    }

    if (repoPath) {
      // The committed bytes. `cat-file blob` reads the object database
      // directly, so no checkout-time CRLF filter runs — which is why both
      // sides go through migrationChecksum() rather than being compared raw.
      const blob = git(['cat-file', 'blob', `HEAD:${repoPath}`]);
      if (blob.status !== 0) {
        // Tracked, but not present at HEAD: `git add` and no `git commit`. This
        // is the state that reads as "tracked" to the old guard and as GONE to
        // everybody else — a staged file is exactly as recoverable as an
        // untracked one, which is to say one `git reset` from nothing.
        stop(`${f} is STAGED but NOT COMMITTED — it exists in the index, in no commit.`, [
          'A staged file is not a shipped file: nothing outside this working tree can',
          'reproduce this database, and `git reset` would take the source with it.',
          'Finish the commit first:',
          '    git commit',
        ]);
      } else {
        const committed = migrationChecksum(blob.stdout);
        const working = migrationChecksum(readFileSync(f, 'utf8'));
        if (committed !== working) {
          // THE HOLE. Tracked, committed once, then edited — and applied.
          stop(`${f} has UNCOMMITTED CHANGES — the file on disk is not the file at HEAD.`, [
            'This is the one the old guard missed. `git ls-files` reads the INDEX, so a',
            'migration that was committed, failed, was edited and re-run applied its EDITED',
            'text to production while the repository still held the version that failed.',
            '',
            `    committed at HEAD   ${committed}`,
            `    about to be applied ${working}`,
            '',
            'What actually runs must be what anyone can recover. See the difference and',
            'commit it before applying:',
            `    git diff -- ${repoPath}`,
            `    git add ${repoPath} && git commit`,
          ]);
        }
      }
    }

    // ── THE FOURTH STATE: committed, but not where production can find it ───
    //
    // Everything above asks "is this committed?" and answers it against HEAD.
    // In a git worktree HEAD is that session's OWN BRANCH, so a migration
    // committed to claude/whatever passes every check above, applies to
    // production, and never reaches main. The repository still cannot rebuild
    // production — the guard just stopped noticing.
    //
    // That is not hypothetical and it is not rare. Eighteen migrations were
    // recovered on 2026-08-20 alone: sixteen from claude/docs54-stage-c, 795
    // from claude/decision-cockpit, 800 from an uncommitted worktree. Every one
    // had satisfied the checks above at the moment it was applied.
    //
    // Production is ONE shared database and main is the ONE shared source of
    // truth for it. "Committed somewhere" is not the invariant; "reachable from
    // origin/main" is, and only origin/main can answer it.
    if (repoPath) {
      const ALLOW_UNMERGED = process.argv.includes('--allow-unmerged');
      // Best effort: a stale origin/main would refuse a migration that IS on
      // main, which is the annoying-but-safe direction. Network failures are
      // tolerated for that reason — but the ANSWER still comes from the ref.
      git(['fetch', '--quiet', 'origin', 'main'], { timeout: 20000 });

      const onMain = git(['cat-file', 'blob', `origin/main:${repoPath}`]);
      const working = migrationChecksum(readFileSync(f, 'utf8'));
      const mainSum = onMain.status === 0 ? migrationChecksum(onMain.stdout) : null;

      if (mainSum !== working) {
        const why = mainSum === null
          ? `${repoPath} is not on origin/main at all.`
          : `${repoPath} on origin/main is DIFFERENT from the file being applied.`;
        if (ALLOW_UNMERGED) {
          console.error('');
          console.error('⚠  --allow-unmerged: APPLYING SCHEMA main CANNOT REBUILD  ⚠');
          console.error(`   ${why}`);
          console.error('   Production will hold this migration and main will not. Merge and push');
          console.error('   the moment this returns — until you do, this is an orphan.');
          console.error('');
        } else {
          console.error(`REFUSED: ${why}`);
          console.error('  It may be committed on your branch — that is not the same thing. Production is');
          console.error('  one shared database and main is the one source of truth for it, so a migration');
          console.error('  applied from an unmerged branch is an orphan the moment it lands: production');
          console.error('  carries schema that main cannot reproduce.');
          console.error('');
          console.error('  This is how 18 migrations became orphans on 2026-08-20 — every one of them');
          console.error('  passed the "is it committed?" check above, on its own branch.');
          console.error('');
          console.error('  Push and merge to main first, then apply:');
          console.error(`      git push origin HEAD  &&  <merge to main>  &&  git fetch origin main`);
          console.error('');
          console.error('  Or, if you really mean production to hold schema main cannot rebuild:');
          console.error(`      node scripts/db-query.mjs ${f} --allow-unmerged`);
          process.exit(1);
        }
      }
    }
  }
}

const res = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query }),
});

const text = await res.text();
if (!res.ok) {
  console.error(`HTTP ${res.status}`);
  console.error(text);
  process.exit(1);
}
console.log(text);

// ── Record it in the ledger (mig 364) ──────────────────────────────────────
// Only for a real migration FILE, and only AFTER it succeeded — a failed
// migration must never leave a row claiming it was applied. This is what turns
// the ledger from a one-off snapshot into something that stays true: before
// this, "which migrations are applied" lived in one person's memory.
const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (file && /supabase[\\/]migrations[\\/]/.test(file)) {
  try {
    const name = file.split(/[\\/]/).pop();
    // CRLF-normalised, and normalised by the SHARED function: certify compares
    // this exact hash against the file as committed at HEAD, so the two must be
    // the same code and not two copies that agree today.
    const sum = migrationChecksum(readFileSync(file, 'utf8'));
    const rec = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `select public.record_migration_applied(
                  ${JSON.stringify(name).replace(/"/g, "'")}, '${sum}', 'db-query.mjs') as r`,
      }),
    });
    if (rec.ok) {
      const r = JSON.parse(await rec.text())[0]?.r;
      if (r?.content_changed_since_last_apply) {
        console.error(`⚠  ${name} was applied before with DIFFERENT content — the database may not match this file.`);
      } else if (r?.reapplied) {
        console.error(`ledger: ${name} re-applied`);
      } else {
        console.error(`ledger: ${name} recorded`);
      }
    }
  } catch {
    // Never fail a successful migration because the bookkeeping call failed —
    // but say so, so the ledger silently drifting is visible.
    console.error('⚠  migration applied, but the ledger could not be updated');
  }
}
