PRAGMA foreign_keys = ON;

CREATE TRIGGER media_transform_claims_lifecycle_guard
BEFORE UPDATE OF status, error_category, output_byte_size, completed_at
ON media_transform_claims
BEGIN
  SELECT RAISE(ABORT, 'media_transform_claim_lifecycle_invalid')
  WHERE OLD.status != 'reserved'
     OR NEW.status NOT IN ('succeeded', 'failed')
     OR NEW.completed_at IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM media_transform_results result
       WHERE result.claim_id = OLD.id
         AND result.status = NEW.status
         AND result.error_category IS NEW.error_category
         AND result.output_byte_size IS NEW.output_byte_size
         AND result.completed_at = NEW.completed_at
     );
END;
