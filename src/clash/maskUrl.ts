// Display-only redaction of subscription URLs. Never use the result to fetch
// anything: downloads and updates must keep using the original URL.
//
// Kept free of imports so scripts/test-mask-url.mjs can load it with plain
// `node` (Node >= 22.18 strips the type annotations).

const MASK = "***";

/** Query parameters whose values are treated as credentials. */
const SECRET_PARAM = /token|key|secret|pass|pwd|auth|sig|uuid/i;

/**
 * Hide the credentials in a subscription URL for display:
 *
 * - `https://user:pass@host/p`  -> `https://user:***@host/p` (user kept)
 * - `https://token@host/p`      -> `https://***@host/p` (bare userinfo = token)
 * - `https://:pass@host/p`      -> `https://***@host/p`
 * - `...?token=abc&x=1`         -> `...?token=***&x=1` (credential-like params)
 *
 * Anything without credentials is returned unchanged. Non-string input yields "".
 */
export function maskSubscriptionUrl(url: unknown): string {
  if (typeof url !== "string") return "";
  let s = url;

  // Authority = text after "scheme://" (or from the start) up to / ? or #.
  const schemeMatch = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(s);
  const start = schemeMatch ? schemeMatch[0].length : 0;
  const rest = s.slice(start);
  const end = rest.search(/[/?#]/);
  const authority = end === -1 ? rest : rest.slice(0, end);
  const at = authority.lastIndexOf("@"); // an unencoded '@' in the password stays hidden
  if (at !== -1) {
    const userinfo = authority.slice(0, at);
    const colon = userinfo.indexOf(":");
    const user = colon === -1 ? "" : userinfo.slice(0, colon);
    const shown = user ? `${user}:${MASK}` : MASK;
    s = s.slice(0, start) + shown + rest.slice(at);
  }

  // Credential-like query parameter values.
  const q = s.indexOf("?");
  if (q !== -1) {
    const hash = s.indexOf("#", q);
    const query = s.slice(q + 1, hash === -1 ? undefined : hash);
    const masked = query
      .split("&")
      .map((kv) => {
        const eq = kv.indexOf("=");
        if (eq === -1 || eq === kv.length - 1) return kv;
        return SECRET_PARAM.test(kv.slice(0, eq)) ? `${kv.slice(0, eq)}=${MASK}` : kv;
      })
      .join("&");
    s = s.slice(0, q + 1) + masked + (hash === -1 ? "" : s.slice(hash));
  }
  return s;
}
