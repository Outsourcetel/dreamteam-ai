---
title: Connecting OAuth (sign-in) apps
category: Connectors
feature: Connectors — OAuth connect
audience: admin
difficulty: intermediate
tags: [oauth, sign-in, quickbooks, xero, clio, gusto, procore, jobber, dropbox, platform admin]
---

# Connecting OAuth (sign-in) apps

## What it is
Some systems connect by **signing in** rather than pasting an API key. Instead of copying a token, you click **Connect with…**, get sent to the provider to approve access, and are returned to DreamTeam already connected. Today these sign-in connectors are **QuickBooks Online, Xero, Clio, Gusto, Procore, Jobber,** and **Dropbox**.

## Why it matters
Sign-in (OAuth) is the way these providers expect apps to connect — there's no long-lived key to paste, copy, or leak. You approve access in the provider's own screen, and DreamTeam receives scoped, revocable tokens that it stores server-side and encrypted.

## The honest prerequisite: a platform admin registers the app first
OAuth requires the provider to know DreamTeam as a registered developer app. That registration is a **one-time platform-admin step per provider** — an ordinary tenant can't run the sign-in until it's done. The connect screen is explicit about this: the **Connect with…** button stays disabled with the note *"A platform admin must add the app credentials first."*

**One-time platform setup (platform admin only):**
1. Register the developer app in the provider's console (for example, Intuit's developer portal for QuickBooks, Xero's developer portal, and so on).
2. Add DreamTeam's exact **redirect URL** in the app's settings — the connect screen displays the precise URL to copy under *"add this exact redirect URL in its settings."*
3. Back in DreamTeam, on the provider's connect screen, enter the app's **Client ID** and **Client secret** and click **Save app credentials.** These are stored Vault-encrypted; only platform admins can set them.

Once saved, anyone in the workspace can connect their own account by signing in.

## Step by step — connect by signing in
1. Open **Connectors → + Connect a system.**
2. Pick the category and choose the provider (e.g. QuickBooks Online). Because it's an OAuth provider, the wizard shows the sign-in flow instead of credential fields: *"Connect by signing in — no keys to paste. You'll be sent to [provider] to approve access, then returned here."*
3. If the app has already been registered, click **Connect with [provider].** You'll be redirected to the provider, where you approve access, then returned to DreamTeam with the connector live.
4. If the app hasn't been registered yet, you'll see the **One-time platform setup** panel — a platform admin needs to add the app's Client ID and secret (and register the redirect URL) first.

## Options & settings
- **Update app credentials** — after setup, a platform admin can click **Update app credentials** to rotate the Client ID/secret.
- **Display name** — optional label for the resulting connector.
- **Provider specifics handled for you** — QuickBooks returns a company (realm) id and Xero resolves your organisation automatically during the sign-in exchange; you don't manage these by hand.

## Tips & best practices
- Do the platform registration once, up front, for the providers your customers use most — it unblocks every tenant afterward.
- Approve only the access the provider requests; the scopes are read-oriented for accounting and file data.
- To revoke, **Disconnect** in DreamTeam (purges the stored tokens) and, if you want, also remove DreamTeam's authorization in the provider's own connected-apps settings.

## Troubleshooting
- **Connect button is greyed out** — the app hasn't been registered. A platform admin must add the Client ID/secret first.
- **"Only platform admins can set this up."** — saving app credentials is restricted to platform admins by design.
- **Redirect/callback error at the provider** — the redirect URL in the provider's app settings must exactly match the URL shown on DreamTeam's setup panel. Copy it precisely, including scheme and path.
- **"Could not start sign-in."** — retry; if it persists, confirm the app credentials were saved and the provider app is active.

## Related articles
- connecting-your-first-system
- how-credentials-are-kept-safe
- supported-systems
