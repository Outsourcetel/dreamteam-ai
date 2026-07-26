// Defense-in-depth mirror of public.is_safe_external_url() (migration
// 099). The DB-level CHECK constraint on connectors.base_url is the
// primary guard; this catches the same class of address at the actual
// fetch chokepoint in case anything ever reaches a caller that wasn't
// validated on insert (e.g. a direct service-role write, or an
// operator-supplied MCP endpoint in specialist_sources.config, which
// has no DB-level CHECK behind it — see mcp-client/index.ts).
//
// LIMITATION (documented, not fixed here): this is a LEXICAL check. It
// cannot stop DNS-rebinding — a public hostname whose A record resolves
// to a private/link-local address at fetch time. Closing that requires
// resolving the host and validating the resolved IP before connecting,
// which the Deno fetch path here does not expose. The known-metadata
// hostname denylist below blocks the common static cases; the residual
// DNS-rebinding surface is accepted for now.
export function isSafeExternalUrl(url: string): boolean {
  if (!url) return false;
  if (!/^https?:\/\/[^/]/i.test(url)) return false;

  let rest = url.replace(/^https?:\/\//i, '');
  const authorityPart = rest.split('/')[0];
  if (authorityPart.includes('@')) {
    rest = rest.replace(/^[^/@]*@/, '');
  }
  let host = rest.split('/')[0].split('?')[0].split('#')[0].toLowerCase();

  // Host extraction — handle IPv6 literals correctly. `[::1]:9000` must
  // strip both the brackets AND the trailing :port; the old single regex
  // only matched a fully-bracketed string and let `[::1]:9000` through.
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    host = end > 0 ? host.slice(1, end) : host.slice(1);
  } else {
    host = host.split(':')[0]; // strip :port for IPv4 / hostname
  }
  if (!host) return false;

  // IPv4-mapped / -compatible IPv6 (e.g. ::ffff:169.254.169.254,
  // ::127.0.0.1) — pull out the trailing dotted-quad and re-check it as
  // IPv4 so the mapping can't be used to smuggle a private address past
  // the v4 rules below.
  const mapped = host.match(/:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) host = mapped[1];

  // ...but the dotted form is only what a HUMAN types. The WHATWG URL
  // serializer rewrites a mapped literal to HEX, and every caller here
  // validates a string that has been through `new URL(...)` at least once
  // (siteDiscovery resolves redirects with `new URL(loc, current).toString()`).
  // So the regex above never saw the form that actually arrives. Reproduced:
  //
  //   http://[::ffff:169.254.169.254]/  ->  http://[::ffff:a9fe:a9fe]/   ALLOWED
  //   http://[::ffff:127.0.0.1]/        ->  http://[::ffff:7f00:1]/      ALLOWED
  //   http://[::ffff:10.1.2.3]/         ->  http://[::ffff:a01:203]/     ALLOWED
  //   http://[::ffff:192.168.1.1]/      ->  http://[::ffff:c0a8:101]/    ALLOWED
  //
  // That is a straight path to AWS/GCP instance metadata. Decode the hex pair
  // back to dotted quad so the v4 rules below judge the real address.
  const mappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    host = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  // Any OTHER v4-mapped/compatible shape we cannot confidently decode is
  // refused rather than waved through — an address we cannot read is not an
  // address we can vouch for.
  if (host.startsWith('::ffff:') || /^::\d/.test(host)) return false;

  // Bare-integer and octal IPv4 (http://2130706433/ == 127.0.0.1). The URL
  // serializer normalises these too, so a caller that validates the RAW string
  // before normalising would otherwise let them through. Cheap to just handle.
  if (/^\d+$/.test(host)) {
    const n = Number(host);
    if (!Number.isSafeInteger(n) || n > 0xffffffff) return false;
    host = `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
  }
  if (/^0[0-7]*\./.test(host)) return false; // octal-looking first octet

  // ── Hostname denylist (non-IP internal names) ──
  // Cloud metadata + internal-only TLDs. NOTE: the generic ".internal"
  // suffix is deliberately NOT blocked — the self-management provider
  // uses a "dreamteam.internal" marker (mig 142) that must stay valid,
  // and the DB mirror (is_safe_external_url) has to accept it too. The
  // specific metadata hostnames are still blocked by exact name (plus
  // 169.254.169.254 by IP); a generic "*.internal" GCP-VM host is the
  // accepted residual, kept in sync with migration 154.
  if (host === 'localhost' || host === 'localhost.localdomain') return false;
  if (host === 'metadata' || host === 'metadata.google.internal') return false;
  if (/\.(local|localhost|localdomain)$/.test(host)) return false;

  // ── IPv4 private / loopback / link-local ──
  if (/^127\./.test(host)) return false;
  if (host === '0.0.0.0' || /^0\./.test(host)) return false;
  if (/^10\./.test(host)) return false;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  if (/^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\./.test(host)) return false; // CGNAT 100.64/10

  // ── IPv6 loopback / link-local / unique-local ──
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return false;
  if (host === '::') return false;
  if (/^fe80/.test(host)) return false;
  if (/^f[cd][0-9a-f][0-9a-f]:/.test(host)) return false; // fc00::/7 ULA

  return true;
}
