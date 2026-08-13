// The "what ran is what is committed" comparison, split the way
// provider-catalog-check.mjs and discovery-spine-check.mjs are split, and for
// the same reason: certify.mjs runs against PRODUCTION, so the only way to
// prove one of these assertions can FIRE is to hand the REAL comparison a
// mutated COPY of live state and watch it go red — never to write a wrong row
// into the live ledger.
//
// certify.mjs fetches and formats; committedLedgerFailures() decides;
// scripts/certify-mutation-test.mjs imports the IDENTICAL function so its
// fixtures exercise the gate rather than a paraphrase of it.
//
// ── Why this file exists at all ────────────────────────────────────────────
// CLAUDE.md: "Commit the migration before you apply it. An applied-but-
// uncommitted migration is the worst state available: the effect is permanent,
// the source is one `rm` from gone, and a rebuilt environment differs
// silently."
//
// Two things were supposed to hold that line and neither could:
//
//   1. scripts/db-query.mjs refused only an UNTRACKED file (`git ls-files
//      --error-unmatch`, which consults the INDEX). A migration that was
//      committed, failed on bad SQL, was EDITED, and re-applied straight from
//      the working tree sailed through — proven live on 2026-08-13 with
//      migration 737. Production ran uncommitted schema and nothing objected.
//
//   2. certify's `migration-files-match-ledger-checksums` section, whose stated
//      purpose is "a migration edited after applying no longer describes what
//      ran", asserted only `checksum is null and recorded_at > '2026-08-01'`.
//      It never compared a ledger checksum to any file content. Production
//      holds 763 ledger rows and ZERO null checksums, so it returned zero rows
//      the way an empty scan does: indistinguishable from a clean result.
//
// scripts/migration-status.mjs DOES compare checksums, but against DISK — so
// the exact state this exists to catch (applied from an edited working tree,
// never committed) reads APPLIED there. Disk agrees with the ledger precisely
// BECAUSE the wrong thing was applied. HEAD is the only witness that disagrees.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const MIGRATION_DIR = 'supabase/migrations';

/**
 * THE canonical migration checksum — the one public.schema_migrations rows are
 * written with by scripts/db-query.mjs, and therefore the only hash a
 * comparison against that ledger may use.
 *
 * ⚠ The CRLF normalisation is load-bearing and must never be "cleaned up".
 * This repo runs on Windows with core.autocrlf=true: git stores LF in the
 * object database and checks out CRLF, so `git cat-file` content and the file
 * on disk differ by line ending in EVERY migration. Hash the raw bytes and
 * this check is red for all 761 files forever, which is worse than the hole it
 * closes. Hash the normalised text and a file that differs only by line ending
 * is correctly not a changed migration.
 *
 * Imported by db-query.mjs (which WRITES the ledger checksum) and by
 * migration-status.mjs (which compares it to disk), so the three cannot drift
 * into three subtly different definitions of "the same migration".
 */
export const migrationChecksum = (content) =>
  createHash('sha256').update(String(content).replace(/\r\n/g, '\n'), 'utf8').digest('hex');

/**
 * Every migration file AS COMMITTED at a git revision, keyed by basename.
 *
 * ONE `git cat-file --batch` process, not 761 `git show` calls: the per-spawn
 * cost on Windows would turn a sub-second read into most of a minute, and a
 * check that is slow is a check someone eventually moves out of --fast.
 *
 * Reads the blob bytes directly, so no checkout-time CRLF filter is applied —
 * which is exactly why migrationChecksum() must normalise.
 *
 * @param {string} rev git revision to read (default HEAD)
 * @returns {{ content: Map<string,string>, rev: string, revSha: string }}
 * @throws if git cannot be consulted at all. A gate that cannot read its
 *         evidence must STOP, never quietly report "nothing to compare".
 */
export function readCommittedMigrations(rev = 'HEAD') {
  const sha = spawnSync('git', ['rev-parse', '--verify', `${rev}^{commit}`], { encoding: 'utf8' });
  if (sha.error || sha.status !== 0) {
    throw new Error(
      `cannot resolve ${rev} to a commit (${String(sha.stderr ?? sha.error).trim().slice(0, 160)}). `
      + 'An unborn branch, a non-repo working directory or a missing git binary all land here — '
      + 'and none of them are a pass.',
    );
  }
  const revSha = sha.stdout.trim();

  const ls = spawnSync('git', ['ls-tree', '-r', '-z', '--name-only', revSha, '--', MIGRATION_DIR],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (ls.error || ls.status !== 0) {
    throw new Error(`git ls-tree failed: ${String(ls.stderr ?? ls.error).trim().slice(0, 160)}`);
  }
  // -z, not newline-split: a filename may legally contain a newline, and
  // newline-splitting would silently mis-key it rather than fail.
  const paths = ls.stdout.split('\0').filter((p) => p.endsWith('.sql'));

  const content = new Map();
  if (paths.length === 0) return { content, rev, revSha };

  const batch = spawnSync('git', ['cat-file', '--batch'], {
    input: paths.map((p) => `${revSha}:${p}`).join('\n') + '\n',
    maxBuffer: 512 * 1024 * 1024,
  });
  if (batch.error || batch.status !== 0) {
    throw new Error(`git cat-file failed: ${String(batch.stderr ?? batch.error).trim().slice(0, 160)}`);
  }
  // `--batch` emits "<oid> <type> <size>\n<contents>\n" per request, in request
  // order. Parsed by declared SIZE rather than by scanning for a delimiter,
  // because SQL contains every byte a delimiter could be.
  const buf = batch.stdout;
  let off = 0;
  for (const p of paths) {
    const nl = buf.indexOf(0x0a, off);
    if (nl === -1) throw new Error(`git cat-file output ended early at ${p}`);
    const header = buf.toString('utf8', off, nl);
    const m = /^([0-9a-f]{40,64}) (\w+) (\d+)$/.exec(header);
    if (!m || m[2] !== 'blob') {
      throw new Error(`git cat-file returned "${header.slice(0, 80)}" for ${p} — expected a blob`);
    }
    const size = Number(m[3]);
    content.set(p.split('/').pop(), buf.toString('utf8', nl + 1, nl + 1 + size));
    off = nl + 1 + size + 1;                     // skip the trailing newline
  }
  return { content, rev, revSha };
}

/**
 * PURE. No database, no git, no clock, no filesystem.
 *
 * @param {object} s
 * @param {{filename:string, checksum:string|null, provenance:string|null}[]} s.ledger
 *        public.schema_migrations, every row.
 * @param {Map<string,string>} s.committed basename -> file content AS COMMITTED.
 * @param {Set<string>} s.onDisk basenames present in the working tree.
 * @returns {{failures:string[], compared:number, comparedByProvenance:Record<string,number>,
 *            orphans:string[], uncommitted:string[]}}
 */
export function committedLedgerFailures({ ledger, committed, onDisk }) {
  const failures = [];
  const orphans = [];
  const uncommitted = [];
  const comparedByProvenance = {};
  let compared = 0;

  // ── Liveness, first, because it is the failure this repo actually ships ──
  // "0 findings" from "0 comparisons" reads exactly like a clean result. If
  // the revision holds no migrations, or the ledger is empty, this section has
  // proven NOTHING and must say so in red — not print a reassuring zero.
  if (!(committed instanceof Map) || committed.size === 0) {
    failures.push('read 0 migration files from the commit — nothing was compared, so nothing is proven');
  }
  if (!Array.isArray(ledger) || ledger.length === 0) {
    failures.push('the ledger returned 0 rows — nothing was compared, so nothing is proven');
  }

  for (const row of ledger ?? []) {
    const name = row?.filename;
    if (!name) {
      failures.push('a schema_migrations row has no filename — the ledger cannot be joined to anything');
      continue;
    }
    // The ORIGINAL assertion, kept — but now it is one arm of a check that has
    // others, instead of the whole thing. A null checksum means the ledger
    // records that something ran and cannot say what.
    if (!row.checksum) {
      failures.push(`${name}: ledger row has NO checksum — the ledger cannot say what ran`);
      continue;
    }

    const head = committed.get(name);
    if (head !== undefined) {
      compared++;
      const p = row.provenance ?? 'unknown';
      comparedByProvenance[p] = (comparedByProvenance[p] ?? 0) + 1;
      const want = migrationChecksum(head);
      if (want !== row.checksum) {
        failures.push(
          `${name}: APPLIED CONTENT != COMMITTED CONTENT.\n`
          + `    ledger says   ${row.checksum}\n`
          + `    the commit is ${want}\n`
          + '    Production is running a version of this migration that the repository does not\n'
          + '    hold. Either the file was edited after it was applied, or it was applied from an\n'
          + '    uncommitted working tree. Do NOT "fix" this by re-hashing the ledger: work out\n'
          + '    which text actually ran, and ship the difference as a NEW migration.',
        );
      }
      continue;
    }

    // In the ledger, not in the commit. Two very different states — and the
    // difference is the whole point of comparing against a COMMIT rather than
    // against disk, which is all scripts/migration-status.mjs can do.
    if (onDisk?.has(name)) {
      // The file is right there in the working tree, so migrate:status calls
      // it APPLIED and is green. It is nothing of the sort: nothing outside
      // this machine has ever seen it. This is the hole, stated exactly.
      uncommitted.push(name);
      failures.push(
        `${name}: APPLIED BUT NEVER COMMITTED. The file is in the working tree and in the\n`
        + '    ledger, and in no commit — so `npm run migrate:status` reads it as APPLIED while a\n'
        + '    fresh clone cannot rebuild this database. Commit the file exactly as it was applied.',
      );
    } else {
      // In the ledger, in no commit, and not on disk either: an ORPHAN.
      //
      // DELIBERATELY NOT A FAILURE HERE, and not by an exemption list. This
      // section's question is "does what ran match what is committed"; an
      // orphan has no file to answer with. The question "is there a ledger row
      // whose file the repo no longer holds" is already owned, by name, by the
      // `migration-ledger` section (scripts/migration-status.mjs ORPHANED),
      // which is RED for 715_the_definition_says_which_engine_owns_it.sql and
      // 717_four_roles_get_a_procedure_and_intake.sql as this is written.
      //
      // Failing here as well would make this section permanently red for
      // pre-existing debt that another gate is already red for — and a section
      // that is always red is a section people stop reading. A NEW orphan is
      // not let off: it turns migration-ledger red the day it appears. The
      // names are printed below either way, so this never becomes silence.
      orphans.push(name);
    }
  }

  if (compared === 0 && !failures.length) {
    failures.push('0 ledger rows were compared against committed content — a comparison that compares nothing is not a pass');
  }
  return { failures, compared, comparedByProvenance, orphans, uncommitted };
}
