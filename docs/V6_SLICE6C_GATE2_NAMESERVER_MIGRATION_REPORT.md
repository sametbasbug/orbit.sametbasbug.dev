# Orbit V6 — Slice 6C Gate 2 Nameserver Migration Report

Status: **PASS — authoritative delegation moved to Cloudflare; Orbit traffic unchanged**

Report date: `2026-07-17`

Starting main SHA: `c158673894f95498abeeab0eaf0bb8e8344aa92f`

Gate 1 canonical tuple SHA-256:
`920d2c1cd79641698550e9c57758fc1601b2a4805cfe827a7a0bf75e46487083`

This report records the secret-free operational evidence for Slice 6C Gate 2.
It contains no verification token, sensitive TXT value, credential, cookie or
panel-session material. Gate 2 authorized only the registrar delegation
change. It did not authorize or perform DNS-record changes, DNSSEC, Orbit
traffic cutover, Worker/OAuth/Pages mutation, production-data work or a paid
Cloudflare feature.

## 1. Pre-mutation gate

The canonical repository was clean and `main == origin/main` at the expected
starting SHA. The Gate 1 report was present on `main`.

The following controls passed immediately before changing delegation:

- the Cloudflare zone was `pending` on the Free plan;
- exactly 21 user records were present: 4 `A`, 8 `CNAME`, 6 `MX` and 3 `TXT`;
- missing, extra, duplicate and proxied record counts were zero;
- every user-record TTL was 300 seconds;
- both assigned Cloudflare authoritative nameservers returned the exact Gate 1
  digest with 21 records and no missing/extra/duplicate tuple;
- all four Name.com authoritative nameservers returned the same exact digest;
- public DS was empty and Cloudflare DNSSEC was disabled;
- `orbit.sametbasbug.dev` was DNS-only and targeted the existing GitHub Pages
  hostname on both authoritative providers;
- the Pages rollback artifact, production Worker serving version and exact
  Workers.dev OAuth callback were unchanged.

No preflight drift was found.

## 2. Registrar delegation change

The previous parent delegation was:

- `ns1kpv.name.com`
- `ns2dqx.name.com`
- `ns3jnr.name.com`
- `ns4hmp.name.com`

The final registrar delegation contains only:

- `harley.ns.cloudflare.com`
- `hera.ns.cloudflare.com`

The two replacements and removal of the remaining Name.com entries were
staged in the Name.com UI and committed as one controlled save operation at
`2026-07-17T03:43:54Z`. The panel required no password, 2FA or additional
security approval.

Name.com displayed a generic transient error together with its success notice
after submission. No blind retry was made. A full page reload retained only
the Cloudflare pair, and the `.dev` parent registry independently confirmed
the same pair, proving the operation committed successfully.

No old/new nameserver mixture remained in the registrar panel or parent
delegation.

## 3. Activation and parent evidence

| Event | UTC time |
| --- | --- |
| Registrar save submitted | `2026-07-17T03:43:54Z` |
| Cloudflare zone activated | `2026-07-17T03:44:32.045250Z` |
| Cloudflare-only parent delegation observed | `2026-07-17T03:44:59Z` |

The `.dev` authoritative parent returned only the two assigned Cloudflare
nameservers. Its DS answer remained empty. Cloudflare remained on the Free
plan, DNSSEC stayed disabled and no proxy state was enabled.

## 4. Three consecutive stability checks

Three complete checks were taken at least five minutes apart:

| Check | UTC time | Parent | Zone | Authoritative parity | Recursive parity | Result |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `2026-07-17T03:45:28Z` | Cloudflare pair only | active | 21/21 exact | 21/21 exact | PASS |
| 2 | `2026-07-17T03:50:48Z` | Cloudflare pair only | active | 21/21 exact | 21/21 exact | PASS |
| 3 | `2026-07-17T03:56:05Z` | Cloudflare pair only | active | 21/21 exact | 21/21 exact | PASS |

At every check:

- both Cloudflare authoritative nameservers answered authoritatively;
- canonical authoritative digest was exactly
  `920d2c1cd79641698550e9c57758fc1601b2a4805cfe827a7a0bf75e46487083`;
- missing, extra and duplicate counts were zero;
- Cloudflare, Google and Quad9 recursive resolvers each returned all 21 source
  records with zero missing/extra/duplicate tuples;
- recursive content digest, excluding naturally decreasing cache TTL, was
  `54a66d86627ceca6e65ac69df712ac58fa4dc806d3855e67548156e249665ff3`;
- all six MX records and their priority ordering were present;
- `orbit` continued to resolve to the GitHub Pages target;
- public DS remained empty and Cloudflare DNSSEC remained disabled.

The preserved Name.com authoritative service was also rechecked after the
delegation change and continued to return the exact Gate 1 digest. It remains
a valid rollback source while its zone is retained.

## 5. DNS, web and mail smoke evidence

Exact authoritative and recursive comparison covered the apex, `www`,
`orbit`, `auth`, `equinox`, `haber`, `play`, `selene`, `status`, all other
exported owners, all six MX records, SPF and exported verification TXT
records. Sensitive TXT contents were compared exactly in restricted
operational evidence and are not repeated here.

The source export contained no DMARC or DKIM-selector record. Cloudflare still
has exactly the source 21 records and no extra record was introduced. Direct
checks for `_dmarc` and the previously tested common DKIM selector names also
returned no record.

HTTPS/TLS verification succeeded for the apex and every exported web
subdomain. Observed application-root results remained consistent with the
existing services: apex, Orbit, Equinox, Haber, Play and Status returned 200;
`www` returned its expected redirect; Auth and Selene returned their existing
404 root behavior without DNS or TLS failure.

For Orbit specifically:

- `/` returned HTTP 200;
- response header remained `server: GitHub.com`;
- `/healthz` remained HTTP 404 from GitHub Pages;
- no TLS validation error was observed.

MX, priority, SPF and verification TXT parity passed through both authoritative
and three independent recursive paths. No authenticated `@sametbasbug.dev`
mailbox session was available in the approved execution context, so no real
message was sent and no mailbox state was changed. This did not block the DNS
migration because the complete mail-DNS tuples matched exactly before and
after delegation.

## 6. Production and rollback non-mutation evidence

Post-migration checks confirmed:

- latest GitHub Pages deployment remained workflow run `29387967237`, source
  SHA `35ad75abbe0708b873e768b2d361f8b6a1d08182`;
- production Worker serving version remained
  `01384034-5584-4181-8763-b31e3aecf95e` (version 4);
- the production Worker remained Workers.dev-only with no custom domain;
- dark-launch `/healthz` still returned HTTP 200 with
  `X-Robots-Tag: noindex, nofollow, noarchive`;
- the production OAuth App retained the exact Workers.dev homepage and
  callback;
- production D1 remained `199fe088-2f56-48c4-bc81-50b8c5e4b471`;
- production cache KV remained `5c1574a9562448cf863aa84fad10877f`;
- the private production backup and media R2 buckets remained present;
- no Worker deploy, OAuth change, Pages deployment, D1/KV/R2/backup mutation,
  DNS-record edit, proxy enablement or paid-plan enablement was performed.

The existing GitHub Pages artifact and Name.com zone were preserved as the
rollback surfaces required by the Slice 6C plan.

## 7. Rollback and gate result

No rollback trigger occurred:

- authoritative and recursive parity never drifted;
- no critical record was missing or incorrect;
- the Cloudflare zone activated promptly;
- no widespread SERVFAIL or NXDOMAIN was observed;
- DS/DNSSEC state remained expected;
- web, TLS and mail-DNS checks passed;
- no mixed registrar delegation remained.

**Rollback applied: no.**

**Slice 6C Gate 2 result: PASS.**

The authoritative migration is complete, while Orbit itself remains on the
unchanged GitHub Pages artifact. Gate 3 DNSSEC still requires a separate
explicit approval. OAuth live-domain migration, Worker live mode, custom
domain attachment and Orbit traffic cutover also remain separately gated and
were not authorized by Gate 2.
