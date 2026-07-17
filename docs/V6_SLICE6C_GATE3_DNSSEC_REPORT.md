# Orbit V6 Slice 6C Gate 3 DNSSEC Report

Date: 2026-07-17  
Starting main SHA: `ab5aca7990d71cff2fea97af3a35955ed65de9a2`  
Gate 2 canonical DNS tuple SHA-256: `920d2c1cd79641698550e9c57758fc1601b2a4805cfe827a7a0bf75e46487083`

## 1. Scope and result

Gate 3 authorized exactly two control-plane mutations:

1. enable Cloudflare zone signing for `sametbasbug.dev`; and
2. add the single, exact Cloudflare-generated DS record at the Name.com
   registrar.

No nameserver, ordinary DNS record, proxy, TTL, Orbit traffic, Worker, OAuth,
GitHub Pages or production-data change was authorized or performed.

**Gate 3 result: `PASS`.**

Cloudflare DNSSEC is `active`, the `.dev` parent publishes the exact single DS,
the DS-to-DNSKEY chain validates through three independent recursive
resolvers, and all three stability checks passed. No rollback was applied.

## 2. Preflight

Preflight completed before either mutation:

- local `main` and `origin/main` were equal at the expected starting SHA;
- the worktree was clean;
- the Gate 1 and Gate 2 reports were present on `main`;
- Cloudflare zone status was `active` on the Free plan;
- parent delegation contained only `harley.ns.cloudflare.com` and
  `hera.ns.cloudflare.com`;
- public DS was empty and Cloudflare DNSSEC status was `disabled`;
- both Cloudflare authoritative nameservers returned all 21 user records and
  the exact Gate 2 canonical digest;
- missing, extra, duplicate and proxied record counts were zero;
- every user-record TTL was 300 seconds;
- apex, exported subdomains, six MX records, SPF and verification TXT parity
  passed;
- `orbit.sametbasbug.dev` remained a DNS-only CNAME to the existing GitHub
  Pages target;
- Orbit `/` returned HTTP 200 from `server: GitHub.com`, while `/healthz`
  returned the expected GitHub Pages HTTP 404;
- production Worker, OAuth, Pages, D1, KV and R2 rollback surfaces matched the
  Gate 2 evidence.

No preflight drift was found.

## 3. Signing and registrar DS chronology

| Event | UTC time |
| --- | --- |
| Cloudflare signing enabled | `2026-07-17T04:15:38Z` |
| Name.com save confirmed successful | by `2026-07-17T04:20:05Z` |
| Parent DS first confirmed on all `.dev` authorities | `2026-07-17T04:22:37Z` |
| Cloudflare DNSSEC first jointly confirmed `active` | `2026-07-17T04:22:37Z` |

After Cloudflare signing was enabled and before the registrar DS was added:

- Cloudflare reported `pending`;
- the parent DS remained empty;
- both authoritative nameservers published two DNSKEY records and a DNSKEY
  RRSIG;
- signed apex A, Orbit CNAME, MX and TXT answers contained their expected
  RRSIG records;
- the normal 21-record authoritative digest stayed exact; and
- all three public resolvers continued to answer without an unexpected
  NXDOMAIN.

Name.com showed no pre-existing registry DS. Its form explicitly supported
Algorithm 13 and SHA-256. The Cloudflare values were copied exactly, one DS was
saved, and the registrar reported successful completion. The registrar page
then showed exactly one registry DS with the expected safe metadata and digest
hash.

## 4. DS and signing evidence

| Field | Evidence |
| --- | --- |
| Key Tag | `2371` |
| Algorithm | `13` — ECDSA P-256 with SHA-256 |
| Digest Type | `2` — SHA-256 |
| DS digest SHA-256 proof | `6d2799936dba95fcd8423f1e4ccff2dec6daa5dacbc13ef25eefcc59ee2e8bc6` |
| Parent DS TTL | `1800` seconds |
| Registrar DS count | `1` |
| Cloudflare DNSSEC status | `active` |

The full DS digest is intentionally omitted from this report. The SHA-256 proof
above is the hash of the exact uppercase digest string supplied by Cloudflare.
All five `.dev` authoritative servers returned the same Key Tag, Algorithm,
Digest Type and digest proof.

Both Cloudflare authoritative nameservers returned DNSKEY and RRSIG material.
The parent DS matched the Cloudflare DS exactly. Cloudflare `1.1.1.1`, Google
`8.8.8.8` and Quad9 `9.9.9.9` returned the `AD` flag for apex A, exported web
hosts, MX, TXT, DNSKEY and DS queries during each counted stability check. This
provides independent validating-resolver evidence for the DS-to-DNSKEY chain.

The local macOS `delv` binary reported that it had no crypto support or loaded
trust anchors, so it was not used as gate evidence. The three independent
validating resolver results were used instead.

## 5. Propagation and stability window

Immediately after parent publication, Cloudflare `1.1.1.1` briefly returned a
cached SERVFAIL while Google and Quad9 already validated the new chain. It
recovered to `NOERROR + AD` before the first counted stability check. There was
no widespread SERVFAIL, no NXDOMAIN and no service outage, so the documented
rollback threshold was not met.

Three complete checks were performed at least five minutes apart:

| Check | UTC time | Parent NS/DS | Three resolvers | Authoritative digest | Recursive digest |
| --- | --- | --- | --- | --- | --- |
| 1 | `2026-07-17T04:25:12Z` | exact | all critical queries `NOERROR + AD` | Gate 2 exact | exact on all three |
| 2 | `2026-07-17T04:30:46Z` | exact | all critical queries `NOERROR + AD` | Gate 2 exact | exact on all three |
| 3 | `2026-07-17T04:36:29Z` | exact | all critical queries `NOERROR + AD` | Gate 2 exact | exact on all three |

Every check confirmed:

- parent delegation contained only the Cloudflare pair;
- the single parent DS exactly matched Cloudflare;
- Cloudflare DNSSEC was `active`;
- DNSKEY and RRSIG were present;
- `1.1.1.1`, `8.8.8.8` and `9.9.9.9` validated the chain;
- the normal 21-record tuple digest remained
  `920d2c1cd79641698550e9c57758fc1601b2a4805cfe827a7a0bf75e46487083`;
- the recursive content digest remained
  `54a66d86627ceca6e65ac69df712ac58fa4dc806d3855e67548156e249665ff3`
  on all three resolvers;
- missing, extra, duplicate and proxied record counts were zero;
- six MX records retained exact ordering and priority; and
- web/TLS and Orbit rollback-surface checks remained clean.

## 6. DNS, web and mail smoke

The apex and every exported web subdomain resolved through validating
resolvers and completed TLS successfully. Application-root responses matched
the pre-Gate behavior:

- apex, Orbit, Equinox, Haber, Play and Status returned HTTP 200;
- `www` returned the existing HTTP 301 redirect;
- Auth and Selene returned their existing HTTP 404 root behavior without DNS
  or TLS failure;
- Orbit remained HTTP 200 from `server: GitHub.com`; and
- Orbit `/healthz` remained the expected GitHub Pages HTTP 404.

All six MX records, their priorities, SPF and verification TXT records matched
the source export on both authoritative and validating recursive paths. The
source export contained no DMARC or DKIM-selector record; none was added during
Gate 3. No authenticated mailbox session was available in the approved
execution context, so no real mail was sent and no mailbox state changed.

## 7. Non-mutation evidence

Final read-only checks confirmed:

- Cloudflare remained on the Free plan;
- exactly 21 user DNS records remained, all DNS-only and at TTL 300;
- `orbit.sametbasbug.dev` still targeted the GitHub Pages CNAME;
- no production Worker custom domain existed;
- the production Worker serving version remained
  `01384034-5584-4181-8763-b31e3aecf95e` at 100 percent;
- the Worker remained Workers.dev-only and dark launch; `/healthz` returned
  HTTP 200 with `X-Robots-Tag: noindex, nofollow, noarchive`;
- the production OAuth App retained the exact Workers.dev homepage and
  callback;
- the latest Pages deployment remained run `29387967237`, source SHA
  `35ad75abbe0708b873e768b2d361f8b6a1d08182`;
- production D1 remained `199fe088-2f56-48c4-bc81-50b8c5e4b471` in EU with
  1 account, 4 agents, 6 projects, 4 topics, 13 records and 13 revisions; the
  read-only count query wrote zero rows;
- cache KV remained `5c1574a9562448cf863aa84fad10877f`;
- private R2 buckets `orbit-v6-production-backups` and
  `orbit-v6-production-media` remained present; and
- no Worker deploy, OAuth change, Pages deployment, D1/KV/R2/backup mutation,
  paid feature, ordinary DNS edit, proxy enablement, nameserver change or
  Orbit traffic cutover occurred.

## 8. Rollback and remaining gates

**Rollback applied: no.**

No rollback trigger persisted: the DS was exact, the chain validated, all
three stability checks passed, DNS parity remained exact and service smoke
tests stayed clean. Cloudflare signing and the single parent DS therefore
remain active.

Gate 3 does not authorize the Orbit live-domain cutover. The following still
require separate explicit approval and bounded execution:

- final production backup;
- live-domain OAuth callback and credential transition;
- reviewed live Worker configuration deployment;
- Worker custom-domain attachment and Orbit traffic cutover; and
- live-domain smoke, rollback verification and any later Pages retirement.

