# Orbit V6 Slice 6C Gate 5 Live OAuth Report

Date: 2026-07-18
Starting main SHA: `ac41aef69e8b5bbcc0304374619f19cf369156a4`
Gate 4 final backup ID: `019f6e6f-8aff-77ad-aa99-8bd7a51f9ba8`

## 1. Scope and final result

Gate 5 initially authorized a separate live GitHub OAuth App only after the
existing dark-launch credential pair was proven recoverable from approved
production secret custody. That first custody prerequisite did not pass, so
the first execution stopped fail-closed as `BLOCKED`.

The production macOS Keychain service contains the Gate 4 backup encryption
entry, but it does not contain either dark-launch GitHub OAuth client entry.
Cloudflare has the two expected Worker secret bindings, but Worker secrets are
write-only and cannot serve as recoverable rollback custody. The documented
fail-closed rule was therefore applied before any live App, live secret, or
token-endpoint probe was created.

No GitHub OAuth App, secret, Worker, OAuth, DNS, Pages, D1, KV, R2, custom
domain, route, or live-traffic mutation was performed during that first
attempt.

The user then explicitly authorized creation of one additional dark-launch
client secret as a recoverable rollback credential while preserving the old
working secret. Gate 5 resumed on the same branch and completed without any
Worker, traffic, DNS, Pages, or production-data change.

**Final Gate 5 result: `PASS`.**

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

## 3. Existing dark-launch App at the initial attempt

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

## 4. Initial custody audit and blocker

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

## 5. State at the initial fail-closed stop

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

## 6. Non-mutation evidence at the initial stop

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

## 7. Explicit continuation authorization

After the initial blocker, the user explicitly authorized exactly one
additional client secret on the existing `Orbit Production Dark Launch` App.
The authorization required the old working secret to remain present and
forbade any Worker secret/config deployment.

Before generating it, the GitHub UI confirmed additive behavior: the existing
secret could not be deleted until another secret existed. It did not present a
replacement or automatic-revocation warning. One new secret was generated,
and the App's secret count moved from 1 to 2. The old secret remained listed
and retained its prior last-used evidence.

The dark App's name, owner, homepage, callback, and Device Flow setting all
remained exact. Its settings ID remained `3733923`.

## 8. Dark rollback credential custody and probe

The new rollback pair was stored in macOS Keychain under service
`production.orbit.sametbasbug` using two distinct accounts:

- `GITHUB_OAUTH_DARK_CLIENT_ID`; and
- `GITHUB_OAUTH_DARK_CLIENT_SECRET`.

Both entries were retrieved and verified as non-empty without displaying
their values. The dark Client ID matched the GitHub settings page; its
secret-free SHA-256 proof is
`348b087d7270ffcdc6a2d39741d795e754ee97b288c2f5f80e5bf356894efc8f`.

The new dark credential pair was used for exactly one server-side token
exchange probe with a cryptographically random invalid code and the exact
Workers.dev callback. GitHub returned `bad_verification_code`; it did not
return `incorrect_client_credentials`, an access token, or success.

The new credential was retained only as rollback custody. It was not uploaded
to the production Worker, and the existing old dark secret was not revoked,
deleted, or changed.

## 9. Live OAuth App and custody

A separate GitHub OAuth App was created with the following exact state:

| Field | Evidence |
| --- | --- |
| App name | `Orbit Production` |
| Settings ID | `3736304` |
| Owner | same GitHub personal account as the dark-launch App |
| Homepage | `https://orbit.sametbasbug.dev` |
| Callback | `https://orbit.sametbasbug.dev/v1/auth/github/callback` |
| Callback count | 1 |
| Description | empty |
| Device Flow | disabled |
| Client secret count | 1 |
| Authorized users | 0 |

The live pair was stored in the same Keychain service using separate accounts:

- `GITHUB_OAUTH_LIVE_CLIENT_ID`; and
- `GITHUB_OAUTH_LIVE_CLIENT_SECRET`.

Both live entries were recoverable and non-empty, did not overwrite either
dark entry, and the Client ID matched the settings page. Its secret-free
SHA-256 proof is
`6289621dd6613a54ae7b508f946dff1b777e5da02c51ac956e4119d4a8f49b96`.

The live pair was used for exactly one server-side invalid-code probe with the
exact live callback. GitHub returned `bad_verification_code`; it did not return
`incorrect_client_credentials`, an access token, or success. No authorization
or consent flow was started, and no authorization code, token, OAuth identity,
or production session was created.

## 10. Secret handling and cleanup

The two newly generated secrets were moved directly from their one-time
GitHub display into Keychain custody. Neither secret was written to a shell
argument, environment dump, normal file, screenshot, report, Git object, or
application log. The temporary pasteboard was cleared after each transfer.

All four Keychain accounts were independently verified present and
recoverable. The temporary signed local custody helper and its directory were
removed after the final probes, no helper process remained, and the clipboard
was empty. Invalid probe codes and request bodies were kept only in process
memory and were not retained.

## 11. Final non-mutation evidence

Final checks after both probes established:

- production Worker version
  `01384034-5584-4181-8763-b31e3aecf95e` remained at 100 percent;
- no Worker upload, deployment, secret update, or configuration promotion
  occurred;
- the Worker secret name/type inventory retained exact SHA-256
  `3f0dfad8433bd2eed551eaace0131e07d253818718e9bdfe4db7ca17791992b1`;
- the Worker remained Workers.dev-only and dark launch; its Domains page
  showed only the Workers.dev URL and `No custom domains`;
- Orbit DNS remained a CNAME to `sametbasbug.github.io.`;
- Orbit `/` remained HTTP 200 from `server: GitHub.com`, while `/healthz`
  remained the GitHub Pages HTTP 404;
- Cloudflare delegation, DNSSEC validation, and the single parent DS remained
  exact;
- the latest Pages workflow run and deployment artifact remained unchanged;
- production D1 remained at 1 account, 1 auth identity, 4 agents, 6 projects,
  4 topics, 13 records, 13 revisions, 3 sessions, 0 credentials, 4 backup
  runs, and 0 media assets, with zero foreign-key violations;
- no new OAuth identity or session was created;
- cache KV remained present and unchanged;
- backup R2 remained at four objects and media R2 remained empty;
- Gate 4 backup `019f6e6f-8aff-77ad-aa99-8bd7a51f9ba8` remained directly
  readable with encrypted SHA-256
  `cc3221a7fff29cb00f223bc7e42894b1235545469977dde41172f836c24835f1`;
  and
- no paid feature was enabled.

The only authorized control-plane changes were the additional dark rollback
secret and the new live OAuth App plus its single secret. Neither credential
pair was installed on the Worker.

## 12. Remaining gates

Gate 6 and Gate 7 remain separately gated. This `PASS` does not authorize
Worker secret installation, live configuration deployment, custom-domain
attachment, Orbit DNS cutover, real live OAuth login/callback testing, or
GitHub Pages retirement.
