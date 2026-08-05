// ============================================================
// Write bindings — what request would ACTUALLY go to the vendor?
//
// WHY THIS EXISTS: reads fail loudly-ish (an empty result set is at least
// visible). A write that renders wrong either 400s in front of a client or,
// worse, succeeds against the wrong resource. And unlike the reads, we cannot
// even see the response shape to sanity-check it — a write is fire-and-observe.
//
// So this renders every bound action through the REAL renderAction — the same
// pure function preview_action and execute_action both call, which is precisely
// why preview and execute cannot drift — and inspects the exact method, URL and
// body that would leave the building.
//
// It reads bindings and param schemas from the DATABASE, so it cannot pass
// while production holds something else.
//
// HONEST LIMITATION: this proves the REQUEST is well-formed and carries the
// values the approver saw. It cannot prove the vendor accepts it. A live smoke
// test is still owed — and for writes that means a real post on a real Page,
// which is a thing to do deliberately, on a test Page, once.
// ============================================================
import { describe, it, expect } from 'vitest';
import { runQuery, adminTokenAvailable } from './helpers/adminQuery';
import { renderAction, validateActionBinding } from '../supabase/functions/_shared/adapterTemplates.ts';

// Connector variables, as a real connected account would have them.
const VARS: Record<string, Record<string, string>> = {
  'Meta (Facebook & Instagram)': { page_id: '1234567890' },
  'Google Ads': { customer_id: '9876543210', login_customer_id: '' },
  'Google Search Console': { site_url: 'sc-domain%3Aomnexasol.com' },
};

// Plausible values per param name, so every binding renders with real input.
const VALUE: Record<string, string> = {
  body: 'Ant season is here — booking now',
  publish_at: '1785500000',
  comment_ref: '1234567890_5555_1',
  post_ref: '1234567890_9876543210',
  campaign_ref: '222',
  budget_ref: '333',
  keyword: 'free pest control',
  match_type: 'PHRASE',
  sitemap_url: 'https://omnexasol.com/sitemap.xml',
  reason: 'wasting budget on non-buyers',
  amount_cents: '50000',
  duration_days: '7',
};

interface Param { name: string; required?: boolean }

if (!adminTokenAvailable()) {
  describe.skip('write bindings (no admin token)', () => { it('skipped', () => {}); });
} else {
  describe('write bindings — the request that would actually be sent', () => {
    let rows: Array<{
      action_key: string; category: string; label: string; status: string;
      param_schema: Param[]; base_url_template: string; binding: Record<string, unknown>;
      template: string; destructive: boolean;
    }> = [];

    it('every active marketing action is bound to a template', async () => {
      rows = await runQuery(
        `select a.action_key, a.category, a.label, a.status, a.param_schema,
                (a.risk->>'destructive')::boolean as destructive,
                t.name as template, t.definition->>'base_url_template' as base_url_template,
                t.definition->'actions'->a.action_key as binding
           from action_definitions a
           join adapter_templates t on t.id = a.template_id
          where a.scope = 'platform' and a.status = 'active'
            and a.category in ('ads','social','web_analytics')
          order by a.category, a.action_key`,
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(r.binding, `${r.action_key} has no binding`).toBeTruthy();
    });

    it('each binding passes the framework validator', async () => {
      const failures: string[] = [];
      for (const r of rows) {
        const params = r.param_schema.map((p) => p.name);
        const vars = new Set(Object.keys(VARS[r.template] ?? {}));
        const errs = validateActionBinding(r.action_key, r.binding as never, params, vars);
        if (errs.length) failures.push(`${r.action_key}: ${errs.join('; ')}`);
      }
      expect(failures, `\n  ${failures.join('\n  ')}\n`).toEqual([]);
    });

    it('renders a complete request — nothing left unresolved', async () => {
      const failures: string[] = [];
      for (const r of rows) {
        const params: Record<string, string> = {};
        for (const p of r.param_schema) {
          if (!p.required) continue; // optional params are legitimately absent
          const v = VALUE[p.name];
          if (v === undefined) { failures.push(`${r.action_key}: test has no sample value for required param "${p.name}"`); continue; }
          params[p.name] = v;
        }

        const out = renderAction(r.base_url_template, r.binding as never, VARS[r.template] ?? {}, params);
        if (!out.ok) { failures.push(`${r.action_key}: ${out.error} ${(out.missing ?? []).join(',')}`); continue; }

        // THE INVARIANT: a surviving {placeholder} means something never
        // resolved. It would be sent to the vendor literally.
        const whole = `${out.url} ${out.body ?? ''}`;
        const leftover = whole.match(/\{[a-zA-Z0-9_]+\}/g);
        if (leftover) failures.push(`${r.action_key}: unresolved ${leftover.join(', ')}`);

        if (!/^https:\/\//.test(out.url ?? '')) failures.push(`${r.action_key}: URL is not https — ${out.url}`);
      }
      expect(failures, `\n  ${failures.join('\n  ')}\n`).toEqual([]);
    });

    it('renders each vendor request exactly as documented', async () => {
      const by = Object.fromEntries(rows.map((r) => [r.action_key, r]));
      const render = (key: string, params: Record<string, string>) => {
        const r = by[key];
        return renderAction(r.base_url_template, r.binding as never, VARS[r.template] ?? {}, params);
      };

      // Meta: publishing is a POST to the Page's feed with the message.
      const pub = render('publish_post', { body: VALUE.body });
      expect(pub.ok).toBe(true);
      expect(pub.method).toBe('POST');
      expect(pub.url).toBe('https://graph.facebook.com/v21.0/1234567890/feed');
      expect(JSON.parse(pub.body!)).toEqual({ message: VALUE.body });

      // A draft is the SAME endpoint with published:false — the one character
      // between "nobody sees this" and "everybody does". Worth pinning.
      const draft = render('draft_post', { body: VALUE.body });
      expect(JSON.parse(draft.body!)).toEqual({ message: VALUE.body, published: false });

      const sched = render('schedule_post', { body: VALUE.body, publish_at: VALUE.publish_at });
      expect(JSON.parse(sched.body!)).toEqual({
        message: VALUE.body, published: false, scheduled_publish_time: VALUE.publish_at,
      });

      // Replying posts to the COMMENT's comments edge, not the page feed —
      // getting this wrong would publish a reply as a new public post.
      const reply = render('reply_to_comment', { comment_ref: VALUE.comment_ref, body: VALUE.body });
      expect(reply.url).toBe(`https://graph.facebook.com/v21.0/${encodeURIComponent(VALUE.comment_ref)}/comments`);
      expect(JSON.parse(reply.body!)).toEqual({ message: VALUE.body });

      const del = render('delete_post', { post_ref: VALUE.post_ref, reason: VALUE.reason });
      expect(del.method).toBe('DELETE');
      expect(del.url).toBe(`https://graph.facebook.com/v21.0/${encodeURIComponent(VALUE.post_ref)}`);

      // Google Ads: the ":" in ":mutate" must survive rendering — renderTemplate
      // URL-encodes substituted VALUES, never the template text. If it ever
      // encoded the path, this becomes %3Amutate and 404s.
      const pause = render('pause_campaign', { campaign_ref: VALUE.campaign_ref, reason: VALUE.reason });
      expect(pause.url).toBe('https://googleads.googleapis.com/v18/customers/9876543210/campaigns:mutate');
      expect(pause.url).not.toContain('%3A');
      expect(JSON.parse(pause.body!)).toEqual({
        operations: [{
          update: { resourceName: 'customers/9876543210/campaigns/222', status: 'PAUSED' },
          updateMask: 'status',
        }],
      });

      // updateMask names API fields, so it stays snake_case while the body is
      // camelCase — the same split that broke the read paths in 576.
      expect(JSON.parse(pause.body!).operations[0].updateMask).toBe('status');
      const resume = render('resume_campaign', { campaign_ref: VALUE.campaign_ref, reason: VALUE.reason });
      expect(JSON.parse(resume.body!).operations[0].update.status).toBe('ENABLED');

      const neg = render('add_negative_keyword', {
        campaign_ref: VALUE.campaign_ref, keyword: VALUE.keyword, match_type: VALUE.match_type,
      });
      expect(JSON.parse(neg.body!)).toEqual({
        operations: [{
          create: {
            campaign: 'customers/9876543210/campaigns/222',
            negative: true,
            keyword: { text: VALUE.keyword, matchType: VALUE.match_type },
          },
        }],
      });
      // negative:true is what makes this EXCLUDE a term rather than bid on it.
      // Dropped, the employee would start buying the traffic it meant to block.
      expect(JSON.parse(neg.body!).operations[0].create.negative).toBe(true);

      // Search Console: the sitemap URL is the path segment and must be encoded.
      const sm = render('submit_sitemap', { sitemap_url: VALUE.sitemap_url });
      expect(sm.method).toBe('PUT');
      expect(sm.url).toBe(
        `https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Aomnexasol.com/sitemaps/${encodeURIComponent(VALUE.sitemap_url)}`,
      );
    });

    it('a money param is named amount_cents, or every money gate is inert', async () => {
      // execute_action resolves the transaction amount from a param named
      // exactly 'amount_cents'. Any other name and the approval threshold, the
      // per-DE spend cap and the trust ceiling all silently pass. Checked for
      // DISABLED rows too, so re-enabling one cannot quietly reopen the hole.
      const all = await runQuery(
        `select a.action_key, p->>'name' as param, p->>'type' as type
           from action_definitions a, lateral jsonb_array_elements(a.param_schema) p
          where a.scope = 'platform' and a.category in ('ads','social','web_analytics')
            and (p->>'type') in ('integer','number')
            and (p->>'name') ~* '(budget|amount|cents|price|spend)'`,
      );
      const wrong = all.filter((r) => r.param !== 'amount_cents');
      expect(wrong.map((r) => `${r.action_key}.${r.param}`), 'money param not on the registry convention').toEqual([]);
    });

    it('everything that speaks or spends is still gated after being wired', async () => {
      // Making an action executable is exactly when its classification stops
      // being theoretical. Re-checked here rather than trusted from the seed.
      const by = Object.fromEntries(rows.map((r) => [r.action_key, r.destructive]));
      for (const k of ['publish_post', 'schedule_post', 'reply_to_comment', 'hide_comment', 'delete_post']) {
        expect(by[k], `${k} is bound but not gated`).toBe(true);
      }
      for (const k of ['pause_campaign', 'resume_campaign']) {
        expect(by[k], `${k} is bound but not gated`).toBe(true);
      }
      // And the protective ones must NOT be gated, or the employee does nothing.
      expect(by.draft_post, 'drafting is gated').toBe(false);
      expect(by.add_negative_keyword, 'blocking a wasteful term is gated').toBe(false);
      expect(by.submit_sitemap, 'submitting a sitemap is gated').toBe(false);
    });

    it('every disabled action records why', async () => {
      const off = await runQuery(
        `select action_key, description from action_definitions
          where scope = 'platform' and category in ('ads','social','web_analytics') and status = 'disabled'`,
      );
      expect(off.length).toBeGreaterThan(0);
      for (const r of off) {
        expect(r.description, `${r.action_key} is disabled with no reason`).toContain('NOT AVAILABLE');
      }
    });
  });
}
