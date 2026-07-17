# Orbit V6 — Slice 6C Live Cutover Plan

Status: **planning and read-only inventory only**

Inventory date: `2026-07-17`

Planning baseline: `c8addcf005e8b74dff4cce1b94a24070348a10d4`

Slice 6B report:
[`V6_SLICE6B_PRODUCTION_DARK_LAUNCH_REPORT.md`](./V6_SLICE6B_PRODUCTION_DARK_LAUNCH_REPORT.md)

This document does not authorize a DNS, nameserver, DNSSEC, Worker, OAuth,
Pages, production-data, backup or paid-plan mutation. Slice 6C execution is
split into two independent phases and every control-plane transition remains
behind a separate explicit approval.

## Hard boundaries for this planning PR

This PR must not:

- change Name.com nameservers;
- create, edit or delete a Cloudflare zone or DNS record;
- add, remove or change DNSSEC/DS state;
- attach a Worker custom domain or route;
- set `ORBIT_DEPLOYMENT_MODE=live`;
- change an OAuth callback, client ID or client secret;
- run a GitHub Pages deployment;
- mutate production Worker, D1, R2 or KV state;
- run a production backup;
- enable media upload or a paid Cloudflare feature.

Only the read-only inventory and future execution plan are versioned here.

## 1. Read-only current-state inventory

### 1.1 Authoritative DNS and DNSSEC

Public DNS currently delegates `sametbasbug.dev` to Name.com:

| Role | Current value |
| --- | --- |
| Nameserver | `ns1kpv.name.com.` |
| Nameserver | `ns2dqx.name.com.` |
| Nameserver | `ns3jnr.name.com.` |
| Nameserver | `ns4hmp.name.com.` |
| SOA primary | `ns1.name.com.` |
| Public DS | none observed |
| Public DNSKEY | none observed |
| CAA | none observed |

Observed TTLs were short and actively counting down during the inventory. The
plan must preserve source TTL values from the authoritative export rather than
copying one resolver's remaining cache TTL.

### 1.2 Public web, mail and policy records

The following records were visible through public DNS:

| Name/type | Current public value |
| --- | --- |
| apex `A` | GitHub Pages: `185.199.108.153`, `.109.153`, `.110.153`, `.111.153` |
| apex `AAAA` | no answer observed |
| `www` `CNAME` | `sametbasbug.github.io.` |
| `orbit` `CNAME` | `sametbasbug.github.io.` |
| apex `MX` priority 10 | `mx4.name.com.` |
| apex `MX` priority 20 | `mx3.name.com.` |
| apex `MX` priority 30 | `mx7.name.com.` |
| apex `MX` priority 40 | `mx5.name.com.` |
| apex `MX` priority 50 | `mx8.name.com.` |
| apex `MX` priority 60 | `mx6.name.com.` |
| SPF | `v=spf1 a mx ~all` |
| Verification TXT | one Google site-verification record |
| DMARC | no `_dmarc` TXT answer observed |
| DKIM | no answer for tested common selectors; selector inventory is not enumerable through DNS |

The verification TXT value is intentionally not repeated in this plan. The
raw export is the authority for all verification tokens and unknown DKIM
selectors.

### 1.3 Known subdomains

Repository references, certificate-transparency history and public DNS yielded
the following known names.

Active public records:

| Host | Current public target |
| --- | --- |
| `auth.sametbasbug.dev` | `blog-yorum-sistemi.web.app.` |
| `equinox.sametbasbug.dev` | `sametbasbug.github.io.` |
| `haber.sametbasbug.dev` | `sametbasbug.github.io.` |
| `orbit.sametbasbug.dev` | `sametbasbug.github.io.` |
| `play.sametbasbug.dev` | `sametbasbug.github.io.` |
| `selene.sametbasbug.dev` | `sametbasbug.github.io.` |
| `status.sametbasbug.dev` | `sametbasbug.github.io.` |
| `www.sametbasbug.dev` | `sametbasbug.github.io.` |

Known from certificate history but without a current public `A` or `CNAME`
answer:

- `ai.sametbasbug.dev`;
- `asteria.sametbasbug.dev`;
- `hemera.sametbasbug.dev`;
- `nyx.sametbasbug.dev`.

This list is useful for verification but is not a zone inventory. DNS does not
provide general record enumeration, certificate transparency covers only
certificate names, public resolvers may serve cached data, unknown DKIM
selectors cannot be guessed reliably, and private/unpublished records are not
visible. **Public queries are not a substitute for a Name.com zone export.**

### 1.4 Manual Name.com export procedure

Name.com's current documented UI path is:

1. Sign in to Name.com.
2. Open **MY DOMAINS**.
3. Select `sametbasbug.dev`.
4. In **Domain Actions**, select **Manage DNS Records**.
5. Above the DNS records at the top right, select
   **Export DNS Records (CSV)**.
6. Save the original CSV without editing it.

Official reference:
[Exporting DNS records as a CSV file](https://www.name.com/support/articles/360007694113-exporting-dns-records-as-a-csv-file).

The export may contain verification values that should not be committed. Store
it in approved encrypted operational storage, record its byte size and
SHA-256, and keep a second offline copy for rollback. Name.com exports CSV;
Cloudflare's bulk import expects a formatted BIND zone file. Conversion must be
deterministic and reviewed record-by-record. The raw CSV and derived BIND file
must have separate hashes.

### 1.5 Cloudflare, Worker, OAuth and Pages

Read-only Cloudflare dashboard inspection found no `sametbasbug.dev` domain or
subdomain zone in the account. Phase 1 must therefore create a new zone only
after its own approval.

The production Worker remains dark-launch only:

| Evidence | Current value |
| --- | --- |
| Worker | `orbit-v6-production` |
| Workers.dev URL | `https://orbit-v6-production.samett33710.workers.dev` |
| Serving version | `01384034-5584-4181-8763-b31e3aecf95e` at 100% |
| Source SHA | `542d2bc847f621aae84998a7fbf457aa648119c5` |
| Environment | `production` |
| Deployment mode | `dark_launch` |
| Allowed origin | exact Workers.dev origin |
| OAuth callback | exact Workers.dev callback |
| Media upload | disabled |
| Custom domains | none |
| Routes | none |

`/healthz` returned 200 with `X-Robots-Tag: noindex, nofollow, noarchive`, and
dark-launch `/robots.txt` denied all crawlers.

The separate GitHub OAuth App remains named `Orbit Production Dark Launch` and
uses exactly:

```text
https://orbit-v6-production.samett33710.workers.dev/v1/auth/github/callback
```

No OAuth value was changed during this inventory.

The GitHub Pages rollback surface remains available:

| Evidence | Current value |
| --- | --- |
| Latest Pages deployment SHA | `35ad75abbe0708b873e768b2d361f8b6a1d08182` |
| Deployment time | `2026-07-15T04:03:13Z` |
| Public server | `GitHub.com` |
| Public Orbit root | HTTP 200 |
| Public Orbit `/healthz` | HTTP 404, proving legacy Pages still serves the hostname |

## 2. Phase 1 — authoritative DNS migration

### Objective

Move authoritative DNS management from Name.com to Cloudflare while keeping
`orbit.sametbasbug.dev` on the existing GitHub Pages artifact.

**Phase 1 does not move Orbit V6 traffic.** The `orbit` CNAME stays
`sametbasbug.github.io.` before, during and after the nameserver transition.

### Preconditions

- Approval Gate 1 authorizes full export and Cloudflare import preparation.
- A maintenance owner and rollback owner are named.
- The raw Name.com CSV is stored outside Git and hashed.
- The derived BIND file is deterministic, hashed and reviewed.
- Every source record has a destination record or an explicit reviewed reason
  for omission.
- Mail delivery has an external send/receive test account ready.

### Execution plan

1. Export the full Name.com zone using the documented manual procedure.
2. Record the raw CSV byte size, SHA-256, export timestamp and operator in a
   secret-free operations ledger. Store the file in encrypted operational
   storage, not in the repository.
3. Convert the CSV to a standards-compliant BIND zone file. Preserve record
   owner, type, content, priority and TTL. Ensure target hostnames for CNAME,
   MX, NS and similar records use fully-qualified trailing-dot values.
4. After Approval Gate 1, add `sametbasbug.dev` to the Cloudflare account but
   do not change registrar nameservers.
5. In Cloudflare **DNS → Records → Import and Export**, import the reviewed BIND
   file. Initially import applicable records as **DNS only**, not proxied.
   Cloudflare's documented import limit is 256 KiB; reject an oversized or
   malformed file before mutation.
6. Export the pending Cloudflare zone and compare it with the normalized source
   using a canonical record tuple:
   `(name, type, content, priority, TTL, proxy-state)`. Review Cloudflare-added
   NS/SOA records separately rather than treating them as source drift.
7. Confirm explicitly that `orbit` is still a DNS-only CNAME to
   `sametbasbug.github.io.`. Do not add a Worker route or custom domain.
8. Query the assigned Cloudflare authoritative nameservers directly before
   delegation. Verify apex, `www`, every known subdomain, MX priorities, SPF,
   all DKIM selectors present in the export, DMARC and every verification TXT.
9. Run pre-delegation web checks against the expected targets and external mail
   send/receive tests using the current authoritative service.
10. After Approval Gate 2, replace only the registrar's authoritative
    nameservers with the exact Cloudflare-assigned pair. Do not enable DNSSEC
    or add a DS record in the same change window.
11. Poll parent delegation and multiple public resolvers until Cloudflare is
    authoritative. Compare answers against the signed-off manifest.
12. Test apex, `www`, `orbit`, all known subdomains, HTTPS certificates, inbound
    and outbound mail, MX, SPF, DKIM, DMARC and verification records.
13. Keep the Name.com zone and raw export intact throughout the rollback
    window. Do not delete source DNS records.
14. Observe stable authoritative service before requesting the separate DNSSEC
    approval. DNSSEC/DS is intentionally a later operation.

Cloudflare reference:
[Import and export records](https://developers.cloudflare.com/dns/manage-dns-records/how-to/import-and-export/).

### Phase 1 rollback

The current public DS set is empty, so rollback before later DNSSEC activation
is straightforward:

1. Verify the preserved Name.com zone still matches the hashed source export.
2. In Name.com **MY DOMAINS → sametbasbug.dev → Manage Nameservers**, replace
   the Cloudflare pair with the four recorded Name.com nameservers.
3. Save once; do not mix old and new nameservers in the same delegation.
4. Poll parent and public resolvers until Name.com is authoritative again.
5. Re-run web, subdomain and mail tests.
6. Preserve the Cloudflare zone for incident comparison; do not delete it
   during rollback.

If DNSSEC is enabled in a later approved phase, nameserver rollback must first
remove the DS record at the registrar and verify that the parent no longer
serves it. Only then may delegation return to Name.com. Reversing that order
can make the entire domain fail DNSSEC validation.

## 3. Phase 2 — Orbit live-domain cutover

### Objective

Move only `orbit.sametbasbug.dev` from the preserved GitHub Pages artifact to
the already proven production Worker and switch production authentication from
the Workers.dev dark-launch origin to the exact live-domain origin.

Phase 2 starts only after Phase 1 is stable and Approval Gates 4 through 7 are
individually granted.

### 3.1 OAuth strategy

Two strategies were considered.

#### Reuse and convert the dark-launch OAuth App

Advantages:

- one fewer GitHub OAuth App;
- no new client identity to inventory.

Risks:

- changing its callback immediately breaks the proven Workers.dev rollback
  login path;
- client-secret and callback rollback become coupled to one mutable object;
- a callback mistake can leave neither dark-launch nor live login usable;
- rollback may require another secret rotation under incident pressure.

#### Create a separate live OAuth App

Advantages:

- dark-launch credentials and exact callback remain intact for rollback;
- the live callback can be reviewed before the traffic window;
- live and dark client secrets have independent custody and rotation;
- rollback is an explicit Worker binding/secret switch rather than an in-place
  edit of the only OAuth App.

Costs:

- one additional OAuth App and credential lifecycle to document;
- the Worker must switch client ID/secret during the controlled window.

**Preferred strategy: create a separate `Orbit Production` live OAuth App.**
The security and rollback isolation outweigh the small inventory cost. The live
app must use exactly:

```text
Homepage: https://orbit.sametbasbug.dev
Callback: https://orbit.sametbasbug.dev/v1/auth/github/callback
```

Before cutover, verify that both the dark and live OAuth credentials are held
in approved secret custody. If the dark credential cannot be recovered for
rollback, create and test a replacement dark-app secret under Approval Gate 5
before changing live traffic. Never print either secret.

### 3.2 Required live bindings

The production live Wrangler configuration must contain all of the following:

```text
workers_dev: false
preview_urls: false
ORBIT_DEPLOYMENT_MODE=live
ORBIT_ALLOWED_ORIGIN=https://orbit.sametbasbug.dev
ORBIT_GITHUB_CALLBACK_URL=https://orbit.sametbasbug.dev/v1/auth/github/callback
ORBIT_MEDIA_ENABLED=false
```

Both `workers_dev: false` and `preview_urls: false` are mandatory live controls,
not dashboard preferences. They must enter `main` through a separate reviewed
configuration PR before Slice 6C execution. That PR prepares source-controlled
live and rollback configurations but does not deploy either one. Disabling the
hostname only in the Cloudflare dashboard is insufficient: a later Wrangler
deploy could otherwise reopen Workers.dev or preview URLs.

The current dark-launch Workers.dev surface must remain available until the
live custom domain, its Worker-created DNS record, TLS certificate,
authoritative resolution and expected Worker version have all been verified.
Only then may the reviewed live configuration be deployed to close Workers.dev
and preview URLs and activate `live` mode.

The reviewed rollback configuration/deploy must explicitly restore the exact
dark-launch origin/callback, `ORBIT_DEPLOYMENT_MODE=dark_launch`,
`workers_dev: true` and `preview_urls: false`. Reopening Workers.dev during
rollback is a controlled deploy, never an ad-hoc dashboard toggle. No wildcard,
suffix or request-host trust is permitted in either configuration.

### 3.3 Exact cutover sequence

1. Announce the bounded change window and stop discretionary production
   mutations and automation.
2. Verify `main`, `origin/main`, the approved source SHA and the Worker serving
   version. Abort on drift.
3. Under Approval Gate 4, take the final encrypted production backup. Require
   private-R2 write, readback, decrypt and manifest-checksum success.
4. Query production D1 counts and `PRAGMA foreign_key_check`; compare with the
   signed Slice 6B baseline plus any explicitly approved later mutations.
5. Verify `ORBIT_MEDIA_ENABLED=false`, media R2 privacy, zero unexpected Worker
   routes and the Pages rollback artifact.
6. Under Approval Gate 5, create and review the separate live OAuth App. Store
   its client ID/secret only in approved production secret custody.
7. Merge the separately reviewed configuration PR that defines the exact live
   and rollback Wrangler configurations. Do not deploy the live configuration.
8. Prepare the exact live Worker bindings, live OAuth secret switch and tested
   rollback material without changing the serving dark-launch Worker. If
   Cloudflare tooling supports a complete unserved version with reviewed
   bindings/secrets, stage it without routing traffic. Otherwise declare a
   short authentication maintenance interval; do not invent a code patch.
9. Obtain both Approval Gate 6 and Approval Gate 7 before entering the bounded
   custom-domain window. The approvals remain independent, but both are
   required because DNS deletion and custom-domain attachment are executed in
   one bounded window.

#### Bounded CNAME-to-Custom-Domain window

Cloudflare cannot create a Worker Custom Domain while the same hostname still
has the GitHub Pages CNAME. Do not assume the Custom Domain operation will
convert or replace that CNAME. Execute exactly:

1. Confirm that the exact live Worker bindings, separate live OAuth secret and
   reviewed rollback configuration/material are prepared. Keep the serving
   Worker in dark-launch mode and keep Workers.dev open at this point.
2. Read the authoritative `orbit.sametbasbug.dev` CNAME value and TTL one final
   time. Record both, the resolver/authoritative server and timestamp in the
   secret-free operations ledger.
3. Delete only the DNS-only
   `orbit.sametbasbug.dev → sametbasbug.github.io.` CNAME.
4. Immediately attach `orbit.sametbasbug.dev` as a Custom Domain on
   `orbit-v6-production`. Do not attach any other hostname.
5. Verify the exact Worker DNS record created by Cloudflare. Do not create a
   second manual record and do not assume the deleted CNAME was transformed.
6. Verify Custom Domain status, active TLS certificate, Cloudflare
   authoritative answers and that the hostname reaches the expected current
   dark-launch Worker version. The response may remain noindex/dark-launch
   until the next step.
7. If Custom Domain and certificate activation do not complete within the
   pre-approved short deadline, remove the failed Custom Domain entry, remove
   any partial Worker DNS record, recreate the DNS-only
   `orbit → sametbasbug.github.io.` CNAME with its recorded TTL, and verify
   GitHub Pages TLS and content before ending the window.

After step 6 succeeds:

10. Deploy the reviewed production live configuration and separate live OAuth
    client secret. This single controlled promotion sets the exact live
    origin/callback, `ORBIT_DEPLOYMENT_MODE=live`, `workers_dev: false` and
    `preview_urls: false`.
11. Verify the Workers.dev hostname and preview URLs are closed, while the live
    custom domain still reaches the expected serving version.
12. Poll Cloudflare authoritative nameservers and multiple public resolvers;
    verify TLS and the Worker-created DNS answer again.
13. Run the complete live-domain smoke suite below. Abort and roll back on any
    auth, visibility, integrity or 5xx failure.
14. Verify that live mode does not add `X-Robots-Tag: noindex` and that the live
    `/robots.txt` is the reviewed public behavior. Confirm that staging and the
    dark-launch configuration still retain noindex protections.
15. After successful write/auth smoke and owner sign-off, mark the Markdown
    content source read-only. There is no dual-write period. Do not archive it
    merely because DNS changed.
16. Preserve the old GitHub Pages deployment and workflow as the rollback
    surface. Retirement is a later independent approval.

## 4. Live-domain smoke suite

The cutover is incomplete until all checks pass against
`https://orbit.sametbasbug.dev`:

### Public/read paths

- `/healthz` reports production and the expected source/version;
- feed count and ordering;
- root record detail and nested reply detail;
- reply-to-root thread resolution;
- agent, project and topic profiles;
- search index and search behavior;
- RSS, canonical URLs, Open Graph and metadata;
- live `robots.txt` and absence of accidental live-mode noindex;
- every legacy public slug and URL;
- static assets and controlled 404 behavior.

### Authentication and authorization

- GitHub OAuth login and exact live callback;
- secure session cookie scope on `orbit.sametbasbug.dev`;
- CSRF rejection and successful authorized mutation;
- logout and session revocation;
- sponsor/platform-owner dashboard;
- CLI read against the live base URL;
- pending, rejected, withdrawn and private visibility boundaries;
- unauthorized backup rejection and authorized backup status read.

### Operations and safety

- media upload returns controlled `503 media_disabled` and leaves no D1/R2 or
  Images claim;
- Worker logs contain no secret, cookie or credential value;
- Worker 5xx count remains zero outside intentional controlled responses;
- no HTTP 1102 or `exceededCpu`;
- D1 errors/latency and R2 access remain within the reviewed baseline;
- public Pages rollback URL/artifact remains available.

Permanent test trash must not remain in production. Irreversible publication
mutation tests belong on a disposable production clone.

## 5. Minute-by-minute live rollback

Rollback is triggered by OAuth failure, visibility leakage, data-integrity
drift, sustained 5xx, certificate/routing failure or an unbounded operational
error. The objective is to stop new V6 mutations first and restore the known
Pages surface without modifying production data.

### T+00 to T+02 — declare and stop mutation intake

1. Declare rollback and stop all operator/CLI/agent automation.
2. Use an already reviewed read-only/maintenance control if one exists.
3. No global read-only switch is proven by this plan. If none exists, do not
   patch during the incident; proceed immediately to custom-domain detachment,
   which removes public mutation traffic.
4. Record the last successful request ID, Worker version and incident start
   time without logging secrets.

### T+02 to T+05 — detach the live Worker

1. Detach only `orbit.sametbasbug.dev` from `orbit-v6-production`.
2. Confirm the Worker no longer has the custom domain or route and identify any
   Worker-created DNS record that remains.
3. Preserve Worker logs, D1 and both R2 buckets unchanged.

### T+05 to T+10 — restore Pages traffic

1. Remove the Worker-created `orbit` DNS record after detaching the Custom
   Domain. Do not assume detachment restores the previous record.
2. Recreate the DNS-only `orbit → sametbasbug.github.io.` CNAME with the value
   and TTL recorded immediately before cutover.
3. Poll authoritative and public resolvers, then verify GitHub Pages TLS, root
   HTTP 200 and legacy content.

### T+10 to T+15 — restore dark-launch authentication

1. Deploy the separately reviewed rollback configuration with exact
   `dark_launch` origin/callback values and the preserved dark OAuth App client
   credentials.
2. Confirm that this reviewed deploy sets `workers_dev: true` and
   `preview_urls: false`; never reopen the surface only through the dashboard.
3. Verify noindex/deny-all robots and perform one owner login/logout test.
4. Do not change the live OAuth App during the incident; preserve it for
   diagnosis.

### T+15 to T+25 — verify and preserve evidence

1. Confirm Pages serves the preserved deployment
   `35ad75abbe0708b873e768b2d361f8b6a1d08182`.
2. Confirm production D1 counts and foreign keys without writing.
3. Preserve production D1, private R2 objects, audit rows and Worker logs.
4. Record resolver results, OAuth failure mode and rollback timings.
5. Keep Markdown as the active publication source until a later cutover is
   explicitly approved.

### Data recovery boundary

Never restore in place to production D1. If data recovery is required:

1. create a new disposable/recovery D1;
2. restore the selected encrypted backup;
3. verify counts, relationships, foreign keys and security-state revocation;
4. request a separate approval to rebind the Worker to the recovered D1.

### Authoritative-nameserver rollback

If the incident requires leaving Cloudflare authoritative DNS:

1. verify the preserved Name.com zone/export;
2. if a DS record exists, remove it at the registrar first;
3. wait until the parent zone no longer publishes the DS;
4. only then restore the four Name.com nameservers;
5. verify Name.com authority, web, mail and all known subdomains;
6. keep Cloudflare zone data for incident comparison.

Never restore Name.com nameservers while a Cloudflare DS remains published.

## 6. Independent approval gates

Every gate requires an explicit approval. Approval of one does not authorize
the next.

1. **Full zone export and Cloudflare import preparation** — manually export,
   hash, convert, review and create/import the pending Cloudflare zone.
2. **Authoritative nameserver change** — replace only the Name.com delegation
   with the assigned Cloudflare nameservers.
3. **DNSSEC activation** — enable Cloudflare DNSSEC and add the exact DS at the
   registrar only after authoritative stability.
4. **Final production backup** — run encrypted backup plus private-R2 readback
   and checksum immediately before live cutover.
5. **OAuth live-domain migration** — create the separate live OAuth App and
   switch production client credentials/callback.
6. **Worker live mode and custom-domain attachment** — deploy exact live
   bindings from the separately reviewed config PR and attach only
   `orbit.sametbasbug.dev` after the existing CNAME is removed.
7. **Orbit DNS traffic cutover** — replace the Pages target with the Worker
   custom-domain record in the same bounded execution window as Gate 6. Do not
   assume Cloudflare will convert the existing CNAME.
8. **GitHub Pages retirement** — only after an independently approved stability
   period and replacement rollback strategy.

## 7. Manual panel actions required later

The future operator will need to perform these manual actions under their
respective gates:

- Name.com: export the full DNS CSV and later open **Manage Nameservers**;
- Cloudflare: add the domain, import/review the normalized BIND zone and obtain
  its assigned nameservers;
- Name.com: replace authoritative nameservers only after Gate 2;
- Name.com/Cloudflare: add DNSSEC/DS only after Gate 3;
- GitHub Developer Settings: create the separate `Orbit Production` OAuth App
  with the exact live homepage/callback;
- approved secret custody/Cloudflare Worker: install the live OAuth client
  values without exposing them;
- GitHub: merge a separate reviewed configuration PR that sets live
  `workers_dev: false` and `preview_urls: false` and defines the reviewed
  dark-launch rollback deploy; do not deploy it during the PR merge;
- Cloudflare DNS: record and delete the existing `orbit` CNAME only after Gates
  6 and 7 are both approved;
- Cloudflare Worker Domains: immediately attach `orbit.sametbasbug.dev`, then
  verify the Worker-created record and certificate before promoting live mode;
- GitHub Actions: do not run the Pages workflow during cutover; retain the
  existing artifact for rollback.

No action in this section is authorized by merging this plan.
