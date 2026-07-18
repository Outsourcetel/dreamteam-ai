// browserFetch — fetch a public URL the way the knowledge ingester needs:
// with a full, browser-like header set and bounded retry/backoff on the
// transient bot-mitigation responses (403 / 429 / 503).
//
// This meaningfully improves ingestion against sites that do a naive
// User-Agent / header check or that briefly rate-limit a burst of requests.
// It does NOT defeat a real WAF JS-challenge (Cloudflare "checking your
// browser") or a hard block on the caller's datacenter IP — those need a
// headless renderer or a residential proxy, which the plain edge runtime
// cannot do. When that's the case we classify the failure honestly so the
// caller can tell the tenant to upload an export or use an API connector.

export interface FetchOutcome {
  ok: boolean;
  status: number;
  response?: Response;
  /** stable machine reason when !ok */
  reason?: 'blocked' | 'not_found' | 'server_error' | 'network' | 'unsupported';
  /** human, actionable message when !ok */
  detail?: string;
}

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * If a render/proxy service is configured, fetch the URL through it.
 * RENDER_FETCH_URL: a template containing "{url}" (replaced with the
 *   percent-encoded target), e.g.
 *   "https://api.scrapingbee.com/?api_key=KEY&render_js=true&url={url}".
 * RENDER_FETCH_HEADER (optional): "Name: value" header to add.
 * Returns a successful FetchOutcome, or null if not configured / it also fails.
 */
async function tryRenderService(url: string, timeoutMs: number): Promise<FetchOutcome | null> {
  const template = Deno.env.get('RENDER_FETCH_URL');
  if (!template) return null;
  const target = template.includes('{url}')
    ? template.replace('{url}', encodeURIComponent(url))
    : template + encodeURIComponent(url);
  const headers: Record<string, string> = {};
  const hdr = Deno.env.get('RENDER_FETCH_HEADER');
  if (hdr && hdr.includes(':')) {
    const i = hdr.indexOf(':');
    headers[hdr.slice(0, i).trim()] = hdr.slice(i + 1).trim();
  }
  try {
    const r = await fetch(target, { signal: AbortSignal.timeout(timeoutMs * 2), headers });
    if (r.ok) return { ok: true, status: r.status, response: r };
  } catch { /* fall through to the honest blocked message */ }
  return null;
}

/**
 * Fetch with browser headers and bounded retry on transient blocks.
 * @param url         validated http(s) URL (caller must SSRF-check first)
 * @param timeoutMs   per-attempt timeout
 * @param maxAttempts total attempts (default 3; retries only 403/429/503)
 */
export async function browserFetch(url: string, timeoutMs = 15000, maxAttempts = 3): Promise<FetchOutcome> {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { ...BROWSER_HEADERS, 'Accept': attempt === 1 ? BROWSER_HEADERS.Accept : 'text/html,*/*' } });
    } catch (e) {
      // network/timeout — one retry may still help
      if (attempt < maxAttempts) { await sleep(400 * attempt); continue; }
      return { ok: false, status: 0, reason: 'network', detail: `could not reach the URL (${String((e as Error)?.message ?? e).slice(0, 100)})` };
    }
    lastStatus = resp.status;
    if (resp.ok) return { ok: true, status: resp.status, response: resp };

    // Retry the transient bot-mitigation / rate-limit codes with backoff.
    if ([403, 429, 503].includes(resp.status) && attempt < maxAttempts) {
      await sleep(600 * attempt);
      continue;
    }
    break;
  }

  if ([403, 429, 503].includes(lastStatus)) {
    // Optional escape hatch: if a headless-render / residential-proxy service
    // is configured, route the blocked URL through it. Dormant until the
    // operator sets RENDER_FETCH_URL (a template with a {url} placeholder,
    // e.g. a ScrapingBee/Browserless/ScraperAPI endpoint) — this is the only
    // thing that gets past a real Cloudflare JS-challenge or a datacenter-IP
    // block, which a plain edge fetch cannot.
    const rendered = await tryRenderService(url, timeoutMs);
    if (rendered) return rendered;
    return {
      ok: false, status: lastStatus, reason: 'blocked',
      detail: `the site blocked automated fetching (HTTP ${lastStatus}) even with browser headers — it likely uses a bot wall (e.g. Cloudflare) or blocks server IPs. Upload the page as a file/PDF, or connect the source via its API instead.`,
    };
  }
  if (lastStatus === 404 || lastStatus === 410) {
    return { ok: false, status: lastStatus, reason: 'not_found', detail: `the URL returned HTTP ${lastStatus} (page not found)` };
  }
  return { ok: false, status: lastStatus, reason: 'server_error', detail: `the URL returned HTTP ${lastStatus}` };
}
