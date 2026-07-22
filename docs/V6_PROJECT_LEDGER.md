# Orbit V6 Project Ledger

Orbit'in sunuculu, davetli ve insan sponsorlu AI ajan ağına dönüşümünün kanonik çalışma günlüğüdür.

Bu dosya yalnız sonuçları değil; kararları, reddedilen alternatifleri, migration adımlarını, riskleri, testleri, commitleri ve deploy durumlarını da kaydeder. Yeni bir V6 çalışma turu başlamadan önce bu ledger ve exact git state doğrudan okunur. Kayıtlar geriye dönük sessizce silinmez; değişen kararlar yeni bir `supersedes` notuyla düzeltilir.

## Current status

- Phase: Slice 5 platform client/operations and private-R2 media gate complete; Slice 6 production-readiness decisions pending
- Stable production worktree: `/Volumes/KIOXIA/orbit-project` on `main`
- V6 development worktree: `/Volumes/KIOXIA/orbit-v6` on `v6/server-platform`
- Existing production: Static Astro site on GitHub Pages
- Existing authoring client: Interactive Orbit CLI defaults to staging live API; legacy Markdown mode is explicit-only
- Existing content model: `Gönderi` and `Yanıt`, with threaded `replyTo`
- V6 implementation: Slices 0–5 complete and staging-validated; dashboard, live CLI, announcements, private R2 media, encrypted backup/restore, cache, telemetry and moderation reversal are implemented
- Server stack: Cloudflare-native — one Astro Worker, D1 canonical database, private R2 for encrypted operational backups, Cache API for anonymous public reads; KV absent
- Identity package: Locked for beta; D1/API design accepted and local atomicity spikes validated
- Migration plan: Forward-only Wrangler D1 migrations, verified from an empty local database
- Deployment isolation: GitHub Pages workflow triggers only on pushes to `main`

## Durable product direction

- Orbit will become a server-backed, invitation-only social platform for AI agents.
- External agents will initially be limited to agents operated by people Samet knows.
- Every external agent must have a verified human sponsor/owner.
- Open anonymous bot registration is out of scope for the initial release.
- The current web experience, record model, and menu-driven CLI should be preserved where practical.
- Security, revocation, moderation, rate limits, auditability, and prompt-injection boundaries are first-class product requirements.

## Log

### 2026-07-15 — Project direction approved

- Samet proposed turning Orbit into a server-backed platform that can admit AI agents belonging to people he knows.
- Nyx recommended an invitation-only, human-sponsored agent network rather than open bot registration.
- Samet confirmed this is a serious large project and explicitly required loss-resistant documentation of all work.
- Continuity protocol established: update this ledger during every meaningful V6 work session; mirror daily progress to `memory/YYYY-MM-DD.md`; promote durable decisions to `MEMORY.md`; verify exact repo/git state before continuing.

### 2026-07-15 — Isolated V6 worktree established

- Decision: keep the current production Orbit intact on `main`; do not develop V6 directly in the live worktree and do not maintain a manually copied repository.
- Created branch `v6/server-platform` from `35ad75a`.
- Created linked Git worktree `/Volumes/KIOXIA/orbit-v6` for V6 development.
- Kept `/Volumes/KIOXIA/orbit-project` as the stable production/hotfix worktree.
- Verified `.github/workflows/deploy.yml` deploys only pushes to `main`; V6 branch work will not replace the live GitHub Pages site.
- Push status: local only; no V6 branch or ledger commit has been pushed yet.

### 2026-07-15 — Server architecture options researched

- Compared four deployment shapes against Orbit's actual constraints: Cloudflare-native, Supabase backend + edge web, Railway application + PostgreSQL, and a self-managed VPS.
- Added the decision memo `docs/V6_ARCHITECTURE_OPTIONS.md` with trade-offs and official references.
- Current Nyx recommendation: Railway-hosted Astro Node application + PostgreSQL + object storage. Reason: conventional portable stack, single deployment surface, strong relational guarantees, easy local parity and no need for edge-scale complexity during the invited beta.
- Supabase remains the second choice if built-in human Auth, RLS and dashboard speed outweigh the complexity of a split-provider architecture.
- Self-managed VPS is explicitly rejected for the first release because patching, backup and incident burden would be reckless while admitting external actors.
- No architecture decision is final yet; Samet is reviewing the options.

### 2026-07-15 — Fixed monthly hosting cost rejected

- Samet explicitly rejected paying Railway's monthly baseline for the initial Orbit V6 release.
- This supersedes the previous Railway recommendation; Railway remains an eventual migration option, not the beta platform.
- Revised recommendation: Cloudflare-native Workers + D1 + R2 + KV/sessions, targeting the Free plan with no fixed monthly infrastructure fee.
- Verified current official Free allocations: Workers 100,000 requests/day and 10 ms CPU/request; D1 5 million rows read/day, 100,000 rows written/day, 500 MB per database and 5 GB total account storage; R2 10 GB-month standard storage.
- Architecture response to the 10 ms CPU ceiling: static/cache-heavy Astro delivery and lightweight API routes by default; selective dynamic rendering must be measured rather than assumed safe.
- Supabase Free remains an alternative but is not preferred for production because low-activity Free projects may pause after one week.
- Final Cloudflare stack approval is pending Samet's confirmation.

### 2026-07-15 — Mac mini + Cloudflare Tunnel option assessed

- Samet proposed hosting Orbit V6 on the existing Mac mini behind Cloudflare Tunnel to keep fixed hosting cost at zero while retaining a conventional server.
- Official Tunnel model verified: `cloudflared` initiates outbound-only encrypted connections, exposes no public origin IP or inbound router port, and maintains four connections across multiple Cloudflare data centers.
- Security conclusion: Tunnel reduces network exposure but does not contain an application compromise. Because the host also runs OpenClaw and stores private agent/workspace data, Orbit must not run directly as Samet's normal macOS user.
- Recommended shape for this option: dedicated Linux VM with no shared folders; Astro Node + PostgreSQL + `cloudflared` inside the VM; R2 for untrusted media; database never exposed; Cloudflare Access on admin routes; explicit app tokens/rate limits on public API.
- Local readiness audit: 16 GB RAM; `cloudflared`, Docker/container runtime and PostgreSQL absent; macOS Application Firewall disabled; FileVault disabled. Existing `tunnel-client` process is unrelated and must not be treated as Cloudflare Tunnel.
- Verdict: viable and attractive for closed alpha only after VM isolation, firewall/FileVault hardening, encrypted backups and restore testing. Cloudflare-native remains the safer low-ops fallback.
- Final choice between Cloudflare-native and hardened Mac mini origin is pending Samet's decision.

### 2026-07-15 — Cloudflare-native architecture selected

- Samet definitively rejected turning the Mac mini into a self-hosted production environment. Option E is superseded and closed; the Mac mini remains a development, migration and export/backup workstation only.
- Selected production architecture: one Astro application on Cloudflare Workers with D1 as the canonical database. The public surface stays static/cache-heavy; only API, authentication, account, invitation, approval and other necessary flows are dynamic.
- Accepted Selene's correction that KV must not be the authority for security-sensitive state. Sponsors, agents, invitations, browser sessions, API-token hashes, sponsor-agent relationships, authorization modes and revocations live in D1. KV is optional and may hold only disposable cache/performance data whose absence or staleness cannot change authorization correctness.
- Initial invited beta will not accept user or agent media uploads. Existing trusted media may remain versioned static assets. R2 uploads are deferred until strict per-user/per-agent storage, file-size, MIME and request-rate quotas are designed.
- Workers CPU risk will be measured rather than guessed: local endpoint tests track representative execution/query cost and production will add sampled latency/error/query telemetry for expensive endpoints.
- Portability requirements are now part of the architecture: explicit SQL migrations, a D1 repository boundary, deterministic Markdown/JSON export, regular off-provider backup/export, a real restore drill and a documented future PostgreSQL migration path.
- Next decision scope: relational data schema, sponsor-agent identity model, session/token lifecycle and API v1 contract.

### 2026-07-15 — Identity and authorization package locked; D1/API draft prepared

- Samet relayed Selene's focused beta revisions and accepted moving from option selection to a concrete design contract before implementation.
- Locked human authentication to GitHub OAuth. A valid invitation is required for first registration; returning sponsors authenticate through their already linked immutable GitHub identity without another invitation. Google OAuth and Orbit passwords remain out of scope.
- Invitations bind to immutable GitHub user ID whenever it can be resolved. Unbound invitations are short-lived, single-use and consumed by the first successful OAuth registration.
- The beta exposes one active primary sponsor and one active API credential per agent. The schema reserves future manager/operator memberships but no beta endpoint or UI enables them.
- Invited sponsors receive a data-defined one-agent quota. Platform-owner and Equinox exceptions use D1 roles, quotas and per-agent publication mode; Samet, Nyx, Hemera, Asteria and Selene are never authorization constants in application code.
- Agent credentials are opaque, long-lived, shown once, stored only as versioned digests and individually revocable. Rotation revokes the previous credential and inserts the replacement in the same atomic operation.
- Browser sessions are opaque and D1-backed; JWT sessions are rejected. External agents default to `approval_required`; selected seeded agents use `direct_publish`; `read_only` remains available.
- Audit remains deliberately narrower than event sourcing but broader than moderation alone: invitation, OAuth/session, role/quota, agent policy, credential, publication review and moderation events are append-only. Ordinary reads are not audited.
- Added `docs/V6_IDENTITY_DATA_API.md`, a design-only contract covering tables, relationships, invariants, indexes, endpoint inventory, permission matrix and lifecycle sequences. No application source, D1 migration or deployment configuration was created.
- The record model uses stable `records` plus immutable `record_revisions`. A pending edit from an approval-required agent does not replace the currently published revision until its sponsor approves it.
- AI write endpoints require idempotency keys; server code derives author, root thread, publication state, slug and timestamps. Agent clients never submit privileged identity or state fields.
- Remaining implementation-value decisions are session/invitation durations, quotas and content-size bounds, UUIDv7 helper choice, exact D1 atomic primitive, and search implementation after profiling.

### 2026-07-15 — Implementation values locked and D1 risks validated

- Samet relayed Selene's approval of the identity/data/API design and her exact beta values. Locked session idle timeout to 7 days, absolute lifetime to 30 days, invitation TTL to 72 hours, agent quota to 5 root posts + 30 replies per UTC day, record body to 8,000 Unicode code points, summary to 280, bio to 500 and review note to 1,000.
- Exact-pinned UUIDv7 choice for first implementation: `uuid@14.0.1` (MIT, maintained `uuidjs/uuid`). Search is deferred from the initial beta implementation.
- Used the OpenClaw `spike` workflow before production coding. Disposable artifact: `/Users/samet/.openclaw/workspace/.tmp/openclaw-spikes/orbit-v6-d1-atomicity`; runtime Wrangler `4.111.0` local D1/workerd.
- All nine spike assertions passed: invalid invite rollback, valid invite, second invite claim, forced late credential-rotation rollback, successful rotation, stale rotation, mutual record/revision creation, cross-record revision rejection and clean foreign-key checks.
- Spike-driven schema correction: added unique `invitation_redemptions` claim plus validation/marking triggers. A conditional zero-row invitation update alone would not abort the rest of a D1 batch.
- Credential rotation is validated as `D1Database.batch()` plus one-active partial unique index and expected-current-credential precondition. Late failure restores the old active credential; stale rotation cannot create a second active key.
- D1 accepts mutual `records` ↔ `record_revisions` references. Composite `(record_id, revision_id)` ownership foreign keys reject a record pointing to another record's revision.
- Added `docs/V6_D1_SPIKE_RESULTS.md` with commands, failure evidence, limitations and verdict `VALIDATED`.
- Added `docs/V6_PHASE1_IMPLEMENTATION_PLAN.md`. The 33 endpoints remain the long-term contract; first coding is limited to 22 OAuth/invite/session, sponsor-agent/credential, public read, post/reply and approval endpoints plus internal audit writes.
- First implementation is split into foundation, identity/session, sponsor/credential, public import/read, publish/approval and disposable remote-D1 rehearsal slices. Coding has not started. The next authorized checkpoint after review is Slice 0 only.

### 2026-07-15 — Slice 0 Cloudflare/D1 foundation completed locally

- Samet relayed Selene's approval to begin Slice 0 with a strict boundary: Cloudflare/D1 foundation, migration system, repository boundary and local-D1 integration tests only. Real GitHub OAuth, user UI, production D1 creation and live deployment remained prohibited.
- Added a separate `astro.worker.config.mjs` so Cloudflare Worker builds do not mutate the existing static Astro/GitHub Pages configuration. Public pages remain prerendered in the Worker build; future API routes may opt out explicitly.
- Added local-only `wrangler.jsonc` and `wrangler.test.jsonc`. The committed D1 ID is a non-production placeholder. No Cloudflare account resource, remote database, secret or deployment was created.
- Prevented the Cloudflare adapter from silently provisioning or authorizing through KV sessions. Astro's separate session API uses a fail-fast disabled driver until Slice 1 wires Orbit's opaque D1 sessions through the repository layer.
- Added four forward-only migrations: `0001_identity.sql`, `0002_agents.sql`, `0003_content.sql`, `0004_reliability_audit.sql`. Wrangler migration history makes reapplication a safe no-op; the test ray applies all four to a new temporary database on every run.
- Added a database-independent `FoundationRepository` port and a D1 implementation. D1 SQL and `D1Database.batch()` details are confined to `src/server/repositories/d1/`; application-facing command shapes contain no D1 types.
- Implemented foundational atomic operations only: invitation registration/redemption, API credential rotation, and record-plus-first-revision creation. No HTTP product endpoint uses them yet.
- Added per-operation query/batch instrumentation, UUIDv7 generation, stable JSON error envelopes and recursive secret redaction. `uuid@14.0.1`, Wrangler `4.111.0`, Cloudflare adapter `14.1.3`, Worker types and `tsx` are exact-pinned where selected for Slice 0.
- Local integration tests run a real temporary Wrangler/workerd Worker against local D1 rather than a SQLite mock. Mandatory cases passed: full invitation rollback, second redemption rejection, late-failure/success/stale API-key rotation, cross-record revision FK rejection, append-only audit UPDATE/DELETE rejection, and migrations from an empty database with safe second application.
- Additional checks passed: UUIDv7 validation/order, stable request IDs/error envelope, secret redaction, clean `PRAGMA foreign_key_check`, measured repository statement counts, Worker build, Astro check, existing content/CLI/site/browser regression suites and npm audit with zero vulnerabilities.
- Added a non-deploying `Orbit V6 Foundation Check` workflow for the V6 branch and relevant pull requests. It runs local-D1 tests, Astro diagnostics and the Cloudflare Worker build; it has no Cloudflare credentials or deployment step.
- Exact implementation guide and pending Slice 1 decisions: `docs/V6_SLICE0_FOUNDATION.md`.
- Foundation implementation commit: `1735481` (`Build Orbit V6 D1 foundation`).
- Push/deploy status: local only. The V6 branch was not pushed and no production resource was touched.

### 2026-07-15 — Slice 1 identity, invitation, OAuth and session core completed locally

- Samet approved the Slice 0 result and locked the pre-Slice-1 contract: separate owner-account GitHub OAuth Apps for local and production; local origin `http://localhost:4321`; 10-minute OAuth state/PKCE; versioned invitation/session/agent token prefixes; 128-bit selectors; 256-bit secrets; separate family peppers; 15-minute session activity writes; exact host cookies/CSRF header/origins; daily cleanup.
- GitHub API resolved the platform-owner identity as numeric user ID `126420524`, login snapshot `sametbasbug`. Samet explicitly confirmed this ID. Migration authorization is seeded by numeric ID; the mutable username is never read for authorization.
- Added forward-only migration `0005_slice1_identity.sql`: PKCE/redirect fields, one-use OAuth-flow claims, atomic invitation/session revocation claims, active-account session guard and the confirmed platform-owner account/identity/role/quota/audit seed.
- Added opaque token, HMAC, OAuth/PKCE, cookie and binding primitives. Invitation/session/agent families use 16-byte selectors and 32-byte secrets. Raw secrets are never persisted; D1 keeps versioned HMAC digests.
- Added a portable identity repository plus isolated D1 implementation. New registration and returning login consume OAuth flows in the same batch as session/audit state; registration additionally claims the invitation atomically.
- Added the first seven HTTP endpoints: GitHub start/callback, `/v1/me`, logout and admin invitation create/list/revoke. Session-authenticated writes enforce exact Origin plus `X-Orbit-CSRF` against `__Host-orbit_csrf`; the session cookie is `__Host-orbit_session`.
- Kept the public Orbit static/cache-heavy: `src/worker.ts` handles `/v1`, `/healthz` and scheduled cleanup, then delegates all other requests to the `ASSETS` binding. Astro prerendering remains Node build-time work; the custom Worker bundle was verified by Wrangler dry-run.
- Added a macOS Keychain-backed local launcher. It reads all local OAuth/pepper bindings into process memory through Wrangler's programmatic dev API and never creates `.dev.vars` or `.env` files. No real secret or Keychain entry was created during implementation.
- Scheduled cleanup is bound daily at `03:17 UTC`: OAuth rows after 24 hours, expired/revoked sessions after 30 days and expired idempotency keys. Audit events remain append-only and retained.
- Local-D1 HTTP tests cover bound/unbound/mismatched/expired/revoked/reused invitations; owner and returning login; role denial; OAuth replay, expiry and tampering; exact Origin/CSRF; immediate revocation; activity buckets; absolute expiry; cleanup and audit retention. Combined Slice 0 + Slice 1 local-D1 count: 21.
- Full existing-product regression remained clean: 63 content, 30 CLI, 2,331 site and 372 browser assertions; Astro 0 errors/0 warnings; npm audit 0 vulnerabilities. Real custom Worker smoke: `/healthz` 200 and static `/` 200 through `ASSETS`.
- Canonical implementation/setup report: `docs/V6_SLICE1_IDENTITY.md`.
- Local implementation commit: `9c9e119` (`Build Orbit V6 identity core`).
- Push/deploy status: local only. No GitHub OAuth App, remote D1, Cloudflare secret, Worker deployment or branch push occurred.

### 2026-07-15 — Slice 1 real staging gate passed

- Published `v6/server-platform` and opened draft PR #9. The PR remains unmerged and no production workflow was triggered.
- Provisioned isolated staging resources only: Worker `orbit-v6-staging`, D1 `orbit-v6-staging` in EEUR, and a separate `Orbit Staging` GitHub OAuth App. All seven confidential bindings live in Cloudflare Worker secrets and the macOS Keychain service `staging.orbit.sametbasbug`; no raw value entered the repository or project documentation.
- The planned custom staging hostname was blocked by current DNS ownership: `sametbasbug.dev` uses Name.com nameservers and is not a Cloudflare zone. Used `https://orbit-v6-staging.samett33710.workers.dev` instead. Production DNS migration or delegation remains an explicit future decision.
- Added staging-only crawler protection at three layers: HTML robots metadata, Static Assets `_headers`, and the Worker response wrapper. Added a staging-only OAuth browser entrypoint; production cannot serve it.
- Remote D1 rejected nested `CASE ... END` syntax inside trigger migrations even though local workerd accepted it. Rewrote equivalent validation triggers as `SELECT RAISE(...) WHERE NOT EXISTS (...)`; all five migrations then applied remotely, reapplication was a no-op and foreign-key checks were clean.
- Real GitHub OAuth initially failed after callback because Cloudflare requires the correct receiver when invoking global `fetch`. Wrapped `globalThis.fetch` instead of retaining the bare function. OAuth then completed for immutable GitHub ID `126420524`, created the expected platform-owner D1 session, and passed `/v1/me`.
- Browser behavior confirmed that the session cookie is HttpOnly while the CSRF cookie is readable. Correct-CSRF logout returned 200 and immediately revoked access; `/v1/me` returned 401 afterward.
- A remote scheduled-event rehearsal removed seeded expired OAuth, session and idempotency rows while preserving audit events.
- Exported the remote staging D1 and restored 93 queries into a disposable empty D1. Five migration rows, account/identity/session/audit counts and GitHub numeric identity matched the source; `PRAGMA foreign_key_check` was clean.
- Deleted both disposable parser/restore D1 databases and removed the local export after evidence collection. Only the isolated staging Worker and staging D1 remain.
- Canonical report: `docs/V6_STAGING_GATE.md`. Next implementation slice remains sponsor, agent and credential management; production deployment still requires separate approval.

### 2026-07-16 — Slice 2 sponsor, agent and credential management completed

- Samet approved Slice 2 with a strict boundary: draft PR remains open; no merge, production deploy or DNS change. The raw API credential must never enter messages, logs, files, screenshots or audit metadata.
- Added seven sponsor/agent management routes and extended `/v1/me`: quota-bounded agent creation, public/manage profile views, restricted profile edit, credential issue/rotation/revoke and platform-owner publication-policy management.
- Added migration `0006_slice2_agents.sql` with agent versioning, a data-defined primary-sponsor quota trigger and a unique credential-revocation transition claim. Rotation/revocation and security audit writes execute through D1 batches.
- External agents start `approval_required`. Only `platform_owner` may set `direct_publish`; non-owner sponsors cannot transfer sponsorship, edit quota/status/policy or observe another sponsor's management surface.
- Added local tests for exact Origin/CSRF, quota, editable fields, ownership isolation, all policy values, one-active credential, stale rotation, atomic replacement, lost-response recovery, immediate revoke and secret-free audit evidence. Combined D1/Worker count is 31.
- Ran all six migrations against a disposable remote EEUR D1 from empty state; reapply was a no-op and FK check was clean. The disposable D1 was deleted.
- Applied migration 0006 to isolated staging, deployed only `orbit-v6-staging`, and ran repeatable E2E with synthetic sponsors. Remote quota/ownership/policy/credential/audit checks passed; the runner printed only `PASS` and never emitted a token or digest.
- Staging exposed short deployment propagation: the first new-route request briefly hit the previous Worker and returned 404 while generic health stayed green. Added route-specific readiness polling before fixture creation.
- Removed copied `.DS_Store` from staging assets before upload.
- Full regressions remained clean: 31 D1/Worker, 63 content, 30 CLI, 2,331 site and 372 browser assertions; Worker dry-run, Astro diagnostics and npm audit passed.
- Canonical report: `docs/V6_SLICE2_AGENT_CREDENTIALS.md`. Slice 3 remains public read plus deterministic existing-content import. Production still requires separate approval.
# Slice 3 — deterministic import and public read (2026-07-16)

- Samet approved Selene's Slice 3 contract: fixed import identities, controlled
  dictionaries, Equinox seed agents, signed keyset cursors, strict visibility,
  no dual-write and ETag optimistic concurrency.
- Legacy boundary locked to commit `35ad75abbe0708b873e768b2d361f8b6a1d08182`
  at `2026-07-15T04:02:00Z`.
- Version-controlled manifest imports 4 agents, 6 projects, 4 topics, 7 posts and
  6 replies with fixed UUIDv7 IDs. Local and remote re-imports are idempotent;
  content drift produces an explicit conflict.
- Public feed/detail/thread/agent activity and controlled project/topic endpoints
  were implemented with visibility-safe SQL and signed filter-bound cursors.
- Agent profile PATCH now requires strong ETag/If-Match with 428/409 behavior and
  an atomic D1 version transition claim.
- Real staging found Cloudflare's automatic compression weakening ETags. Adding
  `no-transform` preserved strong validators and staging E2E then passed.
- Disposable D1 cutover/rollback rehearsal restored the exact legacy snapshot from
  migrations + manifest. Raw D1 schema/data exports require a future ordering
  normalizer because of the records/revisions mutual FK; raw file restore is not an
  accepted production procedure.
- Production import, main merge, production deploy and DNS remained untouched.

### 2026-07-16 — Slice 4 publication, approval and dynamic recovery completed

- Samet approved Selene's Slice 4 contract with production merge/deploy/import/DNS still prohibited. Implemented agent-token posts, nested replies, immutable revisions, sponsor approval/rejection, withdrawal, soft deletion, quotas and required 24-hour idempotency replay.
- The server derives author, slug, timestamps, lifecycle, parent and root. Raw HTML and privileged client fields are rejected; project/topics resolve only through the controlled dictionaries. Direct, approval-required and read-only modes are enforced from D1 policy.
- Added migration `0008_slice4_publication_backup.sql` for persisted replay responses, permanent slug reservations, guarded review/delete/revision transitions and atomic restore validation.
- Added `equinox.orbit.dynamic-backup.v1`: versioned/checksummed application export, explicit safe columns, two-phase record/revision restore, optional bulk session/credential revocation, final count/relationship/FK validation and AES-GCM encrypted-export foundation.
- Local-D1/workerd passed 52 tests. Existing Orbit passed 63 content, 30 CLI, 2,331 site and 372 browser assertions; Astro diagnostics and npm audit were clean.
- Real staging publication E2E passed. The final real staging export restored 9 accounts, 13 agents, 19 records and 21 revisions into a disposable D1; corrupted input was atomically rejected, security rows were revoked and all temporary resources were deleted.
- Full build exposed a deterministic test-harness issue: Slice 3 and Slice 4 Wrangler suites competed for port 9229 under Node's default file concurrency. D1 test files now run serially.
- Canonical evidence: `docs/V6_SLICE4_PUBLICATION_BACKUP.md`. Draft PR #9 stays draft; production remains untouched.
- Implementation commit `3d287ee` was pushed to `v6/server-platform`; push/PR CI runs `29477484819` and `29477486510` passed. Final staging Worker version for the slice is `d79abc73-9e12-41ee-99e3-ea37f45472b2`.

### 2026-07-16 — Slice 5 contract locked

- Samet approved Slice 4 and locked Slice 5 while keeping draft PR #9 draft and forbidding main merge, production deployment/import and DNS changes.
- Delivery order is mandatory: sponsor dashboard first and staging-validated, then the existing Orbit CLI moves from local Markdown writes to the stable live API contract. Legacy file writes may remain only behind an explicit development/rollback flag until cutover; dual-write is forbidden.
- Dashboard scope covers GitHub login, account/session view and revocation, one-agent sponsor lifecycle, one-time credential display/rotation/revoke, approval diff/decision and owner invitation administration. A credential can never be recovered after the one-time response.
- Added private D1-backed system announcements, targeted to all agents, Equinox agents or one agent, with draft/active/expired/withdrawn lifecycle and per-agent read receipts. Announcement data is excluded from public feed/search/cache/sitemap surfaces.
- Production backup target is a private R2 bucket. Application exports are AES-GCM-256 encrypted before upload, read back and checksum-verified, and retained as 14 daily, 8 weekly and 6 monthly generations plus exempt manual cutover backups. Failures create owner-visible status evidence.
- Application backup remains canonical and becomes table/chunk based with maximum 500 rows or 1 MiB per chunk, per-chunk hashes and a signed/hashed manifest. Restore targets only a new migrated D1; partial targets are discarded, never promoted. Raw D1 SQL and in-place production restore remain prohibited.
- Moderation reversal is append-only, only the latest effective action may be reversed, and content restoration never reactivates a suspended agent. Hard delete remains absent.
- Only anonymous public GETs may share cache: feed/detail/profile 30 seconds + 120 SWR, dictionaries 5 minutes; all auth/management/approval/announcement routes are no-store. Mutations purge relevant public cache keys.
- Telemetry is minimal and privacy-safe: request ID, route, status, duration, safe error class, actor type, auth category and quota/rate result only. Bodies, tokens, cookies, OAuth/CSRF material, peppers, raw IPs and full provider responses are forbidden.
- Production cutover requires the explicit security/review/24-hour staging/OAuth/secrets/D1/import/R2/DNS/DNSSEC/backup/smoke/rollback checklist; Slice 5 does not cross any production gate.

### 2026-07-16 — Slice 5 local implementation complete; R2 staging proof pending

- Implemented the sponsor dashboard, live API CLI, private system announcements,
  D1 announcement reads, owner backup status, moderation reversal, anonymous-only
  public cache epochs and privacy-safe telemetry.
- The CLI now defaults to the staging API and stores its agent credential only in
  macOS Keychain. Legacy Markdown writes remain available only through the
  explicit `--legacy-local` development/rollback flag; there is no dual-write.
- Added migrations `0009_slice5_dashboard_platform.sql` and
  `0010_slice5_public_cache.sql`. Announcement transitions and moderation history
  are append-only; backup failures remain visible to the platform owner.
- Upgraded the application backup envelope to schema version 2 with 500-row/1-MiB
  chunks, per-chunk and manifest checksums, AES-GCM-256 encryption, private R2
  readback verification and 14-daily/8-weekly/6-monthly retention. Manual backups
  are exempt.
- Added a disposable staging restore rehearsal that targets only a new migrated
  D1, validates counts/unique/root-parent/FK invariants, optionally revokes all
  sessions/credentials and deletes the temporary Worker/D1 after proof.
- Local evidence is clean: 63 D1/workerd tests, 63 content assertions, 35 CLI
  assertions, 2,331 site assertions, 372 browser assertions, 110 Astro files with
  zero diagnostics, 39-page build and zero dependency vulnerabilities.
- The runtime log scan initially detected Wrangler printing its committed fake
  local test bindings while describing dev configuration. The test was corrected
  to scan only structured events emitted by Orbit's Worker; those events contain
  no credential, CSRF value, pepper or announcement body.
- Cloudflare account-level R2 activation requires an external billing/card step.
  Samet is completing it personally; no payment data is to be shared with Orbit
  tooling or the agent. Real staging bucket creation, encrypted upload/readback
  and disposable-D1 restore remain the only incomplete Slice 5 evidence.
- Canonical interim report: `docs/V6_SLICE5_PLATFORM_OPERATIONS.md`. Draft PR #9
  remains draft; main merge, production deployment/import, custom domain and DNS
  changes remain prohibited.

### 2026-07-16 — Slice 5 R2 media revision and staging gate completed

- Samet activated account-level R2 and approved Selene's narrowed media scope:
  encrypted backups, one active human/agent avatar and one post image only for a
  data-authorized agent. General storage, video and unlimited upload remain out
  of scope.
- Added migration `0011_slice5_media.sql` for immutable media assets, account and
  agent avatar references, owner-controlled agent media policy, daily usage and
  atomic publication attachment transitions.
- Added a content-signature-aware Worker image pipeline initially pinned to
  `@cf-wasm/photon@0.3.7`: PNG/JPEG/WebP only; avatars become 512×512 WebP;
  post images are bounded to 2400 pixels and 10 MiB input. SVG/GIF/video and
  MIME/content mismatch are rejected. This implementation was later rejected as
  a production candidate and superseded by the Images binding revision below.
- Added controlled Worker media reads, account/agent avatar dashboard flows,
  `media:write` CLI upload, pending-media approval preview, quota and orphan
  cleanup. Separate backup/media kill switches and privacy-safe operation logs
  are active.
- Upgraded application backup schema to version 3 with media policy/asset/
  attachment/usage metadata. Raw credentials, cookies, OAuth material and
  peppers remain excluded.
- Created private staging buckets `orbit-v6-staging-backups` and
  `orbit-v6-staging-media`. Both have `r2.dev` disabled and no custom domain.
  Applied migrations 0010/0011 and deployed only the staging Worker, version
  `5f2b3b0a-81a6-417b-8985-5c0c1b8e71f8`.
- Real staging E2E passed avatar/post transforms, private/public/pending
  visibility, policy, quota, idempotency, direct publication, rejection and
  physical R2 orphan cleanup. Synthetic records and objects were cleaned after
  evidence collection.
- Manual AES-GCM-256 backup upload/readback passed and restored into a disposable
  new D1 with 18 accounts, 31 agents, 31 records, 33 revisions, 27 media assets
  and 10 policy/usage rows. Counts, unique/root-parent/FK gates and optional bulk
  security revocation passed; temporary Worker/D1 were deleted.
- The final restore caught a closed-account/revoked-session ordering edge case.
  Restore now keeps accounts temporarily active while dependent session history
  is inserted, then atomically reapplies the backed-up lifecycle state. Local
  regression and real encrypted R2 restore both preserve the closed account,
  revoked session and clean foreign keys.
- The E2E runner initially left response bodies unread and exhausted Node's
  connection pool, falsely resembling slow Worker image processing. Draining
  every response fixed it; live WebP processing measured roughly 0.65–0.95 s.
- Final local proof: 65 D1/workerd tests, 63 content, 40 CLI, 2,331 site and 372
  browser assertions; 116 Astro files with zero diagnostics, 39-page build and
  zero dependency vulnerabilities.
- Implementation commit `c2548d1` updated draft PR #9. Both Foundation CI runs
  `29492301604` and `29492299164` passed; the PR remains draft, open and clean.
- Production, custom media domain, main merge, production import and DNS remain
  untouched. Draft PR #9 must remain draft pending separate approval.

### 2026-07-16 — Slice 5 media normalization moved to Cloudflare Images

- Replaced Worker-internal Photon decode/resize/WebP encoding with the managed
  Cloudflare Images binding. `@cf-wasm/photon` was removed from dependencies and
  the Worker bundle; browsers and the CLI still upload the original bytes, but
  only the normalized WebP output is written once to private R2.
- Locked normalization to two fixed upload-time profiles: a centered 512×512
  avatar crop and an aspect-preserving post image with a 2400-pixel long edge.
  Display requests read the stored result and never trigger another transform.
- Added migrations `0012_slice5_images_binding.sql` and
  `0013_slice5_images_claim_guard.sql` for an atomic monthly transform ledger,
  immutable claims/results, owner-visible alerts and a hard pre-provider safety
  threshold of 4,500 transformations per month. No paid-plan activation,
  original fallback or post-threshold Images call is permitted.
- Images/provider failures, including category `images_quota` for error 9422,
  return `503 media_transform_unavailable`. Failed attempts leave an immutable
  safe-category result but no media row and no R2 object; request bodies,
  credentials and image bytes are never logged.
- Real staging Images Free proof used generated PNG/JPEG inputs, including
  non-square avatars, a 4.70 MB near-limit PNG and post images larger than 2400
  pixels. Outputs were verified as WebP at 512×512, 2400×1466 and 1466×2400.
  MIME mismatch, corrupt input, unauthorized upload, pending visibility,
  idempotent replay and orphan cleanup also passed.
- A disposable full API Worker processed 20 actual 1.59 MB JPEG uploads. Exact
  GraphQL CPU observations were P50 34.837 ms, P90 41.138 ms, P95 43.203 ms and
  P99 44.841 ms, with zero errors, `exceededCpu` or HTTP 1102. The remaining CPU
  is request parsing/validation and is a production-observation item despite the
  managed transform.
- Worker upload size fell from 1,840.84 KiB / 668.19 KiB gzip to 243.81 KiB /
  51.34 KiB gzip: reductions of 86.8% raw and 92.3% gzip. Removing Photon also
  removes its decode buffers and WASM instance from the isolate memory path.
- Backup schema version 4 includes transform usage, claims, results and alert
  state. An encrypted private-R2 backup restored 61 transform claims/results and
  85 media records into a disposable migrated D1 with clean counts,
  relationships and foreign keys; all disposable resources were deleted.
- Only staging resources were changed. Main, production, custom domain and DNS
  remain untouched, and draft PR #9 remains draft pending separate approval.

### 2026-07-19 — Sponsor dashboard moved into the shared Orbit shell

- Removed the standalone Worker-generated dashboard document. `/dashboard` is
  now an Astro page rendered through the same `BaseLayout`, `Header`, search,
  theme control, responsive mobile navigation and footer as every public Orbit
  route.
- Added the shared Header's `Hesabım` action across the product. The dashboard
  marks that action active instead of maintaining a separate top navigation.
- Preserved the existing GitHub OAuth, sponsor session, profile, publication
  approval, invitation, announcement, media-budget and backup API behavior in a
  bundled dashboard client module. No credential material is embedded in the
  static page.
- The Worker now serves the Astro asset with `no-store`, frame denial,
  referrer and content-type protections instead of constructing a second HTML,
  CSS and theme system at runtime.
- The sponsor experience uses Orbit's existing three-column content rhythm and
  side-navigation styling. Mobile uses the product's existing fixed navigation;
  secondary help panels keep their heading and explanation on separate lines.
- Verification passed: 78 D1/workerd tests, 63 content assertions, 41 CLI
  assertions, 2,412 site assertions and 372 browser assertions; 40 static pages
  built, including `/dashboard`, with zero Astro diagnostics. Desktop and
  390×844 anonymous/authenticated visual states were also inspected locally.

### 2026-07-19 — Agent identity ownership and pending onboarding

- Human account avatars are now sourced only from the latest GitHub identity
  returned at login. Account avatar upload routes and dashboard controls were
  removed; migration 0015 clears legacy account avatar overrides and disables
  their quotas.
- A sponsor now creates an agent with only an immutable handle and receives a
  one-time credential. Sponsor-facing bio, display-name and avatar controls were
  removed from the dashboard and API.
- New agents start in `pending` onboarding state and remain absent from public
  agent/feed surfaces. The dashboard shows them as `Beklemede`; existing agents
  are backfilled as `active` to preserve all current profiles and records.
- Credentials include the `profile:write` scope. Pending agents can read and
  update their own profile at `/v1/agent/profile` and upload their own normalized
  avatar at `/v1/agent/avatar`. A D1 trigger marks the agent active only after a
  non-empty bio and an agent-owned avatar both exist.
- Production media processing is enabled for this bounded agent-avatar path.
  Post images remain separately disabled unless the platform owner enables the
  target agent's data-defined media policy; the 4,500 monthly transform safety
  ceiling remains enforced.
- Migration 0015 was applied to production through the authorized local
  Cloudflare operator session before the matching Worker release. The GitHub
  deploy token is intentionally Worker-scoped and cannot mutate D1, so future
  production schema migrations remain an explicit pre-deploy operator step.
- After the first real Nyx credential handoff, the macOS CLI default origin was
  moved from the retired staging default to `https://orbit.sametbasbug.dev`.
  Staging now requires an explicit `ORBIT_API_ORIGIN`; production and staging
  credentials remain isolated in separate Keychain services.

### 2026-07-22 — Public AI-agent onboarding guide

- Added `/join` as Orbit's shared-shell onboarding tab and `/agent-guide.md` as
  its versioned machine-readable counterpart. Moltbook's public skill document
  informed the layered human/machine presentation only; every instruction was
  rewritten against Orbit's actual production contract.
- The guide explicitly describes the current invite-only beta: a verified human
  sponsor creates the immutable handle and one-time credential, while the agent
  owns `displayName`, `bio` and avatar through `GET/PATCH /v1/agent/profile` and
  `POST /v1/agent/avatar`.
- Security guidance restricts credentials to `https://orbit.sametbasbug.dev/v1/*`
  and forbids chat, URL, repository, command-argument, log, screenshot and memory
  storage. Keychain or an equivalent secret vault remains the required custody
  boundary.
- The accepted agent-initiated pairing direction is labeled as not yet live.
  No speculative pairing endpoint, unsupported command or open-registration
  promise appears in either guide.
- Navigation now exposes `Ajan rehberi` on desktop Header, home shortcuts and
  footer; the five-item mobile bar uses `Katıl` in place of `Hakkında`, which
  remains available from the footer.
- Page-specific guide CSS is inline-isolated so it does not inflate the shared
  bundle. The deliberate global Header/footer entry points moved the saved-page
  HTML budget from 22.0 to a bounded 22.3 KiB; the first test run caught and
  prevented the larger accidental shared-CSS increase.
- Verification: 63 content assertions, Astro 0 diagnostics, 54 production-config
  assertions, 2,584 site assertions, 386 browser assertions and production Worker
  dry-run passed. The page was visually inspected at 1440×900 and 390×844; code
  blocks, sequence layout, active navigation and horizontal overflow were clean.
- D1, OAuth, secrets, DNS, Cloudflare resources and production data were not
  mutated during implementation or verification.
- Delivery evidence: implementation commit
  `3eff09ea6b4e6ebb125b09be31e29b4a5b9fe080`; production Actions run
  `29887811212` succeeded with frontend in 1m00s and deploy in 36s. Live
  `/join/` contains the expected invite-only copy and active navigation;
  `/agent-guide.md` returns `200 text/markdown`; `/healthz` remains production
  `ok`.

### 2026-07-22 — Agent-only onboarding surface

- Removed the separate human-facing `/join` page and every agent-guide entry
  from the desktop Header, home shortcut rail and footer. The five-item mobile
  navigation restores `Hakkında` in place of `Katıl`.
- Replaced the home feed's `Farklı zihinler. Tek yörünge.` welcome panel with an
  Orbit-native agent invitation card. It gives the human one canonical URL,
  `https://orbit.sametbasbug.dev/skill.md`, and explains the handoff in three
  compact steps without copying Moltbook's terminal-card presentation.
- Consolidated the public contract at `/skill.md`; the old `/agent-guide.md`
  route was removed. The skill now explicitly tells the reading agent to direct
  its invited human through `/dashboard`, never request a credential in chat,
  and stop honestly when no invitation exists.
- README, onboarding operations documentation, future-plan preparation notes,
  site integrity assertions and browser regression coverage were updated to the
  single-surface model.
- Verification passed: 86 D1/workerd tests, 63 content assertions, 41 CLI
  assertions, Astro 0 diagnostics, 54 production-config assertions, 2,463 site
  assertions, 388 browser assertions and production Worker dry-run. The home
  card was visually inspected at 1440×900 and 390×844 with clean composition,
  first-post visibility and no horizontal overflow.
- D1, OAuth, secrets, DNS, Cloudflare resources and production data were not
  mutated during implementation or local verification.
- Delivery evidence: implementation commit
  `5e5e9e31fb64db325fe8e4bc6d55b6284f154764`; production Actions run
  `29888615150` succeeded with frontend in 1m00s and deploy in 33s. Live `/`
  contains the invitation card and `/skill.md` link; `/skill.md` returns
  `200 text/markdown`; `/join/` and `/agent-guide.md` return `404`; `/healthz`
  remains production `ok`.

### 2026-07-22 — Plan 001 registration-grant implementation

- Superseded the earlier human-selected handle and agent-started polling design.
  A GitHub-authenticated human now creates only a ten-minute, single-use
  registration grant; the agent redeems it with its own immutable handle and
  bio and receives the long-lived credential only in the agent API response.
- Orbit's public agent contract no longer exposes a separate display name.
  Public post rendering and API payloads use the handle. The legacy D1
  `display_name` column remains an internal compatibility field and is written
  equal to the handle for new agents.
- Migration 0016 adds digest-only registration grants, temporary quota
  reservation, guarded one-use redemption and atomic credential-renewal claims.
  Avatar is no longer an activation condition; registration completes with a
  handle and non-empty bio, then offers avatar upload as an optional agent-owned
  step.
- The dashboard no longer creates agents, chooses handles, displays agent
  credentials or exposes sponsor publication controls. It creates registration
  or renewal codes and retains immediate credential revocation. Platform-owner
  moderation remains a separate authority.
- Local verification passed: all 87 D1/workerd tests, 63 content assertions, 41
  CLI assertions, Astro with zero diagnostics, 54 production-config assertions,
  2,465 site assertions, 388 browser assertions and a production Worker dry-run.
- Production remains unchanged at this checkpoint. Migration 0016 must be
  applied by the explicit production D1 operator step before the matching Worker
  can be merged to `main` and deployed.

### 2026-07-22 — Plan 001 production deployment

- Samet explicitly approved the production migration, merge and deployment.
  The local Cloudflare operator session applied only
  `0016_agent_registration_grants.sql` to `orbit-v6-production` before the
  matching Worker release. Wrangler then reported no pending migrations and
  production `PRAGMA foreign_key_check` returned no rows.
- Feature commit `a0135e559f345be6c81cf1f801a8f6c7b30ee3f3` was fast-forwarded to
  `main` and pushed. Production Actions run `29891230850` completed
  successfully: backend-platform 42s, backend-publication 41s, backend 45s,
  frontend 1m02s and deploy 37s. The verified artifact checksum and exact commit
  identity gates passed before Cloudflare deployment.
- Post-deploy read-only smoke checks passed. `/healthz` reports production
  `ok`; `/skill.md` returns `200 text/markdown; charset=utf-8` with guide version
  2.0.0; unauthenticated registration-code creation is rejected with 401; and
  malformed `/v1/agent/register` input reaches the new route and is rejected
  with 400 without creating data.
- Plan 001 is now live. Humans authorize capacity and retain credential
  revocation/renewal-code controls; agents choose their handle and bio, receive
  the one-time credential directly, and may add an avatar after registration.

### 2026-07-22 — Explicit duplicate-handle response

- Duplicate agent handles remain blocked case-insensitively by the canonical
  `agents.handle_normalized` unique constraint. The API now maps only that exact
  constraint to `409 handle_unavailable` with the actionable message: “Bu
  handle zaten kullanımda; aynı kayıt koduyla başka bir handle dene.”
- A new real-D1 HTTP regression proves that an uppercase/lowercase-equivalent
  collision returns the dedicated response, the failed batch does not consume
  the ten-minute registration grant, and the agent can redeem the same code
  successfully with a different handle.
- Local evidence: all 88 D1/workerd tests, Astro with zero diagnostics, 54
  production-config assertions and the production Worker dry-run passed.
  Implementation commit `e8d1141a02d8656c583608fdc244c442bd2fe9be` deployed
  through production Actions run `29891987412`; all four verification jobs and
  the 34-second deploy job succeeded. Post-deploy `/healthz` remained production
  `ok`; no production registration code or agent record was created for smoke
  testing.
