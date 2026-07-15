# Orbit V6 Slice 1 — Identity, Invitation, OAuth and Session

Status: completed locally on 2026-07-15. No production deploy and no branch push.

## Fixed local OAuth contract

- Local origin: `http://localhost:4321`
- Local callback: `http://localhost:4321/v1/auth/github/callback`
- Local OAuth App name: `Orbit Local`
- Production callback: `https://orbit.sametbasbug.dev/v1/auth/github/callback`

The local server binds only to `127.0.0.1:4321`. Wildcard origins and credentialed public CORS are forbidden.

## Bindings

Non-secret configuration:

- `ORBIT_ENVIRONMENT`
- `ORBIT_ALLOWED_ORIGIN`
- `ORBIT_GITHUB_CALLBACK_URL`
- `ORBIT_PLATFORM_OWNER_GITHUB_ID`

Keychain locally and Cloudflare Worker secrets in production:

- `GITHUB_OAUTH_CLIENT_ID`
- `GITHUB_OAUTH_CLIENT_SECRET`
- `ORBIT_INVITATION_PEPPER_V1`
- `ORBIT_SESSION_PEPPER_V1`
- `ORBIT_AGENT_CREDENTIAL_PEPPER_V1`
- `ORBIT_OAUTH_STATE_PEPPER_V1`
- `ORBIT_CSRF_PEPPER_V1`

The client ID is not confidential, but the local launcher loads it through the same binding path so local and production configuration cannot drift.

## Local Keychain setup

Each command prompts for the value because `-w` is intentionally the final argument. The value does not enter shell history, a file or a Git commit.

```bash
security add-generic-password -U -s dev.orbit.sametbasbug -a GITHUB_OAUTH_CLIENT_ID -w
security add-generic-password -U -s dev.orbit.sametbasbug -a GITHUB_OAUTH_CLIENT_SECRET -w
security add-generic-password -U -s dev.orbit.sametbasbug -a ORBIT_INVITATION_PEPPER_V1 -w
security add-generic-password -U -s dev.orbit.sametbasbug -a ORBIT_SESSION_PEPPER_V1 -w
security add-generic-password -U -s dev.orbit.sametbasbug -a ORBIT_AGENT_CREDENTIAL_PEPPER_V1 -w
security add-generic-password -U -s dev.orbit.sametbasbug -a ORBIT_OAUTH_STATE_PEPPER_V1 -w
security add-generic-password -U -s dev.orbit.sametbasbug -a ORBIT_CSRF_PEPPER_V1 -w
```

Generate each pepper independently with at least 32 random bytes. Never reuse a pepper between token families.

Start local Orbit with:

```bash
npm run d1:migrate:local
npm run worker:dev
```

The launcher reads Keychain entries into process memory and supplies them through Wrangler's programmatic dev API. It does not create `.dev.vars` or `.env` files.

## Production secret setup — not executed

After the production Worker exists and only with explicit approval:

```bash
npx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
npx wrangler secret put ORBIT_INVITATION_PEPPER_V1
npx wrangler secret put ORBIT_SESSION_PEPPER_V1
npx wrangler secret put ORBIT_AGENT_CREDENTIAL_PEPPER_V1
npx wrangler secret put ORBIT_OAUTH_STATE_PEPPER_V1
npx wrangler secret put ORBIT_CSRF_PEPPER_V1
```

`GITHUB_OAUTH_CLIENT_ID` and the four non-secret Orbit configuration values will be environment vars, not secrets. No production command has been run.

## Platform owner seed

GitHub API resolved and Samet confirmed:

- Numeric GitHub user ID: `126420524`
- Login snapshot at verification time: `sametbasbug`

Migration `0005_slice1_identity.sql` seeds authorization by numeric ID. The mutable login is never used for authorization.

## Implemented identity surface

- `POST /v1/auth/github/start`
- `GET /v1/auth/github/callback`
- `GET /v1/me`
- `POST /v1/auth/logout`
- `POST /v1/admin/invitations`
- `GET /v1/admin/invitations`
- `POST /v1/admin/invitations/{id}/revoke`

The public site remains prerendered. A custom Worker router owns `/v1/*`, `/healthz` and scheduled work, then delegates every other request to the static `ASSETS` binding.

## Security and lifecycle implementation

- Invitation, session and future agent credentials use 128-bit selectors and 256-bit secrets.
- D1 stores versioned HMAC-SHA-256 digests only; invitation and session raw secrets are returned/set once.
- OAuth state and PKCE browser binding expire after 10 minutes.
- A short-lived signed `__Host-orbit_oauth` HttpOnly cookie binds the callback to the browser-held PKCE verifier.
- Human sessions have 7-day idle and 30-day absolute expiry. Activity writes occur at most once per 15-minute bucket.
- `__Host-orbit_session` is HttpOnly; `__Host-orbit_csrf` is readable for the required `X-Orbit-CSRF` double-submit header. Both are Secure, host-only, `Path=/` and `SameSite=Lax`.
- Cookie-authenticated mutations require the exact configured Origin. No wildcard or credentialed public CORS response is emitted.
- OAuth flow consumption, first registration, returning login, invitation revocation and session revocation use one-use claim tables/triggers plus D1 batches. A zero-row conditional update is never treated as a successful security transition.
- Scheduled cleanup runs daily at `03:17 UTC`: OAuth rows after 24-hour retention, expired/revoked sessions after 30-day retention and expired idempotency keys. Append-only audit events are untouched.

## Local-D1 and Worker evidence

The integration ray uses a new temporary Wrangler/workerd D1 database and a fake GitHub boundary; it never calls production GitHub OAuth.

| Case | Result |
|---|---|
| Platform-owner login by immutable GitHub numeric ID | PASS |
| Bound invitation registration | PASS |
| Unbound first-claim registration | PASS |
| Ordinary sponsor invitation denial | PASS |
| GitHub identity mismatch without invitation consumption | PASS |
| Expired, revoked and second-use invitation rejection | PASS |
| OAuth callback replay rejection | PASS |
| OAuth state/PKCE 10-minute expiry | PASS |
| Tampered state and browser cookie rejection | PASS |
| Exact Origin and CSRF enforcement | PASS |
| Immediate logout revocation | PASS |
| 15-minute session activity bucket and absolute expiry | PASS |
| Daily cleanup and audit retention | PASS |
| Static asset delegation and `/healthz` in the real Worker | PASS |

Combined local-D1 suites: 21 assertions/tests. Existing Orbit regression: 63 content, 30 CLI, 2,331 site and 372 browser assertions. Astro diagnostics: 0 errors and 0 warnings; one pre-existing unused-import hint. npm audit: 0 vulnerabilities.

## Explicitly not done

- No GitHub OAuth App was created.
- No real client ID or secret was stored.
- No Keychain item was created by automation.
- No remote D1 database or Cloudflare Worker was created.
- No production secret was installed.
- No branch push or deployment occurred.
- Sponsor agent/credential management remains Slice 2.
