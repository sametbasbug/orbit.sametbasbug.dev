# Orbit V6 Slice 6C Gate 4 Final Backup Report

Date: 2026-07-17
Starting main SHA: `2c1b2bb3002f68d4bdf04b2ae893d459dcba27d0`

## 1. Scope and result

Gate 4 authorized one final manual encrypted backup through the existing
production backup path, its normal backup-run metadata, and a restore proof on
disposable resources. It did not authorize or perform a Worker deploy, OAuth
change, DNS change, Pages deployment, custom-domain attachment, production
restore, KV write, media write, paid-feature activation, or live traffic
cutover.

**Gate 4 result: `PASS`.**

The new backup was read back byte-for-byte from private R2, decrypted and
verified. A disposable D1 restore passed count, relationship, integrity,
security-revocation, non-empty-target, and corruption-rejection checks. Both
older successful production backups remain directly readable. All disposable
Gate 4 resources and local temporary secret/data files were removed.

## 2. Preflight

Preflight completed before the backup mutation:

- local `main` and `origin/main` were equal at the expected starting SHA and
  the worktree was clean;
- the Gate 1, Gate 2, and Gate 3 reports were present on `main`;
- the Cloudflare zone was active on the Free plan, DNSSEC was active, the
  parent published the exact single DS, and validating DNS answers were clean;
- `orbit.sametbasbug.dev` remained a DNS-only CNAME to
  `sametbasbug.github.io.`;
- Orbit `/` returned HTTP 200 from `server: GitHub.com`, while `/healthz`
  returned the expected GitHub Pages HTTP 404;
- production Worker version
  `01384034-5584-4181-8763-b31e3aecf95e` remained at 100 percent on the
  Workers.dev-only dark-launch surface;
- the production OAuth App retained the exact Workers.dev homepage and
  callback;
- production backup was enabled and media upload was disabled;
- the production D1 migration list was current, foreign-key check returned
  zero violations, and a read-only export passed local SQLite
  `PRAGMA integrity_check` with `ok`; and
- production data met the required minimums: 1 account, 4 agents, 6 projects,
  4 topics, 13 records, and 13 revisions.

The remote D1 API does not permit `PRAGMA integrity_check`; the read-only
export/import proof was therefore used without writing to production.

## 3. Final backup evidence

| Field | Evidence |
| --- | --- |
| Backup ID | `019f6e6f-8aff-77ad-aa99-8bd7a51f9ba8` |
| Backup kind/status | `manual` / `succeeded` |
| Object key | `orbit-v6/manual/2026-07-17T04-57-11-572Z-019f6e6f-8aff-77ad-aa99-8bd7a51f9ba8.json.enc` |
| Created at | `2026-07-17T04:57:11.572Z` |
| Encrypted size | 58,253 bytes |
| Encrypted object SHA-256 | `cc3221a7fff29cb00f223bc7e42894b1235545469977dde41172f836c24835f1` |
| Plaintext canonical checksum | `uaJFBWr18380E6tZo5pndITkj3mHDT9mT7p74JlyI_Q` |
| Manifest checksum | `T4roLSaUluQLbJKJm4nn38M29dT3zQzGJd53AEamp5g` |
| Envelope | `equinox.orbit.encrypted-chunked-backup.v1`, AES-GCM-256 |
| Manifest/schema | `equinox.orbit.chunked-backup.v1` v1; source `equinox.orbit.dynamic-backup.v1` v5 |
| Key identifier | `v1` (secret key material omitted) |
| Chunks / exported rows | 14 / 88 |
| R2 ETag | Not exposed by the canonical Wrangler readback command |

All 14 chunk checksums passed. The envelope reported no plaintext secrets and
no credential digests. Session digests were present as required by the
versioned backup policy so sessions could be restored and then force-revoked;
no session token, cookie, OAuth credential, encryption key, or plaintext
credential was printed or written to Git. A field-name scan found no
disallowed plaintext-secret field.

The private R2 object was fetched twice after creation. Both reads were 58,253
bytes and had the exact encrypted SHA-256 above. Decryption authenticated,
the plaintext checksum matched, the manifest checksum matched, and every
chunk checksum matched.

## 4. Source manifest

The source manifest contained these non-zero counts:

| Table | Count |
| --- | ---: |
| accounts | 1 |
| auth identities | 1 |
| account roles | 1 |
| account quotas | 1 |
| agents | 4 |
| agent memberships | 4 |
| projects | 6 |
| topics | 4 |
| records | 13 |
| record revisions | 13 |
| record topics | 26 |
| sessions | 3 |
| avatar upload policies | 5 |
| audit events | 6 |

All other versioned backup tables had a count of zero, including agent
credentials, media assets, media transform claims/results, platform alerts,
publication reviews, moderation actions, announcements, and slug
reservations. These counts matched the production read-only preflight.

## 5. Disposable restore proof

A unique disposable D1 and a minimal temporary restore Worker were created.
The Worker was bound only to that disposable D1 and the production backup
bucket; it had no production D1, KV, or media binding. The final object was
read, authenticated, decrypted, checksum-verified, and restored with
`revokeSecurity: true`.

Restore evidence:

- restore input: 38,856 bytes and 105 D1 statements, within the canonical
  4 MiB / 2,000-statement limits;
- restored core counts: 1 account, 4 agents, 6 projects, 4 topics, 13 records,
  13 revisions, and 3 sessions;
- foreign-key, unique, and record relationship violations: 0 / 0 / 0;
- a read-only restored D1 export passed local SQLite `integrity_check` with
  `ok` and foreign-key count 0;
- 30 of 32 exported tables matched byte-canonical row digests without any
  normalization;
- the only raw mutable differences were the migration-seeded owner account's
  `last_login_at` and GitHub identity's `last_seen_at` timestamps;
- after excluding those two runtime login timestamps and the documented
  `revokeSecurity` fields (`revoked_at` / `revoked_reason`) from the canonical
  application-data comparison, all 32 tables matched and both source and
  restored digest were
  `QIhpIVNYGc85GT4DOK9XWmz4hkwcHU4KyzU-azCPVh4`;
- all 3 restored sessions were revoked, active session count was 0, active
  credential count was 0, and one restore-validation row was created;
- a same-length modified chunk was rejected as
  `chunked_backup_chunk_checksum_invalid` before any row was written; and
- a second restore into the now non-empty disposable D1 was rejected as
  `backup_restore_target_not_empty`, with before/after counts unchanged.

The two timestamp differences are expected from the canonical migration seed:
the restore uses conflict-safe seed handling for the owner identity, while
security state is intentionally re-established rather than replayed as a
live session. No publication, profile, project, topic, relationship, audit,
or media data drift remained.

## 6. Retention and privacy

No prune or lifecycle operation was run. Code inspection confirmed that the
manual backup endpoint does not invoke retention pruning and that scheduled
retention applies only to daily, weekly, and monthly prefixes, not manual
backups.

After the final backup, all three known successful objects were fetched
directly from private R2:

- prior manual backup: 55,374 bytes, SHA-256
  `194c76216178e6a6bba1fdf1958d0a609f30dad0f64ddb5c864bc3d9fafc29ef`;
- prior daily backup: 58,253 bytes, SHA-256
  `f8cf37aae062c32c996314321b1e80fe1cb5024336127cdbdd1017b61ba19f3a`;
- final manual backup: 58,253 bytes, SHA-256
  `cc3221a7fff29cb00f223bc7e42894b1235545469977dde41172f836c24835f1`.

The backup and media buckets still have no custom domain and public `r2.dev`
access remains disabled. The media bucket remained empty. The R2 aggregate
bucket counter still displayed two objects immediately after the operation,
but all three exact keys were directly readable; the aggregate counter is an
eventually updated metric and was not used as retention evidence.

## 7. Cleanup

The temporary Worker and disposable D1 were deleted after proof collection.
The D1 ID no longer resolved and the temporary Workers.dev endpoint returned
HTTP 404. No temporary R2 object was created.

The temporary restore token, restore Worker source/config, encrypted local
readback copies, production/readback SQL exports, local SQLite databases, and
the key-handling inspection helper were removed. No disposable Gate 4 Worker,
D1, secret, config, or data file remained.

## 8. Production and live non-mutation

Final checks confirmed:

- Orbit DNS still resolves to `sametbasbug.github.io.`;
- Orbit `/` remains HTTP 200 from `server: GitHub.com`, and `/healthz` remains
  the expected GitHub Pages HTTP 404;
- parent delegation remains the Cloudflare pair, the single parent DS is
  unchanged, Cloudflare reports DNSSEC protected, and Cloudflare, Google, and
  Quad9 return validating `AD` answers;
- production Worker serving version remains
  `01384034-5584-4181-8763-b31e3aecf95e` at 100 percent;
- the Worker remains Workers.dev-only and dark launch, and `/healthz` retains
  `X-Robots-Tag: noindex, nofollow, noarchive`;
- the OAuth App homepage and callback remain the exact Workers.dev values;
- the latest Pages deployment remains run `29387967237`, source SHA
  `35ad75abbe0708b873e768b2d361f8b6a1d08182`;
- production D1 remains at 1 account, 4 agents, 6 projects, 4 topics,
  13 records, 13 revisions, 3 sessions, 0 credentials, and 0 media assets,
  with zero foreign-key violations;
- the only expected D1 change is `backup_runs` increasing from 2 to 3 with the
  new successful manual run;
- cache KV remains `5c1574a9562448cf863aa84fad10877f` and was not written;
- media R2 remained at zero objects and was not written;
- `ORBIT_MEDIA_ENABLED=false` remains mandatory;
- no custom domain or route was added; and
- no paid Cloudflare feature was enabled.

## 9. Remaining gate

Gate 4 is complete. Gate 5 live-domain OAuth preparation and transition still
requires separate explicit approval. This report does not authorize a live
Worker deployment, OAuth credential change, custom-domain attachment, Orbit
DNS traffic cutover, Pages retirement, or any production restore.
