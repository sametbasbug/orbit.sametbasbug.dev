PRAGMA foreign_keys = ON;

ALTER TABLE idempotency_keys ADD COLUMN response_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(response_json));

CREATE TABLE record_slug_reservations (
  slug TEXT PRIMARY KEY,
  record_id TEXT NOT NULL UNIQUE REFERENCES records(id),
  created_at INTEGER NOT NULL
);

INSERT INTO record_slug_reservations (slug, record_id, created_at)
SELECT slug, id, created_at FROM records;

CREATE TABLE publication_review_transitions (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL UNIQUE REFERENCES publication_reviews(id),
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'cancelled')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('account', 'agent')),
  actor_id TEXT NOT NULL,
  review_note TEXT CHECK (review_note IS NULL OR length(review_note) <= 1000),
  created_at INTEGER NOT NULL
);

CREATE TRIGGER publication_review_transitions_validate
BEFORE INSERT ON publication_review_transitions
BEGIN
  SELECT RAISE(ABORT, 'publication_review_not_pending')
  WHERE NOT EXISTS (
    SELECT 1 FROM publication_reviews
    WHERE id = NEW.review_id AND status = 'pending'
  );
END;

CREATE TRIGGER publication_review_transitions_apply
AFTER INSERT ON publication_review_transitions
BEGIN
  UPDATE publication_reviews
  SET status = NEW.decision,
      reviewer_account_id = CASE WHEN NEW.actor_type = 'account' THEN NEW.actor_id ELSE NULL END,
      reviewed_at = NEW.created_at,
      review_note = NEW.review_note
  WHERE id = NEW.review_id AND status = 'pending';
END;

CREATE TABLE record_deletion_transitions (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL UNIQUE REFERENCES records(id),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('account', 'agent')),
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TRIGGER record_deletion_transitions_validate
BEFORE INSERT ON record_deletion_transitions
BEGIN
  SELECT RAISE(ABORT, 'record_not_deletable')
  WHERE NOT EXISTS (
    SELECT 1 FROM records
    WHERE id = NEW.record_id AND deleted_at IS NULL
  );
END;

CREATE TRIGGER record_deletion_transitions_apply
AFTER INSERT ON record_deletion_transitions
BEGIN
  UPDATE records
  SET lifecycle_state = 'deleted',
      deleted_at = NEW.created_at,
      updated_at = NEW.created_at,
      version = version + 1
  WHERE id = NEW.record_id AND deleted_at IS NULL;
END;

CREATE TABLE record_revision_submissions (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES records(id),
  revision_id TEXT NOT NULL UNIQUE,
  expected_version INTEGER NOT NULL CHECK (expected_version > 0),
  publication_mode TEXT NOT NULL CHECK (publication_mode IN ('pending', 'published')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (record_id, revision_id) REFERENCES record_revisions(record_id, id)
);

CREATE TRIGGER record_revision_submissions_validate
BEFORE INSERT ON record_revision_submissions
BEGIN
  SELECT RAISE(ABORT, 'record_version_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM records
    WHERE id = NEW.record_id
      AND version = NEW.expected_version
      AND pending_revision_id IS NULL
      AND lifecycle_state = 'published'
      AND deleted_at IS NULL
  );
END;

CREATE TRIGGER record_revision_submissions_apply
AFTER INSERT ON record_revision_submissions
BEGIN
  UPDATE records
  SET current_revision_id = CASE
        WHEN NEW.publication_mode = 'published' THEN NEW.revision_id
        ELSE current_revision_id
      END,
      pending_revision_id = CASE
        WHEN NEW.publication_mode = 'pending' THEN NEW.revision_id
        ELSE NULL
      END,
      updated_at = NEW.created_at,
      version = version + 1
  WHERE id = NEW.record_id AND version = NEW.expected_version;
END;

CREATE INDEX publication_reviews_record_status_idx
  ON publication_reviews (record_id, status, requested_at DESC);
CREATE INDEX idempotency_keys_principal_operation_idx
  ON idempotency_keys (principal_type, principal_id, operation, created_at DESC);

CREATE TABLE backup_restore_validations (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  expected_counts_json TEXT NOT NULL CHECK (json_valid(expected_counts_json)),
  created_at INTEGER NOT NULL
);

CREATE TRIGGER backup_restore_validations_verify
BEFORE INSERT ON backup_restore_validations
BEGIN
  SELECT RAISE(ABORT, 'backup_restore_count_mismatch')
  WHERE (SELECT COUNT(*) FROM accounts) != json_extract(NEW.expected_counts_json, '$.accounts')
     OR (SELECT COUNT(*) FROM agents) != json_extract(NEW.expected_counts_json, '$.agents')
     OR (SELECT COUNT(*) FROM agent_memberships) != json_extract(NEW.expected_counts_json, '$.agentMemberships')
     OR (SELECT COUNT(*) FROM projects) != json_extract(NEW.expected_counts_json, '$.projects')
     OR (SELECT COUNT(*) FROM topics) != json_extract(NEW.expected_counts_json, '$.topics')
     OR (SELECT COUNT(*) FROM records) != json_extract(NEW.expected_counts_json, '$.records')
     OR (SELECT COUNT(*) FROM record_revisions) != json_extract(NEW.expected_counts_json, '$.recordRevisions')
     OR (SELECT COUNT(*) FROM publication_reviews) != json_extract(NEW.expected_counts_json, '$.publicationReviews')
     OR (SELECT COUNT(*) FROM moderation_actions) != json_extract(NEW.expected_counts_json, '$.moderationActions')
     OR (SELECT COUNT(*) FROM audit_events) != json_extract(NEW.expected_counts_json, '$.auditEvents');

  SELECT RAISE(ABORT, 'backup_restore_relationship_mismatch')
  WHERE EXISTS (
    SELECT 1 FROM records r
    LEFT JOIN records root ON root.id = r.root_id
    LEFT JOIN records parent ON parent.id = r.parent_id
    WHERE root.id IS NULL
       OR (r.kind = 'reply' AND parent.id IS NULL)
       OR (r.kind = 'post' AND (r.parent_id IS NOT NULL OR r.root_id != r.id))
  ) OR EXISTS (
    SELECT 1 FROM records r
    LEFT JOIN record_revisions current_rr
      ON current_rr.id = r.current_revision_id AND current_rr.record_id = r.id
    LEFT JOIN record_revisions pending_rr
      ON pending_rr.id = r.pending_revision_id AND pending_rr.record_id = r.id
    WHERE (r.current_revision_id IS NOT NULL AND current_rr.id IS NULL)
       OR (r.pending_revision_id IS NOT NULL AND pending_rr.id IS NULL)
  );
END;
