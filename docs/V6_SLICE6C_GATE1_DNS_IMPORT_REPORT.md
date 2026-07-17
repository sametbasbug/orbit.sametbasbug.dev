# Orbit V6 — Slice 6C Gate 1 DNS Import Report

Status: **PASS — pending Cloudflare zone prepared; delegation not changed**

Report date: `2026-07-17`

Starting main SHA: `60c8b00d2c2d13cca46a9a2d11c91afea93aecee`

This report records the secret-free evidence for Slice 6C Approval Gate 1. It
does not contain raw DNS content, verification tokens, DKIM values or other
sensitive TXT data. The Name.com export, derived BIND file and exact local
comparison manifest remain outside Git in restricted operational storage with
a second offline copy.

Gate 1 authorized export, deterministic conversion, a Free-plan pending
Cloudflare zone, DNS-only import and pre-delegation verification. It did not
authorize or perform registrar delegation, DNSSEC, live traffic, Worker,
OAuth, Pages or production-data changes.

## 1. Source and derived artifacts

| Artifact | Bytes | SHA-256 | Records |
| --- | ---: | --- | ---: |
| Raw Name.com CSV | 1,095 | `94c5f8fb7a7d981783fd6b0fc7ea3354dd86bbde9f3abdadf7e3b2ed96fe0655` | 21 |
| Derived Cloudflare-compatible BIND zone | 853 | `6c8f27a83fd9e480100dc9ebcd4eb52b7a005e04c93bab3eb1c6b5a52d81b1c6` | 21 |

The export timestamp recorded from the raw file was
`2026-07-17T03:01:48.534949+00:00`. The CSV contained 22 lines including its
header. Primary and offline copies produced identical hashes and were stored
with owner-only permissions.

The converter accepted the exact Name.com schema
`(Type, Host, Answer, TTL, Priority)`, rejected unknown types and ambiguous
owners, and produced one destination record for every source record. It did
not infer or add records.

| Type | Source | Imported |
| --- | ---: | ---: |
| `A` | 4 | 4 |
| `CNAME` | 8 | 8 |
| `MX` | 6 | 6 |
| `TXT` | 3 | 3 |
| **Total** | **21** | **21** |

The source export included the apex web records, `www`, `orbit`, `auth`,
`equinox`, `haber`, `play`, `selene`, `status`, all six MX priorities, SPF and
verification TXT records. It contained no AAAA, DMARC or DKIM-selector record;
none was invented or imported.

## 2. Pending Cloudflare zone

The `sametbasbug.dev` zone was added on Cloudflare's Free plan and remains in
`pending` state. Cloudflare assigned:

- `harley.ns.cloudflare.com`
- `hera.ns.cloudflare.com`

The registrar still delegates to the four original Name.com nameservers. The
assigned Cloudflare pair was recorded only and was not applied at Name.com.

All 21 source records were imported. Cloudflare's import preview initially
selected proxying for 12 eligible web records; every one was explicitly set
to **DNS only** before completion. Final proxy count is zero.

Cloudflare initially normalized the 12 `A`/`CNAME` TTL values to `Auto`. Before
parity acceptance, those records were corrected to the source TTL of 300
seconds. Final imported TTL values are exactly 300 seconds for all 21 records.
No TTL normalization remains in the accepted state.

Cloudflare's own SOA/NS control-plane records were evaluated separately from
the 21 user records. DNSSEC status is `disabled` and no DS record was created.

## 3. Exact parity evidence

The canonical comparison tuple was:

```text
(name, type, content, priority, TTL)
```

Sensitive values were compared exactly in the restricted local manifest but
are not repeated here. Cloudflare's API representation added a single outer
quote layer around TXT values; canonical comparison removed only that
representation layer and preserved exact TXT content.

| Check | Result |
| --- | --- |
| Source/import record count | `21 / 21` |
| Canonical tuple SHA-256 | `920d2c1cd79641698550e9c57758fc1601b2a4805cfe827a7a0bf75e46487083` |
| Unexplained missing records | `0` |
| Unexplained extra records | `0` |
| Duplicate/conflicting records | `0` |
| Incorrect proxy state | `0` |
| MX priority parity | exact |
| TXT/SPF/verification parity | exact |
| `orbit` target | unchanged GitHub Pages target, DNS only |

## 4. Pre-delegation authoritative verification

Both pending Cloudflare authoritative nameservers were queried directly. Each
answered authoritatively for the zone and returned all 21 source records with
the same canonical tuple digest.

| Nameserver | Queries | Records | Missing | Extra | Duplicate | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `harley.ns.cloudflare.com` | 12 | 21 | 0 | 0 | 0 | PASS |
| `hera.ns.cloudflare.com` | 12 | 21 | 0 | 0 | 0 | PASS |

The same exact verification was run against all four currently authoritative
Name.com nameservers. Each returned 21 records, zero missing/extra/duplicate
records and the same canonical tuple digest. This includes exact MX ordering,
SPF and exported verification records. No mail message or mailbox state was
changed during this read-only DNS verification.

Direct Cloudflare queries were pre-delegation tests only; they did not direct
public traffic to Cloudflare.

## 5. Non-mutation evidence

Checks repeated after the import confirmed:

- parent delegation still lists only `ns1kpv.name.com`, `ns2dqx.name.com`,
  `ns3jnr.name.com` and `ns4hmp.name.com`;
- the public DS answer remains empty;
- public `orbit.sametbasbug.dev` remains a CNAME to
  `sametbasbug.github.io.`;
- the public site remains HTTP 200 from `server: GitHub.com`;
- public `/healthz` remains HTTP 404 from GitHub Pages;
- the latest Pages workflow run remains `29387967237`, deployed from
  `35ad75abbe0708b873e768b2d361f8b6a1d08182` on 2026-07-15;
- production Worker serving version remains
  `01384034-5584-4181-8763-b31e3aecf95e` (version 4);
- the Worker remains Workers.dev-only with no custom domain, and `/healthz`
  still carries `X-Robots-Tag: noindex, nofollow, noarchive`;
- the production OAuth App still uses the exact Workers.dev homepage and
  callback;
- production D1 remains `199fe088-2f56-48c4-bc81-50b8c5e4b471`, KV remains
  `5c1574a9562448cf863aa84fad10877f`, and the two private production R2 buckets
  remain present;
- no production Worker deploy, D1/KV/R2/backup mutation, OAuth mutation,
  GitHub Pages deploy, custom-domain operation or paid feature was performed.

Temporary upload bridge copies were removed after the primary and offline
artifact hashes were reverified. The canonical restricted operational copies
remain outside Git.

## 6. Gate result and next approval

**Slice 6C Gate 1 result: PASS.**

The pending Cloudflare Free zone is an exact DNS-only copy of the Name.com
export, with zero unexplained drift, DNSSEC disabled and authoritative
pre-delegation checks passing on both assigned nameservers. Public delegation
and Orbit traffic remain unchanged.

Gate 2 — changing the authoritative nameservers at Name.com — still requires a
separate explicit approval and a bounded execution/rollback window. This
report does not authorize Gate 2, DNSSEC, Worker live mode, OAuth live-domain
changes, Worker custom-domain attachment or Orbit traffic cutover.
