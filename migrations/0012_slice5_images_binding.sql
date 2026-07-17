PRAGMA foreign_keys = ON;

CREATE TABLE media_transform_usage_monthly (
  month_utc TEXT PRIMARY KEY,
  attempted_count INTEGER NOT NULL DEFAULT 0 CHECK (attempted_count BETWEEN 0 AND 4500),
  succeeded_count INTEGER NOT NULL DEFAULT 0 CHECK (succeeded_count BETWEEN 0 AND attempted_count),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count BETWEEN 0 AND attempted_count),
  updated_at INTEGER NOT NULL
);

CREATE TABLE media_transform_claims (
  id TEXT PRIMARY KEY,
  month_utc TEXT NOT NULL REFERENCES media_transform_usage_monthly(month_utc),
  profile TEXT NOT NULL CHECK (profile IN ('avatar', 'post')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('account', 'agent')),
  actor_id TEXT NOT NULL,
  source_content_type TEXT NOT NULL CHECK (
    source_content_type IN ('image/png', 'image/jpeg', 'image/webp')
  ),
  source_byte_size INTEGER NOT NULL CHECK (source_byte_size > 0 AND source_byte_size <= 10485760),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'succeeded', 'failed')),
  error_category TEXT,
  output_byte_size INTEGER,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX media_transform_claims_month_idx
  ON media_transform_claims (month_utc, created_at, id);

CREATE TABLE media_transform_results (
  claim_id TEXT PRIMARY KEY REFERENCES media_transform_claims(id),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  error_category TEXT CHECK (
    error_category IS NULL OR error_category IN (
      'images_quota',
      'images_input',
      'images_service',
      'images_output',
      'images_unknown'
    )
  ),
  output_byte_size INTEGER CHECK (output_byte_size IS NULL OR output_byte_size > 0),
  completed_at INTEGER NOT NULL,
  CHECK (
    (status = 'succeeded' AND error_category IS NULL AND output_byte_size IS NOT NULL)
    OR
    (status = 'failed' AND error_category IS NOT NULL AND output_byte_size IS NULL)
  )
);

CREATE TABLE platform_alerts (
  alert_key TEXT PRIMARY KEY,
  alert_type TEXT NOT NULL CHECK (alert_type = 'images_transform_budget'),
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved')),
  message_code TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TRIGGER media_transform_claims_budget_validate
BEFORE INSERT ON media_transform_claims
BEGIN
  SELECT RAISE(ABORT, 'media_transform_budget_exhausted')
  WHERE COALESCE((
    SELECT attempted_count FROM media_transform_usage_monthly
    WHERE month_utc = NEW.month_utc
  ), 0) >= 4500;
END;

CREATE TRIGGER media_transform_claims_reserve
AFTER INSERT ON media_transform_claims
BEGIN
  INSERT INTO media_transform_usage_monthly (
    month_utc, attempted_count, succeeded_count, failed_count, updated_at
  ) VALUES (NEW.month_utc, 0, 0, 0, NEW.created_at)
  ON CONFLICT(month_utc) DO NOTHING;

  UPDATE media_transform_usage_monthly
  SET attempted_count = attempted_count + 1,
      updated_at = NEW.created_at
  WHERE month_utc = NEW.month_utc;

  INSERT INTO platform_alerts (
    alert_key, alert_type, severity, status, message_code,
    metadata_json, created_at, resolved_at
  )
  SELECT
    'images-transform-budget:' || NEW.month_utc,
    'images_transform_budget',
    CASE WHEN usage.attempted_count >= 4400 THEN 'critical' ELSE 'warning' END,
    'active',
    'images_transform_budget_approaching',
    json_object(
      'monthUtc', NEW.month_utc,
      'attemptedCount', usage.attempted_count,
      'warningThreshold', 4000,
      'safetyLimit', 4500
    ),
    NEW.created_at,
    NULL
  FROM media_transform_usage_monthly usage
  WHERE usage.month_utc = NEW.month_utc
    AND usage.attempted_count >= 4000
  ON CONFLICT(alert_key) DO UPDATE SET
    severity = excluded.severity,
    status = 'active',
    message_code = excluded.message_code,
    metadata_json = excluded.metadata_json,
    resolved_at = NULL;
END;

CREATE TRIGGER media_transform_results_validate
BEFORE INSERT ON media_transform_results
BEGIN
  SELECT RAISE(ABORT, 'media_transform_claim_not_reserved')
  WHERE NOT EXISTS (
    SELECT 1 FROM media_transform_claims
    WHERE id = NEW.claim_id AND status = 'reserved'
  );
END;

CREATE TRIGGER media_transform_results_apply
AFTER INSERT ON media_transform_results
BEGIN
  UPDATE media_transform_claims
  SET status = NEW.status,
      error_category = NEW.error_category,
      output_byte_size = NEW.output_byte_size,
      completed_at = NEW.completed_at
  WHERE id = NEW.claim_id AND status = 'reserved';

  UPDATE media_transform_usage_monthly
  SET succeeded_count = succeeded_count + CASE WHEN NEW.status = 'succeeded' THEN 1 ELSE 0 END,
      failed_count = failed_count + CASE WHEN NEW.status = 'failed' THEN 1 ELSE 0 END,
      updated_at = NEW.completed_at
  WHERE month_utc = (
    SELECT month_utc FROM media_transform_claims WHERE id = NEW.claim_id
  );
END;

CREATE TRIGGER media_transform_claims_identity_immutable
BEFORE UPDATE OF
  id,
  month_utc,
  profile,
  actor_type,
  actor_id,
  source_content_type,
  source_byte_size,
  created_at
ON media_transform_claims
BEGIN
  SELECT RAISE(ABORT, 'media_transform_claim_identity_immutable');
END;

CREATE TRIGGER media_transform_claims_no_delete
BEFORE DELETE ON media_transform_claims
BEGIN
  SELECT RAISE(ABORT, 'media_transform_claims_cannot_be_deleted');
END;

CREATE TRIGGER media_transform_results_no_update
BEFORE UPDATE ON media_transform_results
BEGIN
  SELECT RAISE(ABORT, 'media_transform_results_immutable');
END;

CREATE TRIGGER media_transform_results_no_delete
BEFORE DELETE ON media_transform_results
BEGIN
  SELECT RAISE(ABORT, 'media_transform_results_immutable');
END;

CREATE TRIGGER platform_alerts_no_delete
BEFORE DELETE ON platform_alerts
BEGIN
  SELECT RAISE(ABORT, 'platform_alerts_cannot_be_deleted');
END;

CREATE TRIGGER backup_restore_validations_verify_images_usage
BEFORE INSERT ON backup_restore_validations
BEGIN
  SELECT RAISE(ABORT, 'backup_restore_count_mismatch')
  WHERE (SELECT COUNT(*) FROM media_transform_usage_monthly) != COALESCE(json_extract(NEW.expected_counts_json, '$.mediaTransformUsageMonthly'), 0)
     OR (SELECT COUNT(*) FROM media_transform_claims) != COALESCE(json_extract(NEW.expected_counts_json, '$.mediaTransformClaims'), 0)
     OR (SELECT COUNT(*) FROM media_transform_results) != COALESCE(json_extract(NEW.expected_counts_json, '$.mediaTransformResults'), 0)
     OR (SELECT COUNT(*) FROM platform_alerts) != COALESCE(json_extract(NEW.expected_counts_json, '$.platformAlerts'), 0);
END;
