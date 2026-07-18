# Orbit V6 Slice 6C Gate 5 Live OAuth Report

Date: 2026-07-18
Starting main SHA: `ac41aef69e8b5bbcc0304374619f19cf369156a4`
Gate 4 final backup ID: `019f6e6f-8aff-77ad-aa99-8bd7a51f9ba8`

## 1. Scope and result

Gate 5 authorized a separate live GitHub OAuth App only after the existing
dark-launch credential pair was proven recoverable from approved production
secret custody. The custody prerequisite did not pass.

**Gate 5 result: `BLOCKED`.**

The production macOS Keychain service contains the Gate 4 backup encryption
entry, but it does not contain either dark-launch GitHub OAuth client entry.
Cloudflare has the two expected Worker secret bindings, but Worker secrets are
write-only and cannot serve as recoverable rollback custody. The documented
fail-closed rule was therefore applied before any live App, live secret, or
token-endpoint probe was created.

No GitHub OAuth App, secret, Worker, OAuth, DNS, Pages, D1, KV, R2, custom
domain, route, or live-traffic mutation was performed.

## 2. Preflight

Preflight completed before the custody decision:

- local `main` and `origin/main` were equal at the expected starting SHA and
  the worktree was clean;
- Gate 1 through Gate 4 reports were present on `main`;
- Gate 4 backup
  `019f6e6f-8aff-77ad-aa99-8bd7a51f9ba8` remained directly readable from
  private R2 at 58,253 bytes with encrypted SHA-256
  `cc3221a7fff29cb00f223bc7e42894b1235545469977dde41172f836c24835f1`;
- parent delegation remained only the Cloudflare pair;
- the parent still published one exact DS with Key Tag 2371, Algorithm 13,
  Digest Type 2, and digest SHA-256 proof
  `6d2799936dba95fcd8423f1e4ccff2dec6daa5dacbc13ef25eefcc59ee2e8bc6`;
- Cloudflare remained on the Free plan and reported DNSSEC protected;
- Cloudflare, Google, and Quad9 returned validating `AD` answers;
- `orbit.sametbasbug.dev` remained a CNAME to
  `sametbasbug.github.io.`;
- Orbit `/` returned HTTP 200 from `server: GitHub.com`, while `/healthz`
  returned the expected GitHub Pages HTTP 404;
- production Worker version
  `01384034-5584-4181-8763-b31e3aecf95e` remained at 100 percent on the
  Workers.dev dark-launch surface;
- `/healthz` retained `X-Robots-Tag: noindex, nofollow, noarchive`;
- the latest Pages deployment remained run `29387967237`, source SHA
  `35ad75abbe0708b873e768b2d361f8b6a1d08182`; and
- production D1, KV, backup R2, and media R2 content baselines remained
  consistent with Gate 4 except for one explained scheduled daily backup.

The scheduled backup began at `2026-07-18T03:17:08.932Z`, before Gate 5
execution. It explains `backup_runs` increasing from 3 to 4 and the private
backup bucket increasing from 3 to 4 objects. It was produced by the already
configured daily cron, not by Gate 5. User data counts did not change.

## 3. Existing dark-launch App

The GitHub OAuth Apps list contained exactly the existing dark-launch and
staging Apps. There was no App named exactly `Orbit Production`, so no
duplicate or unexpected live App existed.

The existing dark-launch App was checked without editing it:

| Field | Evidence |
| --- | --- |
| App name | `Orbit Production Dark Launch` |
| Settings ID | `3733923` |
| Owner | same expected GitHub personal account |
| Homepage | `https://orbit-v6-production.samett33710.workers.dev` |
| Callback | `https://orbit-v6-production.samett33710.workers.dev/v1/auth/github/callback` |
| Device Flow | disabled |
| Client secret count | 1 |

No dark-launch App field or secret was changed.

## 4. Custody audit and blocker

The approved production Keychain convention was discovered without reading or
printing any stored value:

- custody provider: macOS Keychain;
- service: `production.orbit.sametbasbug`;
- present account: `backup-encryption-v1`;
- missing account: `GITHUB_OAUTH_CLIENT_ID`;
- missing account: `GITHUB_OAUTH_CLIENT_SECRET`.

The user Keychain search list contained only the normal login keychain. A
metadata-only inventory found no other production Orbit/GitHub OAuth client
entry. Staging entries existed under the isolated staging service and were not
read, copied, or treated as production credentials.

The production Worker secret inventory did contain
`GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET`, alongside the seven
other expected confidential bindings. The inventory had 9 names and the
sorted name/type digest was
`3f0dfad8433bd2eed551eaace0131e07d253818718e9bdfe4db7ca17791992b1`.
Cloudflare does not permit reading Worker secret values back, so those
bindings prove deployment presence but not rollback recoverability.

Because the dark client pair could not be recovered from approved custody,
Gate 5 explicitly prohibited:

- generating a new dark secret;
- deleting the existing dark secret;
- changing Worker secrets;
- creating the live OAuth App; and
- continuing to either invalid-code probe.

The execution stopped at that boundary.

## 5. Live App and probes

The planned live App values remain:

- name: `Orbit Production`;
- homepage: `https://orbit.sametbasbug.dev`;
- callback: `https://orbit.sametbasbug.dev/v1/auth/github/callback`;
- description: empty;
- Device Flow: disabled.

No live OAuth App was registered, so there is no live settings ID, client ID
proof, client secret, or live custody entry. No live or dark token-endpoint
probe was sent. Consequently:

- no authorization request or consent screen was started;
- no authorization code was generated or stored;
- no access token was generated;
- no production session or OAuth identity was created; and
- there was no `incorrect_client_credentials`, `redirect_uri_mismatch`, or
  `bad_verification_code` result to claim.

## 6. Final non-mutation evidence

Final checks matched the preflight:

- Worker deployment version and traffic percentage were unchanged;
- no Worker version upload or deployment occurred;
- Worker secret name/type inventory remained exact with the same SHA-256;
- no `wrangler secret put` or version-secret command was run;
- the Worker remained Workers.dev-only and dark launch;
- no live custom domain or route was added;
- the GitHub OAuth Apps list still contained no `Orbit Production` App;
- the dark-launch App retained its exact name, owner, homepage, callback,
  Device Flow state, and one-secret count;
- Orbit DNS remained the GitHub Pages CNAME;
- Orbit `/` remained HTTP 200 from GitHub Pages and `/healthz` remained the
  Pages HTTP 404;
- DNS delegation, DNSSEC, and parent DS remained exact;
- the Pages workflow run and deployment artifact remained unchanged;
- production D1 remained at 1 account, 1 auth identity, 4 agents, 6 projects,
  4 topics, 13 records, 13 revisions, 3 sessions, 0 credentials, 4 backup
  runs, and 0 media assets, with zero foreign-key violations;
- cache KV remained present and was not written;
- backup R2 remained at the four preflight objects and media R2 remained
  empty;
- the Gate 4 final backup remained directly readable with its exact encrypted
  SHA-256; and
- no paid feature was enabled.

The Cloudflare secret-list API does not expose per-secret modification
timestamps. Non-mutation evidence therefore uses the unchanged secret
name/type digest, unchanged serving deployment/version, and the fact that no
secret mutation command or control-plane action was performed.

## 7. Required remediation and remaining gates

Before Gate 5 can be resumed, the existing dark-launch client pair must be
placed in approved production custody without changing the GitHub App or
Worker:

1. Open GitHub **Settings → Developer settings → OAuth Apps → Orbit Production
   Dark Launch** (settings ID `3733923`).
2. Store the existing Client ID in macOS Keychain service
   `production.orbit.sametbasbug`, account `GITHUB_OAUTH_CLIENT_ID`.
3. Store the existing single Client secret in the same service, account
   `GITHUB_OAUTH_CLIENT_SECRET`.
4. Use Keychain's prompted-input path; do not place either value in a shell
   argument, file, screenshot, log, or Git.
5. Confirm both entries can be retrieved without displaying their values, then
   explicitly resume Gate 5.

For the macOS `security` CLI, `-w` must be the final option so the value is
prompted instead of appearing in the process list. The two safe command forms
are:

```text
security add-generic-password -U -s production.orbit.sametbasbug -a GITHUB_OAUTH_CLIENT_ID -w
security add-generic-password -U -s production.orbit.sametbasbug -a GITHUB_OAUTH_CLIENT_SECRET -w
```

Gate 6 and Gate 7 remain separately gated. This blocked report does not
authorize live credential creation, Worker secret installation, live config
deployment, custom-domain attachment, Orbit DNS cutover, or Pages retirement.
