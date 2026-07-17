// Constant-time string comparison for secrets (dispatch secret,
// service-role key). A plain `a === b` short-circuits on the first
// differing byte, leaking a timing signal about how much of the secret
// was guessed correctly. Over the public internet network jitter swamps
// that signal, so this is defense-in-depth, not a live hole — but it's
// cheap and the compare is copy-pasted across ~10 functions.
//
// Compares the SHA-256 digests (fixed 32-byte length) so the timing is
// independent of input length as well as content.
export async function secureEqual(a: string, b: string): Promise<boolean> {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
