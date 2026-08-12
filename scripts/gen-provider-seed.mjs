// Prints the VALUES body for the connector_providers seed, read from the
// TypeScript constant so the two cannot disagree at authoring time.
//
// Usage: node scripts/gen-provider-seed.mjs
//   node scripts/gen-provider-seed.mjs > seed.sql   # keep the output to paste
//
// WHY THIS DOES NOT `import { PROVIDERS } from '../src/lib/connectorApi.ts'`.
// That was tried first and fails two different ways:
//   - plain node: Error [ERR_MODULE_NOT_FOUND] — connectorApi.ts imports
//     '../supabase' with no extension, which is fine for a bundler but not
//     for node's own ESM resolver.
//   - npx tsx: resolves the import fine, then throws
//     `TypeError: Cannot read properties of undefined (reading
//     'VITE_SUPABASE_URL')` inside src/lib/env.ts — import.meta.env is a
//     Vite-only global, populated only by Vite's own transform pipeline
//     (which is why the same import works fine under `vitest`, and only
//     there: vitest runs on Vite). A generator script is not a good place to
//     drag in the Vite/vitest pipeline just to read a data constant.
//
// So instead this reads connectorApi.ts as TEXT and asks the TypeScript
// compiler — already a devDependency, already the version this repo builds
// with — to parse out just the `PROVIDERS` object literal and evaluate it
// into a real JS value. It never executes connectorApi.ts (no side effects,
// no other imports touched), so it cannot hit either failure above, and it
// runs anywhere plain `node` runs. It still can't diverge from what's
// actually written in the source: evalNode() below walks the parsed AST, it
// does not re-derive or guess the values.
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const SRC = 'src/lib/connectorApi.ts';
const source = ts.createSourceFile(
  SRC, readFileSync(SRC, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
);

// Evaluates the literal AST nodes PROVIDERS is actually built from: nested
// object/array literals, strings, numbers, booleans. Anything else (a spread,
// a function call, a computed key, …) throws instead of guessing — a
// generator that silently mis-parses a future edit is worse than one that
// stops and says so.
function evalNode(node) {
  if (ts.isObjectLiteralExpression(node)) {
    const obj = {};
    for (const prop of node.properties) {
      if (!ts.isPropertyAssignment(prop)) {
        throw new Error(`unsupported object member kind in PROVIDERS: ${ts.SyntaxKind[prop.kind]}`);
      }
      let key;
      if (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)) key = prop.name.text;
      else throw new Error(`unsupported property key kind in PROVIDERS: ${ts.SyntaxKind[prop.name.kind]}`);
      obj[key] = evalNode(prop.initializer);
    }
    return obj;
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(evalNode);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  throw new Error(`unsupported literal kind while evaluating PROVIDERS: ${ts.SyntaxKind[node.kind]} (${node.getText()})`);
}

let providersNode = null;
source.forEachChild((node) => {
  if (!ts.isVariableStatement(node)) return;
  for (const decl of node.declarationList.declarations) {
    if (ts.isIdentifier(decl.name) && decl.name.text === 'PROVIDERS' && decl.initializer) {
      providersNode = decl.initializer;
    }
  }
});
if (!providersNode) throw new Error(`could not find "export const PROVIDERS = ..." in ${SRC}`);

const PROVIDERS = evalNode(providersNode);

const q = (s) => (s === null || s === undefined ? 'null' : `'${String(s).replace(/'/g, "''")}'`);
const arr = (a) => (a.length ? `array[${a.map(q).join(',')}]` : `'{}'::text[]`);

const rows = Object.entries(PROVIDERS).map(([key, m]) => {
  // Aliases: the key, the label, and the label without punctuation. Curated
  // synonyms are added by hand in the migration below, not generated.
  const aliases = [...new Set([key, m.label.toLowerCase(), m.label.toLowerCase().replace(/[^a-z0-9]/g, '')])];
  const authKind = m.oauth ? 'oauth' : m.fields?.some((f) => f.secret) ? 'api_key' : 'basic';
  return `  (${q(key)}, ${q(m.label)}, ${q(m.defaultCategory)}, ${arr(aliases)}, ${q(authKind)}, ` +
         `${q(m.help)}, ${q(m.baseUrlPlaceholder ?? null)}, ${m.implemented ? 'true' : 'false'})`;
});
console.error(`gen-provider-seed: parsed ${Object.keys(PROVIDERS).length} providers from ${SRC}`);
console.log(rows.join(',\n'));
