// Prints the VALUES body for the connector_providers seed, read from the
// TypeScript constant so the two cannot disagree at authoring time.
// Usage: node scripts/gen-provider-seed.mjs
import { PROVIDERS } from '../src/lib/connectorApi.ts';

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
console.log(rows.join(',\n'));
