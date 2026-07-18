# Orbit V6 Slice 6C Gate 6 Worker Readiness Report

Date: 2026-07-18
Starting main SHA: `dca341521259e22d36ee4d9292a1f2244272880e`
Gate 4 final backup ID: `019f6e6f-8aff-77ad-aa99-8bd7a51f9ba8`

## 1. Scope and result

Gate 6 authorized preparation and upload of two unserved Worker versions:

- an exact live candidate using the recoverable live GitHub OAuth pair; and
- an exact dark-launch rollback candidate using the recoverable dark GitHub
  OAuth pair.

No deployment, traffic split, custom domain, route, DNS, Worker URL toggle,
Preview URL toggle, OAuth App edit, Pages action, or production-data mutation
was authorized or performed.

**Gate 6 readiness result: `READY_FOR_GATE7`.**

Gate 7 remains separately gated. Neither candidate may receive traffic until
that explicit approval is given.

## 2. Preflight

The preflight passed before either version upload:

- branch `main`, local `main`, and `origin/main` were equal at the exact
  starting SHA, with a clean worktree;
- PR #20 was merged into `main`, and the Gate 1 through Gate 5 reports were
  present;
- the Cloudflare zone remained active on the Free plan with Full DNS setup;
- DNSSEC remained protected, the parent published one exact DS, and
  Cloudflare, Google, and Quad9 returned validating `AD` answers;
- parent delegation remained only `harley.ns.cloudflare.com` and
  `hera.ns.cloudflare.com`;
- authoritative Orbit DNS remained a DNS-only CNAME to
  `sametbasbug.github.io.` with TTL 300;
- Orbit `/` returned HTTP 200 from `server: GitHub.com`, and `/healthz`
  returned the expected GitHub Pages HTTP 404;
- the latest Pages run remained `29387967237`, source SHA
  `35ad75abbe0708b873e768b2d361f8b6a1d08182`;
- the active Worker deployment contained only version
  `01384034-5584-4181-8763-b31e3aecf95e` at 100 percent;
- Workers.dev `/healthz` returned HTTP 200 with
  `X-Robots-Tag: noindex, nofollow, noarchive`;
- Workers.dev remained enabled, Preview URLs remained disabled, and the
  Worker and zone dashboards showed no custom domains and no routes;
- the active secret name/type inventory retained SHA-256
  `3f0dfad8433bd2eed551eaace0131e07d253818718e9bdfe4db7ca17791992b1`;
- all four live/dark Keychain OAuth entries were recoverable without exposing
  their values;
- GitHub OAuth settings remained exact: dark App `3733923` had two secrets,
  and live App `3736304` had one secret and zero authorized users;
- production D1 remained at 1 account, 1 auth identity, 4 agents, 6 projects,
  4 topics, 13 records, 13 revisions, 3 sessions, 0 agent credentials, 4
  backup runs, and 0 media assets;
- cache KV remained empty;
- backup R2 remained private at 4 objects and media R2 remained private and
  empty; and
- the Gate 4 backup readback retained encrypted SHA-256
  `cc3221a7fff29cb00f223bc7e42894b1235545469977dde41172f836c24835f1`.

## 3. Build, test, and generated-config safety

Validation completed before upload:

- production config tests: 39 assertions;
- Astro diagnostics: 0 errors, 0 warnings, 0 hints;
- Orbit content tests: 63 assertions;
- Orbit CLI tests: 41 assertions;
- D1/Worker suites: 78 tests across 6 suites;
- site integrity suite: 2,331 assertions;
- browser regression suite: 372 assertions; and
- static build: 39 pages.

Both required production builds completed in dry-run mode. Their dry-run
binding output named the exact Worker, D1, KV, backup R2, media R2, Images,
Assets, environment, owner, backup, media, mode, origin, and callback
surfaces. No dry-run applied a deployment or trigger.

The generated `.wrangler/deploy/config.json` pointed at an Astro-generated
client config. It was not trusted for either candidate. Explicit
`--config wrangler.production.live.jsonc` and
`--config wrangler.production.dark-launch.jsonc` version-upload dry runs
produced the exact tracked resources and variables, proving the explicit
configs took precedence.

The tracked configs contained no route, custom-domain, or credential value.
They differed only in the reviewed live/dark mode surfaces:

- `workers_dev`;
- `ORBIT_DEPLOYMENT_MODE`;
- `ORBIT_ALLOWED_ORIGIN`; and
- `ORBIT_GITHUB_CALLBACK_URL`.

Both retained `preview_urls: false`, `ORBIT_MEDIA_ENABLED=false`, compatibility
date `2026-07-15`, cron `17 3 * * *`, and identical observability and resource
bindings.

## 4. Candidate inventory

### Live candidate

| Field | Value |
| --- | --- |
| Version ID | `5dc9bbe1-60f8-4737-beac-8ace7129c62b` |
| Tag | `slice6c-gate6-live-dca341521259` |
| Message | `Slice 6C Gate 6 live candidate from dca341521259` |
| Created | `2026-07-18T05:38:43.340266Z` |
| Config SHA-256 | `faaa68cebc0ff151b9ac0b4b500c1e066261c24aa0872dcdd33a56bd3f81cc8f` |
| Asset manifest SHA-256 | `280e1db666042f851b4018e04ec53646eeabd52710c28cdcb6fec166e353b8e3` |
| Deployment mode | `live` |
| Allowed origin | `https://orbit.sametbasbug.dev` |
| OAuth callback | `https://orbit.sametbasbug.dev/v1/auth/github/callback` |
| OAuth custody | macOS Keychain live entries; values not exposed |
| OAuth App | `Orbit Production`, settings ID `3736304` |

### Dark rollback candidate

| Field | Value |
| --- | --- |
| Version ID | `86f7f47c-5150-49b8-90d3-38d3848ff67b` |
| Tag | `slice6c-gate6-dark-rollback-dca341521259` |
| Message | `Slice 6C Gate 6 dark rollback candidate from dca341521259` |
| Created | `2026-07-18T05:39:58.61934Z` |
| Config SHA-256 | `d5e59ef36ceb0e41a47add7cd1fdc7dc9aec662c63043fb611f106bff79feb0b` |
| Asset manifest SHA-256 | `c81d5d62c315e561160f8ce1740a43e6466e8bc95731a8361b2c32f8104e0a66` |
| Deployment mode | `dark_launch` |
| Allowed origin | `https://orbit-v6-production.samett33710.workers.dev` |
| OAuth callback | `https://orbit-v6-production.samett33710.workers.dev/v1/auth/github/callback` |
| OAuth custody | macOS Keychain dark rollback entries; values not exposed |
| OAuth App | `Orbit Production Dark Launch`, settings ID `3733923` |

The differing asset hashes are expected: live output is indexable and uses the
live canonical origin, while dark output applies the noindex crawler policy
and Workers.dev origin. Each hash reproduced across the validation and final
upload build.

## 5. Binding and source parity

Each candidate exposes exactly nine secret binding names:

- `GITHUB_OAUTH_CLIENT_ID`;
- `GITHUB_OAUTH_CLIENT_SECRET`;
- `ORBIT_INVITATION_PEPPER_V1`;
- `ORBIT_SESSION_PEPPER_V1`;
- `ORBIT_AGENT_CREDENTIAL_PEPPER_V1`;
- `ORBIT_OAUTH_STATE_PEPPER_V1`;
- `ORBIT_CSRF_PEPPER_V1`;
- `ORBIT_CURSOR_PEPPER_V1`; and
- `ORBIT_BACKUP_ENCRYPTION_KEY_V1`.

The sorted candidate secret-name digest is
`03c93e1680ef6a198aff947bbb2a08521588fe2af5b49b9a91d8c5198992a115`
for both versions. Wrangler's documented additive `--secrets-file` behavior
preserved the seven existing production secret bindings while replacing only
the candidate-specific GitHub OAuth pair from the matching Keychain custody.

After excluding the three expected mode/origin/callback plain-text values,
the complete version binding inventories were exact. Both candidates use:

- D1 `199fe088-2f56-48c4-bc81-50b8c5e4b471`;
- KV `5c1574a9562448cf863aa84fad10877f`;
- R2 buckets `orbit-v6-production-backups` and
  `orbit-v6-production-media`;
- identical Images and Assets bindings;
- the same production environment, platform owner, backup-enabled, and
  media-disabled values; and
- the same Worker script etag
  `ece97a82f51e25fece8c0c2e391b565b208c3384616a46985d22aa5fa66d926c`.

The common script etag proves identical application source. The version tags,
messages, and report starting SHA bind both candidates to the same main source
state.

## 6. Secret input and cleanup

Each upload used a unique owner-only directory under `/private/tmp` and a
mode-600 JSON file containing only the two matching GitHub OAuth fields. The
values moved directly from macOS Keychain through process memory into that
file and were never printed, placed in a shell argument, copied into the repo,
or written to `.env`, `.dev.vars`, `.orbit`, or `.wrangler`.

An exact cleanup trap removed each secret file immediately after its upload
and removed its private directory. Post-upload searches found no Gate 6 secret
input directory or file. No secret value entered terminal output, application
logs, Git, or the report.

## 7. Unserved-version proof

The version inventory contains both candidates, but the deployment inventory
did not change. It still contains four historical deployments, with the last
and active deployment `80816ff8-ec68-487a-b3cf-b3c5e01d26e4` serving only
version `01384034-5584-4181-8763-b31e3aecf95e` at 100 percent.

Neither candidate ID appears in a deployment or traffic split. Account-level
Preview URLs remained disabled. Although Wrangler version metadata reports a
preview-capable artifact for each uploaded version, both predicted version
preview hostnames returned HTTP 404. The candidates therefore receive neither
normal production traffic nor public preview traffic.

No `wrangler versions deploy`, `wrangler rollback`, `wrangler triggers
deploy`, Worker deploy, secret mutation, split deployment, custom-domain
attachment, route creation, or dashboard promotion occurred.

## 8. Final production non-mutation

Post-upload checks matched the preflight:

- active serving version and its 100-percent traffic allocation were exact;
- the deployment count and latest deployment ID were unchanged;
- Workers.dev `/healthz` remained HTTP 200 with the exact noindex header;
- the active Worker secret name/type inventory retained its exact Gate 5
  digest;
- Workers.dev remained enabled, Preview URLs remained disabled, and no custom
  domain or route existed;
- both GitHub OAuth Apps retained their exact names, settings IDs, homepages,
  callbacks, Device Flow state, and secret counts;
- authoritative Orbit DNS remained the TTL-300 Pages CNAME;
- DNSSEC and the single parent DS remained exact;
- Orbit remained HTTP 200 on GitHub Pages and `/healthz` remained Pages 404;
- the Pages run and source artifact were unchanged;
- production D1 counts, including three sessions and zero agent credentials,
  were unchanged;
- KV remained empty;
- backup R2 remained at four objects and media R2 remained empty;
- the final Gate 4 backup checksum remained exact; and
- no paid feature was enabled.

The only production control-plane additions were the two explicitly
authorized unserved Worker versions and their content-addressed static asset
uploads.

## 9. Gate 7 bounded cutover package

This section is a runbook only. None of these commands or dashboard actions
were executed in Gate 6.

### Frozen inputs

- Current Pages DNS: `orbit` CNAME `sametbasbug.github.io.`, TTL 300,
  DNS-only.
- Current Pages run: `29387967237`, source
  `35ad75abbe0708b873e768b2d361f8b6a1d08182`.
- Current serving Worker version:
  `01384034-5584-4181-8763-b31e3aecf95e`.
- Live candidate: `5dc9bbe1-60f8-4737-beac-8ace7129c62b`.
- Dark rollback candidate: `86f7f47c-5150-49b8-90d3-38d3848ff67b`.
- Custom Domain: `orbit.sametbasbug.dev` on the single Worker
  `orbit-v6-production`.
- Live/dark config and asset hashes: the exact values in Section 4.
- OAuth Apps: dark `3733923`, live `3736304`.

### Pre-cutover proof

Run both authoritative queries and preserve their TTL-300 Pages answers:

```text
dig @harley.ns.cloudflare.com orbit.sametbasbug.dev CNAME +noall +answer
dig @hera.ns.cloudflare.com orbit.sametbasbug.dev CNAME +noall +answer
```

Reconfirm the active deployment, Workers.dev health/noindex header, Pages root
and `/healthz`, both candidate views, parent DS, final backup checksum, and
production D1/R2 counts before opening the bounded window.

### Bounded live cutover

1. In Cloudflare DNS, delete only the existing DNS-only `orbit` Pages CNAME.
2. Query both authoritative nameservers until the old CNAME answer is absent;
   do not alter any other record.
3. Open **Workers & Pages → orbit-v6-production → Domains → Add Domain** and
   attach exactly `orbit.sametbasbug.dev` to this Worker only.
4. Confirm Cloudflare created exactly one Worker-managed Orbit DNS record and
   that no stale Pages CNAME or duplicate Orbit record remains.
5. Require authoritative DNS visibility and a valid TLS certificate within
   five minutes of attachment. If either is missing at the deadline, start the
   rollback sequence without promoting the live version.
6. Promote only the live candidate at 100 percent:

```text
npx wrangler versions deploy 5dc9bbe1-60f8-4737-beac-8ace7129c62b@100% --name orbit-v6-production --message "Slice 6C Gate 7 live cutover" --yes
```

7. Within one minute, verify the deployment contains only the live candidate
   at 100 percent. Then verify `/healthz`, public feed/detail/profile/project
   reads, management no-store/CSP surfaces, exact live Origin and callback,
   CSRF/session behavior, and one real bounded GitHub OAuth login/callback.
8. In the Worker Domains page, disable the Workers.dev Production Worker URL;
   keep Preview URLs disabled. Verify the Workers.dev and both version preview
   hostnames no longer expose the application.
9. Complete DNSSEC-validating resolver checks, TLS checks, D1/session checks,
   and the full browser/site smoke within five additional minutes. Any
   widespread error, wrong callback, bad session, data drift, or TLS failure
   triggers rollback.

### Exact rollback

1. Promote only the prepared dark rollback candidate at 100 percent:

```text
npx wrangler versions deploy 86f7f47c-5150-49b8-90d3-38d3848ff67b@100% --name orbit-v6-production --message "Slice 6C Gate 7 dark rollback" --yes
```

2. Re-enable the Workers.dev Production Worker URL and verify dark-launch
   `/healthz` plus the exact noindex header.
3. Detach `orbit.sametbasbug.dev` from **orbit-v6-production → Domains**.
4. Remove only the Worker-created Orbit DNS record if Cloudflare did not
   remove it automatically. Prove no Orbit record remains before recreation.
5. Recreate exactly one DNS-only record: name `orbit`, type `CNAME`, target
   `sametbasbug.github.io.`, TTL 300.
6. Query both authoritative nameservers until the exact Pages CNAME is visible,
   then validate Cloudflare, Google, and Quad9 resolution.
7. Verify Pages TLS, Orbit `/` HTTP 200 with `server: GitHub.com`, `/healthz`
   Pages HTTP 404, and the frozen Pages artifact/run.
8. Confirm the rollback deployment contains only the dark candidate at 100
   percent, no custom domain/route remains, Preview URLs stay disabled,
   production data counts are unchanged, and no other DNS record moved.

The rollback never deletes either candidate or OAuth App and never modifies
OAuth secrets, production D1/KV/R2, DNSSEC, DS, nameservers, or Pages content.

## 10. Remaining gates

Gate 7 requires a separate explicit approval for the bounded custom-domain,
DNS, deployment, real OAuth, and traffic window above. Gate 8 remains a later
independent approval. This report alone authorizes neither gate.
