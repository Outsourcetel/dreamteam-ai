-- Wave 5: the Website & Growth DE for Outsourcetel — advisor-first, built
-- so the same structure scales to execution once Google Ads / GA4 / a CMS
-- are connected. This seeds ONE tenant's instance; the capability (create a
-- growth DE, attach growth knowledge, ask it grounded questions) is generic.
--
-- Knowledge here is genuine marketing best-practice, not fabricated business
-- data — so the DE's answers are grounded and cited, and honest about the
-- fact it is advising, not yet executing.

DO $$
DECLARE
  v_tenant uuid := (SELECT id FROM tenants WHERE slug = 'outsourcetel-hq');
  v_owner  uuid := (SELECT user_id FROM profiles WHERE tenant_id = v_tenant AND role = 'tenant_owner' AND coalesce(is_active,true) ORDER BY created_at LIMIT 1);
  v_de     uuid;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'tenant not found'; END IF;

  -- ── The DE (idempotent on name) ──────────────────────────────
  SELECT id INTO v_de FROM digital_employees
   WHERE tenant_id = v_tenant AND name = 'Website & Growth DE';

  IF v_de IS NULL THEN
    INSERT INTO digital_employees (
      tenant_id, name, persona_name, description, category, department,
      display_title, purpose_statement, primary_business_outcome, responsibilities,
      lifecycle_status, status, trust_level, external_reply_mode, charter, created_by
    ) VALUES (
      v_tenant, 'Website & Growth DE', 'Sky',
      'Advises on SEO, Google Ads, website analytics and landing-page conversion — grounded in marketing best practice.',
      'Internal', 'Marketing',
      'Website & Growth Advisor',
      'Grow qualified website traffic and conversion by advising the team on SEO, paid search, analytics and page performance.',
      'More qualified traffic and higher conversion from the website',
      ARRAY[
        'Review SEO — keyword targeting, on-page structure, content gaps',
        'Review Google Ads — account structure, budgets, keywords, ad copy',
        'Read traffic and conversion data and explain what to focus on',
        'Critique landing pages and content for clarity and conversion'
      ],
      'active', 'active', 'supervised', 'draft',
      jsonb_build_object(
        'mission', 'Be a trustworthy growth advisor. Recommend, explain the why, and cite the principle. Never invent numbers about this business — ask for the data. State plainly that you advise; you do not yet execute changes to the live site or ad accounts.',
        'scales_to_execution', 'When a Google Ads, GA4 or CMS connector is attached, the same advice can become a drafted change routed through the normal approval + guardrail path. Advisory only until then.'
      ),
      v_owner
    ) RETURNING id INTO v_de;
    RAISE NOTICE 'created Website & Growth DE %', v_de;
  ELSE
    RAISE NOTICE 'Website & Growth DE already exists %', v_de;
  END IF;

  -- ── Grounding knowledge (tenant-visible; retrieved by de-answer) ──
  -- Upsert-ish: only insert docs not already present by title.
  INSERT INTO knowledge_docs (tenant_id, title, content, source, tags, visibility, is_current)
  SELECT v_tenant, d.title, d.content, 'upload', d.tags, 'tenant', true
  FROM (VALUES
    (
      'SEO fundamentals — on-page and content',
      E'Search engine optimisation grows unpaid ("organic") traffic by making pages the best available answer to what people search for.\n\nKEYWORD TARGETING: Each important page should target one primary search intent. Group related queries onto one page rather than making thin pages for near-duplicate terms. Prioritise terms by a balance of search volume, how commercial the intent is, and how realistically you can rank (lower-competition, specific "long-tail" phrases convert well and are easier to win).\n\nON-PAGE STRUCTURE: Put the primary term in the page title (<title>, ~50-60 chars), the H1, the URL slug, the first 100 words, and naturally through the body. Use one H1 and a logical H2/H3 outline. Write a compelling meta description (~150-160 chars) — it does not affect ranking directly but drives click-through.\n\nCONTENT QUALITY: Google rewards content that satisfies the searcher and demonstrates real expertise (E-E-A-T: Experience, Expertise, Authoritativeness, Trust). Cover the topic more completely and concretely than competing pages. Add original data, examples, or a clear point of view. Refresh important pages when they go stale.\n\nCONTENT GAPS: Find questions your audience asks that you have no page for (search "People also ask", competitor headings, your own support tickets). Each unanswered high-intent question is a content opportunity.\n\nTECHNICAL BASICS: Pages must be crawlable and indexable, load fast (Core Web Vitals), work on mobile, and use HTTPS. A fast, clean site with a clear internal-link structure lets your best content rank.',
      ARRAY['seo','organic','content','keywords','on-page']
    ),
    (
      'Google Ads — account structure and optimisation',
      E'Google Ads buys clicks on search and other placements. Well-structured accounts spend efficiently; sloppy ones waste budget.\n\nACCOUNT STRUCTURE: Organise campaigns by budget and goal (e.g. one campaign per product line or region so you can control spend where it matters). Within a campaign, group tightly-themed keywords into ad groups so the ad copy and landing page match the query closely. Loose ad groups mean generic ads and low Quality Score.\n\nQUALITY SCORE: Google rates expected click-through rate, ad relevance, and landing-page experience (1-10). Higher Quality Score means lower cost-per-click for the same position. Improve it by tightening keyword-to-ad-to-page relevance, not by bidding more.\n\nKEYWORDS & MATCH TYPES: Exact and phrase match give control; broad match reaches more but needs strong negative-keyword lists to avoid irrelevant clicks. Review the search-terms report regularly and add negatives for queries you should not pay for.\n\nAD COPY: Write ads that mirror the searcher''s intent, state a clear benefit and a call to action, and use all available headlines/assets. Test at least 2-3 variations per ad group. Use ad extensions (sitelinks, callouts, structured snippets) — they are free and lift CTR.\n\nBUDGET & BIDDING: Start with enough budget for meaningful data before optimising. Once conversion tracking is solid, automated bidding (Maximise Conversions / Target CPA / Target ROAS) usually beats manual. Bad or missing conversion tracking is the single most common cause of wasted spend — fix that first.\n\nLANDING PAGES: The ad''s promise must be kept by the page it lands on. Mismatched landing pages waste clicks and hurt Quality Score.',
      ARRAY['google-ads','ppc','paid-search','campaigns','quality-score']
    ),
    (
      'Website analytics — reading traffic and conversion',
      E'Analytics turns raw visits into decisions. The point is not the numbers, it is "what should we do next".\n\nCORE METRICS: Sessions/users (volume), traffic by channel (organic, paid, direct, referral, social, email), engagement (engaged sessions, time, pages per session), conversions and conversion rate, and the value per channel. In GA4, define conversion "events" for the actions that matter (form submit, signup, purchase, call).\n\nSEGMENT BEFORE CONCLUDING: A flat overall number hides the story. Always split by channel, device, landing page, and new vs returning. "Conversion dropped" usually means one segment moved — find which.\n\nDIAGNOSING A DROP: Check (1) did a channel''s volume fall (a ranking loss, a paused campaign)? (2) did conversion rate fall on a specific page or device (a broken form, a slow page, a redesign)? (3) is it seasonal or a tracking break (compare year-over-year and confirm tags still fire)? Rule out tracking problems before chasing a real decline.\n\nWHERE TO FOCUS: Prioritise pages with high traffic AND low conversion (biggest upside), and channels with good conversion but low volume (scale them). Do not over-invest in low-traffic, already-converting pages.\n\nATTRIBUTION HONESTY: Most journeys touch several channels. Last-click undercredits awareness channels; be cautious about cutting a channel purely on last-click data. Match the decision to the question, and never present a modelled or estimated figure as if it were measured.',
      ARRAY['analytics','ga4','traffic','conversion','metrics']
    ),
    (
      'Landing pages and conversion rate optimisation',
      E'A landing page''s job is to convert the visitor a specific channel sent. Small clarity gains compound across all your traffic.\n\nMESSAGE MATCH: The headline must match the promise that got the person here (the ad, the search, the email). A visitor decides in seconds whether they are in the right place — the hero must confirm it and state the core value clearly.\n\nONE PAGE, ONE JOB: Each landing page should have a single primary call to action. Competing CTAs and navigation that leaks attention lower conversion. Repeat the one CTA down the page.\n\nCLARITY OVER CLEVERNESS: Say what it is, who it is for, and what to do next, in plain language. Lead with the benefit to the customer, support it with proof (specific outcomes, testimonials, logos, numbers), and remove jargon.\n\nFRICTION: Every required form field, every slow second, every unanswered objection costs conversions. Ask only for what you need now. Address the top objections on the page (price, risk, effort, trust) before the visitor has to go looking.\n\nTRUST & SPEED: Social proof, clear contact details, security cues, and a fast mobile load all lift conversion. Core Web Vitals matter here too — a page that is slow on a phone loses paid clicks you already paid for.\n\nTESTING: Improve with evidence, not opinion. Change one meaningful thing (headline, hero, CTA, form length), measure conversion, keep what wins. Prioritise tests on your highest-traffic pages where a small lift is worth the most.',
      ARRAY['landing-pages','cro','conversion','copywriting','ux']
    )
  ) AS d(title, content, tags)
  WHERE NOT EXISTS (
    SELECT 1 FROM knowledge_docs k
     WHERE k.tenant_id = v_tenant AND k.title = d.title AND k.is_current
  );

  RAISE NOTICE 'growth knowledge docs ensured for tenant %', v_tenant;
END $$;

SELECT (SELECT count(*) FROM digital_employees WHERE tenant_id=(SELECT id FROM tenants WHERE slug='outsourcetel-hq') AND name='Website & Growth DE') AS de_count,
       (SELECT count(*) FROM knowledge_docs WHERE tenant_id=(SELECT id FROM tenants WHERE slug='outsourcetel-hq') AND tags && ARRAY['seo','google-ads','analytics','cro'] AND is_current) AS growth_docs;
