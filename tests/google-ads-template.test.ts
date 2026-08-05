// ============================================================
// Google Ads adapter — do the declared response paths actually resolve?
//
// WHY THIS EXISTS: connecting a real Google Ads account needs a developer
// token, which is a vendor approval measured in weeks. Without one, the
// template is unfalsifiable — it looks correct and cannot be tried. That is the
// precise condition under which hollow machinery ships.
//
// The part most likely to be silently wrong is the RESPONSE PATHS, because
// Google Ads uses two different naming conventions in the same request:
//
//     GAQL query text   snake_case   SELECT ad_group_criterion.keyword.text
//     JSON response     camelCase    { adGroupCriterion: { keyword: { text }}}
//
// (Google's REST surface follows the proto3 JSON mapping, which lowerCamelCases
// every field name.) Writing the query correctly and then reading the response
// with the query's own field names yields ok:true, zero usable items, and no
// error — a connector that looks connected and returns nothing.
//
// So: run a realistic response through the REAL walkPath and the REAL branch
// logic from runTemplateOp, against the template AS IT IS STORED IN THE
// DATABASE. Not a copy of the template — the row itself, so this cannot pass
// while production holds something different.
//
// HONEST LIMITATION: the fixture is built from Google's documented proto3 JSON
// mapping, not captured from a live account. It proves our paths match the
// documented shape and that every op yields an identified item. It cannot prove
// Google returns exactly this. A live smoke test is still owed once a developer
// token exists — that is what test_op is for.
// ============================================================
import { describe, it, expect } from 'vitest';
import { runQuery, adminTokenAvailable } from './helpers/adminQuery';
import { walkPath, validateAdapterDefinition } from '../supabase/functions/_shared/adapterTemplates.ts';

// A GoogleAdsRow as the REST API returns it: camelCase field names, int64 as
// string, money in micros. One fixture per resource the template queries.
const RESPONSES: Record<string, unknown> = {
  search_campaigns: {
    results: [
      {
        campaign: { resourceName: 'customers/1234567890/campaigns/222', id: '222', name: 'Pest Control — Jeddah — Exact', status: 'ENABLED', advertisingChannelType: 'SEARCH' },
        campaignBudget: { amountMicros: '150000000' },
        metrics: { costMicros: '98450000', clicks: '412', conversions: 31.0 },
      },
    ],
  },
  get_campaign: {
    results: [
      {
        campaign: { resourceName: 'customers/1234567890/campaigns/222', id: '222', name: 'Pest Control — Jeddah — Exact', status: 'ENABLED', advertisingChannelType: 'SEARCH' },
        campaignBudget: { amountMicros: '150000000' },
        metrics: { costMicros: '98450000', clicks: '412', conversions: 31.0, ctr: 0.081, averageCpc: '238956' },
      },
    ],
  },
  search_keywords: {
    results: [
      {
        adGroupCriterion: { resourceName: 'customers/1234567890/adGroupCriteria/55~66', criterionId: '66', status: 'ENABLED', keyword: { text: 'pest control jeddah', matchType: 'EXACT' } },
        campaign: { name: 'Pest Control — Jeddah — Exact' },
        metrics: { impressions: '5120', clicks: '412', costMicros: '98450000', conversions: 31.0 },
      },
    ],
  },
  search_search_terms: {
    results: [
      {
        searchTermView: { resourceName: 'customers/1234567890/searchTermViews/…', searchTerm: 'free pest control jeddah', status: 'NONE' },
        campaign: { name: 'Pest Control — Jeddah — Exact' },
        metrics: { impressions: '310', clicks: '44', costMicros: '9100000', conversions: 0.0 },
      },
    ],
  },
  get_account_performance: {
    results: [
      {
        customer: { resourceName: 'customers/1234567890', id: '1234567890', descriptiveName: 'Omnexa Solutions', currencyCode: 'SAR' },
        metrics: { costMicros: '412300000', clicks: '1840', impressions: '61200', conversions: 96.0, conversionsValue: 184000.0 },
      },
    ],
  },
};

interface Binding {
  method: string;
  single_item?: boolean;
  response: { items_path?: string; id_path: string; title_path?: string; snippet_path?: string };
}

// The EXACT list-selection branch from runTemplateOp (connector-hub). Kept in
// step deliberately: if that logic changes, this must change with it, and the
// comment there points here.
function selectList(body: unknown, b: Binding): { ok: boolean; list?: Array<Record<string, unknown>>; why?: string } {
  const walked = walkPath(body, b.response.items_path ?? '');
  if (!walked.found) return { ok: false, why: `items_path died at "${walked.failed_segment}"` };
  if (b.single_item) return { ok: true, list: [walked.value as Record<string, unknown>] };
  if (Array.isArray(walked.value)) return { ok: true, list: (walked.value as Array<Record<string, unknown>>).slice(0, 10) };
  if (walked.value && typeof walked.value === 'object') return { ok: true, list: [walked.value as Record<string, unknown>] };
  return { ok: false, why: `items_path points at a ${typeof walked.value}` };
}

if (!adminTokenAvailable()) {
  describe.skip('google ads template (no admin token)', () => { it('skipped', () => {}); });
} else {
  describe('Google Ads adapter — declared paths resolve against a real-shaped response', () => {
    let def: { ops: Record<string, Binding>; auth: Record<string, unknown>; base_url_template: string; variables: Array<{ key: string }> };

    it('is published at platform scope', async () => {
      const rows = await runQuery(
        `select definition from adapter_templates where name = 'Google Ads' and scope = 'platform' and status = 'published'`,
      );
      expect(rows.length).toBe(1);
      def = rows[0].definition;
    });

    it('every op yields an identified, titled item — not an empty success', async () => {
      const failures: string[] = [];
      for (const [op, binding] of Object.entries(def.ops)) {
        const body = RESPONSES[op];
        if (!body) { failures.push(`${op}: no fixture — an op shipped that this test does not cover`); continue; }

        const sel = selectList(body, binding);
        if (!sel.ok) { failures.push(`${op}: ${sel.why}`); continue; }
        if (!sel.list!.length) { failures.push(`${op}: selected an empty list`); continue; }

        // The failure mode being hunted: a list of ARRAYS, which happens when
        // single_item is set on a response whose items_path is already a list.
        for (const row of sel.list!) {
          if (Array.isArray(row)) { failures.push(`${op}: selected a list of arrays (single_item on an array items_path)`); break; }

          const id = walkPath(row, binding.response.id_path);
          if (!id.found || id.value === undefined || id.value === null || id.value === '') {
            failures.push(`${op}: id_path "${binding.response.id_path}" resolved to nothing (present here: ${Object.keys(row).join(', ')})`);
          }
          for (const p of ['title_path', 'snippet_path'] as const) {
            const path = binding.response[p];
            if (!path) continue;
            const v = walkPath(row, path);
            if (!v.found || v.value === undefined || v.value === null || v.value === '') {
              failures.push(`${op}: ${p} "${path}" resolved to nothing`);
            }
          }
        }
      }
      expect(failures, `\n  ${failures.join('\n  ')}\n`).toEqual([]);
    });

    it('the manager-account header is actually sent, not just collected', async () => {
      // login_customer_id is required on EVERY call when the account is managed
      // through an agency MCC — which is our own deployment shape. A variable
      // the wizard collects and the executor never sends is dead config, and
      // the resulting failure (PERMISSION_DENIED) names neither cause nor fix.
      const declaresVar = def.variables.some((v) => v.key === 'login_customer_id');
      if (!declaresVar) return; // fine — not declared, nothing to honour
      const headers = (def.auth.extra_headers ?? {}) as Record<string, string>;
      const sentSomewhere = Object.values(headers).some((v) => v.includes('{login_customer_id}'));
      expect(sentSomewhere, 'login_customer_id is a declared variable but no header carries it').toBe(true);
    });

    it('binds no mutate endpoint — writes must stay under decide_action_execution', async () => {
      expect(JSON.stringify(def.ops)).not.toContain(':mutate');
    });

    it('passes the framework validator the wizard itself runs', async () => {
      // A template can sit in the database and still be unusable: the builder
      // validates before saving and the connect flow re-reads it. Asserting the
      // ROW exists proves storage, not usability.
      const r = validateAdapterDefinition(def, 'ads');
      expect(r.errors, `\n  ${r.errors.join('\n  ')}\n`).toEqual([]);
      expect(r.ok).toBe(true);
    });
  });
}
