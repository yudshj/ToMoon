// Unit tests for src/clash/maskUrl.ts. Not part of the rollup build.
// Run: node scripts/test-mask-url.mjs   (Node >= 22.18; strips TS types natively)
import assert from "node:assert/strict";
import { maskSubscriptionUrl as m } from "../src/clash/maskUrl.ts";

const cases = [
  // user + password: keep user, hide password
  ["https://alice:SECRET@sub.example.ts.net/clash/hyd.yaml",
   "https://alice:***@sub.example.ts.net/clash/hyd.yaml"],
  // bare token as userinfo
  ["https://abcdef123456@host.example/sub", "https://***@host.example/sub"],
  // empty user, password only
  ["https://:pw@host/x", "https://***@host/x"],
  // unencoded '@' inside the password must not leak its tail
  ["https://u:p@ss@host/x", "https://u:***@host/x"],
  // '@' in the path is not userinfo
  ["https://host/a@b/c.yaml", "https://host/a@b/c.yaml"],
  // no scheme
  ["alice:SECRET@host/c.yaml", "alice:***@host/c.yaml"],
  // credential-like query params
  ["https://host/api/v1/client/subscribe?token=abc123&flag=clash",
   "https://host/api/v1/client/subscribe?token=***&flag=clash"],
  ["https://u:p@host/s?key=k#frag", "https://u:***@host/s?key=***#frag"],
  // nothing to hide
  ["https://host/clash/hyd.yaml", "https://host/clash/hyd.yaml"],
  ["https://host/x?target=clash", "https://host/x?target=clash"],
  ["", ""],
  [undefined, ""],
  [null, ""],
];

let failed = 0;
for (const [input, want] of cases) {
  try {
    assert.equal(m(input), want);
  } catch (e) {
    failed++;
    console.error(`FAIL ${JSON.stringify(input)}\n  got  ${JSON.stringify(m(input))}\n  want ${JSON.stringify(want)}`);
  }
}
// the secret must never survive
assert.ok(!m("https://alice:SECRET@h/x").includes("SECRET"));
console.log(failed ? `${failed}/${cases.length} failed` : `all ${cases.length} cases passed`);
process.exit(failed ? 1 : 0);
