// Defense-in-depth mirror of public.is_safe_external_url() (migration
// 099). The DB-level CHECK constraint on connectors.base_url is the
// primary guard; this catches the same class of address at the actual
// fetch chokepoint in case anything ever reaches a connector row that
// wasn't validated on insert (e.g. a direct service-role write).
export function isSafeExternalUrl(url: string): boolean {
  if (!url) return false;
  if (!/^https?:\/\/[^/]/i.test(url)) return false;

  let rest = url.replace(/^https?:\/\//i, '');
  const authorityPart = rest.split('/')[0];
  if (authorityPart.includes('@')) {
    rest = rest.replace(/^[^/@]*@/, '');
  }
  let host = rest.split('/')[0].split('?')[0].split('#')[0].toLowerCase();
  host = host.replace(/^\[(.*)\]$/, '$1');
  if (!/:.*:/.test(host)) {
    host = host.split(':')[0];
  }

  if (!host) return false;
  if (host === 'localhost' || host === 'localhost.localdomain') return false;
  if (/^127\./.test(host)) return false;
  if (host === '0.0.0.0' || /^0\./.test(host)) return false;
  if (/^10\./.test(host)) return false;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  if (host === '::1') return false;
  if (/^fe80/.test(host)) return false;
  if (/^f[cd][0-9a-f][0-9a-f]:/.test(host)) return false;

  return true;
}
