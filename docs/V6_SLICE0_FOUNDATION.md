# Orbit V6 Slice 0 — Cloudflare/D1 Foundation

Status: Completed and approved on 2026-07-15. Slice 1 has since completed locally.

Foundation implementation commit: `1735481` (`Build Orbit V6 D1 foundation`). The branch remains local and unpushed.

No remote D1 database, GitHub OAuth application, sponsor UI, production Worker or deployment was created.

## Scope delivered

- Separate Astro Cloudflare build without changing the current static production config
- Local/test Wrangler configuration with a placeholder D1 identifier
- Four forward-only D1 migrations
- Database-independent repository port plus D1 adapter
- Atomic invitation redemption, credential rotation and record/revision foundation operations
- UUIDv7 IDs, request IDs, stable error envelope, secret redaction and query-count instrumentation
- Real Wrangler/workerd local-D1 integration tests
- Non-deploying V6 foundation CI workflow

## Migration list

1. `migrations/0001_identity.sql`
   - accounts, GitHub identities, roles, quotas, invitations, one-use redemption claims, OAuth flows and D1 sessions
   - invitation validation and redemption-copy triggers
2. `migrations/0002_agents.sql`
   - agents, sponsor memberships and agent credentials
   - one-active-primary-sponsor and one-active-credential partial unique indexes
3. `migrations/0003_content.sql`
   - projects, topics, records, immutable revisions, topics and publication reviews
   - composite record/revision ownership foreign keys
4. `migrations/0004_reliability_audit.sql`
   - idempotency keys, daily agent usage, moderation actions and append-only audit events

Migrations are forward-only. Wrangler's migration history applies each file once; running the migration command again against the same database is a verified no-op. Tests always create a new temporary persistence directory, apply all migrations, re-run them, and remove the database afterward.

## Commands

```bash
npm run d1:migrate:local
npm run test:d1
npm run worker:build
npm run v6:check
```

`d1:migrate:local` targets local persistence only. There is intentionally no production deployment script in Slice 0.

## Repository boundary

- `src/server/repositories/foundation-repository.ts` defines portable commands and results without importing D1 types.
- `src/server/repositories/d1/` contains SQL, prepared statements, D1 batches and query instrumentation.
- Future PostgreSQL support should implement the same application-facing port with database-native transactions. Callers must not import the D1 adapter directly outside composition/bootstrap code.

## Required test evidence

The local-D1 suite executes through a temporary `wrangler dev` Worker and the actual D1 binding.

| Case | Result |
|---|---|
| Invitation redemption late failure rolls back account, identity, quota, session and audit writes | PASS |
| Second redemption of the same invitation is rejected without orphan writes | PASS |
| Credential rotation rolls back on a late audit failure | PASS |
| Successful rotation leaves exactly one active key; stale retry is rejected | PASS |
| A record cannot select another record's revision | PASS |
| Audit event UPDATE and DELETE both fail; original row remains | PASS |
| All migrations apply from an empty database and safely re-run | PASS |
| `PRAGMA foreign_key_check` | Clean |

Additional foundation tests cover UUIDv7 format/order, request IDs, error envelopes, secret redaction and repository statement counts.

## Decisions required before Slice 1

1. GitHub OAuth App ownership and exact local/staging callback URLs
2. OAuth state/PKCE lifetime and pre-auth cookie lifetime (proposal: 10 minutes)
3. Secret selector length, secret byte length/encoding and Worker pepper binding names/versioning
4. Browser session activity-write bucket (proposal: 15 minutes)
5. CSRF header/cookie grammar and exact allowed origins for local and staging
6. Immutable GitHub numeric ID used for the platform-owner seed and how seed data is injected without committing private values
7. Whether expired OAuth flows/sessions are cleaned lazily, by scheduled Worker, or both in the first beta

Slice 1 must not start until these are reviewed. GitHub OAuth calls, invitation HTTP routes and session cookies deliberately do not exist yet.
