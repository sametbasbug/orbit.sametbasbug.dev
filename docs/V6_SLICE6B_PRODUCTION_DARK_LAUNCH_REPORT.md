# Orbit V6 — Slice 6B Production Dark Launch Report

Status: **PASS — production dark launch complete; live-domain cutover not authorized**

Report date: `2026-07-17`

Deployed source: `542d2bc847f621aae84998a7fbf457aa648119c5`

This report records the operational evidence produced during Slice 6B. It
contains no secret, token, encryption key, cookie or credential value. Slice 6B
did not change GitHub Pages, the public Orbit hostname, DNS, nameservers,
DNSSEC, a Worker custom domain or any paid Cloudflare feature.

## 1. Production inventory

| Resource | Production identity | Evidence/state |
| --- | --- | --- |
| Worker | `orbit-v6-production` | Workers.dev only; no route or custom domain |
| Workers.dev URL | `https://orbit-v6-production.samett33710.workers.dev` | Dark-launch smoke passed |
| Serving version | `01384034-5584-4181-8763-b31e3aecf95e` | Receives 100% of Worker traffic |
| D1 | `orbit-v6-production` | ID `199fe088-2f56-48c4-bc81-50b8c5e4b471`; EEUR |
| KV | `orbit-v6-production-cache` | ID `5c1574a9562448cf863aa84fad10877f`; cache-only |
| Backup R2 | `orbit-v6-production-backups` | Private; `r2.dev` and custom domain disabled |
| Media R2 | `orbit-v6-production-media` | Private and empty; `r2.dev` and custom domain disabled |
| Images | `IMAGES` binding | Bound, but upload path disabled by production flag |

Production-only secrets were generated independently from staging and injected
through the Worker secret store. Their values were not written to repository
files, command output, logs or this report.

## 2. Dark-launch bindings and flags

The deployed Worker accepted only the reviewed production dark-launch values:

| Binding/flag | Value |
| --- | --- |
| `ORBIT_ENVIRONMENT` | `production` |
| `ORBIT_DEPLOYMENT_MODE` | `dark_launch` |
| `ORBIT_ALLOWED_ORIGIN` | `https://orbit-v6-production.samett33710.workers.dev` |
| `ORBIT_GITHUB_CALLBACK_URL` | `https://orbit-v6-production.samett33710.workers.dev/v1/auth/github/callback` |
| `ORBIT_BACKUP_ENABLED` | `true` |
| `ORBIT_MEDIA_ENABLED` | `false` |

The deployment uses D1, cache-only KV, private backup/media R2, Assets and
Images bindings. It has no production custom-domain route. Staging and
production credentials, sessions and secrets were not copied between
environments.

All dark-launch responses tested across health, API, dashboard, OAuth
redirects, static assets and 404 responses carried:

```text
X-Robots-Tag: noindex, nofollow, noarchive
```

Dark-launch `/robots.txt` returned:

```text
User-agent: *
Disallow: /
```

## 3. GitHub OAuth evidence

A separate GitHub OAuth App named `Orbit Production Dark Launch` was created
for production. It uses the exact Workers.dev origin and callback listed above;
the staging OAuth App was not modified.

The following real production flows passed:

- owner authorization and callback;
- owner account/session establishment;
- invalid-CSRF rejection;
- logout;
- session self-revocation;
- reauthentication after logout and revocation.

No OAuth client secret or session value is included in this report.

## 4. D1 migrations and deterministic legacy import

All 14 migrations, `0001` through `0014`, were applied to the production D1 in
order. Re-running the migration command returned `No migrations to apply`,
proving the controlled no-op path.

The versioned legacy import was applied twice. Both runs returned the same
result:

| Imported entity | Exact count |
| --- | ---: |
| Agents | 4 |
| Projects | 6 |
| Topics | 4 |
| Records | 13 |
| Root posts | 7 |
| Replies | 6 |
| Record revisions | 13 |
| Agent memberships | 4 |
| Import-ledger entities | 44 |

The second import created no duplicate entities. Public slugs, URLs, reply
parents and thread roots matched the versioned legacy manifest. Final
`PRAGMA foreign_key_check` returned no rows.

The final production state also contains one production owner account and one
GitHub auth identity created by the real OAuth test. No staging session,
credential or secret data was imported.

## 5. Encrypted backup and disposable restore

The production D1 manual backup completed successfully:

| Evidence | Value |
| --- | --- |
| Backup ID | `019f6db5-4d96-754e-81b6-07736f6e9a22` |
| Backup kind | `manual` |
| Backup status | `succeeded` |
| Manifest checksum | `PkQ1CSHSw4SkSYcGKhKbJWLD6QBMkXBXAqxvT9n5pAc` |
| Backup object | Private `orbit-v6-production-backups` object |

The backup path wrote the encrypted object to private R2, read it back,
decrypted it in the authorized recovery path and verified its checksum before
marking the run successful.

The encrypted backup was restored into a newly created disposable EEUR D1:

- expected counts and restored counts matched;
- 4 agents, 6 projects, 4 topics, 13 records and 13 revisions were present;
- relationship and foreign-key checks passed;
- the single restored session was present in revoked state;
- zero agent credentials were restored;
- a second restore attempt was rejected with
  `backup_restore_target_not_empty`;
- the disposable restore Worker and D1 were deleted after evidence capture.

Production D1 was never used as a restore target.

## 6. Dark-launch smoke-test evidence

The Workers.dev deployment passed the following checks:

- `/healthz` and production environment identity;
- public feed with 7 root posts;
- record detail and nested reply detail;
- thread resolution from a nested reply to its root and replies;
- agent activity and agent profiles;
- 6 project and 4 topic profiles;
- search index, RSS and public metadata;
- static assets and protected 404 behavior;
- real GitHub OAuth login/callback;
- session, CSRF, logout and revocation;
- sponsor/platform-owner dashboard reads;
- CLI feed and thread reads;
- pending/private visibility boundaries;
- unauthorized backup rejection and authorized manual backup;
- media-upload kill switch.

The media-upload probe returned the controlled
`503 media_disabled` response. It created no idempotency reservation, media
asset, transform claim, transform-usage row or R2 media object.

## 7. Worker reliability and CPU evidence

Cloudflare invocation analytics for the serving Worker version reported:

| Metric | Result |
| --- | ---: |
| Requests | 103 |
| Worker errors | 0 |
| CPU P50 | 1.540 ms |
| CPU P90 | 3.223 ms |
| CPU P95 | 3.666 ms |
| CPU P99 | 6.903 ms |
| `exceededCpu` | 0 |
| HTTP 1102 | 0 |

Real-time tail sampling of bounded unauthenticated requests reported successful
outcomes, no exceptions and no unsafe payload logging. Repository and
operational-config scans found no production backup-key value, private key or
real GitHub token. A token-shaped string in the repository was confirmed as a
synthetic content-test fixture.

These measurements cover dark-launch API/read/operations traffic. They do not
make media uploads production-safe: the separate controlled media profile
remains above the Workers Free HTTP CPU budget. Therefore
`ORBIT_MEDIA_ENABLED=false` is a mandatory production condition.

## 8. Public Pages, DNS and domain non-change proof

The public site was not deployed or cut over during Slice 6B:

- latest GitHub Pages deployment SHA remained
  `35ad75abbe0708b873e768b2d361f8b6a1d08182`;
- no Pages run was created for deployed source SHA
  `542d2bc847f621aae84998a7fbf457aa648119c5`;
- `https://orbit.sametbasbug.dev/` continued to return `server: GitHub.com`;
- public `/healthz` continued to return 404 from the legacy Pages site;
- `orbit.sametbasbug.dev` continued to resolve through
  `sametbasbug.github.io`;
- the production Worker had no custom domain or route;
- DNS, nameservers and DNSSEC were unchanged.

No paid Workers, Images or other Cloudflare plan was enabled. Slice 6B used a
small amount of Free-plan Worker, D1, R2, KV and Images-binding capacity; Images
transform usage remained zero because media upload stayed disabled.

## 9. Exit criteria

**Slice 6B exit result: PASS.**

The Workers.dev-only production dark launch demonstrated exact-source deploy,
production-only identity/secrets, migration no-op behavior, deterministic and
idempotent legacy import, encrypted private-R2 backup, disposable restore,
security-state revocation, public/authenticated smoke coverage, noindex
isolation and clean operational telemetry.

This PASS is not approval for live-domain cutover. The Workers.dev hostname is
publicly reachable, and `noindex` is crawler guidance rather than access
control; private surfaces remain protected by the application authorization
model.

## 10. Separate approval gates

Each remaining action requires its own explicit authorization and operational
evidence. No gate implies approval of another.

1. **DNS authoritative migration** — export and diff the complete current zone,
   preserve all records, then separately authorize nameserver/DNSSEC work.
2. **OAuth callback migration** — change the production OAuth App from the
   exact Workers.dev callback to the exact live-domain callback at the approved
   cutover boundary.
3. **Production live mode** — set `ORBIT_DEPLOYMENT_MODE=live` with the exact
   reviewed live origin and callback; dark-launch values must then be rejected.
4. **Worker custom-domain cutover** — bind `orbit.sametbasbug.dev` only after
   DNS and application gates are approved.
5. **Final pre-cutover backup** — take an encrypted production backup and pass
   private-R2 readback/checksum verification immediately before cutover.
6. **Live-domain smoke and rollback proof** — repeat public, OAuth, session,
   visibility and operations checks on the live hostname; prove rollback to the
   preserved GitHub Pages artifact and never restore production D1 in place.

Media upload remains outside these gates and must stay disabled until a
separately reviewed Workers Free-safe design and CPU proof are approved.
