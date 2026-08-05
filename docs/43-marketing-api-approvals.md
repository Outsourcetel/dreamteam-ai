# 43 — Getting the marketing APIs approved

**Status:** action list for the founder. Written 2026-08-05 and revised the same day, after
migrations 574–585 shipped the ads / SEO / social categories and six adapters — Google Ads,
Search Console, Facebook Pages, Instagram, LinkedIn and TikTok — with their writes wired.

Requirements below were checked against each vendor's current documentation rather than
written from memory; these programmes change, and the sources are listed at the end.

**Who this is for:** you, doing the applications. Nothing here needs an engineer.
Where a form asks a technical question, the answer is pre-drafted — copy it.

---

## 0. Read this first: what is actually built

Being straight about this changes what you should apply for, so it goes at the top.

*(Updated after migrations 580–585: writes wired, then LinkedIn, Instagram and TikTok.)*

| | Reads | Writes that work | Deliberately switched off |
|---|---|---|---|
| **Google Ads** | campaigns, keywords, search terms, spend | pause, resume, add negative keyword | set budget, edit ad copy, draft ad |
| **Search Console** | queries, page performance | submit sitemap | request re-crawl |
| **Facebook Page** | posts, engagement, comments | publish, schedule, draft, reply, hide, delete | boost |
| **Instagram** | posts, engagement, comments | prepare post, publish, reply | — |
| **LinkedIn** | recent posts | publish, delete | — |
| **TikTok** | videos and their stats | send to drafts, post | — |

Every write is classified, gated, guardrail-scanned, routed to a human, and actually sent
to the vendor when that human approves. The exact HTTP request each one produces is pinned
by a test.

**Two of the four social channels cannot be run by the employee alone**, and this is a
staffing fact rather than a technicality:

- **Instagram has no text-only post.** Every post needs a picture or video. Ever.
- **TikTok is video.** Same.

On both, a person supplies the media and the employee writes the words. Worth being clear
about that with a client before it becomes a surprise in week two.

Five are **disabled with the reason recorded**, rather than left active and broken:

- **request re-crawl** — Google restricts its Indexing API *by policy* to job-posting and
  live-event pages. A pest-control site is neither. There is no compliant way to ask Google
  to crawl an ordinary page; submitting a sitemap is the supported route, and it works.
- **set campaign budget** — Google Ads takes micros, our approval gates take cents. Money
  is the last place to be clever, so this waits for a proper unit conversion.
- **edit ad copy / draft ad** — responsive search ads need *lists* of headlines; the
  template engine substitutes text and cannot build a list.
- **boost post** — four dependent calls to Meta's Marketing API, and it needs
  `ads_management`, which we are not requesting.

**Why this matters for the applications:** Meta rejects submissions where the demo video
does not exactly match the permissions requested. Publishing is now demonstrable — but only
once a Page is connected, which §3.1 gets you without any review. So the sequence is:
connect a test Page under Standard Access → record the real publish-and-approve flow →
submit for write permissions with a video that actually shows them.

---

## 1. The order to do this in

Sequenced by how long each takes and what unblocks a real client soonest.

| # | What | Gate | Realistic time | Unblocks |
|---|---|---|---|---|
| 1 | **Search Console OAuth** | none | **an afternoon** | Real SEO data |
| 2 | **Meta app + Standard Access** | none, if §3.1 applies | **a day** | Facebook + Instagram, reads and writes, for client #1 |
| 3 | **TikTok app, `video.upload` only** | light review | **days** | Videos into the client's TikTok drafts |
| 4 | **Google Ads developer token** (Basic) | Google review | ~5 business days | Real ads data |
| 5 | **LinkedIn Community Management API** | manual review | **1–4 weeks** | LinkedIn, at all |
| 6 | Meta App Review + Business Verification | Meta review | days–weeks | Facebook + Instagram for clients 2..n |
| 7 | TikTok full audit (`video.publish`) | TikTok audit | weeks | Posting straight to a TikTok profile |

**Start 1, 2 and 3 today. Start 4 and 5 today as well, because they queue** — LinkedIn is
now the long pole at up to a month, and nothing about it gets faster by waiting.

Items 6 and 7 are not needed for the first client. Item 6 is what lets clients 2..n connect
without being added to our app; item 7 only buys direct TikTok posting, and the drafts route
in item 3 already does useful work without it.

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

**Instagram is not a separate application.** Same Meta app, same App Review submission,
same Business Verification — just more permissions on the form. That is the single most
useful thing to know here: you file *one* review covering both channels, not two.

All of these are now wired, so all of them can be demonstrated — but only after a Page is
connected. Do §3.1 first, then record one video covering the lot.

**Facebook Page:**

| Permission | What it does | Which of our features needs it |
|---|---|---|
| `pages_show_list` | Lists which Pages a person manages | Picking the Page during connector setup |
| `pages_read_engagement` | Reads Page posts, photos, videos and their engagement | `list_posts`, `get_post`, `list_comments` |
| `pages_manage_posts` | Create, edit and delete Page posts | `publish_post`, `schedule_post`, `draft_post`, `delete_post` |
| `pages_manage_engagement` | Create, edit and delete comments; like posts | `reply_to_comment`, `hide_comment` |

**Instagram — add to the same submission:**

| Permission | What it does | Which of our features needs it |
|---|---|---|
| `instagram_basic` | Reads the linked IG business account and its media | Instagram `list_posts`, `get_post`, `list_comments` |
| `instagram_content_publish` | Creates and publishes IG posts | `create_media_draft`, `publish_media` |
| `instagram_manage_comments` | Reads and replies to comments on IG posts | Instagram `reply_to_comment` |

Instagram additionally needs the account to be an **Instagram Business account linked to the
Facebook Page**, done in the Page's settings. A personal or creator account will not work,
and the API error when it is wrong does not say so.

Instagram publishing is rate-limited to **100 published posts per rolling 24 hours** —
irrelevant at our volume, but it is the limit that exists, not "unlimited".

**Still do not request:**

| Permission | Why not |
|---|---|
| `ads_management` | `boost_post` is disabled — four dependent Marketing API calls one binding cannot express. |

**Every permission above requires App Review and Business Verification for Advanced
Access** — including the read-only ones. There is no permission here that Meta grants
freely at Advanced level.

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
7. Show the employee **preparing a post**, and show it stopping — sitting in the approval
   queue, clearly not published, with the exact text a person is about to release.
8. Approve it. Show the post appearing on the Page. *(This is `pages_manage_posts`.)*
9. Do the same for a reply: employee drafts a reply to a real comment, a person approves,
   the reply appears. *(This is `pages_manage_engagement`.)*

Then, in the same video, the Instagram half:

10. Connect the **Instagram (Business)** connector to the linked account.
11. Show the employee reading recent Instagram posts and the comments on them.
    *(This is `instagram_basic`.)*
12. Show it **preparing** a post — a supplied picture plus a caption it wrote — and show
    that nothing is visible on the account yet.
13. Approve it. Show the post appearing on the Instagram profile.
    *(This is `instagram_content_publish`.)*
14. Draft a reply to an Instagram comment, approve it, show it appear.
    *(This is `instagram_manage_comments`.)*

Steps 7–8 and 12–13 are the submission. Reviewers see a great many apps that post on a
user's behalf; very few show the post being **held for a human first**. That is our actual
architecture, it is enforced in the database rather than by convention, and it is the most
reassuring thing we can put in front of a reviewer. Do not rush past it — let the approval
queue sit on screen long enough to read.

Step 12 is worth doing deliberately for a second reason: it shows a **person supplying the
picture**. Meta reviewers are wary of bulk auto-posting, and the honest answer here is that
this tool cannot bulk-post to Instagram even if someone wanted it to.

**Do not** show boosting. That permission is not being requested, and demonstrating
unrequested capability invites questions we cannot answer yet.

### 3.6 The use-case text — copy this

> DreamTeam is a workforce platform used by businesses to run AI assistants that support
> their marketing team. A business connects its own Facebook Page, and the Instagram
> business account linked to it, to the platform.
>
> The assistant reads recent posts, their engagement, and the comments left on them, so it
> can summarise what customers are asking and prepare replies and posts for a member of
> staff to review.
>
> The assistant never publishes on its own. Every post and every reply it prepares is placed
> in an approval queue and can only be released by a named person at the business. That
> approval step is enforced by the platform, not by policy — the assistant has no route
> that skips it. On Instagram the assistant writes only the caption; a person supplies the
> picture, because we do not generate images.
>
> We use `pages_show_list` so the user can choose which Page to connect,
> `pages_read_engagement` to read its posts and comments, `pages_manage_posts` and
> `pages_manage_engagement` to publish the posts and replies a person has approved, and
> `instagram_basic`, `instagram_content_publish` and `instagram_manage_comments` to do the
> same on the linked Instagram account.

Accurate, narrow, and it leads with the governance rather than burying it.

---

## 4. LinkedIn — start this today, it is the long pole

Up to a month, reviewed by hand, and nothing about it goes faster by waiting. Of everything
in this document it is the one most worth starting this morning.

### 4.1 You must be a registered company

LinkedIn's Community Management API is **only available to registered legal organisations
for commercial use**. Individuals and unregistered side projects are not eligible at all —
there is no hobbyist tier to fall back to. Outsourcetel qualifies; apply as the company, not
as a person.

### 4.2 The steps, in order

1. **Create the app** at the LinkedIn Developer Portal, associated with the Outsourcetel
   LinkedIn Page.
2. **Get the app verified by a Page super admin.** A super admin of that Page must click a
   verification link before any product request can proceed. This is the step people miss,
   because it happens outside the developer portal and nothing chases it.
3. Under **My Apps → your app → Products**, add **Community Management API** and complete
   the access form.
4. **Complete the survey within 21 days.** Requesting a vetted product triggers a survey in
   the Developer Portal, and it expires. Miss the window and the request lapses — you start
   again, having burned three weeks.

### 4.3 What they ask for

- Verified **business email** on the company domain
- The organisation's **legal name and registered address**, matching official records
- **Website** and a reachable **privacy policy** URL
- Your **role** at the organisation
- The use case, in prose

Same discipline as Meta's Business Verification: legal name, address and domain must agree
with each other. Mismatches cost round trips, and round trips here are measured in weeks.

### 4.4 Permissions

| Permission | What it does | Which of our features needs it |
|---|---|---|
| `r_organization_social` | Retrieve the Page's posts, comments and likes | `list_posts`, `get_post` |
| `w_organization_social` | Post, comment and like as the organisation | `publish_post`, `delete_post` |

Both are restricted to organisations where the authenticated person holds **ADMINISTRATOR**,
**CONTENT_ADMIN** or **DIRECT_SPONSORED_CONTENT_POSTER** on the Page. Whoever authorises the
connection needs one of those roles; a plain employee account silently returns nothing.

### 4.5 The use-case text — copy this

> Outsourcetel is a marketing services agency. Our platform lets a business connect its own
> LinkedIn Page so that an AI assistant can support the team that runs it.
>
> The assistant reads the Page's recent posts to report on what has been published and how
> it performed, and prepares new posts for a member of staff to review. It does not publish
> on its own: every post is placed in an approval queue and released by a named person at
> the business. That approval step is enforced by the platform.
>
> We use `r_organization_social` to read the Page's own posts, and `w_organization_social`
> to publish the posts a person has approved.

### 4.6 One thing that will look odd later

LinkedIn returns the id of a newly created post in an HTTP **header** (`x-restli-id`), not
in the response body, and our receipt only reads the body. So a successful LinkedIn publish
records "HTTP 201" with no post id, where Facebook and Instagram record the id. Harmless,
and worth knowing before someone reports it as a bug.

---

## 5. TikTok — two applications, and the small one is worth having on its own

TikTok is the one place where the *restricted* route is genuinely useful to us, so it is
worth applying in two stages rather than waiting for the big approval.

### 5.1 The two scopes

| Scope | What it allows | Approval |
|---|---|---|
| `video.upload` | Puts a video in the creator's **TikTok drafts**; they finish the caption and post it in the app | Light — **no full audit** |
| `video.publish` | Posts straight to the profile | **Full app audit** |

Without the audit, TikTok forces everything an app posts into private-only viewing —
whatever `privacy_level` you send. So `video.publish` is worth nothing until the audit
clears, while `video.upload` does real work immediately.

The `video.upload` route is usually described as defeating automation, because it "puts the
creator in the loop for every post". That is a criticism of schedulers. **It is exactly our
architecture** — the employee prepares, a person releases — so the restriction costs us
nothing and saves weeks. Take it first, and treat the audit as an upgrade.

Also request `video.list` for reading the account's own videos and their stats. That is what
lets the employee report on what worked.

### 5.2 Domain verification — the step that fails as a success

We post videos using TikTok's `PULL_FROM_URL` mode: we hand TikTok a URL and it fetches the
video. **TikTok only accepts URLs on a domain you have verified with them**, via a signature
file or DNS record on the host serving the video.

This matters more than it sounds. A video on an unverified domain is **rejected inside an
HTTP 200** — TikTok answers "success" at the transport level and puts the real verdict in
`error.code`. The platform now reads that verdict, so it fails properly, but the underlying
setup step is easy to skip and the symptom is not obvious.

Decide early where client videos will be hosted, and verify that domain.

### 5.3 The use-case text — copy this

> Outsourcetel is a marketing services agency. Our platform lets a business connect its own
> TikTok account so that an AI assistant can support the person who runs it.
>
> The assistant reads the account's own videos and their view, like and comment counts to
> report on performance, and prepares videos with captions for the account owner. It sends
> prepared videos to the creator's TikTok drafts, where the creator reviews and posts them
> from the TikTok app. The business supplies the video; the assistant writes the caption.
>
> We use `video.list` to read the account's own posts and `video.upload` to place prepared
> videos in the creator's drafts.

Note that this text describes only the drafts route. Apply for `video.publish` separately,
once there is a reason to post without the creator opening the app.

---

## 6. Search Console — no application at all

Worth restating because it is easy to lose among the other two: **Search Console needs no
developer token, no app review and no business verification.** It needs an OAuth consent
screen on a Google Cloud project and a sign-in from someone who already owns the property.

That makes it the only one here that can be live this week, and it happens to cover the SEO
half of what omnexasol asked for.

What you need:
- A Google Cloud project with the **Search Console API** enabled
- An OAuth client (type: Web application) — gives you the client ID and client secret
- A one-time sign-in by omnexasol's Search Console owner to produce the refresh token
- The property URL exactly as Search Console shows it, URL-encoded — `sc-domain:example.com`
  for a domain property, or the full `https://...` for a URL-prefix property

---

## 7. What to tell omnexasol

**All four channels are built** — Facebook, Instagram, LinkedIn and TikTok all read and all
publish. That is the headline and it is true.

Three things belong in the same conversation, because each of them will otherwise surface as
a disappointment in week two.

**On Instagram and TikTok, a person supplies every image and video.** Instagram has no
text-only post — none, ever — and TikTok is video. The employee writes captions, monitors
comments and drafts replies; it cannot invent a photograph of a technician. This is a
staffing question for them, not a technical footnote: someone at omnexasol owns the camera
roll.

**Nothing publishes without a person.** For the first period — and by design after it — the
employee reads everything, drafts everything, and a human clicks publish. That is not a
limitation we are apologising for; it is the product. But it should be what they expect.

**The channels arrive at different times, and not in the order they would guess.** Search
Console and TikTok drafts are days. Facebook and Instagram wait on Meta's review. LinkedIn
is the slowest at up to a month, despite being the least glamorous of the four. If they are
expecting all of it live at once, correct that now.

A reasonable thing to offer: start with SEO and TikTok drafts, add Facebook and Instagram
when Meta clears, and treat LinkedIn as month two.

---

## 8. Nothing here has touched a live account

Every adapter is verified against **fixture responses built from each vendor's documented
format**, not captured from a real account. That proves our field paths match the
documentation. It does not prove the vendor returns exactly that.

The Google Ads adapter is the cautionary tale: it looked correct, passed six checks, and
could not have read a single keyword — Google speaks snake_case in the query and camelCase
in the reply. A fixture caught it. Something else may be waiting that the fixtures agree
with and reality does not.

**The day the first account connects, run a live read on every operation before showing
anyone a dashboard.** Half an hour, and it is the difference between finding a problem
ourselves and finding it in front of a client.

**The first live WRITE deserves more care than the first read.** A read that is wrong
returns nothing and you notice. A write that is wrong posts something. So for each channel,
the first write should be:

1. On a **test Page, test IG account, test LinkedIn Page and test TikTok account** — not the
   client's, whatever the temptation to save an hour.
2. **One post**, watched end to end: approve it, then go and look at the account with your
   own eyes rather than trusting the receipt.
3. Then **delete it**, which also exercises the delete path.

Do that once per channel and the whole surface is proven. Skip it and the first thing a
client sees may be a post that went out wrong under their name.

---

## Sources

- [Google Ads API — Access Levels and Permissible Use](https://developers.google.com/google-ads/api/docs/api-policy/access-levels)
- [Google Ads API — Access levels and RMF](https://developers.google.com/google-ads/api/docs/productionize/access-levels)
- [Meta Graph API — Access Levels](https://developers.facebook.com/docs/graph-api/overview/access-levels)
- [Meta — Permissions Reference](https://developers.facebook.com/docs/permissions)
- [Meta — Instagram Content Publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing)
- [LinkedIn — Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api)
- [LinkedIn — Community Management App Review](https://learn.microsoft.com/en-us/linkedin/marketing/community-management-app-review)
- [TikTok — Content Posting API, getting started](https://developers.tiktok.com/doc/content-posting-api-get-started)
- [TikTok — Content Posting API, direct post reference](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post)
