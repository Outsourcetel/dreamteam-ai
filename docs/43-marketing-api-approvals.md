# 43 — Getting the marketing APIs approved

**Status:** action list for the founder. Written 2026-08-05, after migrations 574–579
shipped the ads / SEO / social categories and the Google Ads, Search Console and
Meta adapters.

**Who this is for:** you, doing the applications. Nothing here needs an engineer.
Where a form asks a technical question, the answer is pre-drafted — copy it.

---

## 0. Read this first: what is actually built

Being straight about this changes what you should apply for, so it goes at the top.

| | Built and path-verified | Governed but **NOT executable** |
|---|---|---|
| **Google Ads** | campaigns, keywords, search terms, spend — all reads | pause, resume, set budget, edit copy, negative keyword, ad draft |
| **Search Console** | queries, page performance — all reads | submit sitemap, request re-crawl |
| **Meta** | posts, engagement, comments — all reads | publish, schedule, reply, hide, delete, boost |

The right-hand column exists as **governed action definitions** — each one classified,
gated, guardrail-scanned and routed to a human for approval. That machinery is real and
enforced. What is missing is the last inch: the HTTP binding that would actually call the
vendor. Approving a `publish_post` today would find nothing to execute.

**Why this matters for the applications:** Meta rejects submissions where the demo video
does not exactly match the permissions requested. We cannot record a video of publishing
a post, because publishing is not wired. So **do not request write permissions in the
first review.** Ask only for what we can show. Details in §3.

---

## 1. The order to do this in

Sequenced by how long each takes and what unblocks a real client soonest.

| # | What | Gate | Realistic time | Unblocks |
|---|---|---|---|---|
| 1 | **Search Console OAuth** | none | **an afternoon** | Real SEO data for omnexasol |
| 2 | **Meta app + Standard Access** | none, if §3.1 applies | **a day** | Real social reads for omnexasol |
| 3 | **Google Ads developer token** (Basic) | Google review | ~5 business days | Real ads data |
| 4 | Meta App Review + Business Verification | Meta review | days–weeks | Social for clients 2..n |
| 5 | Write bindings + a second Meta review | engineering, then review | after 1–4 | Anything that changes a live account |

**Start 1 and 2 today; start 3 today because it queues.** Item 4 is not needed for the
first client and item 5 is not needed until we want the employee to change things rather
than recommend them.

---

## 2. Google Ads developer token

### 2.1 What you need before you start

- A **Google Ads manager account (MCC)**. The token belongs to the manager account, not
  to an ad account. If Outsourcetel does not have one, create it first — it is free.
- Omnexasol's ad account **linked to that MCC**. Google's review checks that active
  accounts are linked.
- A monitored **API Contact Email**. Google emails this address and a bounce fails the
  application.

### 2.2 Where to apply

Sign in to the **manager** account → **Admin → API Center** → request a developer token.
The API Center only appears on manager accounts, which is the usual reason people cannot
find it.

### 2.3 Which access level

Ask for **Basic**. It allows 15,000 operations a day against live accounts and is reviewed
in about 5 business days. Standard is unlimited but takes ~10 business days and is aimed at
"large companies or tools that serve many users."

Our real usage is a handful of reads per client per day. Basic is not a compromise here —
it is roughly a thousand times our current need.

### 2.4 How to describe the use case — copy this

Answer as **an agency using its own internal tooling**, because that is what is true today:
Outsourcetel manages client ad accounts through its MCC. Do not describe it as a product
other companies log into — that framing pushes the application toward Standard access and
Required Minimum Functionality, which we do not need yet and would slow this down.

> Outsourcetel is a marketing services agency. We manage our clients' Google Ads accounts
> through our manager account. We have built internal tooling that reads campaign,
> keyword, search-term and spend data so our team can produce performance reporting and
> prepare optimisation recommendations.
>
> The tool is read-only against the Google Ads API. It retrieves campaign settings and
> performance metrics and presents them to our staff. It does not create, modify, pause or
> budget campaigns. Any change identified as worthwhile is reviewed by a member of our team
> and applied by that person in the Google Ads interface.
>
> The tool is used by Outsourcetel staff only. Clients do not have direct access to it.

That description is accurate — reads are all that is built — and read-only tooling is the
least contentious thing to approve.

### 2.5 Speeding it up

Google offers **brand verification** on the linked Google Cloud project. It is optional for
Basic access but is documented as expediting review. Third-party write-ups in mid-2026
report it cutting a pending review from days to hours; the mechanism is confirmed by
Google, the "hours" figure is not, so treat it as worth doing rather than guaranteed.

### 2.6 When this stops being enough

The moment DreamTeam is sold to customers who connect **their own** Google Ads accounts,
the honest description changes to a tool serving many users. That means **Standard access**
and complying with **Required Minimum Functionality** — a checklist of capabilities Google
requires such tools to offer. That is a real future step. It is not today's problem and
should not be mentioned in today's application.

---

## 3. Meta (Facebook Pages + Instagram)

### 3.1 The shortcut that probably makes review unnecessary for client #1

Meta has two access levels:

- **Standard Access** — granted automatically to new Business apps. Permissions can be
  requested **only from people who have a role on your app** (admin, developer, tester).
- **Advanced Access** — permissions can be requested from anyone. Needs App Review,
  Business Verification, and an annual Data Use Checkup.

So: **if you add omnexasol's Facebook Page admin as a Tester on our Meta app, Standard
Access is enough.** No App Review. No Business Verification. No waiting.

That works for one client, and for two or three. It does not scale — every client would
need a role on our app, which is clumsy and gives them visibility they should not have.
But it means the first real social connection is a day's work, not weeks.

**Do this first and see the product work. Then start App Review in the background.**

### 3.2 Setting up the app

1. developers.facebook.com → **My Apps → Create App** → type **Business**.
2. Add the **Facebook Login** product and, later, **Instagram**.
3. Under **App Roles**, add omnexasol's Page admin as a **Tester**. They must accept the
   invite from their own Facebook account.
4. Under **App Settings → Basic**, set the privacy policy URL and the app icon. Meta
   requires these before review and they are trivial to forget.

### 3.3 Which permissions, and when

**Request now (first review) — these are the ones we can demonstrate:**

| Permission | What it does | Which of our features needs it |
|---|---|---|
| `pages_show_list` | Lists which Pages a person manages | Picking the Page during connector setup |
| `pages_read_engagement` | Reads Page posts, photos, videos and their engagement | `search_posts`, `get_post`, `search_comments` |

**Request later (second review, after the write bindings exist):**

| Permission | What it does | Which of our actions needs it |
|---|---|---|
| `pages_manage_posts` | Create, edit and delete Page posts | `publish_post`, `schedule_post`, `delete_post` |
| `pages_manage_engagement` | Create, edit and delete comments; like posts | `reply_to_comment`, `hide_comment` |
| `instagram_business_basic` | Read an Instagram business profile | Instagram reads |
| `instagram_content_publish` | Publish photo and video posts to Instagram | Instagram publishing |
| `ads_management` | Create and manage ads | `boost_post` |

**Every one of these requires App Review and Business Verification for Advanced Access** —
including the read permissions. There is no permission here that Meta grants freely at
Advanced level.

### 3.4 Business Verification

Done in **Meta Business Manager → Business Settings → Security Centre**. Meta asks for:

- Legal business name, address and phone number, matching official records
- A business document — certificate of incorporation, business licence, or a utility bill
  or bank statement in the business's name
- A domain you control, verified by DNS record, HTML file or meta tag
- Confirmation of your role at the business

For a Saudi entity the commercial registration (CR) is the natural document. **Names must
match exactly** across the CR, the Business Manager profile and the domain registration —
mismatches are the most common cause of a rejected verification, and each round trip costs
days.

Start this **in parallel** with everything else. It is a prerequisite for App Review, so a
submission made before verification completes simply waits.

### 3.5 The screencast — where most submissions die

Meta requires a video showing a real person using the real product to exercise **each
permission requested**. The documented failure is a mismatch: asking for management
permissions while the video shows only reading.

For our first submission, record exactly this:

1. Log in to DreamTeam as a normal user.
2. Go to **Systems → Connectors**, choose **Meta (Facebook & Instagram)**.
3. Click connect. Show the **Facebook login dialog and the permission prompt** — Meta's
   reviewer needs to see their own consent screen.
4. Show the Page picker listing the Pages the account manages. *(This is `pages_show_list`.)*
5. Complete the connection and show the test call succeeding.
6. Open the Social Media Manager employee and show it **reading recent posts, their
   engagement counts, and the comments underneath**. *(This is `pages_read_engagement`.)*
7. Show what the employee produces: a **draft** reply or post, sitting in an approval
   queue, clearly not published.

Step 7 is worth dwelling on. Our whole governance story — nothing reaches the public
without a person — is the reassuring part of this submission, and it is genuinely true.
Show it.

**Do not** show anything publishing, replying or boosting. We are not requesting those
permissions in this round and demonstrating unrequested capability invites questions we
cannot answer yet.

### 3.6 The use-case text — copy this

> DreamTeam is a workforce platform used by businesses to run AI assistants that support
> their marketing team. A business connects its own Facebook Page to the platform.
>
> The assistant reads the Page's recent posts, their engagement, and the comments left on
> them, so that it can summarise what is being asked and prepare draft replies and draft
> posts for a member of staff to review.
>
> The assistant does not publish anything. Every draft it produces is placed in an approval
> queue and can only be released by a person at the business. In this submission we are
> requesting read permissions only.
>
> We use `pages_show_list` so the user can choose which of their Pages to connect, and
> `pages_read_engagement` to read that Page's posts and comments.

Accurate, narrow, and it explains the governance up front.

---

## 4. Search Console — no application at all

Worth restating because it is easy to lose among the other two: **Search Console needs no
developer token, no app review and no business verification.** It needs an OAuth consent
screen on a Google Cloud project and a sign-in from someone who already owns the property.

That makes it the only one of the three that can be live this week, and it happens to cover
the SEO half of what omnexasol asked for.

What you need:
- A Google Cloud project with the **Search Console API** enabled
- An OAuth client (type: Web application) — gives you the client ID and client secret
- A one-time sign-in by omnexasol's Search Console owner to produce the refresh token
- The property URL exactly as Search Console shows it, URL-encoded — `sc-domain:example.com`
  for a domain property, or the full `https://...` for a URL-prefix property

---

## 5. What to tell omnexasol

Two things, both better said now than discovered later.

**Four channels was the ask; two is what we can deliver.** Facebook and Instagram are
built. **LinkedIn and TikTok are not** — both gate publishing behind their own approval
programmes, and neither has an adapter. Promising four and shipping two is a worse start
than scoping to two honestly.

**Recommendation before automation.** For the first period the employees will read
everything and draft everything, and a person will click publish. That is not a limitation
we are apologising for — it is the product working as designed — but it should be what they
expect, not a surprise.

---

## 6. Nothing here has touched a live account

Every adapter is verified against **fixture responses built from each vendor's documented
format**, not captured from a real account. That proves our field paths match the
documentation. It does not prove the vendor returns exactly that.

The Google Ads adapter is the cautionary tale: it looked correct, passed six checks, and
could not have read a single keyword — Google speaks snake_case in the query and camelCase
in the reply. A fixture caught it. Something else may be waiting that the fixtures agree
with and reality does not.

**So: the day the first account connects, run a live read on every operation before showing
anyone a dashboard.** That is a half-hour task and it is the difference between finding a
problem ourselves and finding it in front of a client.

---

## Sources

- [Google Ads API — Access Levels and Permissible Use](https://developers.google.com/google-ads/api/docs/api-policy/access-levels)
- [Google Ads API — Access levels and RMF](https://developers.google.com/google-ads/api/docs/productionize/access-levels)
- [Meta Graph API — Access Levels](https://developers.facebook.com/docs/graph-api/overview/access-levels)
- [Meta — Permissions Reference](https://developers.facebook.com/docs/permissions)
