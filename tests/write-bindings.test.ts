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
import { renderAction, validateActionBinding, walkPath } from '../supabase/functions/_shared/adapterTemplates.ts';

// Connector variables, as a real connected account would have them.
const VARS: Record<string, Record<string, string>> = {
  'Meta (Facebook & Instagram)': { page_id: '1234567890' },
  'Google Ads': { customer_id: '9876543210', login_customer_id: '' },
  'Google Search Console': { site_url: 'sc-domain%3Aomnexasol.com' },
  'LinkedIn (Company Page)': { organization_id: '5515715' },
  'Instagram (Business)': { ig_user_id: '17841400000000000' },
  TikTok: {},
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
  image_url: 'https://omnexasol.com/media/ant-season.jpg',
  caption: 'Ant season is here — booking now',
  creation_id: '17890000000000000',
  video_url: 'https://omnexasol.com/media/ant-season.mp4',
  title: 'Ant season prep in 40 seconds',
  privacy_level: 'PUBLIC_TO_EVERYONE',
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

    it('ONE publish_post capability renders whichever system the connector is', async () => {
      // action_definitions is UNIQUE on (scope, tenant_id, category, action_key),
      // so publish_post is a single row for the whole social category — it
      // cannot be duplicated per vendor. The binding therefore has to resolve
      // from the CONNECTOR's template. Until it did, this row was hardwired to
      // whichever template was linked first, and a LinkedIn connector would have
      // rendered Meta's URL and posted to graph.facebook.com. This is the test
      // for that, and it is the reason the framework change was necessary rather
      // than tidy.
      const tpls = await runQuery<{ name: string; base_url_template: string; binding: Record<string, unknown> }>(
        `select t.name, t.definition->>'base_url_template' as base_url_template,
                t.definition->'actions'->'publish_post' as binding
           from adapter_templates t
          where t.scope = 'platform' and t.category = 'social'
            and t.definition->'actions' ? 'publish_post'
          order by t.name`,
      );
      expect(tpls.map((t) => t.name)).toEqual(['LinkedIn (Company Page)', 'Meta (Facebook & Instagram)']);

      const rendered = tpls.map((t) =>
        renderAction(t.base_url_template, t.binding as never, VARS[t.name] ?? {}, { body: VALUE.body }));
      for (const r of rendered) expect(r.ok).toBe(true);

      // Same capability, same approval, same governed row — different hosts.
      const [li, meta] = rendered;
      expect(li.url).toBe('https://api.linkedin.com/rest/posts');
      expect(meta.url).toBe('https://graph.facebook.com/v21.0/1234567890/feed');
      expect(new URL(li.url!).host).not.toBe(new URL(meta.url!).host);

      // LinkedIn's required envelope. A wrong author URN, a missing distribution
      // block, or lifecycleState set to anything but PUBLISHED each produce a
      // 400 naming a field rather than the cause.
      expect(JSON.parse(li.body!)).toEqual({
        author: 'urn:li:organization:5515715',
        commentary: VALUE.body,
        visibility: 'PUBLIC',
        distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
      });
      // PUBLISHED, not DRAFT — the human has already approved by this point. If
      // this ever said DRAFT, approving would produce nothing anyone can see and
      // nothing would report a failure.
      expect(JSON.parse(li.body!).lifecycleState).toBe('PUBLISHED');
    });

    it('LinkedIn sends the per-operation header its API requires', async () => {
      // X-RestLi-Method changes with the operation, which a template-level
      // header cannot express. Without it LinkedIn's finder and delete reject
      // the call, and the error does not name the missing header.
      const li = await runQuery<{ finder: string; del: string; version: string }>(
        `select t.definition->'ops'->'list_posts'->'headers'->>'X-RestLi-Method' as finder,
                t.definition->'actions'->'delete_post'->'headers'->>'X-RestLi-Method' as del,
                t.definition->'auth'->'extra_headers'->>'Linkedin-Version' as version
           from adapter_templates t where t.name = 'LinkedIn (Company Page)'`,
      );
      expect(li[0].finder).toBe('FINDER');
      expect(li[0].del).toBe('DELETE');
      // A malformed version is rejected by every LinkedIn endpoint, and the
      // error does not say which header is at fault.
      expect(li[0].version).toMatch(/^20\d{2}(0[1-9]|1[0-2])$/);
    });

    it("Instagram's two steps actually connect", async () => {
      // Instagram publishes in two calls: build a container, then publish that
      // container's id. The link between them is response.id_path — a field
      // declared on action bindings since migration 035 and never READ for
      // actions until this work, so the create response was discarded and the
      // second step had no first step.
      //
      // This walks the chain the way production does: render create, pull the id
      // out of a real-shaped response using the BINDING'S OWN declared id_path,
      // feed that as creation_id, render publish. If the declared path and the
      // vendor's response ever disagree, the chain breaks here rather than
      // halfway through publishing something.
      const tpl = (await runQuery<{ base_url_template: string; actions: Record<string, never> }>(
        `select t.definition->>'base_url_template' as base_url_template,
                t.definition->'actions' as actions
           from adapter_templates t where t.name = 'Instagram (Business)'`,
      ))[0];
      const vars = VARS['Instagram (Business)'];

      const create = renderAction(tpl.base_url_template, tpl.actions.create_media_draft, vars, {
        image_url: VALUE.image_url, caption: VALUE.caption,
      });
      expect(create.ok).toBe(true);
      expect(create.url).toBe('https://graph.facebook.com/v21.0/17841400000000000/media');
      expect(JSON.parse(create.body!)).toEqual({
        image_url: VALUE.image_url, caption: VALUE.caption, media_type: 'IMAGE',
      });

      // What Instagram actually returns from /media — the container id, nothing else.
      const createResponse = { id: '17890000000000000' };
      const declaredPath = (tpl.actions.create_media_draft as { response?: { id_path?: string } }).response?.id_path;
      expect(declaredPath, 'create declares no id_path, so publish can never be fed').toBeTruthy();
      const containerId = walkPath(createResponse, declaredPath!);
      expect(containerId.found).toBe(true);
      expect(containerId.value).toBe('17890000000000000');

      // Step two, fed by step one.
      const publish = renderAction(tpl.base_url_template, tpl.actions.publish_media, vars, {
        creation_id: String(containerId.value),
      });
      expect(publish.ok).toBe(true);
      expect(publish.url).toBe('https://graph.facebook.com/v21.0/17841400000000000/media_publish');
      expect(JSON.parse(publish.body!)).toEqual({ creation_id: '17890000000000000' });

      // And the two are DIFFERENT endpoints. If they ever collapsed to one, the
      // gated step would be publishing whatever the ungated step just built,
      // with no person between them.
      expect(publish.url).not.toBe(create.url);
    });

    it('preparing an Instagram post is free; publishing it is not', async () => {
      const rows2 = await runQuery<{ action_key: string; destructive: boolean }>(
        `select action_key, (risk->>'destructive')::boolean as destructive
           from action_definitions
          where scope = 'platform' and category = 'social'
            and action_key in ('create_media_draft','publish_media')`,
      );
      const by = Object.fromEntries(rows2.map((r) => [r.action_key, r.destructive]));
      // A container is genuinely invisible, which is exactly what tempts you to
      // gate neither — and then the publish step gates nothing either.
      expect(by.create_media_draft, 'preparing is gated, so the employee cannot work').toBe(false);
      expect(by.publish_media, 'publishing is ungated — it can post to the public alone').toBe(true);
    });

    it("TikTok's two routes are different endpoints, classified oppositely", async () => {
      const tpl = (await runQuery<{ base_url_template: string; actions: Record<string, never> }>(
        `select t.definition->>'base_url_template' as base_url_template,
                t.definition->'actions' as actions
           from adapter_templates t where t.name = 'TikTok'`,
      ))[0];

      const draft = renderAction(tpl.base_url_template, tpl.actions.upload_video_draft, {}, {
        video_url: VALUE.video_url,
      });
      const post = renderAction(tpl.base_url_template, tpl.actions.publish_video, {}, {
        video_url: VALUE.video_url, title: VALUE.title, privacy_level: VALUE.privacy_level,
      });
      expect(draft.ok).toBe(true);
      expect(post.ok).toBe(true);

      // The SAFE route must hit the inbox. It is ungated precisely because it
      // lands somewhere private; pointed at the direct-post path it would be an
      // unattended public post.
      expect(draft.url).toBe('https://open.tiktokapis.com/v2/post/publish/inbox/video/init/');
      expect(post.url).toBe('https://open.tiktokapis.com/v2/post/publish/video/init/');
      expect(draft.url).not.toBe(post.url);

      // PULL_FROM_URL, never FILE_UPLOAD — the latter needs a chunked upload no
      // single binding can perform. It would render, TikTok would hand back an
      // upload_url, and nothing would ever be sent to it: success, no video.
      expect(JSON.parse(draft.body!).source_info.source).toBe('PULL_FROM_URL');
      expect(JSON.parse(post.body!).source_info.source).toBe('PULL_FROM_URL');
      expect(`${draft.body}${post.body}`).not.toContain('FILE_UPLOAD');

      // The caption and audience only exist on the gated route — the draft route
      // deliberately carries neither, because the human writes them in the app.
      expect(JSON.parse(post.body!).post_info).toEqual({
        title: VALUE.title,
        privacy_level: VALUE.privacy_level,
        disable_comment: false, disable_duet: false, disable_stitch: false,
      });
      expect(JSON.parse(draft.body!).post_info).toBeUndefined();
    });

    it('a write that fails inside an HTTP 200 is not recorded as a success', async () => {
      // TikTok answers 200 to a refusal and puts the verdict in error.code.
      // Keying off the HTTP status alone would close the approval, write a green
      // audit row, and post nothing — the worst shape a write can have. The
      // binding declares the vendor's own verdict; this checks the declaration
      // is present AND that the check it drives actually discriminates.
      const rows2 = await runQuery<{ action_key: string; path: string; equals: string }>(
        `select k as action_key,
                t.definition->'actions'->k->'response'->'success_when'->>'path' as path,
                t.definition->'actions'->k->'response'->'success_when'->>'equals' as equals
           from adapter_templates t, lateral jsonb_object_keys(t.definition->'actions') k
          where t.name = 'TikTok'`,
      );
      expect(rows2.length).toBe(2);
      for (const r of rows2) {
        expect(r.path, `${r.action_key} trusts the HTTP status`).toBe('error.code');
        expect(r.equals).toBe('ok');
      }

      // The executor's rule, exercised against both real TikTok shapes. If this
      // ever passed for the refusal, the guard would be decorative.
      const verdict = (body: unknown, sw: { path: string; equals: string }) => {
        const w = walkPath(body, sw.path);
        return (w.found && w.value != null ? String(w.value) : '') === sw.equals;
      };
      const sw = { path: 'error.code', equals: 'ok' };
      expect(verdict({ data: { publish_id: 'v_pub_1' }, error: { code: 'ok' } }, sw)).toBe(true);
      expect(verdict({ data: {}, error: { code: 'spam_risk_too_many_posts' } }, sw)).toBe(false);
      // And an absent verdict is a failure, not a pass — a truncated or
      // unexpected body must never read as success.
      expect(verdict({ data: {} }, sw)).toBe(false);
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
