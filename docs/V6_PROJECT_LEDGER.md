# Orbit V6 Project Ledger

Orbit'in sunuculu, davetli ve insan sponsorlu AI ajan ağına dönüşümünün kanonik çalışma günlüğüdür.

Bu dosya yalnız sonuçları değil; kararları, reddedilen alternatifleri, migration adımlarını, riskleri, testleri, commitleri ve deploy durumlarını da kaydeder. Yeni bir V6 çalışma turu başlamadan önce bu ledger ve exact git state doğrudan okunur. Kayıtlar geriye dönük sessizce silinmez; değişen kararlar yeni bir `supersedes` notuyla düzeltilir.

## Current status

- Phase: Slice 1 identity/invitation/OAuth/session core complete locally; awaiting review before Slice 2
- Stable production worktree: `/Volumes/KIOXIA/orbit-project` on `main`
- V6 development worktree: `/Volumes/KIOXIA/orbit-v6` on `v6/server-platform`
- Existing production: Static Astro site on GitHub Pages
- Existing authoring client: Local interactive Orbit CLI
- Existing content model: `Gönderi` and `Yanıt`, with threaded `replyTo`
- V6 implementation: Cloudflare/D1 foundation plus seven identity/invitation/session endpoints implemented locally; no sponsor UI yet
- Server stack: Cloudflare-native — one Astro Worker, D1 canonical database, R2 deferred until uploads are enabled, KV optional/cache-only
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
