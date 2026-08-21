// The subprocessor-disclosure comparison, as a PURE function over
// already-fetched state — no database, no network, no clock.
//
// ── What it is guarding (register item A-8) ──────────────────────────────
// `supabase/functions/_shared/llm.ts` walks a provider failover chain, and a
// provider joins it THE MOMENT ITS KEY RESOLVES: workspace settings, platform
// settings, or an edge-function secret. No deploy, no policy change, no
// customer notice. The privacy policy is a commitment to customers, and it
// was carrying that list — plus two claims about today's configuration — as
// hand-written prose. It happened to be accurate. It was accurate by
// coincidence of configuration, not by construction.
//
// So the page now renders from src/lib/subprocessors.ts, and this compares
// that list against three things at once:
//
//   A  the LLM chain the CODE can reach          (both directions)
//   B  the credential keys the CODE resolves     (every one must be claimed)
//   C  the credentials actually CONFIGURED LIVE  (every one must be claimed)
//   D  the page still DERIVES rather than restates
//
// C is the arm that catches the person pasting a key: a secret appearing in
// `platform_config` or `tenant_llm_credentials` for a vendor nothing has
// disclosed is named, by key, on the next certify run.
//
// ⚠ THE LIMIT, STATED RATHER THAN HIDDEN. `aiKeys.ts` falls back to
// `Deno.env.get(name)`. An edge-function env secret arms a provider and NO
// database query can see it — arm C is blind to that store, and says so in
// its own detail line rather than reporting a coverage it does not have. The
// edge runtime is the only thing that can see both sources and it already
// reports per-tier `source: config | env | both | none`
// (supabase/functions/ai-engine-status/index.ts). Wiring that into certify
// needs a platform-admin JWT in CI; it is on the register, not pretended
// here.
//
// certify.mjs fetches and formats; this decides. scripts/certify-mutation-test.mjs
// imports the identical function, so the cases that prove this can fail
// exercise the real gate and not a paraphrase of it.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
// Same reason provider-catalog-check.mjs already carries this: plain node
// cannot `import` a .ts file out of src/, so the manifest is read out of the
// SOURCE TEXT with the compiler this repo already builds with. The file is
// never executed.
import ts from 'typescript';

export const MANIFEST_SRC = 'src/lib/subprocessors.ts';
export const LLM_SRC = 'supabase/functions/_shared/llm.ts';
export const PAGE_SRC = 'src/pages/legal/PrivacyPolicyPage.tsx';

// ── Config keys that travel the credential store but arm NOBODY ──────────
// These resolve through the same platform_config/Vault path as a real
// credential and are not one: model ids, a region, a routing order, a
// failover marker, a mailbox map. Each is exempt BY NAME so that a new
// key cannot slip in under a category — and a name here that appears
// neither live nor anywhere in the code is itself a failure (below), so the
// list cannot outlive its reasons.
export const NON_EGRESS_CONFIG = new Map([
  ['BEDROCK_REGION', 'AWS region string for the Bedrock endpoint — not a credential'],
  ['BEDROCK_MODEL_PREFIX', 'model-id prefix, e.g. "us.anthropic." — not a credential'],
  ['BEDROCK_MODEL_MAP', 'exact model-id overrides — not a credential'],
  ['OPENAI_MODEL', 'model id — not a credential'],
  ['GOOGLE_AI_MODEL', 'model id — not a credential'],
  ['LLM_PROVIDER_ORDER', 'reorders the chain; cannot force in an unarmed provider (llm.ts filters by `available`)'],
  ['LLM_LAST_FAILOVER', 'marker written by mig 700 recording the last failover — not a credential'],
  ['INBOUND_EMAIL_MAP', 'address-to-workspace routing map — not a credential'],
]);

// Patterns, for keys that are per-tenant and therefore cannot be listed by
// name. Deliberately NOT covered by the stale-exemption ratchet below: an
// empty match here means "no workspace has set one", which is an ordinary
// state, not a stale exemption.
export const NON_EGRESS_CONFIG_PATTERNS = [
  { re: /^alert_email_/, reason: 'per-tenant destination address for the workspace\'s own operational alerts' },
];

// Phrases a STATIC page cannot keep true. Each one was on the page before
// A-8 was worked; the ratchet is against them coming back, in any vendor's
// name, rather than against these exact sentences.
export const UNVERIFIABLE_CLAIM_PATTERNS = [
  { re: /only provider currently/i, label: '"…only provider currently…" — a live-configuration claim' },
  { re: /currently receiving/i, label: '"…currently receiving…" — a live-configuration claim' },
  { re: /is (?:configured|set) today/i, label: '"…is configured today…" — a live-configuration claim' },
  { re: /none of the (?:three|four|providers)/i, label: '"none of the three…" — a live-configuration claim' },
];

// ── Reading the manifest out of the TypeScript source ────────────────────
function evalLiteral(node, where) {
  if (ts.isObjectLiteralExpression(node)) {
    const obj = {};
    for (const prop of node.properties) {
      if (!ts.isPropertyAssignment(prop)) {
        throw new Error(`${where}: unsupported object member kind ${ts.SyntaxKind[prop.kind]}`);
      }
      if (!ts.isIdentifier(prop.name) && !ts.isStringLiteralLike(prop.name)) {
        throw new Error(`${where}: unsupported property key kind ${ts.SyntaxKind[prop.name.kind]}`);
      }
      obj[prop.name.text] = evalLiteral(prop.initializer, where);
    }
    return obj;
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((e) => evalLiteral(e, where));
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  // A concatenation of string literals (COUNSEL_PLACEHOLDER is written that way).
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return String(evalLiteral(node.left, where)) + String(evalLiteral(node.right, where));
  }
  throw new Error(`${where}: unsupported literal kind ${ts.SyntaxKind[node.kind]} (${node.getText()})`);
}

/** SUBPROCESSORS + ARMING_GROUPS, derived from the source text every run. */
export function readManifest(src = MANIFEST_SRC) {
  const source = ts.createSourceFile(src, readFileSync(src, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = {};
  source.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) return;
    for (const decl of node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      if (decl.name.text === 'SUBPROCESSORS' || decl.name.text === 'ARMING_GROUPS') {
        // `as const` / satisfies wrappers unwrap to the literal.
        let init = decl.initializer;
        while (ts.isAsExpression(init) || ts.isSatisfiesExpression?.(init)) init = init.expression;
        found[decl.name.text] = init;
      }
    }
  });
  // Not optional. If either constant is renamed away the gate must STOP,
  // never fall back to an empty list and green a disclosure of nothing.
  if (!found.SUBPROCESSORS) throw new Error(`could not find "export const SUBPROCESSORS = ..." in ${src}`);
  if (!found.ARMING_GROUPS) throw new Error(`could not find "export const ARMING_GROUPS = ..." in ${src}`);
  return {
    SUBPROCESSORS: evalLiteral(found.SUBPROCESSORS, 'subprocessors'),
    ARMING_GROUPS: evalLiteral(found.ARMING_GROUPS, 'arming-groups'),
  };
}

// ── Reading the failover chain out of llm.ts ─────────────────────────────
/**
 * The providers the chain can reach, and the key that arms each — derived
 * from the source, never hand-copied. Both halves must be non-empty and must
 * agree, so a refactor that renames `available.push` makes this THROW rather
 * than quietly report an empty chain (which would green everything).
 */
export function readLlmChain(src = LLM_SRC) {
  const text = readFileSync(src, 'utf8');
  const providers = [...text.matchAll(/available\.push\('([a-z0-9-]+)'\)/g)].map((m) => m[1]);
  if (providers.length === 0) {
    throw new Error(`${src}: found no \`available.push('<provider>')\` — the chain derivation has broken, refusing to report an empty chain`);
  }
  // `const anthropicKey = k.ANTHROPIC_API_KEY` → var → key
  const varToKey = new Map([...text.matchAll(/\b(\w+Key)\s*=\s*k\.([A-Z][A-Z0-9_]*)/g)].map((m) => [m[1], m[2]]));
  // `if (anthropicKey) available.push('anthropic')` → var → provider
  const providerToKey = {};
  for (const m of text.matchAll(/if\s*\((\w+Key)\)\s*available\.push\('([a-z0-9-]+)'\)/g)) {
    const key = varToKey.get(m[1]);
    if (!key) throw new Error(`${src}: \`${m[1]}\` gates provider '${m[2]}' but no \`= k.KEY_NAME\` assignment was found for it`);
    providerToKey[m[2]] = key;
  }
  for (const p of providers) {
    if (!providerToKey[p]) throw new Error(`${src}: provider '${p}' joins the chain but the derivation found no key gating it`);
  }
  return { providers: [...new Set(providers)], providerToKey };
}

/**
 * Every credential/config key name the edge functions resolve through
 * aiKeys.ts — i.e. everything that can come out of the shared credential
 * store. Derived from the call sites, so a new `getAIKey(admin, 'X_API_KEY')`
 * arrives here without anyone remembering to add it.
 */
export function readResolvedKeyNames(files) {
  const names = new Set();
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    // getAIKey(admin, 'NAME'…)  and  getAIKeys(admin, ['A','B'…]…)
    for (const m of text.matchAll(/getAIKeys?\s*\(\s*\w+\s*,\s*('[^']+'|\[[^\]]*\])/g)) {
      for (const lit of m[1].matchAll(/'([A-Z][A-Z0-9_]*)'/g)) names.add(lit[1]);
    }
  }
  if (names.size === 0) {
    throw new Error('found no getAIKey/getAIKeys call sites — the credential derivation has broken, refusing to report an empty set');
  }
  return names;
}

/**
 * Every .ts file under supabase/functions plus the front-end modules that can
 * hold an egress credential. ONE enumeration, shared with the mutation test,
 * so the gate and its proof read the same surface. It walks the tree rather
 * than listing files: a NEW edge function that resolves a NEW provider key is
 * exactly the case a hand-written file list would miss.
 */
export function egressSources(roots = ['supabase/functions', 'src/lib', 'src/components']) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name).replace(/\\/g, '/');
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
    }
  };
  for (const r of roots) walk(r);
  if (out.length === 0) throw new Error(`egressSources: found no sources under ${roots.join(', ')} — refusing to derive from an empty tree`);
  return out;
}

/** Every SCREAMING_CASE token that appears anywhere in the given sources. */
export function readKeyTokens(files) {
  const tokens = new Set();
  for (const f of files) {
    if (!existsSync(f)) continue;
    for (const m of readFileSync(f, 'utf8').matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)) tokens.add(m[1]);
  }
  return tokens;
}

/**
 * Does the page actually ITERATE the manifest, or has it gone back to prose?
 *
 * A regex was the first attempt and it was wrong in a way worth recording:
 * the page renders `ARMING_GROUPS.map(group => SUBPROCESSORS.filter(...).map(...))`,
 * so the literal `SUBPROCESSORS` and the `.map(` that consumes it are ~200
 * characters and one local binding apart. Any proximity window tight enough
 * to mean something rejected the correct page, and any window loose enough to
 * accept it would also accept `SUBPROCESSORS` sitting unused in an import
 * beside a hand-written list. So it walks the AST instead: bindings seeded
 * from SUBPROCESSORS, then a `.map(` whose receiver is one of them.
 */
export function pageRendersManifest(pageSource) {
  const sf = ts.createSourceFile(PAGE_SRC, pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const seeded = new Set(['SUBPROCESSORS']);
  // Two passes: a local can be declared after the map that uses it only in
  // hoisted code, but a second pass costs nothing and removes the ordering
  // assumption entirely.
  for (let pass = 0; pass < 2; pass++) {
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const text = node.initializer.getText();
        if ([...seeded].some((n) => new RegExp(`\\b${n}\\b`).test(text))) seeded.add(node.name.text);
      }
      node.forEachChild(visit);
    };
    sf.forEachChild(visit);
  }
  let found = false;
  const look = (node) => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'map') {
      const receiver = node.expression.expression.getText();
      if ([...seeded].some((n) => new RegExp(`\\b${n}\\b`).test(receiver))) found = true;
    }
    node.forEachChild(look);
  };
  sf.forEachChild(look);
  return found;
}

function claimFor(manifest) {
  const byKey = new Map();
  for (const e of manifest) for (const k of e.armedBy ?? []) {
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(e.id);
  }
  return byKey;
}

/**
 * @param {object} s
 * @param {object[]} s.manifest          SUBPROCESSORS, from readManifest()
 * @param {object[]} s.groups            ARMING_GROUPS, from readManifest()
 * @param {string[]} s.llmProviders      from readLlmChain()
 * @param {Record<string,string>} s.llmProviderToKey from readLlmChain()
 * @param {Set<string>} s.resolvedKeyNames  from readResolvedKeyNames()
 * @param {Set<string>} s.repoKeyTokens     from readKeyTokens()
 * @param {{key:string, store:string}[]} s.configuredSecrets  live, both stores
 * @param {number} s.tenantCount         denominator for the tenant store
 * @param {string} s.pageSource          PrivacyPolicyPage.tsx text
 * @param {(p:string)=>boolean} [s.anchorExists] injectable for the mutation cases
 * @returns {{failures:string[], counts:object}}
 */
export function subprocessorDisclosureFailures(s) {
  const {
    manifest, groups, llmProviders, llmProviderToKey, resolvedKeyNames,
    repoKeyTokens, configuredSecrets, tenantCount, pageSource,
  } = s;
  const anchorExists = s.anchorExists ?? ((p) => existsSync(p));
  const failures = [];
  const counts = {
    entries: manifest.length,
    llmTiersCompared: 0,
    resolvedKeysCompared: 0,
    liveSecretsCompared: 0,
    liveTenantCredentialsCompared: 0,
    anchorsCompared: 0,
    armedByCompared: 0,
    pageClaimPatternsCompared: UNVERIFIABLE_CLAIM_PATTERNS.length,
    tenants: tenantCount,
  };

  // Shape first. A malformed entry must not slip through and then be counted
  // as coverage by every arm below it.
  const ids = new Set();
  for (const e of manifest) {
    for (const field of ['id', 'vendor', 'purpose', 'arming', 'anchor']) {
      if (typeof e[field] !== 'string' || e[field].trim() === '') {
        failures.push(`manifest entry ${e.id ?? '<no id>'}: missing or empty "${field}"`);
      }
    }
    if (!Array.isArray(e.armedBy)) failures.push(`manifest entry ${e.id}: "armedBy" must be an array`);
    if (ids.has(e.id)) failures.push(`manifest has duplicate id: ${e.id}`);
    ids.add(e.id);
    const known = new Set(groups.map((g) => g.arming));
    if (!known.has(e.arming)) {
      failures.push(`manifest entry ${e.id}: arming "${e.arming}" has no group in ARMING_GROUPS — it would render nowhere`);
    }
  }

  // ── A. The LLM chain, BOTH directions ─────────────────────────────────
  // One direction alone passes a manifest that is empty (nothing to be
  // missing) or one that names every vendor on earth (nothing to be extra).
  const tiers = new Map(manifest.filter((e) => e.llmProvider).map((e) => [e.llmProvider, e]));
  counts.llmTiersCompared = llmProviders.length + tiers.size;
  for (const p of llmProviders) {
    const e = tiers.get(p);
    if (!e) {
      failures.push(
        `UNDISCLOSED MODEL PROVIDER: ${LLM_SRC} can route customer content to '${p}' `
        + `(armed by ${llmProviderToKey[p] ?? 'an unknown key'}) and ${MANIFEST_SRC} has no entry for it`,
      );
      continue;
    }
    const expected = llmProviderToKey[p];
    if (expected && !(e.armedBy ?? []).includes(expected)) {
      failures.push(
        `manifest entry ${e.id} claims provider '${p}' but does not list its arming key `
        + `${expected} (armedBy: ${(e.armedBy ?? []).join(', ') || 'none'})`,
      );
    }
    if (e.arming !== 'credential') {
      failures.push(`manifest entry ${e.id} claims model provider '${p}' but is marked arming="${e.arming}" — a chain tier joins on a key`);
    }
  }
  for (const [p, e] of tiers) {
    if (!llmProviders.includes(p)) {
      failures.push(
        `OVER-CLAIMED MODEL PROVIDER: ${MANIFEST_SRC} entry ${e.id} names '${p}' as a failover tier, `
        + `but ${LLM_SRC} cannot reach it — a disclosure that names a processor nobody sends to is also wrong`,
      );
    }
  }

  // ── B. Every credential the CODE resolves must be claimed ─────────────
  const byKey = claimFor(manifest);
  for (const key of [...resolvedKeyNames].sort()) {
    if (NON_EGRESS_CONFIG.has(key)) continue;
    if (NON_EGRESS_CONFIG_PATTERNS.some((p) => p.re.test(key))) continue;
    counts.resolvedKeysCompared += 1;
    const owners = byKey.get(key);
    if (!owners) {
      failures.push(
        `UNCLAIMED CREDENTIAL: the code resolves ${key} through the shared credential store, `
        + `and no ${MANIFEST_SRC} entry lists it in armedBy (add the vendor, or add ${key} to NON_EGRESS_CONFIG with a reason)`,
      );
    } else if (owners.length > 1) {
      failures.push(`AMBIGUOUS CREDENTIAL: ${key} is claimed by more than one entry (${owners.join(', ')}) — one key, one vendor`);
    }
  }

  // ── C. Every credential actually CONFIGURED must be claimed ───────────
  // The arm that catches the person pasting a key. It reads the two stores a
  // query can see; the env store is invisible here and is named in the
  // detail line rather than silently counted as covered.
  for (const { key, store } of configuredSecrets) {
    if (store === 'tenant_llm_credentials') counts.liveTenantCredentialsCompared += 1;
    if (NON_EGRESS_CONFIG.has(key)) continue;
    if (NON_EGRESS_CONFIG_PATTERNS.some((p) => p.re.test(key))) continue;
    counts.liveSecretsCompared += 1;
    if (!byKey.has(key)) {
      failures.push(
        `CONFIGURED BUT UNDISCLOSED: ${key} is set in ${store} — customer data can reach that vendor now — `
        + `and no ${MANIFEST_SRC} entry claims it. Disclose the vendor (or, if it sends nothing to a third party, `
        + `add ${key} to NON_EGRESS_CONFIG with a reason).`,
      );
    }
  }

  // ── The exemption list's own ratchet ──────────────────────────────────
  // An exemption that matches neither live state nor the code has outlived
  // its reason, and a list nobody prunes is how a category quietly opens.
  const liveKeys = new Set(configuredSecrets.map((c) => c.key));
  for (const [key, reason] of NON_EGRESS_CONFIG) {
    if (!liveKeys.has(key) && !resolvedKeyNames.has(key) && !repoKeyTokens.has(key)) {
      failures.push(`STALE EXEMPTION: NON_EGRESS_CONFIG lists ${key} ("${reason}") but it appears neither in live configuration nor anywhere in the code — remove it`);
    }
  }

  // ── Anchors and armedBy must point at something real ──────────────────
  for (const e of manifest) {
    counts.anchorsCompared += 1;
    if (typeof e.anchor === 'string' && e.anchor && !anchorExists(e.anchor)) {
      failures.push(`manifest entry ${e.id}: anchor "${e.anchor}" does not exist — the disclosure cites a module nobody can read`);
    }
    for (const k of e.armedBy ?? []) {
      counts.armedByCompared += 1;
      if (!repoKeyTokens.has(k) && !resolvedKeyNames.has(k)) {
        failures.push(`manifest entry ${e.id}: armedBy names ${k}, which appears nowhere in the codebase — the disclosure describes a key that does not exist`);
      }
    }
  }

  // ── D. The page must DERIVE, not restate ──────────────────────────────
  if (!pageRendersManifest(pageSource)) {
    failures.push(
      `${PAGE_SRC} no longer iterates SUBPROCESSORS to render the list — the disclosure has gone back to `
      + 'being hand-maintained prose, which is the whole of A-8',
    );
  }
  if (!/COUNSEL_PLACEHOLDER/.test(pageSource)) {
    failures.push(`${PAGE_SRC} no longer shows COUNSEL_PLACEHOLDER — the page would read as though the legal questions are answered`);
  }
  for (const e of manifest) {
    // The vendor string itself, not a substring of it: a page that hardcodes
    // "Anthropic (Claude)" has a second source of truth, and the second one
    // is the one that drifts.
    if (pageSource.includes(e.vendor)) {
      failures.push(`${PAGE_SRC} hardcodes the vendor name "${e.vendor}" (entry ${e.id}) instead of rendering it from ${MANIFEST_SRC}`);
    }
  }
  for (const { re, label } of UNVERIFIABLE_CLAIM_PATTERNS) {
    if (re.test(pageSource)) {
      failures.push(`${PAGE_SRC} carries ${label} — a static page cannot keep that true; state the capability and let the product report the live state`);
    }
  }

  return { failures, counts };
}
