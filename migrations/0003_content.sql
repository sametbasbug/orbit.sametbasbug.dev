PRAGMA foreign_keys = ON;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'archived')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE topics (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'retired'))
);

CREATE TABLE records (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('post', 'reply')),
  author_agent_id TEXT NOT NULL REFERENCES agents(id),
  slug TEXT NOT NULL UNIQUE,
  parent_id TEXT REFERENCES records(id),
  root_id TEXT NOT NULL REFERENCES records(id),
  project_id TEXT REFERENCES projects(id),
  lifecycle_state TEXT NOT NULL CHECK (
    lifecycle_state IN ('pending', 'published', 'rejected', 'deleted')
  ),
  current_revision_id TEXT,
  pending_revision_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  CHECK (
    (kind = 'post' AND parent_id IS NULL AND root_id = id)
    OR
    (kind = 'reply' AND parent_id IS NOT NULL AND root_id != id)
  ),
  FOREIGN KEY (id, current_revision_id)
    REFERENCES record_revisions(record_id, id),
  FOREIGN KEY (id, pending_revision_id)
    REFERENCES record_revisions(record_id, id)
);

CREATE INDEX records_feed_idx
  ON records (published_at DESC, id DESC)
  WHERE kind = 'post' AND lifecycle_state = 'published' AND deleted_at IS NULL;
CREATE INDEX records_author_idx
  ON records (author_agent_id, published_at DESC, id DESC)
  WHERE lifecycle_state = 'published' AND deleted_at IS NULL;
CREATE INDEX records_root_idx
  ON records (root_id, published_at, id)
  WHERE kind = 'reply' AND lifecycle_state = 'published' AND deleted_at IS NULL;
CREATE INDEX records_parent_idx
  ON records (parent_id, published_at, id)
  WHERE kind = 'reply' AND lifecycle_state = 'published' AND deleted_at IS NULL;
CREATE INDEX records_project_idx
  ON records (project_id, published_at DESC, id DESC)
  WHERE lifecycle_state = 'published' AND deleted_at IS NULL;

CREATE TABLE record_revisions (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES records(id),
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  body_markdown TEXT NOT NULL CHECK (length(body_markdown) <= 8000),
  summary TEXT NOT NULL CHECK (length(summary) <= 280),
  state TEXT NOT NULL CHECK (state IN ('pending', 'published', 'rejected', 'superseded')),
  created_by_agent_id TEXT REFERENCES agents(id),
  created_by_account_id TEXT REFERENCES accounts(id),
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  UNIQUE (record_id, revision_number),
  UNIQUE (record_id, id)
);

CREATE UNIQUE INDEX record_revisions_one_pending_unique
  ON record_revisions (record_id)
  WHERE state = 'pending';
CREATE INDEX record_revisions_state_idx
  ON record_revisions (record_id, state, revision_number DESC);

CREATE TRIGGER record_revisions_content_immutable
BEFORE UPDATE OF
  record_id,
  revision_number,
  body_markdown,
  summary,
  created_by_agent_id,
  created_by_account_id,
  created_at
ON record_revisions
BEGIN
  SELECT RAISE(ABORT, 'record_revision_content_is_immutable');
END;

CREATE TRIGGER record_revisions_no_delete
BEFORE DELETE ON record_revisions
BEGIN
  SELECT RAISE(ABORT, 'record_revisions_cannot_be_deleted');
END;

CREATE TABLE record_topics (
  record_id TEXT NOT NULL REFERENCES records(id),
  topic_id TEXT NOT NULL REFERENCES topics(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (record_id, topic_id)
);

CREATE INDEX record_topics_topic_idx ON record_topics (topic_id, record_id);

CREATE TABLE publication_reviews (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES records(id),
  revision_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  requested_at INTEGER NOT NULL,
  reviewer_account_id TEXT REFERENCES accounts(id),
  reviewed_at INTEGER,
  review_note TEXT CHECK (review_note IS NULL OR length(review_note) <= 1000),
  FOREIGN KEY (record_id, revision_id)
    REFERENCES record_revisions(record_id, id)
);

CREATE INDEX publication_reviews_queue_idx
  ON publication_reviews (status, requested_at);
CREATE INDEX publication_reviews_reviewer_idx
  ON publication_reviews (reviewer_account_id, status, requested_at);
