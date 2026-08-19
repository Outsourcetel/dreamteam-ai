# OAuth app registrations — founder runbook (start these clocks first)

Three developer apps unlock the demand chain and calendar booking. Each is a
one-time registration under OUR account; every CLIENT then connects their own
account through it (that is what "tenant-scoped from day one" means). Two of
the three have human review queues — start them before anything else.

## 1. Google Cloud (unlocks: Google Ads, Google Calendar, GA4, Search Console)
1. console.cloud.google.com → New Project → name it `DreamTeam Connectors`.
2. APIs & Services → Enable APIs: **Google Ads API**, **Google Calendar API**,
   **Google Analytics Data API**, **Search Console API**.
3. APIs & Services → OAuth consent screen → External → fill app name
   `DreamTeam AI`, support email, domain. Add scopes when asked:
   calendar.events, analytics.readonly, webmasters.readonly, adwords.
4. Credentials → Create Credentials → **OAuth client ID** → Web application →
   authorized redirect URI:
   `https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/connector-hub`
   (I will confirm the exact callback path before the first client connects.)
5. Copy the **Client ID** and **Client Secret** → Platform Console (a field
   will exist by the time you have them — do NOT paste them in chat).
6. **The queue:** Google Ads API access starts at "test" level. Apply for a
   **Basic developer token**: Google Ads UI → Tools → API Center. This is the
   human-review step (typically days). Calendar/GA4/GSC need no review.

## 2. Meta (unlocks: Meta ads)
1. developers.facebook.com → My Apps → Create App → type **Business**.
2. Add the **Marketing API** product.
3. App Review → request `ads_read` first (reads), `ads_management` later
   (writes). **This is the human-review queue** — reads are approved faster.
4. Copy App ID + App Secret → Platform Console field (never chat).

## 3. LinkedIn (unlocks: LinkedIn ads)
1. developer.linkedin.com → Create App → verify it against the company page.
2. Request access to the **Advertising API** (this is LinkedIn's review
   queue — often the slowest of the three; start it now, expect weeks).
3. Copy Client ID + Client Secret → Platform Console field (never chat).

## What you do NOT need to do
- No DNS. No MX records. Nothing at HosterPK or Namecheap for any of this.
- No client credentials — clients connect their own accounts later through
  the consent screens these apps provide.
