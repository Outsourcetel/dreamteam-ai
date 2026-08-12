// The provider-catalog comparison, as a PURE function over already-fetched
// state — no database, no I/O, no clock.
//
// It lives here rather than inline in certify.mjs for one reason: certify runs
// against PRODUCTION, and the only way to prove one of these assertions can
// fail used to be writing a violating row to the live catalog. That is now
// refused (and was always the wrong shape — an interrupted run leaves the
// product catalog wrong). Pulling the comparison out lets
// scripts/certify-mutation-test.mjs hand it a MUTATED COPY of the live state
// and watch the real code fire, which is the pattern that file's own header
// describes: "every mutation SYNTHESISES a violating row (no writes)".
//
// certify.mjs fetches and formats; this decides. Both call the same function,
// so the gate cannot drift from the thing that proves the gate works.
import { readFileSync } from 'node:fs';
// Same reason scripts/gen-provider-seed.mjs already carries this: plain node
// cannot `import` src/lib/connectorApi.ts (it drags in '../supabase' with no
// extension, then env.ts touches import.meta.env, a Vite-only global). So the
// constants are read out of the source TEXT instead, with the compiler this
// repo already builds with.
import ts from 'typescript';
import { derivedAliases, derivedAuthKind } from './provider-aliases.mjs';

// ── PROVIDERS / TOP_PROVIDERS / AMBIGUOUS_ALIASES, from the SOURCE TEXT ────
// Walks the parsed AST: it can only read the literals these constants are
// actually written as, and a spread, a computed key or a function call throws
// rather than silently guessing. connectorApi.ts is never EXECUTED, so this
// trips neither failure above, and the values are DERIVED every run, never
// hand-copied.
function evalConnectorLiteral(node) {
  if (ts.isObjectLiteralExpression(node)) {
    const obj = {};
    for (const prop of node.properties) {
      if (!ts.isPropertyAssignment(prop)) {
        throw new Error(`provider-catalog: unsupported object member kind: ${ts.SyntaxKind[prop.kind]}`);
      }
      let key;
      if (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)) key = prop.name.text;
      else throw new Error(`provider-catalog: unsupported property key kind: ${ts.SyntaxKind[prop.name.kind]}`);
      obj[key] = evalConnectorLiteral(prop.initializer);
    }
    return obj;
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(evalConnectorLiteral);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  throw new Error(`provider-catalog: unsupported literal kind: ${ts.SyntaxKind[node.kind]} (${node.getText()})`);
}

export function readConnectorConstants() {
  const SRC = 'src/lib/connectorApi.ts';
  const source = ts.createSourceFile(
    SRC, readFileSync(SRC, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
  );
  const found = {};
  source.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) return;
    for (const decl of node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      if (decl.name.text === 'PROVIDERS' || decl.name.text === 'TOP_PROVIDERS'
        || decl.name.text === 'AMBIGUOUS_ALIASES') {
        found[decl.name.text] = decl.initializer;
      }
    }
  });
  if (!found.PROVIDERS) throw new Error(`could not find "export const PROVIDERS = ..." in ${SRC}`);
  if (!found.TOP_PROVIDERS) throw new Error(`could not find "export const TOP_PROVIDERS = ..." in ${SRC}`);
  // Not optional. If this constant is renamed away, the gate must STOP rather
  // than fall back to an empty stop-list and green a catalog that has quietly
  // re-acquired "close", "front" and "box" as system names.
  if (!found.AMBIGUOUS_ALIASES) throw new Error(`could not find "export const AMBIGUOUS_ALIASES = ..." in ${SRC}`);
  return {
    PROVIDERS: evalConnectorLiteral(found.PROVIDERS),
    TOP_PROVIDERS: evalConnectorLiteral(found.TOP_PROVIDERS),
    AMBIGUOUS_ALIASES: evalConnectorLiteral(found.AMBIGUOUS_ALIASES),
  };
}

// `dreamteam` is exempt BY NAME, not by category. It is the platform's own
// self-connector (supabase/functions/connector-hub/index.ts, dreamteamActions:
// hire_from_archetype, create_digital_employee, draft_playbook,
// propose_connector) and it holds 17 live `connectors` rows. It is deliberately
// NOT in the catalog: the catalog is what the discovery interview offers a
// CUSTOMER, and PROVIDERS is what the connector picker renders — so adding it
// there would have put a "DreamTeam" connector in front of customers to sit and
// try to connect to. One named key; every OTHER value present in only one list
// is still a failure, and the exemption is itself a ratchet (see below).
export const CHECK_ONLY_BY_DESIGN = new Set(['dreamteam']);

/** Pull the accepted values out of a CHECK constraint definition. */
export function providerCheckValues(def) {
  return new Set([...String(def ?? '').matchAll(/'([^']+)'::text/g)].map((m) => m[1]));
}

/**
 * @param {object} s live state, all of it already fetched
 * @param {object} s.PROVIDERS         from src/lib/connectorApi.ts
 * @param {object} s.TOP_PROVIDERS     from src/lib/connectorApi.ts
 * @param {string[]} s.AMBIGUOUS_ALIASES from src/lib/connectorApi.ts
 * @param {object[]} s.rows            public.connector_providers where active
 * @param {Set<string>} s.inCheck      values accepted by connectors_provider_check
 * @param {string[]} s.cats            role_archetypes.required_connector_categories
 * @param {{can_read:boolean, can_delete:boolean}} s.priv
 * @returns {{failures: string[], compared: number, aliasCount: number}}
 */
export function providerCatalogFailures(s) {
  const { PROVIDERS, TOP_PROVIDERS, rows, inCheck, cats, priv } = s;
  const ambiguous = new Set(s.AMBIGUOUS_ALIASES);
  const failures = [];

  const inDb = new Set(rows.map((r) => r.provider_key));
  const inTs = Object.keys(PROVIDERS);

  // BOTH directions. Asserting only one half passes a catalog that is empty.
  for (const k of inTs) if (!inDb.has(k)) failures.push(`catalog missing provider: ${k}`);
  for (const k of inDb) if (!inTs.includes(k)) failures.push(`catalog has unknown provider: ${k}`);

  // ── The THIRD list: the CHECK on connectors.provider ────────────────────
  // PROVIDERS <-> catalog was watched. connectors_provider_check was not, in
  // EITHER direction — so adding a provider to PROVIDERS plus a seed migration
  // while forgetting the CHECK left the gate GREEN, the UI offering the
  // provider, and the INSERT failing at runtime. Precisely the failure mode the
  // catalog was built to end, surviving one layer down.
  if (inCheck.size === 0) {
    failures.push('could not read connectors_provider_check — the third list is unwatched');
  }
  for (const k of inCheck) {
    if (!inDb.has(k) && !CHECK_ONLY_BY_DESIGN.has(k)) {
      failures.push(`connectors.provider accepts "${k}" but the catalog has never heard of it`);
    }
  }
  for (const k of inDb) {
    if (!inCheck.has(k)) failures.push(`catalog offers "${k}" but connectors.provider would REJECT the insert`);
  }
  // The exemption is a ratchet, not a permanent pass: once dreamteam leaves the
  // CHECK the exemption is stale and must be deleted rather than left behind to
  // bless a key nobody uses any more.
  for (const k of CHECK_ONLY_BY_DESIGN) {
    if (!inCheck.has(k)) failures.push(`exempt provider "${k}" is gone from connectors_provider_check — drop the exemption`);
  }

  const seen = new Map();
  for (const r of rows) {
    for (const a of r.aliases ?? []) {
      if (seen.has(a)) failures.push(`alias "${a}" resolves to both ${seen.get(a)} and ${r.provider_key}`);
      else seen.set(a, r.provider_key);
      // mig 729. An alias that is an ordinary English word made matchProvider
      // read "we close deals on monday" as four systems, all at confidence
      // 'exact'. The stop-list only stays a fix while the DATA obeys it, so this
      // is where a re-seed that reintroduced one gets caught.
      if (ambiguous.has(a)) {
        failures.push(`alias "${a}" (${r.provider_key}) is ordinary English — AMBIGUOUS_ALIASES says it must not be an alias`);
      }
    }
  }

  // ── Field-level, not just key-level ─────────────────────────────────────
  // Key-set parity was the ONLY thing compared, leaving 7 of 8 columns as
  // unguarded copies. `auth_kind` decides whether the interview tells a customer
  // "sign in" or "paste a key"; `credential_hint` is the literal instruction
  // they follow. A drift in either is silent and customer-facing.
  //
  // Aliases are compared by CONTAINMENT, not equality, and deliberately: mig 727
  // added curated synonyms ('sfdc', 'qb', 'qbo', 'hub spot', 'zen desk') that no
  // derivation can infer. So the assertion is "everything the generator would
  // produce is present" — a hand-curated extra is allowed, and the ambiguity and
  // duplicate checks above are what keep an extra from being junk.
  let compared = 0;
  const byKey = new Map(rows.map((r) => [r.provider_key, r]));
  for (const [key, m] of Object.entries(PROVIDERS)) {
    const row = byKey.get(key);
    if (!row) continue;                          // already reported as missing above
    const want = {
      label: m.label,
      category: m.defaultCategory,
      auth_kind: derivedAuthKind(m),
      credential_hint: m.help ?? null,
      default_base_url: m.baseUrlPlaceholder ?? null,
      implemented: !!m.implemented,
    };
    for (const [col, v] of Object.entries(want)) {
      compared++;
      const got = row[col] ?? null;
      if (String(got) !== String(v ?? null)) {
        failures.push(`${key}.${col} drifted — catalog ${JSON.stringify(got)} vs PROVIDERS ${JSON.stringify(v)}`);
      }
    }
    for (const a of derivedAliases(key, m, ambiguous)) {
      compared++;
      if (!(row.aliases ?? []).includes(a)) failures.push(`${key}.aliases is missing the derived alias "${a}"`);
    }
  }

  for (const cat of cats) {
    if (!TOP_PROVIDERS[cat]?.length) failures.push(`no provider suggested for category: ${cat}`);
  }

  // Structural, not behavioural: certify runs against PRODUCTION and a real
  // DELETE probe is not safe there, so this reads the grant rather than
  // attempting the write it forbids.
  if (!priv?.can_read) failures.push('authenticated cannot read the catalog');
  if (priv?.can_delete) failures.push('authenticated can DELETE from the catalog');

  return { failures, compared, aliasCount: seen.size };
}
