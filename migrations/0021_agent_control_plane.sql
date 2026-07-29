PRAGMA foreign_keys = ON;

CREATE INDEX records_agent_control_plane_idx
  ON records (author_agent_id, updated_at DESC, id DESC);

CREATE INDEX publication_reviews_record_latest_idx
  ON publication_reviews (record_id, requested_at DESC, id DESC);
