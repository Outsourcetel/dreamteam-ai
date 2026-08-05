// ============================================================
// Search Console + Meta adapters — same discipline as the Google Ads test.
//
// WHY: none of these can be connected to a live account yet. Search Console
// needs an OAuth grant, Meta needs App Review and Business Verification. That
// makes the templates unfalsifiable by normal means, which is exactly when a
// wrong field path ships and is discovered by a client instead of by us.
//
// The Google Ads template proved the risk is not theoretical: it looked correct
// and could not read a single keyword, because Google speaks snake_case in the
// query and camelCase in the reply. It ALSO failed the framework's own
// validator — a get op with no {ref} — while sitting in the database looking
// installed. Both are checked here for every marketing template, not just the
// one that happened to have the bug.
//
// HONEST LIMITATION, same as the ads test: fixtures are built from each
// vendor's documented response shape, not captured from live accounts. They
// prove our paths match the documented shape and that every op yields an
// identified item. They cannot prove the vendor returns exactly this. A live
// smoke test is still owed for all three.
// ============================================================
import { describe, it, expect } from 'vitest';
import { runQuery, adminTokenAvailable } from './helpers/adminQuery';
import {
  walkPath, validateAdapterDefinition, dateValues,
} from '../supabase/functions/_shared/adapterTemplates.ts';

// Vendor-shaped responses. One per op the templates bind.
const RESPONSES: Record<string, Record<string, unknown>> = {
  'Google Search Console': {
    // {rows:[{keys:[…], clicks, impressions, ctr, position}]}
    search_queries: {
      rows: [
        { keys: ['pest control jeddah'], clicks: 120, impressions: 4500, ctr: 0.0266, position: 5.4 },
        { keys: ['iso 9001 consultant jeddah'], clicks: 34, impressions: 900, ctr: 0.0377, position: 8.1 },
      ],
      responseAggregationType: 'byProperty',
    },
    get_page_metrics: {
      rows: [
        { keys: ['https://omnexasol.com/services/pest-control'], clicks: 88, impressions: 2100, ctr: 0.0419, position: 6.2 },
      ],
      responseAggregationType: 'byPage',
    },
  },
  'Instagram (Business)': {
    // {data:[…]} like the rest of Graph, but the fields are Instagram's own —
    // caption not message, permalink not permalink_url, comments_count not a
    // summary object. Close enough to Facebook's to copy by mistake.
    list_posts: {
      data: [
        {
          id: '17900000000000001',
          caption: 'Ant season is here — booking now',
          media_type: 'IMAGE',
          media_url: 'https://scontent.cdninstagram.com/v/ant-season.jpg',
          permalink: 'https://www.instagram.com/p/CxYzAbCdEfG/',
          timestamp: '2026-07-28T09:12:00+0000',
          like_count: 214,
          comments_count: 18,
        },
      ],
      paging: { cursors: { before: 'a', after: 'b' } },
    },
    get_post: {
      id: '17900000000000001',
      caption: 'Ant season is here — booking now',
      media_type: 'IMAGE',
      media_url: 'https://scontent.cdninstagram.com/v/ant-season.jpg',
      permalink: 'https://www.instagram.com/p/CxYzAbCdEfG/',
      timestamp: '2026-07-28T09:12:00+0000',
      like_count: 214,
      comments_count: 18,
    },
    list_comments: {
      data: [
        {
          id: '17900000000000001',
          caption: 'Ant season is here — booking now',
          permalink: 'https://www.instagram.com/p/CxYzAbCdEfG/',
          timestamp: '2026-07-28T09:12:00+0000',
          comments: {
            data: [
              { id: '17800000000000009', text: 'Do you cover Obhur?', username: 'a_customer', timestamp: '2026-07-29T06:00:00+0000', like_count: 0 },
            ],
          },
        },
      ],
    },
  },
  'LinkedIn (Company Page)': {
    // {paging, elements:[…]}; the post id is a URN and commentary is the text.
    list_posts: {
      paging: { start: 0, count: 25, links: [] },
      elements: [
        {
          id: 'urn:li:share:6856921137721544704',
          author: 'urn:li:organization:5515715',
          commentary: 'ISO 9001 in practice: what an auditor actually asks for',
          lifecycleState: 'PUBLISHED',
          visibility: 'PUBLIC',
          createdAt: 1785400000000,
        },
      ],
    },
    get_post: {
      id: 'urn:li:share:6856921137721544704',
      author: 'urn:li:organization:5515715',
      commentary: 'ISO 9001 in practice: what an auditor actually asks for',
      lifecycleState: 'PUBLISHED',
      visibility: 'PUBLIC',
      createdAt: 1785400000000,
    },
  },
  'TikTok': {
    // {data:{videos:[…], cursor, has_more}} — the array is TWO levels down.
    list_posts: {
      data: {
        videos: [
          {
            id: '7301234567890123456',
            title: 'Ant season prep in 40 seconds',
            video_description: 'What to do before the first swarm',
            create_time: 1785300000,
            share_url: 'https://www.tiktok.com/@omnexasol/video/7301234567890123456',
            view_count: 12400, like_count: 830, comment_count: 41, share_count: 12,
          },
        ],
        cursor: 1785300000000,
        has_more: false,
      },
      error: { code: 'ok', message: '', log_id: 'x' },
    },
    get_post: {
      data: {
        videos: [
          {
            id: '7301234567890123456',
            title: 'Ant season prep in 40 seconds',
            video_description: 'What to do before the first swarm',
            create_time: 1785300000,
            share_url: 'https://www.tiktok.com/@omnexasol/video/7301234567890123456',
            view_count: 12400, like_count: 830, comment_count: 41, share_count: 12,
          },
        ],
      },
      error: { code: 'ok', message: '', log_id: 'x' },
    },
  },
  'Meta (Facebook & Instagram)': {
    // Collections are {data:[…]}; a single node is the object itself.
    list_posts: {
      data: [
        {
          id: '1234567890_9876543210',
          message: 'Seasonal ant treatment — what to expect',
          created_time: '2026-07-28T09:12:00+0000',
          permalink_url: 'https://www.facebook.com/1234567890/posts/9876543210',
          likes: { summary: { total_count: 41 } },
          comments: { summary: { total_count: 7 } },
        },
      ],
      paging: { cursors: { before: 'a', after: 'b' } },
    },
    get_post: {
      id: '1234567890_9876543210',
      message: 'Seasonal ant treatment — what to expect',
      created_time: '2026-07-28T09:12:00+0000',
      permalink_url: 'https://www.facebook.com/1234567890/posts/9876543210',
      likes: { summary: { total_count: 41 } },
      comments: { summary: { total_count: 7 } },
    },
    list_comments: {
      data: [
        {
          id: '1234567890_5555',
          message: 'Ant season is here — booking now',
          created_time: '2026-07-27T08:00:00+0000',
          permalink_url: 'https://www.facebook.com/1234567890/posts/5555',
          comments: {
            data: [
              { id: '5555_1', message: 'Do you service Obhur?', from: { name: 'A. Customer' }, created_time: '2026-07-29T06:00:00+0000', like_count: 0 },
            ],
          },
        },
      ],
    },
  },
};

interface Binding {
  method: string;
  single_item?: boolean;
  response: { items_path?: string; id_path: string; title_path?: string; snippet_path?: string; url_path?: string };
}

// The list-selection branch from runTemplateOp, kept in step deliberately.
function selectList(body: unknown, b: Binding): { ok: boolean; list?: Array<Record<string, unknown>>; why?: string } {
  const walked = walkPath(body, b.response.items_path ?? '');
  if (!walked.found) return { ok: false, why: `items_path died at "${walked.failed_segment}"` };
  if (b.single_item) return { ok: true, list: [walked.value as Record<string, unknown>] };
  if (Array.isArray(walked.value)) return { ok: true, list: (walked.value as Array<Record<string, unknown>>).slice(0, 10) };
  if (walked.value && typeof walked.value === 'object') return { ok: true, list: [walked.value as Record<string, unknown>] };
  return { ok: false, why: `items_path points at a ${typeof walked.value}` };
}

if (!adminTokenAvailable()) {
  describe.skip('marketing adapters (no admin token)', () => { it('skipped', () => {}); });
} else {
  describe('Search Console + Meta adapters', () => {
    let templates: Array<{ name: string; category: string; definition: Record<string, unknown> }> = [];

    it('both are published at platform scope', async () => {
      templates = await runQuery(
        `select name, category, definition from adapter_templates
          where scope = 'platform' and status = 'published'
            and name in ('Google Search Console', 'Instagram (Business)', 'LinkedIn (Company Page)', 'Meta (Facebook & Instagram)', 'TikTok')
          order by name`,
      );
      expect(templates.map((t) => t.name)).toEqual(['Google Search Console', 'Instagram (Business)', 'LinkedIn (Company Page)', 'Meta (Facebook & Instagram)', 'TikTok']);
    });

    it('pass the framework validator the wizard runs', async () => {
      const failures: string[] = [];
      for (const t of templates) {
        const r = validateAdapterDefinition(t.definition, t.category as 'social');
        if (!r.ok) failures.push(`${t.name}: ${r.errors.join('; ')}`);
      }
      expect(failures, `\n  ${failures.join('\n  ')}\n`).toEqual([]);
    });

    it('every op yields an identified, titled item — not an empty success', async () => {
      const failures: string[] = [];
      for (const t of templates) {
        const ops = t.definition.ops as Record<string, Binding>;
        for (const [op, binding] of Object.entries(ops)) {
          const body = RESPONSES[t.name]?.[op];
          if (!body) { failures.push(`${t.name}/${op}: no fixture — an op shipped this test does not cover`); continue; }

          const sel = selectList(body, binding);
          if (!sel.ok) { failures.push(`${t.name}/${op}: ${sel.why}`); continue; }
          if (!sel.list!.length) { failures.push(`${t.name}/${op}: selected an empty list`); continue; }

          for (const row of sel.list!) {
            if (Array.isArray(row)) { failures.push(`${t.name}/${op}: selected a list of arrays (single_item over an array)`); break; }
            for (const p of ['id_path', 'title_path', 'snippet_path', 'url_path'] as const) {
              const path = binding.response[p];
              if (!path) continue;
              const v = walkPath(row, path);
              if (!v.found || v.value === undefined || v.value === null || v.value === '') {
                failures.push(`${t.name}/${op}: ${p} "${path}" resolved to nothing (present: ${Object.keys(row).join(', ')})`);
              }
            }
          }
        }
      }
      expect(failures, `\n  ${failures.join('\n  ')}\n`).toEqual([]);
    });

    it('never reads a field it did not request', async () => {
      // On a fields-based API (Meta, Salesforce, Zoho) the response contains
      // ONLY the named fields. Reading one you did not ask for gives HTTP 200,
      // rows, and an empty value — success with nothing in it, the same silent
      // shape as the Google Ads camelCase bug from a different cause.
      const failures: string[] = [];
      for (const t of templates) {
        for (const [op, b] of Object.entries(t.definition.ops as Record<string, Binding & { query_params?: Record<string, string> }>)) {
          const fields = b.query_params?.fields;
          if (!fields) continue; // no fields param — the API returns everything
          for (const p of ['id_path', 'title_path', 'snippet_path', 'url_path'] as const) {
            const path = b.response[p];
            if (!path) continue;
            const root = path.split('.')[0];
            if (!fields.includes(root)) failures.push(`${t.name}/${op}: reads ${p} "${path}" but never requests "${root}"`);
          }
        }
      }
      expect(failures, `\n  ${failures.join('\n  ')}\n`).toEqual([]);
    });

    it('Search Console asks for a MOVING window, not a date frozen at ship time', async () => {
      // A literal date is right the day it ships and wrong every day after, and
      // nothing would ever report it as broken — the connector keeps returning
      // rows, just increasingly stale ones.
      const gsc = templates.find((t) => t.name === 'Google Search Console')!;
      const ops = JSON.stringify(gsc.definition.ops);
      expect(ops, 'a literal yyyy-mm-dd is baked in').not.toMatch(/"(startDate|endDate)":\s*"\d{4}-/);
      expect(ops).toContain('{today}');
      expect(ops).toContain('{days_ago_28}');
    });

    it('the date placeholders actually resolve, and to real ISO dates', async () => {
      // The placeholders being PRESENT proves nothing if the framework does not
      // fill them — that combination renders them to empty string and Search
      // Console returns a 400 nobody can read.
      const v = dateValues(new Date('2026-08-05T10:00:00Z'));
      expect(v.today).toBe('2026-08-05');
      expect(v.days_ago_28).toBe('2026-07-08');
      expect(v.days_ago_1).toBe('2026-08-04');

      const gsc = templates.find((t) => t.name === 'Google Search Console')!;
      const ops = gsc.definition.ops as Record<string, Binding & { body_template?: Record<string, unknown> }>;
      for (const [op, b] of Object.entries(ops)) {
        const start = String(b.body_template?.startDate ?? '');
        const key = start.replace(/[{}]/g, '');
        expect(v[key], `${op}: startDate "${start}" is not a placeholder the framework fills`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });

    it('Search Console declares no developer token — that is its whole advantage', async () => {
      const gsc = templates.find((t) => t.name === 'Google Search Console')!;
      const auth = gsc.definition.auth as Record<string, unknown>;
      expect(auth.secret_headers, 'copied the Google Ads auth block wholesale').toBeUndefined();
      expect(auth.type).toBe('oauth2_refresh_token');
    });

    it('the Meta template cannot write — publishing stays under approval', async () => {
      const meta = templates.find((t) => t.name === 'Meta (Facebook & Instagram)')!;
      const ops = meta.definition.ops as Record<string, Binding>;
      for (const [op, b] of Object.entries(ops)) {
        expect(b.method, `${op} is not a read`).toBe('GET');
      }
    });

    it('every public-speech action is gated, and drafting is not', async () => {
      // The rule, checked against the shipped rows rather than the migration
      // that wrote them: LISTEN ALONE, NEVER SPEAK IN PUBLIC ALONE.
      // Deliberately NOT filtered to active. An action that is merely absent
      // from the active set could equally have been DELETED, and "the dangerous
      // thing is gone" and "the dangerous thing is ungoverned" look identical
      // from a filtered query. Every key must still exist, and be either gated
      // or explicitly switched off.
      const rows = await runQuery(
        `select action_key, status, (risk->>'destructive')::boolean as destructive
           from action_definitions
          where scope = 'platform' and category = 'social'`,
      );
      const by = Object.fromEntries(rows.map((r) => [r.action_key, r]));
      for (const k of ['publish_post', 'schedule_post', 'reply_to_comment', 'hide_comment', 'delete_post', 'boost_post']) {
        expect(by[k], `${k} has vanished from the registry entirely`).toBeTruthy();
        if (by[k].status !== 'active') continue; // disabled is safe; write-bindings.test asserts it says why
        expect(by[k].destructive, `${k} speaks in public but is not gated`).toBe(true);
      }
      expect(by.draft_post?.destructive, 'drafting is gated, so the employee can do nothing alone').toBe(false);
    });
  });
}
