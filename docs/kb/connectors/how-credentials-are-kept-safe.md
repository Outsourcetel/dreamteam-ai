---
title: How your connector credentials are kept safe
category: Connectors
feature: Connectors — Security
audience: admin
difficulty: beginner
tags: [security, credentials, vault, encryption, disconnect, purge, secrets]
---

# How your connector credentials are kept safe

## What it is
When you connect a system, the API token, key, or password you enter is stored **server-side only, encrypted at rest**. It is never sent back to your browser, never shown again, and is **purged immediately** when you disconnect.

## Why it matters
Connector credentials are keys to your real systems of record. DreamTeam is built so that even someone using the app can't read a stored secret back out — the only thing the credential is ever used for is the DE making an audited call to your system on your behalf.

## How it works
- **Entered once, stored server-side.** Secret fields in the connect form are masked as you type. On save, they go straight to a service-role-only secret store through a dedicated function — never through an ordinary data write, and never in a way the browser can read.
- **Never shown again.** The connect form states it plainly under any secret field: *"Credentials are stored server-side only — never shown again, never readable from the browser, purged instantly on disconnect."* If a credential changes, you replace it by reconnecting — there's no "reveal" button, by design.
- **Encrypted for OAuth apps too.** For sign-in (OAuth) connectors, the platform app's client ID and secret are stored Vault-encrypted, and the access/refresh tokens obtained on your behalf are held server-side the same way.
- **Purged on disconnect.** Clicking **Disconnect** asks you to confirm — *"The stored credential is purged immediately"* — then deletes the secret and marks the connector disconnected. The connector's configuration (category, objects, actions) is kept so a later reconnect restores the same shape, but the secret itself is gone.
- **Every disconnect is audited.** Disconnecting writes a config-change entry to the Audit Trail recording which connector was disconnected and that its credential was purged.

## Step by step — remove a credential
1. Open **Connectors**.
2. Find the connector card and click **Disconnect**.
3. Confirm the prompt. The credential is purged, the card shows **Disconnected**, and an audit entry is recorded.
4. To reconnect later, use **+ Connect a system** again and re-enter fresh credentials.

## Tips & best practices
- Prefer **least-privilege** credentials — read-only or narrowly scoped keys — so that even the stored secret can do little beyond what the DE needs. The per-provider credential help text points to the safer option (restricted keys, read-only scopes, dedicated integration users, `Sites.Selected` instead of `Sites.Read.All`, and so on).
- For document systems (SharePoint, Google Drive, Notion, Box, Dropbox), remember that the real security boundary is **what you share with the app** at the source — share only the folders or pages the DE should ever see.
- Rotate a credential by disconnecting and reconnecting with the new value; there's no need to keep old secrets around.

## Troubleshooting
- **"No credentials stored for this connector — reconnect to add them."** The secret is missing (often after a disconnect). Reconnect to add a fresh credential.
- **"Stored credentials are malformed — reconnect to replace them."** Replace the credential by reconnecting.
- **I can't see the token I entered.** That's intended — secrets are never readable back. Reconnect to set a new one.

## Related articles
- connecting-your-first-system
- connecting-oauth-apps
- controlling-what-gets-ingested
- fetch-vs-ingest-modes
