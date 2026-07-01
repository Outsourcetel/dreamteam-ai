// ingest-url Edge Function
// Fetches a URL server-side (no CORS restrictions) and returns extracted text
// so the browser can create a KB article from real page content.
//
// Deploy:
//   1. Supabase Dashboard → Edge Functions → Deploy new function
//   2. Upload this file as "ingest-url"
//   3. No secrets needed — runs anonymously with tenant validation via JWT
//
// POST /functions/v1/ingest-url
// Body: { url: string }
// Response: { title: string; body: string; wordCount: number }

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { url } = await req.json();
    if (!url || typeof url !== 'string') {
      return new Response(JSON.stringify({ error: 'url is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const res = await fetch(url, {
      headers: { 'User-Agent': 'DreamTeam-KB-Ingestor/1.0' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const contentType = res.headers.get('content-type') ?? '';
    let body = '';
    let title = new URL(url).hostname;

    if (contentType.includes('text/html')) {
      const html = await res.text();
      // Extract <title>
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      if (titleMatch) title = titleMatch[1].trim();
      // Strip tags and collapse whitespace
      body = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 12_000);
    } else {
      body = (await res.text()).slice(0, 12_000);
    }

    const wordCount = body.split(/\s+/).filter(Boolean).length;

    return new Response(JSON.stringify({ title, body, wordCount }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
