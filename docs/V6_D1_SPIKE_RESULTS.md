# Orbit V6 D1 Pre-implementation Spike Results

Date: 2026-07-15

Runtime: Wrangler `4.111.0`, local D1/workerd, Node `26.5.0`

Artifact: `/Users/samet/.openclaw/workspace/.tmp/openclaw-spikes/orbit-v6-d1-atomicity`

The artifact is intentionally disposable and is not production code or a migration source. Production implementation must rewrite the validated patterns in the Orbit repository layer.

## Verdict: VALIDATED

Question: Can Orbit safely implement the two required atomic operations and the mutual record/revision foreign-key model on D1 before application work begins?

Evidence: The local D1 schema executed 22 SQL statements successfully. Nine endpoint assertions passed, including forced late-batch failures, repeat redemption, stale credential rotation and cross-record revision assignment.

```text
/health: PASS
/invite-failure: PASS
/invite-success: PASS
/invite-double: PASS
/rotation-failure: PASS
/rotation-success: PASS
/rotation-stale: PASS
/records-success: PASS
/records-cross-failure: PASS
ALL D1 SPIKES: PASS
```

Recommendation: Proceed with the first-phase implementation plan using `D1Database.batch()`, constraint/trigger guards and composite revision ownership foreign keys. Repeat the same suite once against disposable remote D1 staging before admitting any external sponsor.

## Spike A — Invitation redemption transaction

### Question

Can invitation consumption and account, GitHub identity, quota, session and audit creation succeed or fail as one unit?

### Minimal design tested

- `invitations` stores validity, expiry, revocation and optional immutable GitHub binding.
- `invitation_redemptions.invitation_id` is the unique one-use claim.
- A `BEFORE INSERT` trigger rejects missing, expired, revoked, already redeemed or GitHub-mismatched invitations.
- An `AFTER INSERT` trigger copies redemption metadata to the invitation row.
- Account, identity, quota, session, audit and redemption claim are submitted in one `D1Database.batch()`.

### Stress cases

1. A GitHub-binding mismatch is forced only after the preceding account/identity/quota/session/audit inserts have been submitted. The trigger aborts and every preceding write is rolled back.
2. A valid unbound invitation is redeemed successfully.
3. A second account using a different GitHub identity attempts to redeem that same invitation. D1 returns:

```text
D1_ERROR: invalid_invitation: SQLITE_CONSTRAINT
(extended: SQLITE_CONSTRAINT_TRIGGER)
```

The second account and session counts remain zero, while the invitation remains owned by the first account.

### Finding

`VALIDATED`, with one design correction. A conditional `UPDATE ... WHERE redeemed_at IS NULL` is insufficient as the sole batch guard because a zero-row update does not abort later statements. A unique redemption claim plus validation trigger makes the invalid state a constraint failure and therefore rolls the complete batch back.

## Spike B — Agent credential rotation

### Question

Can Orbit revoke the current credential, insert the replacement, link them and append audit evidence without leaving the agent credentialless or with two active credentials?

### Minimal design tested

- Partial unique index: one `agent_credentials` row per agent where `revoked_at IS NULL`.
- Rotation batch order:
  1. revoke the expected active credential;
  2. insert the replacement;
  3. link the old row to `replaced_by_credential_id`;
  4. append audit evidence.

### Stress cases

1. The final audit insert intentionally collides after revocation and replacement insertion. D1 rolls the entire batch back; the old credential remains active and the replacement does not exist.
2. A normal rotation leaves exactly one active replacement and the old credential records its successor.
3. A stale rotation still expecting the original credential attempts to insert another active key. The partial unique index aborts:

```text
D1_ERROR: UNIQUE constraint failed: agent_credentials.agent_id
(extended: SQLITE_CONSTRAINT_UNIQUE)
```

The current replacement remains active and the stale candidate is absent.

### Finding

`VALIDATED`. Rotation must identify the expected active credential, not merely update every active row by agent ID. The partial unique index is both the invariant and the stale-race backstop.

## Spike C — Mutual records/revisions foreign keys

### Question

Can D1 create and safely use this mutual relationship?

```text
records.current_revision_id ──> record_revisions.id
record_revisions.record_id  ──> records.id
```

### Minimal design tested

- Insert the record first with nullable revision pointers.
- Insert its first immutable revision.
- Update the record pointer inside the same batch.
- Strengthen ownership with composite FKs:

```text
(records.id, records.current_revision_id)
  -> record_revisions(record_id, id)
```

The same pattern applies to `pending_revision_id`.

### Stress cases

1. Normal record → revision → current-pointer creation succeeds in one batch.
2. `PRAGMA foreign_key_check` reports no rows.
3. Pointing `record_1` at `record_2`'s revision fails:

```text
FOREIGN KEY constraint failed: SQLITE_CONSTRAINT
(extended: SQLITE_CONSTRAINT_FOREIGNKEY)
```

The original pointer remains unchanged and the subsequent foreign-key check stays clean.

### Finding

`VALIDATED`. Use the composite FK rather than only `current_revision_id REFERENCES record_revisions(id)`; the simple FK proves existence but not revision ownership.

## Dependency check — UUIDv7

The first implementation will exact-pin `uuid@14.0.1`.

- License: MIT
- Repository: `uuidjs/uuid`
- Current at decision time: 2026-06-20 release metadata
- Package size reported by npm: 65,672 bytes unpacked
- Reason: established canonical UUID package with UUIDv7 support; safer than maintaining local bit/timestamp logic

The dependency is not installed in production yet. Worker bundling and UUID ordering/format tests belong to the first foundation implementation slice.

## Limits of this evidence

- This was Wrangler local D1/workerd, not a remote D1 database.
- It validates database semantics, constraint behavior and batch rollback, not network latency or Cloudflare production CPU cost.
- OAuth exchange, cryptographic secret handling and real GitHub calls were intentionally not included.
- A disposable remote-D1 rehearsal remains mandatory before staging is considered ready.

## References

- D1 `batch()`: https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
- D1 foreign keys: https://developers.cloudflare.com/d1/sql-api/foreign-keys/
- D1 SQL statements: https://developers.cloudflare.com/d1/sql-api/sql-statements/
