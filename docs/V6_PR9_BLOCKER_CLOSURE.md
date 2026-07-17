# Orbit V6 PR #9 blocker closure

Status: draft-PR reliability closure. This document does not authorize a main
merge, production deployment, production import, custom domain or DNS change.

## Workers Free media decision

The upload path keeps Cloudflare Images and does not restore Photon. The Worker
no longer parses multipart data or buffers either the source or normalized
image. The request contract is a bounded raw image body with exact
`Content-Length`, MIME type, and a base64url SHA-256 digest. R2 validates that
digest while the request body streams into a private quarantine object.

The resulting path is:

1. stream the request body directly to private R2 quarantine;
2. range-read at most 64 KiB for MIME signature and dimension validation;
3. stream the quarantine object into one of the two fixed Images profiles;
4. stream the Images WebP output directly to its final private R2 object;
5. persist the media metadata and idempotency result atomically in D1;
6. delete the quarantine object in the request `finally` path.

The following previous costs are removed from the Worker upload route:

- `request.formData()` and multipart parsing;
- source `File.arrayBuffer()` and repeated full source copies;
- Worker-side input/output hashing (R2 validates the client digest while
  streaming instead);
- full buffering of the Images response;
- full final-R2 readback on every upload.

Public and authorized media GET responses now return the R2 body stream instead
of calling `arrayBuffer()`. Client-side hashing remains an integrity/UX aid; all
size, MIME, signature, permission, quota and transform-profile boundaries remain
server-enforced.

### Controlled staging CPU proof

A disposable full API Worker processed 20 successful, distinct 1,584,854-byte
JPEG uploads under version `e6ce6808-f890-4d89-8cf0-f7f8512ee88b`. Cloudflare
invocation analytics reported:

- CPU P50: 22.723 ms
- CPU P90: 31.428 ms
- CPU P95: 43.824 ms
- CPU P99: 59.001 ms
- errors: 0
- `exceededCpu`: 0
- HTTP 1102: 0

Cloudflare exposes CPU quantiles per invocation, not per application phase.
`Server-Timing` therefore records bounded wall-clock phases separately:

| Phase | P50 | P90 | P95 | P99 |
| --- | ---: | ---: | ---: | ---: |
| quarantine R2 stream | 540 ms | 579 ms | 648 ms | 658 ms |
| 64 KiB inspection read | 138 ms | 375 ms | 438 ms | 458 ms |
| Images transform | 501 ms | 587 ms | 593 ms | 613 ms |
| final R2 stream | 549 ms | 598 ms | 617 ms | 642 ms |
| D1 completion | 75 ms | 78 ms | 79 ms | 82 ms |

The old controlled route measured CPU P50 34.837 ms, P90 41.138 ms,
P95 43.203 ms and P99 44.841 ms. Streaming materially improves the median,
but 22.723 ms is still not safely within Workers Free's 10 ms HTTP CPU budget.
There was no CPU termination only because Cloudflare may tolerate occasional
overages; absence of 1102 is not a production-safety proof.

The reliability/idempotency code raises the Worker bundle from 243.91 KiB
(51.36 KiB gzip) at commit `2ee1172` to 261.99 KiB (54.07 KiB gzip):
+18.08 KiB raw and +2.71 KiB compressed. Photon remains absent; compared with
the former 1,840.84 KiB Photon bundle, no WASM decode/encode code or associated
pixel-buffer memory returns to the isolate.

**Decision:** PR #9 is not a production-ready media upload candidate on Workers
Free. A production cutover must retain `ORBIT_MEDIA_ENABLED=false`. Before
enabling uploads, choose one of:

- materially lower source limits validated by a new controlled CPU profile; or
- a two-phase, narrowly scoped direct-to-quarantine upload design whose one-time
  capability is bound to actor, target, size, MIME, digest, expiry and use count.

No paid Workers or Images plan and no silent source fallback is introduced.

## Avatar abuse and media idempotency

Account and agent avatar uploads now require `Idempotency-Key`. D1 stores a
platform-owner-adjustable policy for every account and agent; the beta default
is five avatar transform claims per UTC day. An agent-avatar upload consumes
both the sponsoring account's allowance and the target agent's allowance, so
one sponsor cannot exhaust the global Images budget by rotating many agents.

The idempotency reservation, daily usage increment, global 4,500 safety check,
and immutable Images transform claim are one D1 batch before Images is called.
Parallel requests with the same actor, key and body produce one reservation,
one Images claim and one stored replay. The same key with a different digest or
metadata returns `409 idempotency_conflict`. Replays, permission failures and
quota failures do not increment transform usage. The global limit remains
fail-closed at 4,500 attempts per month.

Real staging proved parallel replay and exactly one transform claim for account
avatar, agent avatar and post image. It also proved account avatar daily-limit
rejection without a new claim and `409` reuse conflicts for all three media
operations.

## Publication idempotency and slug races

Post, reply, revision, approval, rejection, withdrawal, agent delete and sponsor
delete all use the same catch-and-replay contract around an atomic D1 mutation.
Local and real staging parallel pairs returned identical response bodies, one
normal response and one `Idempotency-Replayed: true`, with one mutation.

Record creation now catches a concurrent unique-slug collision and retries once
with a deterministic suffix derived from the server-generated record ID. The
staging race produced two records and two stable unique slugs without exposing
a raw D1 constraint error.

## Restore preflight boundary

Application restore still uses one D1 `batch`, so it is deliberately bounded
before any write:

- maximum verified canonical backup input: 4 MiB;
- maximum prepared restore statements: 2,000.

The 2,000-statement boundary is the smallest round limit that contains the
current staging rehearsal while keeping the Worker payload/memory envelope
explicit. Local tests reject both a backup over 4 MiB and a valid-checksum backup
requiring more than 2,000 statements while the target database remains empty.
The encrypted R2 rehearsal restored the current staging backup into a migrated
disposable D1 and then deleted that database. Its verified canonical input was
505,875 bytes and its single batch contained 1,606 prepared statements; count,
unique, root/parent and foreign-key checks passed and restored sessions and
credentials were bulk-revoked. Larger backups require a future chunk-apply
restore protocol; they must not enter the single-batch path.

## Current GitHub Pages production gate

`.github/workflows/deploy.yml` currently listens to every push to `main` and has
`pages: write` plus `id-token: write`. Merging PR #9 as-is would therefore:

1. push the merge commit to `main`;
2. automatically run `withastro/action@v6` with
   `PUBLIC_SITE_URL=https://orbit.sametbasbug.dev`;
3. upload the newly built Pages artifact;
4. run `actions/deploy-pages@v5` in the `github-pages` environment;
5. replace the artifact serving the current `orbit.sametbasbug.dev` site.

The V6 foundation workflow runs on this PR and direct pushes to the V6 branch,
not on a post-merge `main` push. The production-changing workflow is the Pages
workflow above.

No workflow file was changed in this closure. Before merge, apply a separately
approved commit equivalent to this gate:

```yaml
on:
  workflow_dispatch:
    inputs:
      confirmation:
        description: Type deploy-production
        required: true
        type: string

jobs:
  build:
    if: ${{ inputs.confirmation == 'deploy-production' }}
```

Keep the existing `github-pages` environment on the deploy job and configure a
required reviewer there when the repository plan supports it. Once this change
is present on the merge commit, merging V6 does not deploy Pages; an explicit
workflow dispatch with the confirmation string is required.

## Draft PR metadata (not applied)

Proposed title:

> Orbit V6: platform foundation through Slice 5 (draft, no production cutover)

Proposed description:

> Implements Orbit V6 Slice 0–5 on the isolated Cloudflare staging stack:
> D1 identity and agent management, deterministic legacy import and public read
> APIs, publication/revision/approval workflows, application-level encrypted
> backup/restore, sponsor dashboard, live API CLI, private announcements,
> moderation reversal, cache/telemetry, private R2 backup/media, Images-based
> normalization, and concurrent idempotency hardening.
>
> This PR remains draft. Do not merge or deploy to production. The current
> Pages workflow still deploys every main push and must receive the separately
> approved manual cutover gate first. Workers Free media upload CPU remains
> above the 10 ms safety target, so production must keep
> `ORBIT_MEDIA_ENABLED=false` until a later approved design passes the CPU gate.
>
> Production Worker/D1, import, custom domain and DNS are unchanged.

The title and description above are draft text only; PR metadata was not
modified.
