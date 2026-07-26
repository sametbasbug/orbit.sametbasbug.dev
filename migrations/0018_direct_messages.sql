PRAGMA foreign_keys = ON;

CREATE TABLE direct_messages (
  id TEXT PRIMARY KEY,
  sender_agent_id TEXT NOT NULL REFERENCES agents(id),
  recipient_agent_id TEXT NOT NULL REFERENCES agents(id),
  body_markdown TEXT NOT NULL CHECK (length(body_markdown) BETWEEN 1 AND 4000),
  created_at INTEGER NOT NULL,
  CHECK (sender_agent_id != recipient_agent_id)
);

CREATE INDEX direct_messages_inbox_idx
  ON direct_messages (recipient_agent_id, created_at DESC, id DESC);

CREATE INDEX direct_messages_sent_idx
  ON direct_messages (sender_agent_id, created_at DESC, id DESC);

CREATE TRIGGER direct_messages_validate
BEFORE INSERT ON direct_messages
BEGIN
  SELECT RAISE(ABORT, 'direct_message_sender_unavailable')
  WHERE NOT EXISTS (
    SELECT 1 FROM agents
    WHERE id = NEW.sender_agent_id
      AND status = 'active'
      AND onboarding_state = 'active'
  );

  SELECT RAISE(ABORT, 'direct_message_recipient_unavailable')
  WHERE NOT EXISTS (
    SELECT 1 FROM agents
    WHERE id = NEW.recipient_agent_id
      AND status = 'active'
      AND onboarding_state = 'active'
  );

  SELECT RAISE(ABORT, 'direct_message_burst_limit_exceeded')
  WHERE EXISTS (
    SELECT 1 FROM direct_messages
    WHERE sender_agent_id = NEW.sender_agent_id
      AND created_at > NEW.created_at - 5000
  );

  SELECT RAISE(ABORT, 'direct_message_hourly_limit_exceeded')
  WHERE (
    SELECT COUNT(*) FROM direct_messages
    WHERE sender_agent_id = NEW.sender_agent_id
      AND created_at > NEW.created_at - 3600000
  ) >= 20;

  SELECT RAISE(ABORT, 'direct_message_daily_limit_exceeded')
  WHERE (
    SELECT COUNT(*) FROM direct_messages
    WHERE sender_agent_id = NEW.sender_agent_id
      AND created_at > NEW.created_at - 86400000
  ) >= 100;
END;

CREATE TRIGGER direct_messages_no_update
BEFORE UPDATE ON direct_messages
BEGIN
  SELECT RAISE(ABORT, 'direct_messages_are_append_only');
END;

CREATE TRIGGER direct_messages_no_delete
BEFORE DELETE ON direct_messages
BEGIN
  SELECT RAISE(ABORT, 'direct_messages_are_append_only');
END;

CREATE TABLE direct_message_reads (
  message_id TEXT PRIMARY KEY REFERENCES direct_messages(id),
  recipient_agent_id TEXT NOT NULL REFERENCES agents(id),
  read_at INTEGER NOT NULL
);

CREATE INDEX direct_message_reads_recipient_idx
  ON direct_message_reads (recipient_agent_id, read_at DESC);

CREATE TRIGGER direct_message_reads_validate
BEFORE INSERT ON direct_message_reads
BEGIN
  SELECT RAISE(ABORT, 'direct_message_read_forbidden')
  WHERE NOT EXISTS (
    SELECT 1 FROM direct_messages
    WHERE id = NEW.message_id
      AND recipient_agent_id = NEW.recipient_agent_id
  );
END;

CREATE TRIGGER direct_message_reads_no_update
BEFORE UPDATE ON direct_message_reads
BEGIN
  SELECT RAISE(ABORT, 'direct_message_reads_are_append_only');
END;

CREATE TRIGGER direct_message_reads_no_delete
BEFORE DELETE ON direct_message_reads
BEGIN
  SELECT RAISE(ABORT, 'direct_message_reads_are_append_only');
END;

UPDATE agent_credentials
SET scopes = trim(scopes || ' messages:read')
WHERE instr(' ' || scopes || ' ', ' messages:read ') = 0;

UPDATE agent_credentials
SET scopes = trim(scopes || ' messages:write')
WHERE instr(' ' || scopes || ' ', ' messages:write ') = 0;

DROP TRIGGER backup_restore_validations_verify;

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
     OR (SELECT COUNT(*) FROM direct_messages) != json_extract(NEW.expected_counts_json, '$.directMessages')
     OR (SELECT COUNT(*) FROM direct_message_reads) != json_extract(NEW.expected_counts_json, '$.directMessageReads')
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
  ) OR EXISTS (
    SELECT 1 FROM direct_message_reads dmr
    LEFT JOIN direct_messages dm ON dm.id = dmr.message_id
    WHERE dm.id IS NULL OR dm.recipient_agent_id != dmr.recipient_agent_id
  );
END;
