# Orbit V6 staging gate

Status: passed on 2026-07-15. The staging environment is still in use and remains isolated; it must never contain production data.

The fixed resources, secrets, safety contract and commands below are current.
The **Gate evidence** section is a frozen record of the 2026-07-15 run and is
not re-verified on every change.

## Fixed resources

- Worker: `orbit-v6-staging`
- D1: `orbit-v6-staging`
- D1 region: Eastern Europe (`EEUR`)
- Origin: `https://orbit-v6-staging.samett33710.workers.dev`
- OAuth callback: `https://orbit-v6-staging.samett33710.workers.dev/v1/auth/github/callback`
- GitHub OAuth App: `Orbit Staging`
- Wrangler config: `wrangler.staging.jsonc`

Staging deliberately uses the Worker’s isolated `workers.dev` route and keeps preview URLs disabled. Indexing is denied independently by HTML metadata, the Static Assets `_headers` policy and the Worker response wrapper.

When this gate was written, a custom staging domain was impossible: `sametbasbug.dev` was on Name.com nameservers and was not a Cloudflare zone. That constraint is gone — the zone moved to Cloudflare during the Slice 6C cutover (Gates 2 and 3). Staging still stays on `workers.dev` by choice, so that an isolated environment cannot inherit production DNS, TLS or cookie scope by accident.

## Required staging secrets

These bindings are installed through Cloudflare Worker secrets and never committed:

- `GITHUB_OAUTH_CLIENT_ID`
- `GITHUB_OAUTH_CLIENT_SECRET`
- `ORBIT_INVITATION_PEPPER_V1`
- `ORBIT_SESSION_PEPPER_V1`
- `ORBIT_AGENT_CREDENTIAL_PEPPER_V1`
- `ORBIT_OAUTH_STATE_PEPPER_V1`
- `ORBIT_CSRF_PEPPER_V1`
- `ORBIT_CURSOR_PEPPER_V1`

Staging values use the macOS Keychain service `staging.orbit.sametbasbug` as the local recovery source. Each token-family pepper is independently generated from at least 32 random bytes.

## Safety contract

- Never use the production GitHub OAuth App in staging.
- Never point staging at a production D1 database.
- Never write a secret to `.env`, `.dev.vars`, a shell history entry, a log, a commit or the project ledger.
- Never merge the draft V6 PR or run the production Pages deployment as part of this gate.
- Destroy the temporary restore-drill D1 database after evidence is collected.
- Preserve security audit events; staging test identities may be deleted only by destroying the staging database after the beta gate.

## Repeatable commands

```bash
npm run worker:build:staging
npm run d1:migrate:staging
npm run staging:deploy
npm run staging:verify
```

The deploy command is intentionally absent from CI. A human-authorized operator runs it manually after the config, migrations and secrets have been reviewed.

For the real browser OAuth rehearsal, `GET /__staging/oauth` exists only when `ORBIT_ENVIRONMENT=staging`. It delegates to the real `POST /v1/auth/github/start` handler, preserves the short-lived browser-binding cookie and redirects to GitHub. Production cannot serve this route.

## Gate evidence

- The V6 branch is published only as draft PR #9. The production branch was not merged or deployed.
- All five forward migrations applied to the real staging D1 database. A second application was a safe no-op and `PRAGMA foreign_key_check` returned no rows.
- Remote D1 exposed a migration-parser difference that local workerd did not: nested `CASE ... END` inside trigger bodies failed with `incomplete input`. Equivalent `SELECT RAISE(...) WHERE NOT EXISTS (...)` triggers passed both local and remote D1.
- The real GitHub OAuth App requested only `read:user`. Authorization returned to the staging callback and created a D1-backed session for immutable GitHub numeric ID `126420524` with the `platform_owner` role.
- The first real callback exposed a Worker-only runtime difference: retaining the global `fetch` function and invoking it later lost Cloudflare's required receiver. `GithubClient` now uses a wrapper around `globalThis.fetch`; the complete OAuth flow then passed.
- `__Host-orbit_session` was inaccessible to browser JavaScript while `__Host-orbit_csrf` remained readable. A mutation with the CSRF value logged out successfully; the immediately following `/v1/me` request returned `401`.
- Exact-origin rejection, no-index HTML/header policy, `/healthz`, static asset delegation and OAuth start were verified against the deployed Worker.
- The remote scheduled handler deleted seeded expired OAuth, session and idempotency rows. Append-only audit rows remained unchanged.
- A full remote D1 export was restored into an empty disposable D1 database: 93 queries, five migration rows, identical account/identity/session/audit counts and a clean foreign-key check.
- Both disposable D1 databases used for parser and restore drills were deleted after evidence collection. The local SQL export was moved to Trash. Only `orbit-v6-staging` remains.

## Known deployment boundary

Staging has no custom domain. `staging.orbit.sametbasbug.dev` is technically attachable now that the zone is on Cloudflare, but it has not been attached: doing so would place staging inside the production domain's cookie and TLS scope. Attaching it would be a separate decision requiring explicit approval, not a configuration detail.
