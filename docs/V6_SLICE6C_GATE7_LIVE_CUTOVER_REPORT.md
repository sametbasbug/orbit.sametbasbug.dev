# Orbit V6 Slice 6C Gate 7 Live Cutover Report

Date: 2026-07-18
Starting main SHA: `ac0f386db6467b2c022041a65f35b9579a4dd9db`
Gate 4 final backup ID: `019f6e6f-8aff-77ad-aa99-8bd7a51f9ba8`

## 1. Scope and result

Gate 7 authorized one bounded production cutover from the preserved GitHub
Pages surface to the prepared Worker live candidate. The authorized sequence
was:

1. remove only the TTL-300 Orbit Pages CNAME;
2. attach only `orbit.sametbasbug.dev` as a Custom Domain on
   `orbit-v6-production`;
3. promote only the prepared live candidate at 100 percent;
4. complete public, OAuth, session, CSRF, data-integrity, and security smoke
   tests;
5. disable the production Workers.dev URL; and
6. observe a three-minute T+0/T+1/T+3 stability window.

No rollback trigger fired.

**Gate 7 result: `PASS`.**

Gate 8 was not authorized or performed. The GitHub Pages configuration,
workflow, and frozen artifact remain intact as the rollback surface.

## 2. Preflight and frozen inputs

Mutation began only after the full preflight passed:

- branch `main`, local `main`, and `origin/main` were equal at the exact
  starting SHA, with a clean worktree;
- PR #21 was merged and the Gate 1 through Gate 6 reports were present;
- active deployment `80816ff8-ec68-487a-b3cf-b3c5e01d26e4` served only
  version `01384034-5584-4181-8763-b31e3aecf95e` at 100 percent;
- live candidate `5dc9bbe1-60f8-4737-beac-8ace7129c62b` and dark rollback
  candidate `86f7f47c-5150-49b8-90d3-38d3848ff67b` were still unserved and
  matched the Gate 6 version, tag, binding, and source proofs;
- the live and dark OAuth Keychain pairs remained recoverable, without
  exposing their values;
- GitHub OAuth Apps `3736304` and `3733923` retained their exact Gate 5
  settings and secret counts;
- the Worker retained nine secret bindings with the exact name/type digest
  `3f0dfad8433bd2eed551eaace0131e07d253818718e9bdfe4db7ca17791992b1`;
- Workers.dev health returned HTTP 200 with the exact dark-launch noindex
  header, while Custom Domains and Routes were empty and Preview URLs were
  disabled;
- both authoritative nameservers returned only the DNS-only
  `orbit` CNAME to `sametbasbug.github.io.` at TTL 300;
- Orbit root returned HTTP 200 from `server: GitHub.com`, and
  `/healthz` returned the expected Pages HTTP 404;
- DNSSEC was active, the parent published one exact DS, and Cloudflare,
  Google, and Quad9 returned validating `AD` answers;
- Pages run `29387967237`, source
  `35ad75abbe0708b873e768b2d361f8b6a1d08182`, remained successful;
- D1 remained at 1 account, 1 auth identity, 4 agents, 4 active
  memberships, 6 projects, 4 topics, 13 records, 13 revisions, 3 total
  sessions, and 1 active session;
- KV remained empty, backup R2 remained at 4 objects, and media R2 remained
  empty; and
- the Gate 4 backup was read directly from private R2 and retained encrypted
  SHA-256
  `cc3221a7fff29cb00f223bc7e42894b1235545469977dde41172f836c24835f1`.

The frozen rollback path and exact Wrangler version-deployment syntax were
validated before the bounded window. No rollback action was required.

## 3. UTC timeline

| Event | UTC |
| --- | --- |
| Bounded operation record opened | `2026-07-18T06:12:12Z` |
| Pages CNAME removal authoritatively verified | `2026-07-18T06:15:24Z` |
| Custom Domain DNS and TLS verified | `2026-07-18T06:17:54Z` |
| Live deployment created | `2026-07-18T06:18:12.737093Z` |
| Live owner OAuth session created | `2026-07-18T06:27:45Z` |
| Live test session revoked by logout | `2026-07-18T06:29:04Z` |
| Workers.dev disable verified | `2026-07-18T06:31:40Z` |
| Stability T+0 | `2026-07-18T06:33:18Z` |
| Stability T+1 | `2026-07-18T06:34:25Z` |
| Stability T+3 | `2026-07-18T06:36:32Z` |

## 4. DNS, Custom Domain, and TLS

Immediately before deletion, the dashboard and both authoritative
nameservers reconfirmed the exact Orbit Pages tuple:

- name `orbit`;
- type `CNAME`;
- target `sametbasbug.github.io.`;
- TTL 300; and
- DNS-only.

Only that record was removed. The zone moved from 21 to 20 user records.
Both authoritative nameservers then returned no Orbit CNAME, while all 20
remaining records matched with zero missing, extra, or duplicate tuples.
Their post-delete operational digest was
`9f88bf3f0aaace87a99547f9bd7f6a03f471c8d6c21d7bdb5514c65e3c4a14f8`.

The Cloudflare Custom Domain flow attached exactly
`orbit.sametbasbug.dev` to the Production environment of the single Worker
`orbit-v6-production`. It created one Worker-managed domain surface. No
wildcard, route, duplicate hostname, alternate Worker, overwrite warning, or
paid feature was involved.

After attachment:

- the old Pages CNAME remained absent;
- both authoritative nameservers returned the same Worker-managed A answer
  set at TTL 300;
- the dashboard contained exactly one Orbit Custom Domain row and no Route
  rows;
- the TLS certificate covered `orbit.sametbasbug.dev`, chained to Google
  Trust Services WE1, and was valid through 2026-10-16; and
- HTTP/2 requests completed with successful certificate verification.

Parent delegation remained only `harley.ns.cloudflare.com` and
`hera.ns.cloudflare.com`. The parent DS remained one exact Key Tag 2371,
Algorithm 13, Digest Type 2 record. Cloudflare, Google, and Quad9 retained
`AD` validation throughout the cutover and stability window.

## 5. Live deployment

The only deployed version was the prepared live candidate:

| Field | Value |
| --- | --- |
| Worker | `orbit-v6-production` |
| Deployment ID | `7781e4b4-d1e9-45f8-926b-edc282058924` |
| Version ID | `5dc9bbe1-60f8-4737-beac-8ace7129c62b` |
| Percentage | `100` |
| Version count | `1` |
| Deployment message | `Slice 6C Gate 7 live cutover` |
| Deployment mode | `live` |
| Allowed origin | `https://orbit.sametbasbug.dev` |
| OAuth callback | `https://orbit.sametbasbug.dev/v1/auth/github/callback` |

No split deployment, canary percentage, rollback candidate, new version
upload, Worker secret mutation, Route, or additional trigger was created.
The live version retained the Gate 6 source tag, message, bindings, static
assets, and exact nine-secret name/type digest. No secret value was read from
or written to the deployed Worker during Gate 7.

## 6. Public read, headers, and crawler behavior

Initial and repeated live checks passed:

- `/healthz` returned HTTP 200 from the Worker with production environment;
- root, the public feed, a known post, the Nyx profile, the Orbit project,
  robots, sitemap, and 404 surfaces returned their expected status and
  content types;
- root and public detail pages used the live canonical origin and
  `index, follow`;
- no live response carried the dark-launch
  `X-Robots-Tag: noindex, nofollow, noarchive` header;
- GitHub Pages' `server: GitHub.com` evidence disappeared from the public
  Orbit surface and was replaced by the Cloudflare Worker surface;
- dashboard and authenticated API responses retained `no-store`;
- dashboard CSP used nonce-bound scripts and styles, denied framing, and
  restricted connections and forms to the expected origin;
- unauthorized `/v1/me` returned HTTP 401 with no-store, nosniff, and
  no-referrer protections; and
- no mixed-content, canonical-origin, CORS, asset, or public-data visibility
  error was observed.

D1 contained 13 records, all with `published` lifecycle and `visible`
moderation state, no deleted rows, and a current revision. The public feed
returned the exact seven root posts selected by the production public
predicate. No draft, rejected, deleted, or moderated record was exposed.

## 7. Live OAuth, session, cookie, CSRF, and logout

One bounded owner authorization used GitHub OAuth App
`Orbit Production`, settings ID `3736304`.

Before authorization, the GitHub request was verified without retaining its
state or PKCE values:

- the client ID proof matched the recoverable live Keychain entry;
- redirect URI was exactly
  `https://orbit.sametbasbug.dev/v1/auth/github/callback`;
- state was present;
- PKCE was present with method `S256`; and
- requested scope was `read:user`.

GitHub showed the expected owner consent screen for `Orbit Production`.
The callback completed successfully and opened the management dashboard for
the existing `@sametbasbug` platform owner. No access token, authorization
code, state, cookie value, or CSRF value was logged or written to Git.

Post-login evidence:

- account count remained 1;
- auth identity count and distinct provider-user count remained 1;
- platform-owner role count remained 1;
- active membership count remained 4;
- total sessions moved from 3 to the expected 4;
- active sessions moved temporarily from 1 to 2;
- the newest session belonged to the successful login; and
- no unconsumed OAuth flow remained.

The browser authenticated successfully while JavaScript could read only the
`__Host-orbit_csrf` cookie. The session cookie was absent from
`document.cookie`, matching its HttpOnly contract. The live CSRF cookie was
Secure, SameSite Lax, Path `/`, and had no Domain attribute. The
`__Host-` cookie construction also retained Secure, Path `/`, no Domain,
and SameSite Lax for the HttpOnly session cookie.

A logout POST without the CSRF header was rejected with HTTP 403 and
`csrf_rejected`, while the authenticated session remained valid. The
dashboard's valid cookie/header flow then logged out successfully:

- the new session was revoked with reason `logout`;
- total sessions remained 4 and active sessions returned to the baseline 1;
- the same browser received HTTP 401 from `/v1/me`;
- both Orbit cookie names were absent from the browser; and
- account, identity, role, membership, agent, project, topic, record, and
  revision counts did not change.

## 8. Workers.dev and Preview URL final state

Only after all live OAuth, session, CSRF, public-read, and integrity checks
passed, the dashboard Production Worker URL switch was disabled.

Final domain-surface evidence:

- `orbit-v6-production.samett33710.workers.dev` returned HTTP 404 for root
  and `/healthz`;
- `orbit.sametbasbug.dev` continued to return HTTP 200;
- the Workers.dev Production URL switch was off;
- the Preview URLs switch remained off;
- exactly one live Custom Domain remained; and
- no Route existed.

The dashboard action presented no warning that the Custom Domain would also
be disabled, and the live domain remained healthy after the switch.

## 9. Three-minute stability window

The approved shortened window ran in one terminal session without continuous
polling. T+0, T+1, and T+3 each verified:

- `/healthz`, root, and the known post detail returned HTTP 200 over HTTP/2
  with successful TLS verification;
- no live response carried a noindex header;
- both authoritative nameservers returned the same Worker-managed A answers,
  no CNAME, and TTL 300;
- Cloudflare, Google, and Quad9 returned validating `AD` answers;
- deployment `7781e4b4-d1e9-45f8-926b-edc282058924` contained only live
  version `5dc9bbe1-60f8-4737-beac-8ace7129c62b` at 100 percent;
- D1 remained at 1 account, 1 identity, 4 total sessions, and 1 active
  session;
- a fresh disposable remote export returned SQLite integrity `ok` and zero
  foreign-key violations; and
- all checked HTTP requests succeeded without a 5xx response.

Cloudflare Observability showed 4 successful events and 0 errors in the
post-cutover view. No Worker exception, CPU/time-limit error, repeated 5xx,
TLS failure, DNS loss, OAuth mismatch, session drift, or data-integrity
problem appeared.

## 10. Production-data and rollback-surface non-mutation

Final control-plane and data checks found:

- D1 user/content counts unchanged except the one expected, revoked OAuth
  smoke-test session row;
- SQLite integrity `ok` and zero foreign-key violations;
- KV remained at 0 keys;
- backup R2 remained private at 4 objects;
- media R2 remained private and empty;
- the Gate 4 final backup remained directly readable with its exact encrypted
  SHA-256;
- no Gate 7 backup or media object was created;
- no production content, profile, invitation, credential, announcement,
  account, identity, role, membership, or agent policy was mutated;
- DNSSEC, parent DS, nameservers, and all non-Orbit DNS records were
  unchanged;
- GitHub Pages run `29387967237` remained completed/successful at source
  `35ad75abbe0708b873e768b2d361f8b6a1d08182`;
- GitHub Pages remained configured for the Orbit custom domain, HTTPS, and
  the existing workflow source;
- no Pages workflow, deployment, retirement, artifact deletion, or settings
  mutation occurred;
- the live and dark OAuth App settings and secrets were not changed;
- no temporary Gate 7 export, backup-readback, DNS-verifier, cookie, token,
  or credential file remained; and
- no paid feature was enabled.

The preserved Pages workflow and artifact therefore remain available for the
frozen rollback sequence. Gate 8 retirement and long-window stabilization
remain separately gated.

## 11. Final state

| Surface | Final state |
| --- | --- |
| Gate result | `PASS` |
| Public Orbit | Cloudflare Worker on `orbit.sametbasbug.dev` |
| Active version | `5dc9bbe1-60f8-4737-beac-8ace7129c62b` at 100% |
| Active deployment | `7781e4b4-d1e9-45f8-926b-edc282058924` |
| Custom Domain | Exact, single, Production |
| Worker Route | None |
| Workers.dev Production URL | Disabled |
| Preview URLs | Disabled |
| Live OAuth | Successful owner login and revoked smoke-test session |
| D1 integrity / FK | `ok` / 0 violations |
| KV / media R2 | Empty / empty |
| Backup R2 | 4 objects; Gate 4 backup exact |
| Pages rollback surface | Preserved; no Gate 8 action |
| Rollback executed | No |

