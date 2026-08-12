// The ONE definition of how a provider's catalog row is DERIVED from
// PROVIDERS. Imported by scripts/gen-provider-seed.mjs (which writes the seed)
// and by scripts/certify.mjs (which asserts the seed never drifted from it).
//
// It lives in its own file for the same reason scripts/landed-predicate.mjs
// does: two copies of a derivation rule reintroduce, one layer up, exactly the
// hand-sync risk the catalog was built to remove. The gate would then be
// checking its own paraphrase of the generator rather than the generator.

/** Aliases for one provider, before the ambiguity stop-list is applied.
 *  The key, the lowercased label, and the label with punctuation removed. */
export function rawAliases(key, meta) {
  return [...new Set([
    key,
    meta.label.toLowerCase(),
    meta.label.toLowerCase().replace(/[^a-z0-9]/g, ''),
  ])];
}

/** Aliases as they must appear in `connector_providers.aliases`.
 *
 *  `ambiguous` is AMBIGUOUS_ALIASES from src/lib/connectorApi.ts — the curated
 *  stop-list of aliases that are ordinary English words before they are product
 *  names. Passing it in rather than importing it keeps this file free of the
 *  AST-reading machinery both callers already have.
 *
 *  NOTE this is not the whole live column: migration 727 added a handful of
 *  curated synonyms by hand ('sfdc', 'qb', 'qbo', 'hub spot', 'zen desk'),
 *  which no derivation can infer. So callers compare CONTAINMENT — every
 *  derived alias must be present — not set equality. */
export function derivedAliases(key, meta, ambiguous) {
  const stop = ambiguous instanceof Set ? ambiguous : new Set(ambiguous);
  return rawAliases(key, meta).filter((a) => !stop.has(a));
}

/** Which of the three credential shapes the connect form will ask for. */
export function derivedAuthKind(meta) {
  return meta.oauth ? 'oauth' : (meta.fields ?? []).some((f) => f.secret) ? 'api_key' : 'basic';
}
