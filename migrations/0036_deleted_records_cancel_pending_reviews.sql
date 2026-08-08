PRAGMA foreign_keys = ON;

-- Repair records deleted before this migration. A deletion is terminal for the
-- pending moderation lane: the review is cancelled, its pending revision is
-- rejected, and the record no longer advertises a pending revision.
INSERT INTO publication_review_transitions (
  id, review_id, decision, actor_type, actor_id, review_note, created_at
)
SELECT
  'record-delete-repair-' || pr.id,
  pr.id,
  'cancelled',
  rd.actor_type,
  rd.actor_id,
  'Record deleted before review completed.',
  rd.created_at
FROM publication_reviews pr
JOIN records r ON r.id = pr.record_id
JOIN record_deletion_transitions rd ON rd.record_id = r.id
WHERE r.deleted_at IS NOT NULL
  AND pr.status = 'pending';

UPDATE record_revisions
SET state = 'rejected'
WHERE state = 'pending'
  AND id IN (
    SELECT pending_revision_id
    FROM records
    WHERE deleted_at IS NOT NULL
      AND pending_revision_id IS NOT NULL
  );

UPDATE records
SET pending_revision_id = NULL
WHERE deleted_at IS NOT NULL
  AND pending_revision_id IS NOT NULL;

-- The original Slice 4 trigger made the record terminal but left an active
-- moderation review attached to a deleted record. Keep deletion append-only,
-- but close that moderation lane atomically through the existing review
-- transition mechanism before clearing the pending revision pointer.
DROP TRIGGER record_deletion_transitions_apply;

CREATE TRIGGER record_deletion_transitions_apply
AFTER INSERT ON record_deletion_transitions
BEGIN
  INSERT INTO publication_review_transitions (
    id, review_id, decision, actor_type, actor_id, review_note, created_at
  )
  SELECT
    NEW.id || '-review-' || pr.id,
    pr.id,
    'cancelled',
    NEW.actor_type,
    NEW.actor_id,
    'Record deleted before review completed.',
    NEW.created_at
  FROM publication_reviews pr
  WHERE pr.record_id = NEW.record_id
    AND pr.status = 'pending';

  UPDATE record_revisions
  SET state = 'rejected'
  WHERE id = (
      SELECT pending_revision_id
      FROM records
      WHERE id = NEW.record_id
    )
    AND state = 'pending';

  UPDATE records
  SET lifecycle_state = 'deleted',
      pending_revision_id = NULL,
      deleted_at = NEW.created_at,
      updated_at = NEW.created_at,
      version = version + 1
  WHERE id = NEW.record_id
    AND deleted_at IS NULL;
END;
